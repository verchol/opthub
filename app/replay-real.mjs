#!/usr/bin/env node
/**
 * Replay a REAL Claude Code session in a sandbox, on one or more models, and
 * grade by (1) efficiency and (2) a blind judge of the resulting diff against
 * the original session's diff. No synthetic task, no hidden suite.
 *
 *   node replay-real.mjs <sessionId> [--models a,b] [--budget 8]
 */
import { Sandbox } from '../sandbox/e2b/index.mjs'
import { STATE, ENV_FILE } from './lib/state.mjs'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveSecrets, parseEnvFile } from './secrets.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const WORK = '/home/user/repo'
const C = { a: '\x1b[36m', b: '\x1b[35m', j: '\x1b[33m', g: '\x1b[32m', r: '\x1b[31m', d: '\x1b[2m', bold: '\x1b[1m', x: '\x1b[0m' }

resolveSecrets(['E2B_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'ANTHROPIC_API_KEY'])
for (const [k, v] of Object.entries(parseEnvFile(ENV_FILE))) if (!process.env[k] && !v.startsWith('op://')) process.env[k] = v

// -------- registry of how to serve each model in the sandbox ---------------
const MODELS = {
  'opus45-bedrock':  { label: 'Claude Opus 4.5 (Bedrock)',  bedrock: 'eu.anthropic.claude-opus-4-5-20251101-v1:0', inM: 5, outM: 25 },
  'qwen480-bedrock': { label: 'Qwen3-Coder-480B (Bedrock)', bedrock: 'qwen.qwen3-coder-480b-a35b-v1:0',           inM: 0.22, outM: 1.80 },
  'qwen30-bedrock':  { label: 'Qwen3-Coder-30B (Bedrock)',  bedrock: 'qwen.qwen3-coder-30b-a3b-v1:0',             inM: 0.07, outM: 0.28 },
}

// -------- read the real session --------------------------------------------
function findTranscript(id) {
  const proj = path.join(os.homedir(), '.claude', 'projects')
  let hit = null
  const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name)
    if (f.isDirectory()) walk(p); else if (f.name.startsWith(id) && f.name.endsWith('.jsonl')) hit = p } }
  walk(proj)
  return hit
}

/** Reconstruct the files the original session wrote, from its Write/Edit blocks. */
function reconstructOutput(file) {
  const raw = fs.readFileSync(file, 'utf8')
  const files = {}
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let e; try { e = JSON.parse(line) } catch { continue }
    if (e.type !== 'assistant') continue
    for (const b of e.message?.content ?? []) {
      if (b.type !== 'tool_use' || !b.input?.file_path) continue
      const name = b.input.file_path.split('/').pop()
      if (b.name === 'Write') files[name] = b.input.content ?? ''
      else if (b.name === 'Edit' && files[name] != null && b.input.old_string != null)
        files[name] = files[name].replace(b.input.old_string, b.input.new_string ?? '')
      else if (b.name === 'MultiEdit' && files[name] != null)
        for (const ed of b.input.edits ?? []) files[name] = files[name].replace(ed.old_string, ed.new_string ?? '')
    }
  }
  return Object.entries(files).map(([f, c]) => `--- ${f}\n${c}`).join('\n\n')
}

function readSession(id) {
  const file = findTranscript(id)
  if (!file) throw new Error(`no transcript starting ${id}`)
  const raw = fs.readFileSync(file, 'utf8')
  let request = '', cwd = ''
  const edited = new Set()
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let e; try { e = JSON.parse(line) } catch { continue }
    if (e.cwd && !cwd) cwd = e.cwd
    if (e.type === 'user' && !request) {
      const c = e.message?.content
      const t = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((b) => b.type === 'text')?.text ?? '') : ''
      if (t && !t.startsWith('<')) request = t.trim()
    }
    if (e.type === 'assistant') for (const b of e.message?.content ?? [])
      if (b.type === 'tool_use' && /Edit|Write|MultiEdit/.test(b.name) && b.input?.file_path)
        edited.add(b.input.file_path)
  }
  if (!request) throw new Error('no user request found in transcript')
  if (!cwd || !fs.existsSync(cwd)) throw new Error(`session cwd is gone: ${cwd}`)
  return { file, request, cwd, edited: [...edited] }
}

