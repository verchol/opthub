#!/usr/bin/env node
/**
 * Autonomous flow: a controller sandbox runs the main flow and reports status,
 * worker sandboxes execute each stage, and a separate judge sandbox — which has
 * seen none of the workers' reasoning — decides against a pre-registered
 * methodology whether an investor would invest.
 *
 *   node flow.mjs <flow> [--model M] [--github owner/repo] [--dry]
 *
 * The GitHub step is opt-in. Without --github the user story is written to disk
 * and nothing is posted.
 */
import { Sandbox } from '../sandbox/e2b/index.mjs'
import { STATE, ENV_FILE } from './lib/state.mjs'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveSecrets, parseEnvFile } from './secrets.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const WORK = '/home/user/work'
const C = { a: '\x1b[36m', b: '\x1b[35m', j: '\x1b[33m', g: '\x1b[32m', r: '\x1b[31m', d: '\x1b[2m', bold: '\x1b[1m', x: '\x1b[0m' }

resolveSecrets(['ANTHROPIC_API_KEY', 'E2B_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'])
for (const [k, v] of Object.entries(parseEnvFile(ENV_FILE))) if (!process.env[k] && !v.startsWith('op://')) process.env[k] = v

// ---------------------------------------------------------------- flow spec
function loadFlow(name) {
  const file = path.join(ROOT, 'flows', `${name}.md`)
  if (!fs.existsSync(file)) {
    const avail = fs.existsSync(path.join(ROOT, 'flows'))
      ? fs.readdirSync(path.join(ROOT, 'flows')).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')) : []
    throw new Error(`no flow "${name}". available: ${avail.join(', ') || '(none)'}`)
  }
  const src = fs.readFileSync(file, 'utf8')
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src)
  const meta = {}
  for (const line of (m?.[1] ?? '').split('\n')) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (kv) meta[kv[1]] = kv[2].trim()
  }
  const body = src.slice(m?.[0].length ?? 0)
  const stages = {}
  for (const chunk of body.split(/^## /m).slice(1)) {
    const nl = chunk.indexOf('\n')
    stages[chunk.slice(0, nl).trim()] = chunk.slice(nl + 1).trim()
  }
  return { name, meta, stages, order: (meta.stages || Object.keys(stages).join(' ')).split(/\s+/).filter(Boolean) }
}

// ---------------------------------------------------------------- plumbing
const nowSec = () => Date.now() / 1000
const short = (s, n = 90) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

async function boot(label, colour, template) {
  process.stdout.write(`  ${colour}${label.padEnd(12)}${C.x} booting… `)
  const sbx = await Sandbox.create(template, { timeoutMs: 45 * 60 * 1000,
    metadata: { harnessDemo: '1', role: label, flow: '1' } })
  console.log(`${C.g}${sbx.sandboxId}${C.x}`)
  return sbx
}

