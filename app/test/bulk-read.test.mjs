// bulk-read: the gate's decisions, the worker in both modes against fakes, the arm wiring in both
// runners, and the catalog entry. No Docker, no model calls; the only network is a mock on 127.0.0.1.
// Run: node app/test/bulk-read.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawnSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

let pass = 0, fail = 0
const ok = (name, cond, got) => { if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}${got !== undefined ? `  — got ${JSON.stringify(got)}` : ''}`) } }
const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.join(HERE, '..')
const GATE = path.join(APP, 'hooks', 'bulk-read', 'gate.mjs')
const WORKER = path.join(APP, 'hooks', 'bulk-read', 'bulk-read.mjs')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-read-test-'))
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1} of the file`).join('\n') + '\n'
const big = path.join(tmp, 'big.py'); fs.writeFileSync(big, lines(400))
const small = path.join(tmp, 'small.py'); fs.writeFileSync(small, lines(40))
const other = path.join(tmp, 'other.py'); fs.writeFileSync(other, lines(500))
const pdf = path.join(tmp, 'doc.pdf'); fs.writeFileSync(pdf, lines(900))
const bin = path.join(tmp, 'blob.dat'); fs.writeFileSync(bin, Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2]), Buffer.from(lines(900))]))
const transcript = path.join(tmp, 'session.jsonl')
fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [
  { type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: other, old_string: 'a', new_string: 'b' } }] } }) + '\n')

const { decide, countLines, shellReadTargets } = await import('../hooks/bulk-read/gate.mjs')
const cfg = { threshold: 350, maxBlocks: 1, cmd: 'bulk-read', log: path.join(tmp, 'unused.jsonl'), state: path.join(tmp, 'unused.json') }
const empty = { sessions: {}, failed: [] }
const read = (file_path, extra = {}) => ({ tool_name: 'Read', session_id: 's1', cwd: tmp, transcript_path: transcript, tool_input: { file_path, ...extra } })
const bash = (command) => ({ tool_name: 'Bash', session_id: 's1', cwd: tmp, transcript_path: transcript, tool_input: { command } })

console.log('\ngate.mjs — decisions')
ok('counts lines, with or without a final newline', countLines(big) === 400 && (fs.writeFileSync(path.join(tmp, 'nofinal.txt'), 'a\nb'), countLines(path.join(tmp, 'nofinal.txt')) === 2))
ok('binaries, PDFs and missing files are not judged', countLines(bin) === null && countLines(pdf) === null && countLines(path.join(tmp, 'nope')) === null)
let d = decide(read(big), cfg, empty)
ok('a whole read of a 400-line file is blocked', d.action === 'block' && d.files[0].lines === 400, d)
ok('the block names the file, the threshold and the worker command', d.message.includes('big.py (400 lines)') && d.message.includes('over 350') && d.message.includes('bulk-read --question'))
ok('the block offers the targeted-read way out', d.message.includes('offset and limit'))
ok('a small file passes', decide(read(small), cfg, empty).reason === 'small')
ok('a targeted read passes', decide(read(big, { offset: 100, limit: 40 }), cfg, empty).reason === 'targeted')
ok('a limit alone counts as targeted', decide(read(big, { limit: 40 }), cfg, empty).reason === 'targeted')
ok('a PDF passes', decide(read(pdf), cfg, empty).action === 'allow')
ok('a file this session edited passes', decide(read(other), cfg, empty).reason === 'edited in this session')
ok('the second whole read of a blocked file passes as an override',
  decide(read(big), cfg, { sessions: { s1: { blocked: { [big]: 1 } } }, failed: [] }).reason.startsWith('override'))
