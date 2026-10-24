// Hub → Triage → Graph: the two graph routes, against a fixture opthub checkout. No real transcripts.
// Run: node test/hub-graph.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

let pass = 0, fail = 0
const ok = (name, cond, got) => { if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}${got !== undefined ? `  — got ${JSON.stringify(got)}` : ''}`) } }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-graph-test-'))

const EXPORTED = 'aaaaaaaa-1111-4222-8333-944455556666'   // export_hub.py wrote its graph
const REBUILT = 'bbbbbbbb-1111-4222-8333-944455556666'    // graph null: rebuilt from the "transcript"
const EXPIRED = 'cccccccc-1111-4222-8333-944455556666'    // graph null, no transcript
// a file name that would end the script block if injected raw
const graph = (sid) => ({ session: sid, tasks: [{ id: 't1' }], nodes: [{ id: 'f1', kind: 'file', label: 'x</script><b>pwn.md' }], edges: [] })

// fixture opthub checkout: the page template and a stand-in sessiongraph.py
const opthub = path.join(tmp, 'opthub')
fs.mkdirSync(path.join(opthub, 'docs/preview/session-graph'), { recursive: true })
fs.mkdirSync(path.join(opthub, 'tools'), { recursive: true })
fs.writeFileSync(path.join(opthub, 'docs/preview/session-graph/triage-graph.template.html'),
  '<!doctype html><title>g</title><div class="side"></div><script>\nconst G=/*GRAPH*/null;\ndocument.title=G.session\n</script>\n')
fs.writeFileSync(path.join(opthub, 'tools/sessiongraph.py'), `import json, sys
sid, out = sys.argv[1], sys.argv[sys.argv.index('-o') + 1]
if '--keep-text' in sys.argv: sys.exit('never --keep-text')
if sid != '${REBUILT}': sys.exit('no transcript matches ' + sid)
json.dump(${JSON.stringify(graph(REBUILT))}, open(out, 'w'))
`)
// fixture hub state: triage.json and one exported graph
const results = path.join(tmp, 'state', 'results')
fs.mkdirSync(path.join(results, 'graphs'), { recursive: true })
fs.writeFileSync(path.join(results, 'graphs', `${EXPORTED}.json`), JSON.stringify(graph(EXPORTED)))
fs.writeFileSync(path.join(results, 'triage.json'), JSON.stringify({ sessions: [
  { key: 'a', session: EXPORTED, graph: `graphs/${EXPORTED}.json` },
  { key: 'b', session: REBUILT, graph: null },
  { key: 'c', session: EXPIRED, graph: null },
  { key: 'd', session: 'dddddddd-1111-4222-8333-944455556666', graph: '../../escape.json' },
] }))

const port = 20000 + Math.floor(Math.random() * 20000)
const hub = spawn(process.execPath, [fileURLToPath(new URL('../hub.mjs', import.meta.url)), 'start', '--no-open'],
  { env: { ...process.env, OPT_HOME: path.join(tmp, 'state'), OPTHUB_DIR: opthub, HUB_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] })
const base = await new Promise((resolve, reject) => {
  let out = ''
  const t = setTimeout(() => reject(new Error('hub did not start: ' + out)), 15000)
  hub.stdout.on('data', (d) => { out += d; const m = /(http:\/\/127\.0\.0\.1:\d+)\//.exec(out); if (m) { clearTimeout(t); resolve(m[1]) } })
  hub.on('exit', (c) => reject(new Error(`hub exited ${c}: ${out}`)))
})
// raw request: fetch() would normalise a "../" path away before it reached the hub
const get = (p) => new Promise((resolve, reject) => http.get(base + p, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => resolve({ status: r.statusCode, type: r.headers['content-type'], body: b })) }).on('error', reject))

try {
  console.log('GET /api/triage/:sid/graph')
  {
    const r = await get(`/api/triage/${EXPORTED}/graph`)
    ok('exported graph → 200 JSON', r.status === 200 && /json/.test(r.type) && JSON.parse(r.body).session === EXPORTED, r.status)
    const p = await get(`/api/triage/${EXPORTED.slice(0, 8)}/graph`)
    ok('an 8-char prefix finds the session', p.status === 200 && JSON.parse(p.body).session === EXPORTED, p.status)
    const b = await get(`/api/triage/${REBUILT}/graph`)
    ok('null graph → rebuilt by sessiongraph.py', b.status === 200 && JSON.parse(b.body).session === REBUILT, b)
    ok('the rebuilt graph is cached under results/graphs/', fs.existsSync(path.join(results, 'graphs', `${REBUILT}.json`)))
    const e = await get(`/api/triage/${EXPIRED}/graph`)
    ok('no transcript → 404 with the reason', e.status === 404 && /no transcript for this session/.test(JSON.parse(e.body).error), e)
    const u = await get('/api/triage/eeeeeeee-0000-4000-8000-000000000000/graph')
    ok('unknown id → 404', u.status === 404, u.status)
    const x = await get('/api/triage/dddddddd-1111-4222-8333-944455556666/graph')
    ok('a graph path outside results/ is not read', x.status === 404, x.status)
    for (const bad of ['/api/triage/aaaaaaaa..%2F/graph', '/api/triage/..%2F..%2Fetc/graph', '/api/triage/abc/graph', '/api/triage/ABCDEF12-x/graph'])
      ok(`bad id ${bad} → 400`, (await get(bad)).status === 400)
  }
  console.log('GET /triage/:sid/graph')
  {
    for (const sid of [EXPORTED, REBUILT]) {
      const r = await get(`/triage/${sid}/graph`)
      ok(`${sid.slice(0, 8)} → 200 html`, r.status === 200 && /^text\/html; charset=utf-8/.test(r.type), r.status)
      ok('placeholder replaced', !r.body.includes('/*GRAPH*/null'))
      ok('one <script> block: the file name cannot close it', (r.body.match(/<script\b/g) || []).length === 1 && (r.body.match(/<\/script>/g) || []).length === 1)
      const js = /<script>([\s\S]*)<\/script>/.exec(r.body)[1]
      const G = new Function('document', js.replace('const G=', 'return ').split('\n').find((l) => l.startsWith('return ')))({})
      ok('the injected graph parses back intact', G.session === sid && G.nodes[0].label === 'x</script><b>pwn.md', G)
      ok('no absolute paths', !/\/Users\/|\/home\//.test(r.body))
    }
    const e = await get(`/triage/${EXPIRED}/graph`)
    ok('no transcript → 404 page with a link back', e.status === 404 && /html/.test(e.type) && /no transcript for this session/.test(e.body) && /href="\/"/.test(e.body), e)
    ok('bad id → 400 page', (await get('/triage/..%2Fx/graph')).status === 400)
  }
  console.log('GET /api/triage')
  {
    const t = JSON.parse((await get('/api/triage')).body)
    ok('reports the graph template as available', t.graph && t.graph.available === true, t.graph)
  }
} finally {
  hub.kill()
  fs.rmSync(tmp, { recursive: true, force: true })
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