/** Run one agent turn in a sandbox and return its result event. */
async function agent(sbx, label, colour, promptFiles, prompt, { model = 'opus', envs = {}, budget = '6' } = {}) {
  await sbx.commands.run(`mkdir -p ${WORK}`)
  await sbx.files.write([...promptFiles, { path: `${WORK}/PROMPT.md`, data: prompt }])
  const flags = ['-p', '--output-format stream-json', '--verbose', '--dangerously-skip-permissions',
                 '--no-session-persistence', '--disallowed-tools WebSearch WebFetch',
                 `--max-budget-usd ${budget}`, `--model ${model}`].join(' ')
  const t0 = nowSec()
  let turns = 0, final = null, tail = ''
  const res = await sbx.commands.run(
    `cd ${WORK} && cat PROMPT.md | claude ${flags} 2> /home/user/err.txt | tee /home/user/stream.jsonl`,
    { timeoutMs: 25 * 60 * 1000,
      envs: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '', CI: '1', IS_SANDBOX: '1', ...envs },
      onStdout: (d) => {
        tail += d
        const parts = tail.split('\n'); tail = parts.pop() ?? ''
        for (const line of parts) {
          if (!line.trim()) continue
          let ev; try { ev = JSON.parse(line) } catch { continue }
          if (ev.type === 'assistant') {
            turns++
            const tool = (ev.message?.content ?? []).find((b) => b.type === 'tool_use')
            if (tool) process.stdout.write(`\r  ${colour}${label.padEnd(12)}${C.x} ${C.d}${String(turns).padStart(2)} turns · ${short(tool.name + '(' + (tool.input?.file_path ?? tool.input?.command ?? '') + ')', 58).padEnd(58)}${C.x}`)
          }
          if (ev.type === 'result') final = ev
        }
      } })
  if (!final) {
    const jl = await sbx.files.read('/home/user/stream.jsonl').catch(() => '')
    for (const l of jl.split('\n').reverse()) { try { const e = JSON.parse(l); if (e.type === 'result') { final = e; break } } catch {} }
  }
  const secs = Math.round(nowSec() - t0)
  const trace = await sbx.files.read('/home/user/stream.jsonl').catch(() => '')
  const stderr = await sbx.files.read('/home/user/err.txt').catch(() => '')
  if (!final || final.is_error) {
    const e = await sbx.files.read('/home/user/err.txt').catch(() => '')
    const why = String(final?.result ?? e ?? '').trim().split('\n').pop() ?? ''
    if (why) console.log(`\r  ${colour}${label.padEnd(12)}${C.x} ${C.r}${short(why, 100)}${C.x}${' '.repeat(20)}`)
  }
  const err = final?.is_error ? `${C.r}error${C.x}` : `${C.g}ok${C.x}`
  console.log(`\r  ${colour}${label.padEnd(12)}${C.x} ${err} · ${turns} turns · ${secs}s · $${(final?.total_cost_usd ?? 0).toFixed(4)}${' '.repeat(30)}`)
  return { final, turns, secs, exitCode: res.exitCode, trace, stderr }
}

