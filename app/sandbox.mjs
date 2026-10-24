/**
 * sandbox.mjs — run one exported bundle in one E2B sandbox, and say what came
 * back.
 *
 * `run-demo.mjs` does this for the two arms of a scripted experiment. This does
 * it for an arbitrary bundle under an arbitrary configuration, which is what
 * both `opt session export --run` and the tuner need: same boot, same install,
 * same grading, different knobs.
 */
import { Sandbox } from '../sandbox/e2b/index.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { bundleFiles } from './export.mjs'
import { usagePayload } from './langsmith.mjs'
import { getRunner, runnerHostEnv } from './runners.mjs'

const WORK = '/home/user/work'
const nowSec = () => Date.now() / 1000
const readIf = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } }

/**
 * Auth for the agent inside the sandbox. An API key bills credits; a token bills
 * the subscription. `AUTH_MODE=subscription` forces the token even when a key is
 * present — useful when the key's credit balance has run out, which the agent
 * reports only after a sandbox has already booted.
 */
export function sandboxAuth(env = process.env) {
  const key = env.ANTHROPIC_API_KEY, oauth = env.CLAUDE_CODE_OAUTH_TOKEN
  const asKey = { mode: 'API key', envs: { ANTHROPIC_API_KEY: key, CLAUDE_CODE_OAUTH_TOKEN: '' } }
  const asSub = { mode: 'subscription', envs: { CLAUDE_CODE_OAUTH_TOKEN: oauth, ANTHROPIC_API_KEY: '' } }
  if (env.AUTH_MODE === 'subscription') return oauth ? asSub : (key ? asKey : null)
  if (env.AUTH_MODE === 'api-key') return key ? asKey : (oauth ? asSub : null)
  return key ? asKey : (oauth ? asSub : null)
}

/** The agent exits successfully on this, so it has to be recognised by its text. */
const OUT_OF_CREDIT = /credit balance is too low|insufficient credit|billing/i

/**
 * @param {object}   o
 * @param {string}   o.dir        bundle directory
 * @param {object}   o.manifest   its manifest.json
 * @param {object}   o.config     { id, model, flags[], env{}, promptSuffix, settings }
 * @param {object}   o.trace      parent LangSmith span, or null
 * @param {function} o.onEvent    called with each stream-json event
 */
