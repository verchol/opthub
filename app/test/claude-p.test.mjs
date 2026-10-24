// opt claude -p: the profile ladder, the sandbox script, the claims audit against a synthetic run,
// and the models catalog's roles. No Docker, no model calls.
// Run: node test/claude-p.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

let pass = 0, fail = 0
const ok = (name, cond, got) => { if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}${got !== undefined ? `  — got ${JSON.stringify(got)}` : ''}`) } }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-p-test-'))
process.env.OPT_HOME = path.join(tmp, 'home')
const { LEVELS, planFor, recordOutcome, skillDirs, loadProfile } = await import('../lib/claude-profile.mjs')
const { armScript, treeDigest, parseArgs } = await import('../claude-run.mjs')
const { auditClaims, readEvents } = await import('../lib/claims.mjs')
const { AuditLog } = await import('../lib/ult/audit.mjs')
const { startTask } = await import('../lib/task-audit.mjs')
const { rolesFor, anthropicModels } = await import('../lib/models.mjs')
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')

console.log('\nclaude-profile.mjs')
ok('three rungs, cumulative', LEVELS.map((l) => l.id).join() === 'guarded,balanced,aggressive')
ok('guarded: no flags, rules on, router route', planFor('guarded').flags.length === 0 && planFor('guarded').rules.length > 40 && planFor('guarded').router === 'route')
ok('balanced: --effort medium', planFor('balanced').flags.join(' ') === '--effort medium')
ok('aggressive replaces effort, adds subagent model', planFor('aggressive').flags.join(' ') === '--effort low' && planFor('aggressive').env.CLAUDE_CODE_SUBAGENT_MODEL === 'claude-haiku-4-5')
const p = loadProfile('k1')
ok('a new project starts on balanced', p.level === 'balanced')
let m = recordOutcome(p, { level: 'balanced', verdict: 'keep', run: 'r1' })
ok('one keep: no move yet', m.to === 'balanced' && p.streak === 1, m)
m = recordOutcome(p, { level: 'balanced', verdict: 'keep', run: 'r2' })
ok('two keeps in a row: up a rung', m.from === 'balanced' && m.to === 'aggressive' && p.streak === 0, m)
m = recordOutcome(p, { level: 'aggressive', verdict: 'drop', run: 'r3' })
ok('one drop: straight back down', m.to === 'balanced', m)
m = recordOutcome(p, { level: 'balanced', verdict: 'inconclusive', run: 'r4' })
ok('inconclusive moves nothing', m.to === 'balanced' && p.history.length === 4)
m = recordOutcome(loadProfile('k2'), { level: 'guarded', verdict: 'drop' })
ok('cannot go below guarded', m.to === 'guarded')
const proj = path.join(tmp, 'proj'); fs.mkdirSync(path.join(proj, '.opthub', 'skills', 'house-rules'), { recursive: true })
fs.writeFileSync(path.join(proj, '.opthub', 'skills', 'house-rules', 'SKILL.md'), '---\nname: house-rules\n---\n')
const sk = skillDirs(proj).map((d) => path.basename(d))
ok("the project's .opthub/skills are attached; opt's own are not, by default", sk.join() === 'house-rules', sk)
ok("--skill opt-lean attaches opt's own by name", skillDirs(proj, ['opt-lean']).map((d) => path.basename(d)).join() === 'house-rules,opt-lean')

console.log('\nclaude-run.mjs')
const plan = planFor('balanced')
const opt = armScript({ optimized: true, plan, model: 'opus', timeoutSec: 60, extra: [] })
const plain = armScript({ optimized: false, plan, model: 'opus', timeoutSec: 60, extra: [] })
ok('optimized: skills copied in, key hashed, profile flags and rules', opt.includes('~/.claude/skills') && opt.includes('agent-key.sha256') && opt.includes("--effort 'medium'") && opt.includes('--append-system-prompt'))
ok('plain: none of that', !plain.includes('skills') && !plain.includes('agent-key') && !plain.includes('--effort') && !plain.includes('--append-system-prompt'))
ok('both pin the same model and run the same claude -p shape', opt.includes("--model 'opus'") && plain.includes("--model 'opus'") && [opt, plain].every((s) => s.includes('claude -p "$(cat /work/out/task.md)" --output-format stream-json')))
const tree = path.join(tmp, 'tree'); fs.mkdirSync(path.join(tree, 'node_modules'), { recursive: true })
fs.writeFileSync(path.join(tree, 'a.txt'), 'a'); fs.writeFileSync(path.join(tree, 'node_modules', 'x'), 'x')
const d1 = treeDigest(tree); fs.writeFileSync(path.join(tree, 'node_modules', 'x'), 'y')
ok('tree digest ignores node_modules', treeDigest(tree) === d1)
fs.writeFileSync(path.join(tree, 'a.txt'), 'b')
ok('tree digest changes with the source', treeDigest(tree) !== d1)
ok('flags parse: -p, --compare, --repeats, claude args after --', (() => { const f = parseArgs(['-p', 'fix it', '--compare', '--repeats', '3', '--', '--verbose']); return f.prompt === 'fix it' && f.compare && f.repeats === 3 && f.extra[0] === '--verbose' })())
let threw = false; try { parseArgs(['--level', 'reckless']) } catch { threw = true }
ok('an unknown rung is refused', threw)

console.log('\nclaims.mjs')
const DUMMY = 'sk-ant-test-placeholder'
function makeRun({ optModel = 'claude-opus-5-5', baseModel = 'claude-opus-5-5', optOut = 300, baseOut = 900, leak = false, tamper = false, check = ['0', '0'] } = {}) {
  const runDir = fs.mkdtempSync(path.join(tmp, 'run-'))
  const task = startTask('claude-p', { run: path.basename(runDir), task_sha256: sha('Fix the bug in totals.py please, the tests fail.') })
  const text = 'Fix the bug in totals.py please, the tests fail.'
  const usage = (out) => ({ input_tokens: 10, output_tokens: out, cache_read_input_tokens: 20000, cache_creation_input_tokens: 1000 })
  const events = (model, out) => [
    { type: 'system', subtype: 'init', model, skills: ['opt-lean', 'verify'] },
    { type: 'assistant', message: { id: 'm1', model, usage: usage(out), content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'opt-lean' } }] } },
    { type: 'assistant', message: { id: 'm1', model, usage: usage(out), content: [{ type: 'text', text: 'x' }] } },   // same message, second block
    { type: 'assistant', message: { id: 'm2', model, usage: usage(out), content: [] } },
    // the per-message usage above is a first-chunk snapshot; the result carries the real totals
    { type: 'result', is_error: false, num_turns: 2, duration_ms: 20000, total_cost_usd: 0.05, result: 'fixed',
      usage: { cache_creation: { ephemeral_1h_input_tokens: 2000, ephemeral_5m_input_tokens: 0 } },
      modelUsage: { [model]: { inputTokens: 20, outputTokens: out * 2, cacheReadInputTokens: 40000, cacheCreationInputTokens: 2000 } } },
  ].map((e) => JSON.stringify(e)).join('\n')
  for (const [label, model, out, cc] of [['optimized-1', optModel, optOut, check[0]], ['plain-1', baseModel, baseOut, check[1]]]) {
    const d = path.join(runDir, label); fs.mkdirSync(path.join(d, 'check'), { recursive: true })
    fs.writeFileSync(path.join(d, 'task.md'), text)
    fs.writeFileSync(path.join(d, 'events.jsonl'), events(model, out))
    fs.writeFileSync(path.join(d, 'check', 'check_code'), cc)
  }
  fs.writeFileSync(path.join(runDir, 'optimized-1', 'agent-key.sha256'), sha(DUMMY) + '  -\n')
  const log = new AuditLog(path.join(runDir, 'optimized-1', 'router', 'audit.jsonl'))
  const cfg = JSON.parse(fs.readFileSync(new URL('../config/ult.default.json', import.meta.url), 'utf8'))
  for (const id of ['m1', 'm2']) log.append({ kind: 'request', class: 'coding/debug', decision: 'keep', acted: false, target: optModel, usage: usage(optOut),
    cost_usd: (10 * cfg.prices[optModel][0] + 20000 * cfg.prices[optModel][0] * 0.1 + 1000 * cfg.prices[optModel][0] * 1.25 + optOut * cfg.prices[optModel][1]) / 1e6, ...(leak ? { note: text } : {}) })
  if (tamper) { const f = path.join(runDir, 'optimized-1', 'router', 'audit.jsonl'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('"coding/debug"', '"coding/other"')) }
  task.event('run-start', { run: 'optimized-1' }); task.end({})
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ run: path.basename(runDir), task_id: task.id, tree_sha256: 'ab'.repeat(32),
    profile: { level: 'balanced', flags: ['--effort', 'medium'], skills: ['opt-lean'], rules_sha256: 'cd'.repeat(32) },
    check: { name: 'check.py', sha256: 'ef'.repeat(32) }, arms: [{ label: 'optimized-1', side: 'optimized' }, { label: 'plain-1', side: 'baseline' }], verdict: null }))
  return runDir
}
const st = (r, id) => r.claims.find((c) => c.id === id)?.status
const clean = makeRun()
let r = auditClaims(clean, { dummyKey: DUMMY })
ok('a clean, cheaper run: every claim verified, nothing failed', r.summary.failed === 0 && r.summary.notProven === 0 && st(r, 'cheaper') === 'verified' && st(r, 'same-result') === 'verified', r.claims.filter((c) => c.status !== 'verified' && c.status !== 'note').map((c) => c.id))
ok('the same model on both sides is verified from the init event', st(r, 'same-model') === 'verified')
ok('the placeholder key proves the credential stayed with the router', st(r, 'credential') === 'verified')
ok('the attached skill is seen loaded and invoked', st(r, 'profile') === 'verified' && r.claims.find((c) => c.id === 'profile').evidence.join(' ').includes('skills invoked: opt-lean'))
ok('claims.json and claims.md are written beside the run', fs.existsSync(path.join(clean, 'claims.json')) && fs.readFileSync(path.join(clean, 'claims.md'), 'utf8').includes('✓ verified'))
r = auditClaims(makeRun({ optModel: 'claude-opus-5-5', baseModel: 'claude-sonnet-5-5' }), { dummyKey: DUMMY })
ok('different models on the two sides: same-model FAILS', st(r, 'same-model') === 'failed')
r = auditClaims(makeRun({ optOut: 900, baseOut: 300 }), { dummyKey: DUMMY })
ok('a dearer optimized side: the cost claim FAILS', st(r, 'cheaper') === 'failed')
r = auditClaims(makeRun({ check: ['1', '0'] }), { dummyKey: DUMMY })
ok('optimized fails the check the baseline passes: same-result FAILS', st(r, 'same-result') === 'failed')
r = auditClaims(makeRun({ tamper: true }), { dummyKey: DUMMY })
ok('an edited router log: the router claim FAILS', st(r, `router-optimized-1`) === 'failed')
r = auditClaims(makeRun({ leak: true }), { dummyKey: DUMMY })
ok('task text in a log: the trail claim FAILS', st(r, 'trail') === 'failed')
r = auditClaims(makeRun(), { dummyKey: 'some-other-key' })
ok('the agent holding anything but the placeholder: the credential claim FAILS', st(r, 'credential') === 'failed')
const evs = readEvents(path.join(makeRun(), 'plain-1', 'events.jsonl'))
ok('a message repeated per content block is counted once', evs.messages.size === 2)
const { priceResult } = await import('../lib/claims.mjs')
const cfgP = JSON.parse(fs.readFileSync(new URL('../config/ult.default.json', import.meta.url), 'utf8'))
const [pi, po] = cfgP.prices['claude-opus-5-5']
ok('cost comes from the result totals (1h writes at 2x), not the first-chunk message usage',
  Math.abs(priceResult({ usage: { cache_creation: { ephemeral_1h_input_tokens: 10 } }, modelUsage: { 'claude-opus-5-5': { inputTokens: 100, outputTokens: 1000, cacheReadInputTokens: 10000, cacheCreationInputTokens: 1000 } } }, cfgP)
    - (100 * pi + 1000 * po + 10000 * pi * 0.1 + 1000 * pi * 2) / 1e6) < 1e-12)

console.log('\nmodels.mjs')
ok('a small model is offered for background calls', rolesFor({ id: 'qwen2.5-coder:1.5b', paramsB: 1.5, capabilities: ['completion', 'tools'] }).join() === 'background / utility calls,coding (small edits),can take tool calls')
ok('an embedding model is embeddings only', rolesFor({ id: 'nomic-embed-text', paramsB: 0.137, capabilities: ['embedding'] }).join() === 'embeddings only')
ok("the router's remote target is marked", anthropicModels().find((x) => x.id === 'claude-haiku-4-5').roles.length === 1)

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
