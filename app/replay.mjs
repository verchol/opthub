/**
 * replay.mjs — take a session that ran here, and run it again somewhere else.
 *
 * The experiment in one line: a local Claude Code session is exported into a
 * bundle, the bundle is booted in an E2B sandbox, and the agent inside that
 * sandbox is served by an open-weights model instead of Claude. Same prompt,
 * same harness, different brain — and the two are then put side by side.
 *
 * What the comparison can and cannot say:
 *
 *   * Turns, tokens, wall time and artifacts are directly comparable — both
 *     sides are Claude Code doing the same job.
 *   * Cost is not. The local side is API-list equivalent for a subscription
 *     session; the open-weights side has no API behind it at all, so its
 *     marginal token cost is zero and only sandbox seconds are real.
 *   * Quality is only comparable when the bundle is gradeable. Otherwise the
 *     two artifact sets are shown and judged by a human, and this says so.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { exportSession } from './export.mjs'
import { runBundle } from './sandbox.mjs'
import { getRunner } from './runners.mjs'
import { startTrace, ensureProject, enabled as tracingOn, projectUrl } from './langsmith.mjs'

const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', c: '\x1b[36m', m: '\x1b[35m',
            d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }

const n = (v) => (v == null ? '—' : Math.round(v).toLocaleString('en-US'))

/**
 * What the agent produced, not what it was handed. SPEC.md and PROMPT.md are
 * inputs the harness wrote; listing them as artifacts makes an empty run look
 * like it delivered something.
 */
const INPUTS = new Set(['PROMPT.md', 'SPEC.md', 'Modelfile', 'litellm-ollama.yaml',
                        'litellm-bedrock.yaml', '__pycache__', '.claude'])
function deliverables(names, manifest) {
  const out = (names ?? []).filter((f) => !INPUTS.has(f))
  const want = manifest?.task?.file
  return want && out.includes(want) ? [want, ...out.filter((f) => f !== want)] : out
}
const dur = (s) => (s == null ? '—' : s < 90 ? `${Math.round(s)}s`
  : `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`)

/**
 * Step one of the experiment: run a real Claude Code session on this machine.
 *
 * It runs against the same task spec the sandbox will later be given, in a
 * throwaway workspace, and is graded locally by the same hidden suite — which is
 * what makes the two columns of the final table comparable rather than merely
 * adjacent. The local CLI's own credential is used, which is separate from
 * whatever the harness has in `.env`.
 */