ok('the override is per session', decide(read(big), cfg, { sessions: { s2: { blocked: { [big]: 1 } } }, failed: [] }).action === 'block')
ok('a file the worker failed on passes', decide(read(big), cfg, { sessions: {}, failed: [big] }).reason === 'worker failed on this file')
ok('maxBlocks 0 never blocks twice… or at all', decide(read(big), { ...cfg, maxBlocks: 0 }, empty).action === 'allow')
ok('cat of a large file is blocked', decide(bash('cat big.py'), cfg, empty).action === 'block')
ok('cat with a flag is still a whole read', decide(bash('cat -n big.py'), cfg, empty).action === 'block')
ok('a piped cat passes', decide(bash('cat big.py | grep line'), cfg, empty).action === 'allow')
ok('head and tail pass (they are already targeted)', decide(bash('head -n 20 big.py'), cfg, empty).action === 'allow' && decide(bash('tail big.py'), cfg, empty).action === 'allow')
ok('shell targets resolve against cwd', shellReadTargets('cat a/b.py', '/w')[0] === '/w/a/b.py')
ok('other tools pass', decide({ tool_name: 'Grep', tool_input: { pattern: 'x' } }, cfg, empty).action === 'allow')

console.log('\ngate.mjs — as a hook process')
const env = { ...process.env, BULK_READ_LOG: path.join(tmp, 'hook.jsonl'), BULK_READ_STATE: path.join(tmp, 'hook-state.json'), BULK_READ_THRESHOLD: '350' }
const hook = (input) => spawnSync(process.execPath, [GATE], { input: JSON.stringify(input), env, encoding: 'utf8' })
let h = hook(read(big))
ok('blocks with exit 2 and the message on stderr', h.status === 2 && h.stderr.includes('opthub bulk-read'), h.status)
h = hook(read(big))
ok('the same read again passes with exit 0', h.status === 0, h.status)
ok('a small read exits 0 silently', hook(read(small)).status === 0)
ok('bad input never blocks', spawnSync(process.execPath, [GATE], { input: 'not json', env, encoding: 'utf8' }).status === 0)
const hlog = fs.readFileSync(env.BULK_READ_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
ok('the log has the block and the override, not the small read', hlog.length === 2 && hlog[0].action === 'block' && hlog[1].reason.startsWith('override'), hlog.map((x) => x.reason))

console.log('\nbulk-read.mjs — api mode, against a mock Messages API')
let seen = null, status = 200
const server = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    seen = { url: req.url, headers: req.headers, body: JSON.parse(b || '{}') }
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(status === 200 ? JSON.stringify({ content: [{ type: 'text', text: `- ${big}:3 — line 3 is the answer` }],
                                               usage: { input_tokens: 1000, output_tokens: 200 } })
                           : JSON.stringify({ error: { message: 'upstream down' } }))
  })
}).listen(0, '127.0.0.1')
await new Promise((r) => server.on('listening', r))
const base = `http://127.0.0.1:${server.address().port}`
const wenv = { ...process.env, BULK_READ_VIA: 'api', BULK_READ_MODEL: 'route-reader', ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: 'sk-local',
               BULK_READ_PRICE_IN: '1', BULK_READ_PRICE_OUT: '5', BULK_READ_LOG: path.join(tmp, 'worker.jsonl'), BULK_READ_STATE: path.join(tmp, 'worker-state.json') }
