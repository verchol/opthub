#!/usr/bin/env node
/**
 * Optimization Hub — read-only deploy.
 *
 * Same page, same URLs, no transcripts and no credentials. Every GET the hub
 * answers by reading ~/.claude is answered here from deploy/snapshot/, written
 * by tools/hub-snapshot.mjs. Every POST that would spend money is refused.
 *
 *   HUB_PASSWORD=... node hub-demo.mjs        # 8080, basic auth
 *
 * Unset HUB_PASSWORD and it serves openly, which is fine on localhost and is
 * why the deploy sets it as a Fly secret.
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { serveWeb } from './lib/web-dist.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
// In the repo the snapshot sits under deploy/; in the image it is copied next
// to the server. Try both rather than making the caller know which layout it is.
const SNAP = process.env.HUB_SNAPSHOT
  ?? [path.join(ROOT, 'deploy', 'snapshot'), path.join(ROOT, 'snapshot')]
       .find((d) => fs.existsSync(path.join(d, 'sessions.json')))
  ?? path.join(ROOT, 'deploy', 'snapshot')
const PORT = Number(process.env.PORT ?? 8080)
const USER = process.env.HUB_USER ?? 'demo'
const PASS = process.env.HUB_PASSWORD ?? ''

// window.HUB_DEMO has to be set before the page's own script evaluates, so it
// goes first in the head rather than appended to the document.
const DEMO_HEAD = '<script>window.HUB_DEMO=1</script>'

const send = (res, code, ct, body, extra = {}) => {
  res.writeHead(code, { 'content-type': ct, 'cache-control': 'no-store', ...extra })
  res.end(body)
}
const json = (res, obj) => send(res, 200, 'application/json', JSON.stringify(obj))
const file = (res, abs, ct) => {
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return send(res, 404, 'text/plain', 'not found')
  send(res, 200, ct, fs.readFileSync(abs))
}
const snap = (res, rel, fallback) => {
  const abs = path.join(SNAP, rel)
  if (!fs.existsSync(abs)) return fallback === undefined ? send(res, 404, 'text/plain', 'not in snapshot') : json(res, fallback)
  send(res, 200, 'application/json', fs.readFileSync(abs))
}

const authed = (req) => {
  if (!PASS) return true
  const h = req.headers.authorization ?? ''
  if (!h.startsWith('Basic ')) return false
  const [u, p] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':')
  return u === USER && p === PASS
}

const server = http.createServer((req, res) => {
  const U = new URL(req.url, 'http://x')
  const p = U.pathname

  // Ahead of the password gate on purpose: Fly polls this, and a 401 would read
  // as a failing machine.
  if (p === '/healthz') return send(res, 200, 'text/plain', 'ok')

  if (!authed(req))
    return send(res, 401, 'text/plain', 'Optimization Hub — password required\n',
      { 'www-authenticate': 'Basic realm="Optimization Hub", charset="UTF-8"' })

  // Anything that would boot a sandbox. Refused with a readable reason, because
  // the UI shows the message and "failed to fetch" would look like a bug.
  if (req.method === 'POST' || p === '/api/optimize/stop')
    return send(res, 403, 'application/json',
      JSON.stringify({ error: 'read-only deploy', detail: 'This hub serves a frozen snapshot. Runs boot cloud sandboxes and cost money, so they are disabled here.' }))

  if (p.startsWith('/api/sessions')) return snap(res, 'sessions.json')
  if (p === '/api/session') {
    const id = U.searchParams.get('id') ?? ''
    if (!/^[0-9a-f-]{6,}$/i.test(id)) return send(res, 400, 'text/plain', 'bad session id')
    return snap(res, path.join('session', `${id}.json`))
  }
  if (p === '/api/catalog') return snap(res, 'catalog.json')
  if (p === '/api/overview') return snap(res, 'overview.json')
  if (p === '/api/models') return snap(res, 'models.json')
  if (p === '/api/runs') return snap(res, 'runs.json')
  if (p === '/api/optimize/all') return snap(res, 'optimize-all.json', {})
  if (p === '/api/optimize/status') return json(res, { phase: null })
  if (p === '/api/optimize/log') return send(res, 200, 'text/plain', '(no logs on a read-only deploy)')
  if (p === '/optlog') return send(res, 200, 'text/html; charset=utf-8',
    '<!doctype html><meta charset=utf-8><title>log</title><body style="font:13px ui-monospace,monospace;padding:24px">'
    + 'Run logs are not part of this snapshot — it is a read-only deploy.')

  // reports live in the snapshot; docs and config ship with the source
  if (/^\/(results|docs|config)\//.test(p)) {
    const rel = decodeURIComponent(p).replace(/^\//, '')
    if (rel.split('/').some((s) => s === '..')) return send(res, 404, 'text/plain', 'not found')
    const base = rel.startsWith('results/') ? SNAP : ROOT
    const abs = path.normalize(path.join(base, rel))
    const roots = ['results', 'docs', 'config'].map((d) => path.join(base, d) + path.sep)
    if (!roots.some((r) => abs.startsWith(r))) return send(res, 403, 'text/plain', 'forbidden')
    const ct = { '.html': 'text/html; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json',
                 '.yaml': 'text/plain; charset=utf-8', '.yml': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
                 '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml' }[path.extname(abs).toLowerCase()] ?? 'application/octet-stream'
    return file(res, abs, ct)
  }

  // not in the snapshot (Behaviour reads live traces): a JSON 404 the page can show, never the page itself
  if (p.startsWith('/api/')) return send(res, 404, 'application/json', JSON.stringify({ error: 'not in this read-only snapshot', path: p }))

  serveWeb(req, res, p, { head: DEMO_HEAD })
})

server.listen(PORT, '0.0.0.0', () => {
  const n = fs.existsSync(path.join(SNAP, 'sessions.json'))
    ? JSON.parse(fs.readFileSync(path.join(SNAP, 'sessions.json'), 'utf8')).sessions.length : 0
  console.log(`Optimization Hub (read-only) → :${PORT} · ${n} sessions · auth ${PASS ? 'on' : 'OFF'}`)
})