/** The diff the original session produced, reconstructed from the repo's git history near that time. */
function originalDiff(cwd, edited) {
  const rel = edited.map((f) => path.relative(cwd, f)).filter((f) => !f.startsWith('..'))
  try {
    // Best available proxy: the committed change to those files at HEAD. If the
    // working tree still holds the change, use that; else the last commit touching them.
    const wt = execFileSync('git', ['-C', cwd, 'diff', 'HEAD', '--', ...rel], { encoding: 'utf8' })
    if (wt.trim()) return { diff: wt, basis: 'uncommitted working-tree change' }
    const last = execFileSync('git', ['-C', cwd, 'log', '-1', '-p', '--', ...rel], { encoding: 'utf8' })
    return { diff: last.slice(0, 12000), basis: 'last commit touching those files' }
  } catch (e) { return { diff: '', basis: 'unavailable: ' + String(e.message).slice(0, 80) } }
}

const nowSec = () => Date.now() / 1000
const short = (s, n = 60) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

async function creds() {
  return { AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
           AWS_REGION: process.env.AWS_REGION || 'eu-north-1', AWS_DEFAULT_REGION: process.env.AWS_REGION || 'eu-north-1' }
}

/** Serve `model` via LiteLLM and run the request against a fresh copy of the repo. */
async function replayOn(session, modelId, budget, inputs) {
  const m = MODELS[modelId]
  const cr = await creds()
  process.stdout.write(`  ${C.b}${modelId.padEnd(16)}${C.x} booting… `)
  const sbx = await Sandbox.create(process.env.E2B_TEMPLATE, { timeoutMs: 30 * 60 * 1000,
    metadata: { harnessDemo: '1', role: 'replay', model: modelId } })
  console.log(sbx.sandboxId)
  try {
    // load the task inputs and make a clean git baseline so the diff is just the agent's work
    await sbx.commands.run(`mkdir -p ${WORK}`)
    await sbx.files.write(inputs.map((f) => ({ path: `${WORK}/${f.rel}`, data: f.data })))
    await sbx.commands.run(`cd ${WORK} && git init -q && git add -A && git -c user.email=r@r -c user.name=r commit -qm base`)

    // LiteLLM in front of Bedrock
    const cfg = `model_list:\n  - model_name: "*"\n    litellm_params:\n      model: bedrock/${m.bedrock}\n      aws_region_name: os.environ/AWS_REGION\n      aws_access_key_id: os.environ/AWS_ACCESS_KEY_ID\n      aws_secret_access_key: os.environ/AWS_SECRET_ACCESS_KEY\nlitellm_settings:\n  drop_params: true\ngeneral_settings:\n  master_key: sk-local\n  forward_client_headers_to_llm_api: false\n`
    await sbx.files.write('/home/user/lc.yaml', cfg)
    await sbx.commands.run('litellm --config /home/user/lc.yaml --port 4000 --host 127.0.0.1 > /home/user/ll.log 2>&1', { background: true, timeoutMs: 0, envs: cr })
    const up = await sbx.commands.run(`for i in $(seq 1 90); do curl -sf -o /dev/null http://127.0.0.1:4000/health/liveliness && break; sleep 2; done; curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4000/health/liveliness`, { timeoutMs: 300000, envs: cr })
    if (up.stdout.trim() !== '200') throw new Error('litellm not ready: ' + up.stdout)

    // run the real request
    const envs = { ...cr, ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000', ANTHROPIC_API_KEY: 'sk-local', CI: '1', IS_SANDBOX: '1' }
    const flags = ['-p', '--output-format json', '--dangerously-skip-permissions',
                   '--no-session-persistence', '--disallowed-tools WebSearch WebFetch',
                   `--max-budget-usd ${budget}`, '--model opus'].join(' ')
    const t0 = nowSec()
    await sbx.files.write(`${WORK}/.replay_request`, session.request)
    const run = await sbx.commands.run(`cd ${WORK} && cat .replay_request | claude ${flags} > /home/user/out.json 2> /home/user/err.txt; echo DONE`, { timeoutMs: 25 * 60 * 1000, envs })
    const secs = Math.round(nowSec() - t0)
    let result = null
    try { result = JSON.parse(await sbx.files.read('/home/user/out.json')) } catch {}
    const diff = (await sbx.commands.run(`cd ${WORK} && rm -f .replay_request && git add -A && git diff --cached`).catch(() => ({ stdout: '' }))).stdout

    const u = result?.usage ?? {}
    const inTok = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    const trueCost = (inTok * m.inM + (u.output_tokens ?? 0) * m.outM) / 1e6
    console.log(`  ${C.b}${modelId.padEnd(16)}${C.x} ${result?.is_error ? C.r + 'error' + C.x : C.g + 'ok' + C.x} · ${result?.num_turns ?? 0} turns · ${secs}s · $${trueCost.toFixed(4)} · ${diff.split('\n').length} diff lines`)
    return { modelId, label: m.label, secs, diff, isError: !!result?.is_error,
             turns: result?.num_turns ?? 0, out: u.output_tokens ?? 0, inTok, trueCost,
             errTail: result?.is_error ? short(result?.result, 200) : '' }
  } finally { await sbx.kill().catch(() => {}) }
}

// -------- blind diff judge --------------------------------------------------
function judge(request, original, a, b) {
  // randomise which replay is X
  const flip = Math.random() < 0.5
  const [first, second] = flip ? [b, a] : [a, b]
  const prompt = `Two engineers were each given the same request and the same starting code. Below is the ORIGINAL solution a reference session produced, then two candidate diffs (X and Y). Judge which candidate better accomplishes the request, using the original only as one reference point — a candidate may legitimately differ from it.

REQUEST:
${request}

ORIGINAL SESSION'S DIFF (reference, not necessarily optimal):
${(original || '(none recovered)').slice(0, 6000)}

=== CANDIDATE X ===
${(first.diff || '(no changes made)').slice(0, 6000)}

=== CANDIDATE Y ===
${(second.diff || '(no changes made)').slice(0, 6000)}

Score each 1-10 on: correctness (does it do what was asked), quality (idiomatic, complete, no obvious breakage), and faithfulness (addresses the actual request rather than something adjacent). A candidate that made no changes scores 1s.

Reply ONLY with JSON:
{"X":{"correctness":n,"quality":n,"faithfulness":n},"Y":{"correctness":n,"quality":n,"faithfulness":n},"winner":"X"|"Y"|"tie","why":"<two sentences citing something concrete in each diff>"}`
  try {
    // Judge on Bedrock Converse directly — no dependence on local Anthropic auth.
    const body = JSON.stringify({ messages: [{ role: 'user', content: [{ text: prompt }] }], inferenceConfig: { maxTokens: 700 } })
    const out = execFileSync('aws', ['bedrock-runtime', 'converse', '--region', process.env.AWS_REGION || 'eu-north-1',
      '--model-id', 'eu.anthropic.claude-sonnet-4-6', '--cli-input-json', body, '--output', 'json'],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 180000,
        env: { ...process.env, AWS_DEFAULT_REGION: process.env.AWS_REGION || 'eu-north-1' } })
    const text = JSON.parse(out).output.message.content[0].text
    const v = JSON.parse(/\{[\s\S]*\}/.exec(text)[0])
    const label = { X: first.modelId, Y: second.modelId }
    const scores = { [label.X]: v.X, [label.Y]: v.Y }
    const tot = (s) => Object.values(s ?? {}).reduce((a, x) => a + (+x || 0), 0)
    return { scores, totals: { [a.modelId]: tot(scores[a.modelId]), [b.modelId]: tot(scores[b.modelId]) },
             winner: v.winner === 'tie' ? 'tie' : label[v.winner], why: v.why, presentedFirst: first.modelId }
  } catch (e) { return { error: short(e.stderr ?? e.message, 200) } }
}

