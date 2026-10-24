/**
 * The hub's page: the React app in web/, built by `npm run build:web` into web/dist.
 * Both servers (hub.mjs, hub-demo.mjs) answer /api themselves and hand everything else here.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const WEB_DIST = process.env.HUB_WEB_DIST ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist')

const TYPES = {
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json',
}

const MISSING = `<!doctype html><meta charset="utf-8"><title>Optimization Hub</title>
<body style="font:14px ui-monospace,monospace;padding:32px;line-height:1.6">
<b>The hub page is not built.</b><br>Run <code>npm run build:web</code> in the repo root, then reload.<br>
The API is up: <a href="/api/sessions">/api/sessions</a></body>`

/**
 * Serve a built asset, or the app's index.html for any other GET (the page routes in memory,
 * so every path that is not an API or a report is the page). `head` is spliced into <head>.
 */
export function serveWeb(req, res, pathname, { head = '' } = {}) {
  if (pathname.startsWith('/assets/')) {
    const rel = decodeURIComponent(pathname).replace(/^\//, '')
    const abs = path.normalize(path.join(WEB_DIST, rel))
    if (!abs.startsWith(path.join(WEB_DIST, 'assets') + path.sep) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found')
    }
    // Vite hashes every asset name, so a cached copy can never be stale
    res.writeHead(200, { 'content-type': TYPES[path.extname(abs)] ?? 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable' })
    return res.end(fs.readFileSync(abs))
  }
  let html
  try { html = fs.readFileSync(path.join(WEB_DIST, 'index.html'), 'utf8') } catch { html = MISSING }
  if (head) html = html.replace('<head>', '<head>\n' + head)
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(html)
}
