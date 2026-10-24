// tools/demo-startup.mjs: the synthetic company builds, stays inside its own folder, and its
// audited runs verify. The build runs the way opt hub demo runs it: a child process.
// Run: node test/demo-startup.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

let pass = 0, fail = 0
const ok = (name, cond, got) => { if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}${got !== undefined ? `  — got ${JSON.stringify(got)}` : ''}`) } }
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-startup-test-'))
const out = path.join(tmp, 'tallyfox')
const realTrail = path.join(ROOT, 'audit', 'tasks.jsonl')
const digest = (f) => (fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : null)
const before = digest(realTrail)
const env = { ...process.env, OPT_HOME: path.join(out, 'home'), OPT_PROJECTS_DIR: path.join(out, 'projects'), OPT_DEMO_NOW: '2026-10-20T12:00:00Z' }

console.log('\ndemo-startup.mjs')
const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'demo-startup.mjs'), out], { env, encoding: 'utf8' })
ok('builds', r.status === 0, r.stderr.slice(-300))
ok('marked synthetic', fs.readFileSync(path.join(out, 'SYNTHETIC.md'), 'utf8').includes('fictional'))
ok("your real task trail is untouched", digest(realTrail) === before)
ok('its own trail, hash-chained', (() => {
  const v = spawnSync(process.execPath, ['-e', `import('${path.join(ROOT, 'lib', 'task-audit.mjs')}').then(m=>console.log(JSON.stringify(m.verifyAudit(m.AUDIT_FILE))))`], { env, encoding: 'utf8' })
  const j = JSON.parse(v.stdout); return j.ok && j.entries > 20
})())
const q = spawnSync(process.execPath, ['-e', `Promise.all([import('${path.join(ROOT, 'lib', 'claims.mjs')}'), import('${path.join(ROOT, 'lib', 'local-run.mjs')}'), import('${path.join(ROOT, 'lib', 'sessions-index.mjs')}')]).then(([c, l, s]) => console.log(JSON.stringify({ runs: c.listClaudeRuns(l.outRoot(), 20), sessions: s.buildIndex({ limit: 1000 }).sessions.length })))`], { env, encoding: 'utf8' })
const { runs, sessions } = JSON.parse(q.stdout)
ok('hundreds of sessions, read by the hub’s own reader', sessions > 250, sessions)
ok('six opt claude -p comparisons', runs.length === 6, runs.length)
ok('every kept run verifies every claim', runs.filter((x) => x.verdict.verdict === 'keep').every((x) => x.claims.failed === 0), runs.map((x) => [x.verdict.verdict, x.claims.failed]))
ok('the dropped run fails exactly its check claim', runs.filter((x) => x.verdict.verdict === 'drop').every((x) => x.failed.map((f) => f.id).join() === 'same-result'))
const sv = spawnSync(process.execPath, ['-e', `Promise.all([import('${path.join(ROOT, 'lib', 'overview.mjs')}'), import('${path.join(ROOT, 'lib', 'claims.mjs')}'), import('${path.join(ROOT, 'lib', 'local-run.mjs')}'), import('${path.join(ROOT, 'lib', 'watch.mjs')}')]).then(([o, c, l, w]) => console.log(JSON.stringify(o.savedByMonth({ sessions: w.watchList({ limit: 1000 }).sessions, runs: c.listClaudeRuns(l.outRoot(), 200), ledger: o.readLedger() }))))`], { env, encoding: 'utf8' })
const saved = JSON.parse(sv.stdout || '{}')
ok('optimize mode saved money in September and October, and only then', saved.by?.['2026-09']?.estimated > 20 && saved.by?.['2026-10']?.estimated > saved.by['2026-09'].estimated && Object.keys(saved.by).every((m) => m >= '2026-09'), saved.by)
ok('the project whose comparison was dropped counts nothing', saved.rates?.extractor?.rate === 0, saved.rates?.extractor)
ok('Triage classified sessions, with savings', (() => { const t = JSON.parse(fs.readFileSync(path.join(out, 'home', 'results', 'triage.json'), 'utf8')); return t.synthetic && t.sessions.length > 50 && t.sessions.every((s) => s.expected <= s.best + 1e-9) })())
const again = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'demo-startup.mjs'), path.join(tmp, 'nope')], { env: { ...env }, encoding: 'utf8' })
fs.mkdirSync(path.join(tmp, 'mine')); fs.writeFileSync(path.join(tmp, 'mine', 'precious.txt'), 'x')
const refuse = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'demo-startup.mjs'), path.join(tmp, 'mine')], { env, encoding: 'utf8' })
ok('refuses to replace a folder it did not make', refuse.status !== 0 && fs.existsSync(path.join(tmp, 'mine', 'precious.txt')))
ok('a fresh folder builds', again.status === 0)

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
