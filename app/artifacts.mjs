#!/usr/bin/env node
/**
 * Make every generated artifact accessible: render each markdown deliverable to
 * a readable HTML sibling, and build one index linking everything.
 *
 *   node artifacts.mjs          # rebuild the index
 *   node artifacts.mjs --list   # terminal listing only
 */
import fs from 'node:fs'
import { STATE } from './lib/state.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mdToHtml, wrapPage } from './lib/mdlite.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const RESULTS = path.join(STATE, 'results')

const KIND = (f) => {
  if (/^report\.html$/.test(f)) return 'chart'
  if (/^(PITCH|LANDSCAPE|STRATEGY|CASE|STORY|PLAN)\.md$/i.test(f)) return 'deliverable'
  if (/^VERDICT\.json$/i.test(f)) return 'verdict'
  if (/\.(py|js|mjs|ts)$/.test(f)) return 'code'
  if (/^(run|status)\.json$/.test(f)) return 'data'
  if (/^(claude\.err|stream\.jsonl|setup\.txt|teardown\.txt|agent-tests\.txt|report\.txt)$/.test(f)) return 'log'
  return 'other'
}
const SHOW = new Set(['chart', 'deliverable', 'verdict', 'code'])

export function scan() {
  if (!fs.existsSync(RESULTS)) return []
  return fs.readdirSync(RESULTS).filter((d) => !d.startsWith('.'))
    .map((id) => {
      const dir = path.join(RESULTS, id)
      if (!fs.statSync(dir).isDirectory()) return null
      const rd = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { return null } }
      const meta = rd('run.json') ?? rd('status.json') ?? {}
      const files = []
      const walk = (d, rel = '') => {
        for (const f of fs.readdirSync(d)) {
          const p = path.join(d, f)
          const st = fs.statSync(p)
          if (st.isDirectory()) walk(p, path.join(rel, f))
          else files.push({ rel: path.join(rel, f), name: f, size: st.size, kind: KIND(f) })
        }
      }
      walk(dir)
      return { id, dir, mtime: fs.statSync(dir).mtimeMs, files,
               task: meta.task ?? meta.flow ?? '—', experiment: meta.experiment ?? meta.flow ?? '—',
               session: meta.session ?? null, verdict: meta.verdict?.verdict ?? null,
               arms: (meta.arms ?? []).map((a) => ({ arm: a.arm, model: a.model,
                 score: a.grade?.total ? `${a.grade.passed}/${a.grade.total}` : null })),
               judgement: meta.judgement ? { winner: meta.judgement.winner, totals: meta.judgement.totals } : null }
    }).filter(Boolean).sort((a, b) => b.mtime - a.mtime)
}

/** Render every markdown artifact to an HTML sibling so it opens readably. */
function renderMarkdown(runs) {
  let n = 0
  for (const r of runs) {
    for (const f of r.files) {
      if (!f.name.endsWith('.md')) continue
      const src = path.join(r.dir, f.rel)
      const dest = src.replace(/\.md$/, '.html')
      const md = fs.readFileSync(src, 'utf8')
      const crumb = `<a href="${path.relative(path.dirname(dest), path.join(RESULTS, 'index.html'))}">all artifacts</a> · ${r.id} · ${f.rel}`
      fs.writeFileSync(dest, wrapPage(f.name.replace(/\.md$/, '') + ' · ' + r.id, mdToHtml(md), crumb))
      n++
    }
  }
  return n
}

function indexHtml(runs) {
  const fmtSize = (b) => b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b > 1e3 ? `${Math.round(b / 1e3)} KB` : `${b} B`
  const rows = runs.map((r) => {
    const shown = r.files.filter((f) => SHOW.has(f.kind))
      .sort((a, b) => (a.kind === 'chart' ? -1 : 0) - (b.kind === 'chart' ? -1 : 0))
    const links = shown.map((f) => {
      const href = f.name.endsWith('.md') ? f.rel.replace(/\.md$/, '.html') : f.rel
      const label = f.rel.replace(/\//g, ' / ')
      return `<a class="art ${f.kind}" href="${r.id}/${href}">${label}<span>${fmtSize(f.size)}</span></a>`
    }).join('')
    const summary = r.verdict ? `<span class="v ${r.verdict}">${r.verdict}</span>`
      : r.judgement ? `<span class="v">winner ${r.judgement.winner}</span>`
      : r.arms.map((a) => a.score ? `<span class="sc">${a.arm} ${a.score}</span>` : '').join('')
    const models = r.arms.filter((a) => a.model).map((a) => `${a.arm} · ${a.model}`).join(' vs ') || ''
    return `<section class="run">
      <div class="rh"><h2>${r.id}</h2>${summary}</div>
      <div class="meta">task ${r.task}${r.session ? ` · session ${r.session}` : ''}${models ? ` · ${models}` : ''} · ${r.files.length} files</div>
      <div class="arts">${links || '<span class="none">no viewable artifacts</span>'}</div>
    </section>`
  }).join('\n')

  return wrapPage('All artifacts', `
    <h1>Artifacts</h1>
    <p class="lede">Every deliverable, chart and verdict produced by this harness. Markdown files are
    rendered to HTML alongside the originals, so everything opens in a browser.</p>
    ${rows || '<p>Nothing yet.</p>'}
    <style>
      .lede{color:var(--muted);margin-bottom:2.5em}
      .run{border-top:1px solid var(--rule);padding:22px 0}
      .rh{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
      .run h2{font-family:var(--m);font-size:14px;font-weight:500;margin:0;letter-spacing:0}
      .meta{font-family:var(--m);font-size:11px;color:var(--muted);margin:4px 0 12px}
      .arts{display:flex;flex-wrap:wrap;gap:8px}
      .art{display:flex;align-items:baseline;gap:8px;font-family:var(--m);font-size:11.5px;
           text-decoration:none;border:1px solid var(--rule);background:var(--surface);padding:6px 11px}
      .art span{color:var(--muted);font-size:10px}
      .art.chart{border-color:var(--accent);color:var(--accent);font-weight:500}
      .art.verdict{border-color:#A8611F;color:#A8611F}
      .none{font-family:var(--m);font-size:11px;color:var(--muted)}
      .v{font-family:var(--m);font-size:11px;border:1px solid var(--rule);padding:3px 9px;color:var(--muted)}
      .v.INVEST{color:var(--accent);border-color:var(--accent)}
      .v.PASS{color:#A8611F;border-color:#A8611F}
      .sc{font-family:var(--m);font-size:11px;color:var(--muted)}
    </style>`)
}

const runs = scan()
if (process.argv.includes('--list')) {
  for (const r of runs) {
    console.log(`\n  ${r.id}   ${r.verdict ?? r.judgement?.winner ?? ''}`)
    for (const f of r.files.filter((x) => SHOW.has(x.kind))) console.log(`     ${f.kind.padEnd(12)} ${f.rel}`)
  }
  console.log('')
} else {
  const n = renderMarkdown(runs)
  fs.writeFileSync(path.join(RESULTS, 'index.html'), indexHtml(runs))
  console.log(`rendered ${n} markdown artifact(s); index at results/index.html (${runs.length} runs)`)
}