export async function startLocalSession({ ROOT, task = 'regex', model = 'sonnet', onLog = console.log } = {}) {
  const taskDir = path.join(ROOT, 'tasks', task)
  if (!fs.existsSync(taskDir)) throw new Error(`no task "${task}" — look in tasks/`)
  const cfg = JSON.parse(fs.readFileSync(path.join(taskDir, 'task.json'), 'utf8'))
  const spec = fs.readFileSync(path.join(taskDir, 'SPEC.md'), 'utf8')
  const prompt = fs.readFileSync(path.join(ROOT, 'lib', 'BASE_PROMPT.md'), 'utf8')
    .replace(/\{\{FILE\}\}/g, cfg.file)

  const id = new Date().toISOString().replace(/[:.]/g, '-')
  const work = path.join(ROOT, 'local-sessions', id, 'work')
  fs.mkdirSync(path.join(work, 'tests'), { recursive: true })
  fs.writeFileSync(path.join(work, 'SPEC.md'), spec)
  fs.writeFileSync(path.join(work, 'PROMPT.md'), prompt)

  onLog(`  ${C.d}workspace${C.x} ${path.relative(ROOT, work)}`)
  onLog(`  ${C.d}running claude locally on ${C.x}${task}${C.d} — ${cfg.title}${C.x}`)

  const t0 = Date.now()
  // Session persistence is deliberately left on: the point of this step is to
  // produce a real local session that `opt session` can see afterwards, which a
  // non-persisted run would not.
  const args = ['-p', '--output-format', 'json', '--dangerously-skip-permissions', '--model', model]
  const res = await new Promise((resolve, reject) => {
    const p = spawn('claude', args, { cwd: work, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '', err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('error', reject)
    p.on('close', () => {
      try { resolve(JSON.parse(out.trim().split('\n').pop())) }
      catch { reject(new Error(`local claude produced no result\n${(err || out).slice(-500)}`)) }
    })
    p.stdin.end(prompt)
  })
  const wallSec = (Date.now() - t0) / 1000
  onLog(`  ${C.g}✓${C.x} ${C.d}local session ${res.session_id?.slice(0, 8)} — ${res.num_turns} turns, ${Math.round(wallSec)}s${C.x}`)

  // Grade it here, with the suite the sandbox will use, so both sides are
  // measured the same way.
  let grade = null
  if (cfg.kind !== 'document') {
    const gdir = path.join(ROOT, 'local-sessions', id, 'grade')
    fs.mkdirSync(gdir, { recursive: true })
    fs.copyFileSync(path.join(taskDir, 'test_hidden.py'), path.join(gdir, 'test_hidden.py'))
    fs.copyFileSync(path.join(ROOT, 'lib', 'grade.py'), path.join(gdir, 'grade.py'))
    grade = await new Promise((resolve) => {
      const g = spawn('python3', ['grade.py'], { cwd: gdir, env: { ...process.env, GRADE_DIR: work, GRADE_MODULE: cfg.module } })
      let o = ''
      g.stdout.on('data', (d) => { o += d })
      g.on('error', () => resolve(null))
      g.on('close', () => { try { resolve(JSON.parse(o.trim().split('\n').pop())) } catch { resolve(null) } })
    })
    if (grade?.total) onLog(`  ${C.d}graded locally: ${grade.passed}/${grade.total}${C.x}`)
  }

  return { sessionId: res.session_id, work, task, cfg, result: res, grade, wallSec, dir: path.dirname(work) }
}

export async function replay({ ROOT, session, runnerId = 'openmodel', task = null,
                               originOverride = null, onLog = console.log } = {}) {
  const runner = getRunner(runnerId)
  if (!runner) throw new Error(`no such runner: ${runnerId}`)

  const { dir, manifest } = exportSession(ROOT, session, { task })
  const replayId = new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = path.join(ROOT, 'replays', replayId)
  fs.mkdirSync(outDir, { recursive: true })

  await ensureProject()
  const trace = tracingOn() ? startTrace(`replay ${session.ref} → ${runner.id}`, {
    inputs: { ref: session.ref, intent: session.intent, runner: runner.id, model: runner.label,
              fidelity: manifest.fidelity },
    metadata: { replayId, kind: 'replay', origin: session.kind, runner: runner.id,
                template: runner.template ?? 'default', gradeable: manifest.gradeable },
    tags: ['replay', `runner:${runner.id}`, `origin:${session.kind}`],
  }) : null

  onLog(`  ${C.d}origin${C.x}    ${session.kind === 'local' ? 'a session that ran on this machine' : 'an e2b arm'} · ${session.ref}`)
  onLog(`  ${C.d}runner${C.x}    ${C.m}${runner.id}${C.x} ${C.d}— ${runner.label}${C.x}`)
  onLog(`  ${C.d}bundle${C.x}    ${path.relative(ROOT, dir)} (${manifest.fidelity}, ${manifest.promptWords} words)`)
  onLog('')

  let turns = 0
  const rec = await runBundle({
    ROOT, dir, manifest, trace, runner: runnerId,
    config: { id: `replay:${session.ref}`, model: runner.modelAlias ?? 'opus' },
    onEvent: (ev) => {
      if (ev.type === 'runner_step')
        onLog(`  ${ev.exitCode === 0 ? C.g + '✓' : C.r + '✗'}${C.x} ${C.d}${ev.name}${C.x}`)
      else if (ev.type === 'assistant') {
        turns++
        const tool = (ev.message?.content ?? []).find((b) => b.type === 'tool_use')
        process.stdout.write(`\r  ${C.d}turn ${turns}${tool ? ` · ${tool.name}` : ''}${' '.repeat(24)}${C.x}`)
      }
    },
  }).catch((e) => ({ id: `replay:${session.ref}`, fatal: String(e?.message ?? e) }))
  process.stdout.write('\r' + ' '.repeat(70) + '\r')

  const out = {
    replayId, runner: runner.id, runnerLabel: runner.label,
    bundle: path.relative(ROOT, dir), manifest,
    origin: originOverride ?? {
      ref: session.ref, kind: session.kind, intent: session.intent, model: session.model,
      turns: session.turns, wallSec: session.wallSec, cost: session.cost,
      tokens: session.tokens, grade: session.grade,
      artifacts: deliverables((session.artifacts ?? []).map((a) => a.name), manifest),
      costBasis: session.kind === 'local' ? 'API-list equivalent' : 'billed',
    },
    replayed: {
      sandboxId: rec.sandboxId ?? null, turns: rec.turns ?? turns,
      wallSec: rec.wallSec ?? null, cost: rec.cost ?? null,
      usage: rec.usage ?? null, grade: rec.grade ?? null,
      artifacts: Object.keys(rec.artifacts ?? {}),
      fatal: rec.fatal ?? null,
      error: rec.result?.is_error ? rec.result.result : null,
      stderrTail: rec.stderrTail ?? null,
      runnerSteps: rec.steps?.runner ?? [],
      teardown: rec.steps?.teardown ?? null,
      // No API stands behind a sandbox-local model, so its tokens cost nothing;
      // the only real spend is the sandbox itself.
      costBasis: runner.needsAnthropicAuth ? 'billed'
        : runner.needsAws ? 'billed to AWS via Bedrock'
        : 'no API — sandbox seconds only',
    },
  }
  fs.writeFileSync(path.join(outDir, 'replay.json'), JSON.stringify(out, null, 2))
  for (const [name, data] of Object.entries(rec.artifacts ?? {}))
    fs.writeFileSync(path.join(outDir, name), data)
  if (rec.stream) fs.writeFileSync(path.join(outDir, 'stream.jsonl'), rec.stream)

  await trace?.end({
    outputs: { origin: out.origin, replayed: { ...out.replayed, stderrTail: undefined } },
    error: rec.fatal ?? (rec.result?.is_error ? String(rec.result.result).slice(0, 400) : null),
  })
  return { ...out, outDir, traceUrl: trace ? projectUrl() : null }
}

export function renderReplay(r, ROOT) {
  const L = ['']
  const o = r.origin, p = r.replayed
  const w = 26
  const row = (label, a, b) => `  ${C.d}${label.padEnd(14)}${C.x}${String(a).padEnd(w)}${b}`

  L.push(`  ${C.b}${o.ref}${C.x} ${C.d}replayed on${C.x} ${C.m}${r.runner}${C.x}`)
  L.push(`  ${C.d}${o.intent?.slice(0, 96) ?? ''}${C.x}`)
  L.push('')
  L.push(`  ${' '.repeat(14)}${C.c}${'origin (this machine)'.padEnd(w)}${C.x}${C.m}open-weights replay${C.x}`)
  L.push(`  ${C.d}${'─'.repeat(14 + w + 22)}${C.x}`)
  L.push(row('model', o.model ?? '—', r.runnerLabel.split(' via ')[0]))
  L.push(row('turns', o.turns ?? '—', p.fatal ? '—' : (p.turns ?? '—')))
  L.push(row('wall', dur(o.wallSec), dur(p.wallSec)))
  L.push(row('tokens', n(o.tokens?.total), p.usage
    ? n((p.usage.input_tokens ?? 0) + (p.usage.cache_read_input_tokens ?? 0)
        + (p.usage.cache_creation_input_tokens ?? 0) + (p.usage.output_tokens ?? 0)) : '—'))
  L.push(row('cost', o.cost != null ? `$${o.cost.toFixed(4)}` : '—',
    p.costBasis.startsWith('no API') ? `${C.g}$0${C.x} ${C.d}(no API)${C.x}` : (p.cost != null ? `$${p.cost.toFixed(4)}` : '—')))
  L.push(row('artifacts', o.artifacts.length ? o.artifacts.slice(0, 2).join(' ') : '—',
    p.artifacts.length ? p.artifacts.slice(0, 2).join(' ') : '—'))
  if (r.manifest.gradeable)
    L.push(row('graded', o.grade?.total ? `${o.grade.passed}/${o.grade.total}` : '—',
      p.grade?.total ? `${p.grade.passed}/${p.grade.total}` : '—'))
  L.push('')

  if (p.fatal) L.push(`  ${C.r}the replay never ran:${C.x} ${p.fatal.slice(0, 200)}`)
  else if (p.error) L.push(`  ${C.r}the agent reported:${C.x} ${String(p.error).slice(0, 200)}`)
  else if (!p.turns) {
    const calls = (p.teardown?.match(/POST \/v1\/messages/g) ?? []).length
    L.push(`  ${C.y}the replay produced nothing.${C.x} ${C.d}The model answered ${calls || 'some'} request(s)` +
           ` in ${dur(p.wallSec)} and the${C.x}`)
    L.push(`  ${C.d}agent hit its time cap before completing a turn — too slow to drive Claude Code,${C.x}`)
    L.push(`  ${C.d}not wrong. A larger runner (${C.x}--runner openmodel-bedrock${C.d}) is the comparison worth making.${C.x}`)
  }

  L.push('')
  L.push(`  ${C.d}cost is not comparable across the two columns — the origin is ${o.costBasis},${C.x}`)
  L.push(`  ${C.d}the replay is ${p.costBasis}.${C.x}`)
  if (!r.manifest.gradeable)
    L.push(`  ${C.d}nothing here grades quality; compare the artifacts by hand.${C.x}`)
  L.push('')
  L.push(`  ${C.d}written to${C.x}  ${path.relative(ROOT, r.outDir)}/replay.json`)
  if (r.traceUrl) L.push(`  ${C.d}trace${C.x}       ${r.traceUrl}`)
  L.push('')
  return L.join('\n')
}