const work = (args, e = wenv) => new Promise((resolve) => {
  const c = spawn(process.execPath, [WORKER, ...args], { env: e }); let out = '', err = ''
  c.stdout.on('data', (x) => (out += x)); c.stderr.on('data', (x) => (err += x)); c.on('close', (code) => resolve({ code, out, err }))
})
let w = await work(['--question', 'what is on line 3?', big])
ok('answers on stdout with exit 0', w.code === 0 && w.out.includes('line 3 is the answer'), w)
ok('the footer says who answered and how to get exact text', w.out.includes('answered by route-reader') && w.out.includes('offset and limit'))
ok('sends the route alias as the model, with the key', seen.body.model === 'route-reader' && seen.headers['x-api-key'] === 'sk-local' && seen.url === '/v1/messages')
ok('the worker sees numbered lines and the question', seen.body.messages[0].content.includes('3\tline 3 of the file') && seen.body.messages[0].content.endsWith('Question: what is on line 3?'))
ok('the system prompt asks for cited bullets', /path:line/.test(seen.body.system))
let wlog = fs.readFileSync(wenv.BULK_READ_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
ok('logs usage and the priced cost (1000 in at $1, 200 out at $5)', wlog[0].ok && wlog[0].input_tokens === 1000 && Math.abs(wlog[0].cost_usd - 0.002) < 1e-9, wlog[0])
status = 500
w = await work(['--question', 'q', big])
ok('a failed call exits 1 and says to read in ranges', w.code === 1 && w.err.includes('Read the file in ranges'), w)
const st = JSON.parse(fs.readFileSync(wenv.BULK_READ_STATE, 'utf8'))
ok('…and records the file, so the gate lets the next whole read through', st.failed.includes(big) && decide(read(big), cfg, st).reason === 'worker failed on this file')
ok('usage without a question exits 2', (await work([big])).code === 2)
ok('a missing file exits 2', (await work(['-q', 'x', path.join(tmp, 'nope.py')])).code === 2)
server.close()

console.log('\nbulk-read.mjs — claude mode, against a fake claude')
const fake = path.join(tmp, 'fake-claude.sh')
fs.writeFileSync(fake, `#!/bin/sh\necho "$@" > "${tmp}/fake-args.txt"\ncat > "${tmp}/fake-stdin.txt"\necho '{"result":"- big.py:7 seven","total_cost_usd":0.0012,"usage":{"input_tokens":900,"output_tokens":50}}'\n`)
fs.chmodSync(fake, 0o755)
const cenv = { ...process.env, BULK_READ_VIA: 'claude', BULK_READ_CLAUDE: fake, BULK_READ_MODEL: 'claude-haiku-4-5', BULK_READ_LOG: path.join(tmp, 'claude.jsonl'), BULK_READ_STATE: path.join(tmp, 'claude-state.json') }
w = await work(['--question', 'what is on line 7?', big], cenv)
const args = fs.readFileSync(path.join(tmp, 'fake-args.txt'), 'utf8')
ok('answers through claude -p', w.code === 0 && w.out.includes('big.py:7 seven'), w)
ok('one turn, the worker model, no tools, nothing persisted', /-p --model claude-haiku-4-5 --output-format json --max-turns 1 --no-session-persistence --disallowed-tools Bash Read/.test(args), args)
ok('the prompt goes on stdin, not argv', fs.readFileSync(path.join(tmp, 'fake-stdin.txt'), 'utf8').includes('7\tline 7 of the file') && !args.includes('line 7'))
wlog = fs.readFileSync(cenv.BULK_READ_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
ok('takes the cost Claude Code reports', wlog[0].cost_usd === 0.0012 && wlog[0].via === 'claude')

console.log('\narm-config.mjs')
const { claudeSettings, claudeSettingsObject, bulkReadEnv, bulkReadSummary, bulkReadFiles, describeClaude, WORKER_PRICES } = await import('../lib/arm-config.mjs')
const br = { thresholdLines: 350, worker: 'route-reader', localWorker: 'claude-haiku-4-5' }
let s = claudeSettingsObject({ bulkRead: br })
ok('bulkRead alone writes a settings.json with the PreToolUse hook', s.hooks.PreToolUse[0].matcher === 'Read|Bash' && s.hooks.PreToolUse[0].hooks[0].command.includes('$HOME/.opthub/hooks/bulk-read/gate.mjs'))
s = claudeSettingsObject({ bulkRead: br, settings: { model: 'x', hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [] }], Stop: [] } } })
ok('…and keeps the arm’s own settings and hooks', s.model === 'x' && s.hooks.PreToolUse.length === 2 && Array.isArray(s.hooks.Stop))
ok('an arm without bulkRead or settings writes none', claudeSettings({}) === null && claudeSettings({ maxTurns: 3 }) === null)
const e = bulkReadEnv(br, { via: 'api', model: 'route-reader', prices: [0.07, 0.28], log: '/l', state: '/s' })
ok('env carries threshold, mode, model, prices, log and state', e.BULK_READ_THRESHOLD === '350' && e.BULK_READ_VIA === 'api' && e.BULK_READ_MODEL === 'route-reader' && e.BULK_READ_PRICE_IN === '0.07' && e.BULK_READ_LOG === '/l' && e.BULK_READ_STATE === '/s')
ok('the local worker is priced from the rate card', WORKER_PRICES['claude-haiku-4-5'][0] === 1 && WORKER_PRICES['claude-haiku-4-5'][1] === 5)
ok('ships both scripts', bulkReadFiles().map((f) => f.name).join() === 'gate.mjs,bulk-read.mjs')
const sum = bulkReadSummary([
  JSON.stringify({ kind: 'gate', action: 'block', reason: 'large whole-file read' }),
  JSON.stringify({ kind: 'gate', action: 'allow', reason: 'override: read again after a block' }),
  JSON.stringify({ kind: 'gate', action: 'allow', reason: 'edited in this session' }),
  JSON.stringify({ kind: 'worker', ok: true, cost_usd: 0.002, ms: 1200 }),
  JSON.stringify({ kind: 'worker', ok: true, cost_usd: null, ms: 900 }),
  JSON.stringify({ kind: 'worker', ok: false, ms: 30000 }), 'garbage'].join('\n'))