// -------- main --------------------------------------------------------------
async function main() {
  const argv = process.argv.slice(2)
  const id = argv.find((a) => !a.startsWith('--'))
  const models = (argv.find((a) => a.startsWith('--models='))?.split('=')[1] ?? 'opus45-bedrock,qwen480-bedrock').split(',')
  const budget = argv.find((a) => a.startsWith('--budget='))?.split('=')[1] ?? '8'
  if (!id) { console.log('usage: node replay-real.mjs <sessionId> [--models a,b] [--budget 8]\n  models: ' + Object.keys(MODELS).join(', ')); return }

  for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) {
    if (!process.env[k] || process.env[k].startsWith('op://')) {
      console.error(`\n${C.r}${k} did not resolve (got ${process.env[k] ? 'an op:// reference' : 'nothing'}).${C.x}`)
      console.error(`Pre-authorise 1Password, then retry:  op read op://Automation/AWS-harness-bedrock/username > /dev/null\n`)
      process.exit(1)
    }
  }
  const session = readSession(id)
  let orig = { diff: reconstructOutput(session.file), basis: 'reconstructed from the transcript\u2019s Write/Edit blocks' }
  if (!orig.diff.trim()) orig = originalDiff(session.cwd, session.edited)
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '').replace(/(\d{8})(\d{6})/, '$1-$2')
  const RUN = `replay-${id.slice(0, 8)}-${stamp}`
  const OUT = path.join(STATE, 'results', RUN)
  fs.mkdirSync(OUT, { recursive: true })

  console.log(`\n${C.bold}replay real session ${id.slice(0, 8)}${C.x}`)
  console.log(`  request: ${short(session.request, 100)}`)
  console.log(`  repo:    ${session.cwd.replace(os.homedir(), '~')} · original touched ${session.edited.length} file(s)`)
  console.log(`  models:  ${models.join(', ')} · budget $${budget}/model · grade: efficiency + blind diff judge\n`)

  // Ship only the task's INPUTS — never the files the original session produced,
  // or we'd hand the replay its own answer. Built in Node: no shell, no git needed.
  const exclude = new Set(session.edited.map((f) => path.basename(f)))
  const inputs = []
  const collect = (dir, rel = '') => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (f.name.startsWith('.') || f.name === '__pycache__' || f.name === 'node_modules' || f.name === 'tests') continue
      const abs = path.join(dir, f.name), r = rel ? rel + '/' + f.name : f.name
      if (exclude.has(f.name)) continue
      if (f.isDirectory()) collect(abs, r)
      else { const st = fs.statSync(abs); if (st.size < 2 * 1024 * 1024) inputs.push({ rel: r, data: fs.readFileSync(abs, 'utf8') }) }
    }
  }
  collect(session.cwd)
  if (!inputs.length) throw new Error('nothing to ship: the session cwd has no task inputs left after excluding its own output')
  console.log(`  ${C.d}shipping ${inputs.length} input file(s): ${inputs.map((f) => f.rel).join(', ')}${C.x}\n`)

  const results = []
  for (const mId of models) {
    if (!MODELS[mId]) { console.log(`  ${C.r}unknown model ${mId}${C.x}`); continue }
    results.push(await replayOn(session, mId, budget, inputs))
  }
  for (const r of results) fs.writeFileSync(path.join(OUT, `${r.modelId}.diff`), r.diff || '(none)')
  fs.writeFileSync(path.join(OUT, 'original.diff'), orig.diff || '(none)')

  let verdict = null
  if (results.length === 2 && results.every((r) => !r.isError)) {
    console.log(`\n  ${C.j}judging the two diffs (blind, order randomised)…${C.x}`)
    verdict = judge(session.request, orig.diff, results[0], results[1])
    if (verdict.error) console.log(`  ${C.r}judge failed: ${verdict.error}${C.x}`)
  }

  const record = { run: RUN, session: id, request: session.request, repo: session.cwd,
    originalDiffBasis: orig.basis, models: results, verdict, generatedAt: new Date().toISOString() }
  fs.writeFileSync(path.join(OUT, 'replay.json'), JSON.stringify(record, null, 2))

  console.log(`\n${C.bold}${'─'.repeat(64)}${C.x}`)
  console.log(`  ${'model'.padEnd(26)}${'cost'.padStart(9)}${'turns'.padStart(7)}${'diff'.padStart(7)}${'quality'.padStart(9)}`)
  for (const r of results) {
    const q = verdict?.totals?.[r.modelId]
    console.log(`  ${r.label.slice(0, 25).padEnd(26)}${('$' + r.trueCost.toFixed(4)).padStart(9)}${String(r.turns).padStart(7)}${String((r.diff.match(/\n/g) || []).length).padStart(7)}${(q != null ? `${q}/30` : '—').padStart(9)}`)
  }
  if (verdict && !verdict.error) {
    console.log(`\n  ${C.bold}diff winner: ${verdict.winner}${C.x}  ${C.d}(presented first: ${verdict.presentedFirst})${C.x}`)
    console.log(`  ${verdict.why}`)
  }
  const spend = results.reduce((a, r) => a + r.trueCost, 0)
  console.log(`\n  ${C.d}total AWS spend: $${spend.toFixed(4)} · results/${RUN}/${C.x}\n`)
}

main().catch((e) => { console.error(`\n${C.r}${e?.message ?? e}${C.x}\n`); process.exit(1) })