// ---------------------------------------------------------------- main
async function main() {
  const argv = process.argv.slice(2)
  const flagVal = (n) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null }
  const flowName = argv.find((a) => !a.startsWith('--')) ?? 'investor-case'
  const model = flagVal('--model') ?? process.env.BENCH_MODEL ?? 'opus'
  const github = flagVal('--github')
  const dry = argv.includes('--dry')
  const template = process.env.E2B_TEMPLATE || undefined

  const flow = loadFlow(flowName)
  const methodology = fs.readFileSync(path.join(ROOT, 'lib', 'methodology', flow.meta.methodology ?? 'investor.md'), 'utf8')
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '').replace(/(\d{8})(\d{6})/, '$1-$2')
  const RUN = `flow-${flowName}-${stamp}`
  const OUT = path.join(STATE, 'results', RUN)

  console.log(`\n${C.bold}autonomous flow${C.x} · ${flowName}`)
  console.log(`  ${C.d}goal:${C.x} ${short(flow.meta.goal, 150)}`)
  console.log(`  ${C.d}stages: ${flow.order.join(' → ')} · model ${model} · judge is a separate sandbox${C.x}`)
  console.log(`  ${C.d}github: ${github ?? 'not posting (use --github owner/repo)'}${C.x}\n`)

  if (dry) {
    console.log(`${C.d}dry run — nothing booted.${C.x}`)
    for (const st of flow.order) console.log(`\n${C.bold}## ${st}${C.x}\n${(flow.stages[st] ?? '(judge sandbox)').split('\n').map((l) => '  ' + l).join('\n')}`)
    console.log(`\n${C.bold}methodology${C.x} (judge only)\n${methodology.split('\n').slice(0, 12).map((l) => '  ' + C.d + l + C.x).join('\n')}\n  …\n`)
    return
  }
  if (!process.env.E2B_API_KEY) { console.error('E2B_API_KEY missing'); process.exit(1) }
  if (!process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY missing'); process.exit(1) }
  fs.mkdirSync(OUT, { recursive: true })

  const state = { run: RUN, flow: flowName, model, goal: flow.meta.goal, stages: {}, startedAt: new Date().toISOString() }
  const beat = () => { state.updatedAt = new Date().toISOString(); fs.writeFileSync(path.join(OUT, 'status.json'), JSON.stringify(state, null, 2)) }
  beat()

  // ---- controller: owns the flow, reports status, spawns the workers
  const controller = await boot('controller', C.a, template)
  const workers = []
  try {
    const carry = []           // files produced so far, carried into the next stage
    for (const stage of flow.order) {
      if (stage === 'judge') continue
      state.stages[stage] = { status: 'running', startedAt: new Date().toISOString() }; beat()

      const sbx = stage === flow.order[0] ? controller : await boot(`worker:${stage}`.slice(0, 12), C.b, template)
      if (sbx !== controller) workers.push(sbx)

      const expected = /`([A-Z][A-Z0-9_]*\.md)`/.exec(flow.stages[stage])?.[1] ?? null
      const prompt = `${flow.stages[stage]}\n\n---\n\nGOAL OF THIS FLOW\n\n${flow.meta.goal}\n\n`
        + (expected ? `The deliverable of this stage is exactly \`${WORK}/${expected}\`. Write that file and no other.\n\n` : '')
        + `You have no web access. Work autonomously, ask nothing, and print DONE once the file is written.\n`
      const stageBudget = String(flow.meta[`budget_${stage}`] ?? flow.meta.budget ?? '6')
      const r = await agent(sbx, stage, sbx === controller ? C.a : C.b, carry, prompt, { model, budget: stageBudget })
      if (r.trace) fs.writeFileSync(path.join(OUT, `${stage}.stream.jsonl`), r.trace)
      if (r.stderr) fs.writeFileSync(path.join(OUT, `${stage}.err.txt`), r.stderr)

      // collect whatever this stage produced
      const ls = await sbx.commands.run(`cd ${WORK} && ls *.md 2>/dev/null`).catch(() => ({ stdout: '' }))
      const produced = ls.stdout.split('\n').map((s) => s.trim()).filter((f) => f && f !== 'PROMPT.md')
      for (const f of produced) {
        const data = await sbx.files.read(`${WORK}/${f}`).catch(() => null)
        if (data == null) continue
        fs.writeFileSync(path.join(OUT, f), data)
        if (!carry.some((c) => c.path.endsWith('/' + f))) carry.push({ path: `${WORK}/${f}`, data })
      }
      const hitCap = Number(r.final?.total_cost_usd ?? 0) >= Number(stageBudget) * 0.97
      state.stages[stage] = { status: r.final?.is_error ? (hitCap ? 'budget-capped' : 'error') : 'done',
                              turns: r.turns, secs: r.secs, budget: Number(stageBudget),
                              cost: r.final?.total_cost_usd ?? 0, produced }; beat()
      if (hitCap) console.log(`  ${' '.repeat(12)} ${C.r}stopped on the $${stageBudget} cap after ${r.turns} turns${C.x}`)
      console.log(`  ${C.d}${' '.repeat(12)} produced: ${produced.join(', ') || '(nothing)'}${C.x}`)
    }

    // ---- GitHub: opt-in
    const story = carry.find((c) => /STORY\.md$/i.test(c.path))
    if (story && github) {
      const title = (/^#\s*(.+)$/m.exec(story.data)?.[1] ?? `${flowName}: goal`).slice(0, 120)
      try {
        const url = execFileSync('gh', ['issue', 'create', '--repo', github, '--title', title, '--body', story.data],
          { encoding: 'utf8' }).trim().split('\n').pop()
        state.github = { repo: github, issue: url }; beat()
        console.log(`  ${C.g}issue created${C.x} ${url}`)
      } catch (e) { state.github = { repo: github, error: short(e?.stderr ?? e?.message, 200) }; beat()
        console.log(`  ${C.r}issue creation failed${C.x} ${state.github.error}`) }
    } else if (story) {
      console.log(`  ${C.d}STORY.md written locally; pass --github owner/repo to file it as an issue${C.x}`)
    }

    // ---- judge: a sandbox that has seen none of the above reasoning
    state.stages.judge = { status: 'running' }; beat()
    const judgeBox = await boot('judge', C.j, template)
    workers.push(judgeBox)
    const artifact = carry.find((c) => /CASE\.md$/i.test(c.path)) ?? carry[carry.length - 1]
    const judgePrompt = `You are an investment partner. Apply the methodology in METHODOLOGY.md to the single document in CANDIDATE.md and decide.

You have not seen how the document was produced and must not speculate about it. Judge only what is on the page.

Check the gates FIRST and independently. A gate failure caps the verdict at PASS no matter how strong the rest is.

Write your decision to VERDICT.json — this exact shape, nothing else in the file:
{"gates":{"no_fabricated_evidence":{"pass":true|false,"why":"..."},
          "counter_case_present":{"pass":true|false,"why":"..."},
          "ask_is_legible":{"pass":true|false,"why":"..."}},
 "scores":{"thesis":1-10,"evidence":1-10,"wedge":1-10,"moat":1-10,"economics":1-10,"risk":1-10},
 "total":<sum>,
 "verdict":"INVEST"|"SECOND_MEETING"|"PASS",
 "one_line":"<the single sentence you would send the partnership>",
 "strongest":"<what most nearly persuaded you>",
 "fatal":"<what stopped you, or empty if nothing did>"}

Then print DONE.`
    const jr = await agent(judgeBox, 'judge', C.j, [
      { path: `${WORK}/METHODOLOGY.md`, data: methodology },
      { path: `${WORK}/CANDIDATE.md`, data: artifact?.data ?? '(no artifact was produced)' },
    ], judgePrompt, { model, budget: '4' })

    if (jr.trace) fs.writeFileSync(path.join(OUT, 'judge.stream.jsonl'), jr.trace)
    if (jr.stderr) fs.writeFileSync(path.join(OUT, 'judge.err.txt'), jr.stderr)
    const raw = await judgeBox.files.read(`${WORK}/VERDICT.json`).catch(() => '')
    let verdict = null
    try { verdict = JSON.parse(/\{[\s\S]*\}/.exec(raw)?.[0] ?? '') } catch {}
    state.stages.judge = { status: verdict ? 'done' : 'error', turns: jr.turns, secs: jr.secs, cost: jr.final?.total_cost_usd ?? 0 }
    state.verdict = verdict; beat()
    if (raw) fs.writeFileSync(path.join(OUT, 'VERDICT.json'), raw)

    // ---- report
    console.log(`\n${C.bold}${'─'.repeat(66)}${C.x}`)
    if (!verdict) { console.log(`  ${C.r}the judge produced no parsable verdict${C.x}`) }
    else {
      const gateFails = Object.entries(verdict.gates ?? {}).filter(([, g]) => !g.pass)
      console.log(`  gates:`)
      for (const [k, g] of Object.entries(verdict.gates ?? {}))
        console.log(`    ${g.pass ? C.g + '✓' : C.r + '✗'}${C.x} ${k.replace(/_/g, ' ').padEnd(24)} ${C.d}${short(g.why, 70)}${C.x}`)
      console.log(`  scores: ${Object.entries(verdict.scores ?? {}).map(([k, v]) => `${k} ${v}`).join('  ')}   ${C.bold}total ${verdict.total}/60${C.x}`)
      const col = verdict.verdict === 'INVEST' ? C.g : verdict.verdict === 'PASS' ? C.r : C.j
      console.log(`\n  ${col}${C.bold}${verdict.verdict}${C.x}${gateFails.length ? `  ${C.d}(capped by gate: ${gateFails.map(([k]) => k).join(', ')})${C.x}` : ''}`)
      console.log(`  ${verdict.one_line ?? ''}`)
      if (verdict.fatal) console.log(`  ${C.d}fatal: ${verdict.fatal}${C.x}`)
    }
    const spend = Object.values(state.stages).reduce((a, s) => a + (s.cost ?? 0), 0)
    console.log(`\n  ${C.d}${Object.keys(state.stages).length} stages · ${1 + workers.length} sandboxes · $${spend.toFixed(4)} · results/${RUN}/${C.x}\n`)
    state.totalCost = spend; beat()
  } finally {
    for (const s of [controller, ...workers]) await s.kill().catch(() => {})
    console.log(`  ${C.d}sandboxes killed${C.x}`)
  }
}

main().catch((e) => { console.error(`\n${C.r}${e?.message ?? e}${C.x}\n`); process.exit(1) })
