/** Minimal markdown → HTML. No dependencies: artifacts must stay readable offline. */
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
}

export function mdToHtml(md) {
  const out = []
  const lines = md.split('\n')
  let i = 0, list = null
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null } }

  while (i < lines.length) {
    const l = lines[i]

    if (/^```/.test(l)) {                                   // fenced code
      closeList()
      const lang = l.slice(3).trim()
      const buf = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++])
      i++
      out.push(`<pre${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${esc(buf.join('\n'))}</code></pre>`)
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|[-: |]+\|\s*$/.test(lines[i + 1] ?? '')) {   // table
      closeList()
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
      const head = cells(l); i += 2
      const body = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) body.push(cells(lines[i++]))
      out.push(`<table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>` +
        body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('') + `</tbody></table>`)
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(l)
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue }
    if (/^\s*([-*+]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l)
      const want = ordered ? 'ol' : 'ul'
      if (list !== want) { closeList(); out.push(`<${want}>`); list = want }
      out.push(`<li>${inline(l.replace(/^\s*([-*+]|\d+\.)\s+/, ''))}</li>`); i++; continue
    }
    if (/^\s*>/.test(l)) { closeList(); out.push(`<blockquote>${inline(l.replace(/^\s*>\s?/, ''))}</blockquote>`); i++; continue }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(l)) { closeList(); out.push('<hr>'); i++; continue }
    if (!l.trim()) { closeList(); i++; continue }

    closeList()
    const para = [l]; i++
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*([-*+]|\d+\.)\s|\s*>|\s*\|)/.test(lines[i])) para.push(lines[i++])
    out.push(`<p>${inline(para.join(' '))}</p>`)
  }
  closeList()
  return out.join('\n')
}

export const PAGE_CSS = `
:root{--ground:#F3F5F5;--surface:#FFF;--ink:#12181A;--muted:#5A6B6E;--rule:#D7DEDE;--accent:#0E6E65;
 --d:'Archivo',system-ui,sans-serif;--b:'Source Serif 4',Georgia,serif;--m:'JetBrains Mono',ui-monospace,monospace}
@media (prefers-color-scheme:dark){:root{--ground:#0D1214;--surface:#151B1E;--ink:#E3EAE9;--muted:#8B9C9E;--rule:#232D30;--accent:#46BFAF}}
*{box-sizing:border-box}body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--b);font-size:16.5px;line-height:1.65}
.wrap{max-width:820px;margin:0 auto;padding:44px 24px 80px}
.crumb{font-family:var(--m);font-size:11px;color:var(--muted);margin-bottom:20px}
.crumb a{color:var(--accent);text-decoration:none}
h1,h2,h3,h4{font-family:var(--d);letter-spacing:-.02em;line-height:1.2;margin:1.6em 0 .5em;text-wrap:balance}
h1{font-size:32px;font-weight:800;margin-top:0}h2{font-size:23px;font-weight:700}h3{font-size:18px;font-weight:600}
p{margin:0 0 1em}li{margin:.25em 0}
code{font-family:var(--m);font-size:.88em;background:var(--surface);border:1px solid var(--rule);padding:1px 5px}
pre{background:var(--surface);border:1px solid var(--rule);padding:16px 18px;overflow-x:auto}
pre code{border:0;padding:0;background:none;font-size:12.5px;line-height:1.6}
table{width:100%;border-collapse:collapse;font-size:14.5px;margin:1em 0;display:block;overflow-x:auto}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--rule);vertical-align:top}
thead th{font-family:var(--m);font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted)}
blockquote{border-left:2px solid var(--accent);margin:1em 0;padding:2px 0 2px 18px;color:var(--muted)}
hr{border:0;border-top:1px solid var(--rule);margin:2em 0}
a{color:var(--accent)}
`
export function wrapPage(title, bodyHtml, crumb = '') {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title.replace(/[<>&]/g, '')}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;700;800&family=JetBrains+Mono:wght@400;500&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap">
<style>${PAGE_CSS}</style></head><body><div class="wrap">${crumb ? `<div class="crumb">${crumb}</div>` : ''}${bodyHtml}</div></body></html>`
}