export async function runBundle({ ROOT, dir, manifest, config = {}, trace = null, onEvent = null,
                                  runner: runnerId = 'anthropic',
                                  sandboxMs = null, agentMs = null,
                                  budgetUsd = process.env.MAX_BUDGET_USD ?? '5' } = {}) {
  const runner = getRunner(runnerId)
  if (!runner) throw new Error(`no such runner: ${runnerId}`)

  // Only a runner that actually talks to Anthropic needs an Anthropic credential.
  // The open-model runners serve themselves, which is why they still work when
  // the API key is out of credit.
  const auth = runner.needsAnthropicAuth ? sandboxAuth() : { mode: runner.label, envs: {} }
  if (!auth) throw new Error('no ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN — nothing can run')

  sandboxMs ??= runner.sandboxMs ?? Number(process.env.SANDBOX_MS ?? 40 * 60 * 1000)
  agentMs ??= runner.agentMs ?? Number(process.env.AGENT_MS ?? 30 * 60 * 1000)

  const label = config.id ?? 'candidate'
  const model = config.model ?? runner.modelAlias ?? 'opus'
  const flags = [
    '-p', '--output-format stream-json', '--verbose',
    '--dangerously-skip-permissions', '--no-session-persistence',
    `--max-budget-usd ${budgetUsd}`, `--model ${model}`,
    ...(runner.agentFlags ?? []),
    ...(config.flags ?? []),
  ]

  const span = trace?.child({
    name: `candidate ${label}`,
    inputs: { config: { model, flags: config.flags ?? [], env: Object.keys(config.env ?? {}),
                        promptSuffix: config.promptSuffix ? config.promptSuffix.slice(0, 400) : null } },
    metadata: { bundle: path.basename(dir), fidelity: manifest.fidelity, model,
                runner: runner.id, runnerLabel: runner.label, template: runner.template ?? 'default' },
    tags: ['candidate', label, `model:${model}`, `runner:${runner.id}`],
  })

  const rec = { id: label, runner: runner.id, runnerLabel: runner.label,
                config: { model, flags: config.flags ?? [], env: config.env ?? {},
                          promptSuffix: config.promptSuffix ?? null },
                startedAt: new Date().toISOString(), steps: {} }
  const t0 = nowSec()
  const template = runner.template ?? process.env.E2B_TEMPLATE ?? null
  const opts = { timeoutMs: sandboxMs,
                 metadata: { harnessDemo: '1', kind: 'tune', bundle: path.basename(dir),
                             candidate: label, runner: runner.id } }
  const sbx = await Sandbox.create(...(template ? [template, opts] : [opts]))
  rec.sandboxId = sbx.sandboxId
  span?.child({ name: 'sandbox created', runType: 'tool', inputs: { template: template ?? 'default' },
                metadata: { sandboxId: sbx.sandboxId } })?.end({ outputs: { sandboxId: sbx.sandboxId } })

  try {
    const inst = await sbx.commands.run(
      'command -v claude >/dev/null && claude --version || (npm install -g @anthropic-ai/claude-code 2>&1 | tail -2 && claude --version)',
      { timeoutMs: 900000 })
    rec.steps.install = { exitCode: inst.exitCode, version: inst.stdout.trim().split('\n').pop() }
    span?.child({ name: 'install claude-code', runType: 'tool' })
        ?.end({ outputs: { version: rec.steps.install.version },
                error: inst.exitCode === 0 ? null : `exit ${inst.exitCode}` })
    if (inst.exitCode !== 0) throw new Error(`claude install failed: ${inst.stderr || inst.stdout}`)

    // ---- workspace
    await sbx.commands.run(`mkdir -p ${WORK}/tests ${WORK}/.claude`)
    const files = bundleFiles(dir, WORK)
    if (config.promptSuffix) {
      const i = files.findIndex((f) => f.path.endsWith('PROMPT.md'))
      if (i >= 0) files[i] = { ...files[i], data: `${files[i].data}\n\n---\n\n${config.promptSuffix}\n` }
    }
    // A configuration may carry a settings.json — the same lever a real project has.
    if (config.settings)
      files.push({ path: `${WORK}/.claude/settings.json`, data: JSON.stringify(config.settings, null, 2) })
    files.push(...(runner.files?.(WORK) ?? []))
    await sbx.files.write(files)

    // ---- bring the runner's model up before the agent asks it anything
    const hostEnv = runnerHostEnv(runner)
    const stepEnv = { ...hostEnv, ...runner.env, ...(config.env ?? {}) }
    rec.steps.runner = []
    for (const st of runner.steps ?? []) {
      const sp = span?.child({ name: st.name, runType: 'tool', inputs: { cmd: st.cmd.slice(0, 400) },
                               metadata: { kind: st.kind, runner: runner.id } })
      if (st.kind === 'service') {
        // A real background process: commands.run(background) outlives the call
        // that started it, unlike `cmd &` inside a foreground command.
        const h = await sbx.commands.run(st.cmd, { background: true, envs: stepEnv, timeoutMs: 0 })
          .catch((e) => { throw new Error(`${st.name} failed to start: ${e?.message ?? e}`) })
        rec.steps.runner.push({ name: st.name, kind: 'service', started: true })
        await sp?.end({ outputs: { started: true, pid: h?.pid ?? null } })
        continue
      }
      const r = await sbx.commands.run(st.cmd, { timeoutMs: st.timeoutMs ?? 180000, envs: stepEnv })
        .catch((e) => ({ exitCode: -1, stdout: '', stderr: String(e?.message ?? e) }))
      const out = ((r.stdout ?? '') + (r.stderr ?? '')).trim()
      rec.steps.runner.push({ name: st.name, kind: 'run', exitCode: r.exitCode, out: out.slice(-800) })
      onEvent?.({ type: 'runner_step', name: st.name, exitCode: r.exitCode }, { label })
      await sp?.end({ outputs: { out: out.slice(-1500) }, error: r.exitCode === 0 ? null : `exit ${r.exitCode}` })
      if (r.exitCode !== 0) {
        // Bringing the model up is not optional; running the agent against a
        // dead endpoint produces a confusing agent error instead of this one.
        throw new Error(`runner step "${st.name}" failed (exit ${r.exitCode}):\n${out.slice(-600)}`)
      }
    }

    // ---- the agent
    const envs = { ...auth.envs, ...hostEnv, ...runner.env, ...(config.env ?? {}), CI: '1', IS_SANDBOX: '1' }
    const cmd = `cd ${WORK} && cat PROMPT.md | claude ${flags.join(' ')} 2> /home/user/claude.err | tee /home/user/stream.jsonl; echo "CLAUDE_EXIT=\${PIPESTATUS[1]}"`
    const agentSpan = span?.child({
      name: 'agent', runType: 'llm',
      inputs: { prompt: readIf(path.join(dir, 'PROMPT.md'))?.slice(0, 8000) ?? '', flags, command: cmd },
      metadata: { model, ls_model_name: model, ls_provider: 'anthropic', sandboxId: sbx.sandboxId },
      tags: ['agent', label],
    })

    let tail = '', turns = 0, finalEvent = null
    const t1 = nowSec()
    const onLine = (line) => {
      if (!line.trim()) return
      let ev; try { ev = JSON.parse(line) } catch { return }
      if (ev.type === 'assistant') turns++
      if (ev.type === 'result') finalEvent = ev
      onEvent?.(ev, { turns, label })
    }
    let run = await sbx.commands.run(cmd, {
      timeoutMs: agentMs, envs,
      onStdout: (chunk) => {
        tail += chunk
        const parts = tail.split('\n'); tail = parts.pop() ?? ''
        for (const l of parts) onLine(l)
      },
    }).catch((e) => ({ exitCode: -1, stdout: '', stderr: String(e?.message ?? e) }))
    if (tail.trim()) onLine(tail)

    if (!finalEvent) {
      const jl = await sbx.files.read('/home/user/stream.jsonl').catch(() => '')
      for (const l of jl.split('\n').reverse()) {
        try { const ev = JSON.parse(l); if (ev.type === 'result') { finalEvent = ev; break } } catch {}
      }
    }
    // A key with no credit fails in 15 seconds having done nothing. The sandbox
    // is already up and the bundle is already in it, so retrying on the
    // subscription costs a command, not another boot.
    if (runner.needsAnthropicAuth && finalEvent?.is_error && OUT_OF_CREDIT.test(finalEvent.result ?? '')
        && auth.mode === 'API key' && process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      rec.authFallback = `${auth.mode} had no credit — retried on the subscription`
      const sub = sandboxAuth({ ...process.env, AUTH_MODE: 'subscription' })
      finalEvent = null; turns = 0; tail = ''
      const retry = await sbx.commands.run(cmd, {
        timeoutMs: agentMs, envs: { ...sub.envs, ...(config.env ?? {}), CI: '1', IS_SANDBOX: '1' },
        onStdout: (chunk) => {
          tail += chunk
          const parts = tail.split('\n'); tail = parts.pop() ?? ''
          for (const l of parts) onLine(l)
        },
      }).catch((e) => ({ exitCode: -1, stdout: '', stderr: String(e?.message ?? e) }))
      if (tail.trim()) onLine(tail)
      run.exitCode = retry.exitCode
    }

    const agentSec = +(nowSec() - t1).toFixed(1)
    // The command timing out kills claude mid-turn, so no result event is ever
    // written: no cost, no usage, no summary. The work already on disk still
    // grades, which is why this has to be said out loud rather than inferred
    // from a blank cost column.
    rec.cappedOut = !finalEvent && agentSec >= (agentMs / 1000) - 30
    if (rec.cappedOut) rec.cappedNote = `the agent was killed at its ${Math.round(agentMs / 60000)}-minute cap`
    rec.result = finalEvent
    rec.steps.agent = { exitCode: run.exitCode, wallSec: agentSec, turns }
    rec.stderrTail = (await sbx.files.read('/home/user/claude.err').catch(() => '')).trim().slice(-1200)

    await agentSpan?.end({
      outputs: { result: finalEvent?.result ?? null, num_turns: finalEvent?.num_turns ?? turns,
                 total_cost_usd: finalEvent?.total_cost_usd ?? null,
                 usage_metadata: usagePayload(finalEvent?.usage ?? {}, model) },
      error: finalEvent && !finalEvent.is_error ? null
           : (finalEvent?.result ?? `agent exited ${run.exitCode} with no result event`),
    })

    // ---- grade, when the task has a suite to grade against
    if (manifest.gradeable && manifest.task) {
      const taskDir = path.join(ROOT, 'tasks', manifest.task.name)
      const hidden = readIf(path.join(taskDir, 'test_hidden.py'))
      const grader = readIf(path.join(ROOT, 'lib', 'grade.py'))
      if (hidden && grader) {
        await sbx.files.write([
          { path: '/home/user/grade/test_hidden.py', data: hidden },
          { path: '/home/user/grade/grade.py', data: grader },
        ])
        const g = await sbx.commands.run(
          `cd /home/user/grade && GRADE_DIR=${WORK} GRADE_MODULE=${manifest.task.module} python3 grade.py`,
          { timeoutMs: 120000 }).catch((e) => ({ stdout: '', stderr: String(e?.message ?? e) }))
        try { rec.grade = JSON.parse(g.stdout.trim().split('\n').pop()) }
        catch { rec.grade = { error: (g.stdout + g.stderr).slice(-400) } }
        span?.child({ name: 'grade', runType: 'tool', inputs: { module: manifest.task.module } })
            ?.end({ outputs: { passed: rec.grade.passed ?? null, total: rec.grade.total ?? null },
                    error: rec.grade.error ?? null })
      }
    }

    if (runner.teardown) {
      const td = await sbx.commands.run(runner.teardown, { timeoutMs: 60000, envs: stepEnv })
        .catch((e) => ({ stdout: '', stderr: String(e?.message ?? e) }))
      rec.steps.teardown = ((td.stdout ?? '') + (td.stderr ?? '')).slice(-3000)
    }

    // ---- what it produced
    rec.artifacts = {}
    for (const f of [manifest.task?.file, 'PLAN.md', 'STRATEGY.md'].filter(Boolean)) {
      const c = await sbx.files.read(`${WORK}/${f}`).catch(() => null)
      if (c !== null) rec.artifacts[f] = c
    }
    rec.stream = await sbx.files.read('/home/user/stream.jsonl').catch(() => '')
    rec.wallSec = +(nowSec() - t0).toFixed(1)
    rec.cost = finalEvent?.total_cost_usd ?? null
    rec.turns = finalEvent?.num_turns ?? turns
    rec.usage = finalEvent?.usage ?? null

    await span?.end({
      outputs: { passed: rec.grade?.passed ?? null, total: rec.grade?.total ?? null,
                 cost_usd: rec.cost, turns: rec.turns, wallSec: rec.wallSec,
                 cappedOut: rec.cappedOut ?? false,
                 usage_metadata: usagePayload(rec.usage ?? {}, model) },
      error: rec.cappedNote ?? null,
    })
    return rec
  } catch (e) {
    rec.fatal = String(e?.message ?? e)
    rec.wallSec = +(nowSec() - t0).toFixed(1)
    await span?.end({ outputs: { wallSec: rec.wallSec }, error: rec.fatal.slice(0, 600) })
    return rec
  } finally {
    await sbx.kill().catch(() => {})
  }
}