ok('the run summary adds worker spend and counts the gate', sum.delegations === 2 && sum.failures === 1 && Math.abs(sum.workerUsd - 0.002) < 1e-12 && sum.unpriced === 1
  && sum.blocks === 1 && sum.overrides === 1 && sum.allowedEdited === 1 && sum.workerMs === 32100, sum)
ok('the arm description names the lever', describeClaude({ bulkRead: br }).includes('over 350 lines go to route-reader'))

console.log('\nlocal-run.mjs and the catalog')
const { loadCatalog, resolveArm } = await import('../lib/optimizations.mjs')
const { localPlan, containerScript, homeSetup, mergePlans } = await import('../lib/local-run.mjs')
const entry = loadCatalog(APP, { fresh: true }).experiments.find((x) => x.id === 'bulk-read-delegation')
ok('the catalog has the entry, runnable, in context-lifecycle', !!entry && entry.runnable !== false && entry.family === 'context-lifecycle')
ok('its E2B worker is a route alias the arm defines', entry.arm.litellm.routes[entry.arm.claude.bulkRead.worker] === 'qwen30')
ok('resolveArm carries bulkRead to the cell', resolveArm(entry, { modelTier: 'opus' }, () => 'opus45').claude.bulkRead.thresholdLines === 350)
const plan = localPlan(entry)
ok('the local sandbox can run it', !plan.error && plan.env.BULK_READ_VIA === 'claude' && plan.env.BULK_READ_MODEL === 'claude-haiku-4-5' && plan.env.BULK_READ_LOG === '/work/out/bulk-read.jsonl', plan.error)
ok('…bringing the two scripts and the hook', plan.files.length === 2 && plan.settings.hooks.PreToolUse.length === 1)
// the container script must recreate the scripts byte for byte: run its $HOME setup under a scratch HOME
const full = containerScript(plan, { timeoutSec: 60 })
ok('the container script runs the home setup', homeSetup(plan).every((c) => full.includes(c)))
const home = path.join(tmp, 'home')
const sh = spawnSync('bash', ['-lc', homeSetup(plan).join('\n')], { env: { ...process.env, HOME: home }, encoding: 'utf8' })
ok('the container script writes the scripts byte for byte', sh.status === 0
  && fs.readFileSync(path.join(home, '.opthub/hooks/bulk-read/gate.mjs'), 'utf8') === fs.readFileSync(GATE, 'utf8')
  && fs.readFileSync(path.join(home, '.opthub/hooks/bulk-read/bulk-read.mjs'), 'utf8') === fs.readFileSync(WORKER, 'utf8'), sh.stderr)
ok('…and the settings.json with the hook', JSON.parse(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8')).hooks.PreToolUse[0].matcher === 'Read|Bash')
const merged = mergePlans([plan, { flags: [], env: {}, notes: [], settings: { hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [] }] } } }])
ok('stacking with another lever keeps both hooks and the files', merged.settings.hooks.PreToolUse.length === 2 && merged.files.length === 2)

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