/**
 * Ask the API one trivial question before booting anything.
 *
 * An exhausted key and an expired token both fail *inside* the sandbox, after a
 * boot and an npm install, and the agent exits 0 having done nothing — so a
 * whole generation of candidates can burn several minutes of sandbox time to
 * discover one billing problem. One 4-token request up front is cheaper than
 * finding out N times in parallel.
 */
export async function preflightAuth() {
  const auth = sandboxAuth()
  if (!auth) return { ok: false, reason: 'no ANTHROPIC_API_KEY and no CLAUDE_CODE_OAUTH_TOKEN', fix: 'put one in .env' }

  if (auth.mode === 'API key') {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': auth.envs.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }),
        signal: AbortSignal.timeout(20000),
      })
      if (r.ok) return { ok: true, mode: auth.mode }
      const body = await r.text()
      const msg = (() => { try { return JSON.parse(body).error?.message ?? body } catch { return body } })()
      if (/credit balance/i.test(msg)) {
        const hasToken = !!process.env.CLAUDE_CODE_OAUTH_TOKEN
        return { ok: false, mode: auth.mode, reason: msg.trim(),
          fix: hasToken
            ? 'top up at console.anthropic.com/settings/billing, or run with AUTH_MODE=subscription to bill your Claude subscription instead'
            : 'top up at console.anthropic.com/settings/billing, or mint a subscription token with `node auth.mjs`' }
      }
      return { ok: false, mode: auth.mode, reason: msg.slice(0, 300).trim(), fix: 'check the key in .env' }
    } catch (e) {
      return { ok: false, mode: auth.mode, reason: String(e?.message ?? e), fix: 'network reachable?' }
    }
  }

  // A subscription token cannot be checked from here — the API rejects it and
  // only Claude Code knows how to present it — so it is reported as unverified
  // rather than claimed to be good.
  return { ok: true, mode: auth.mode, unverified: true }
}
