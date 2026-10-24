#!/usr/bin/env node
/**
 * Turn results/<runId>/run.json into a standalone HTML report with a radar
 * ("spider") chart comparing the two sessions across six normalised axes,
 * backed by a raw-value table so the normalisation can always be checked.
 *
 *   node report.mjs            # newest run
 *   node report.mjs <runId>    # a specific run
 */
import fs from 'node:fs'
import { STATE } from './lib/state.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const RESULTS = path.join(STATE, 'results')

// ---------------------------------------------------------------- load
export function loadRun(runId) {
  if (!fs.existsSync(RESULTS)) throw new Error('no results/ directory — run the demo first')
  const runs = fs.readdirSync(RESULTS).filter((d) => fs.existsSync(path.join(RESULTS, d, 'run.json'))).sort()
  if (!runs.length) throw new Error('no run.json found under results/')
  const id = runId || runs[runs.length - 1]
  const file = path.join(RESULTS, id, 'run.json')
  if (!fs.existsSync(file)) throw new Error(`no such run: ${id}\navailable: ${runs.join(', ')}`)
  return { id, dir: path.join(RESULTS, id), data: JSON.parse(fs.readFileSync(file, 'utf8')) }
}

// ---------------------------------------------------------------- metrics
const num = (v) => (Number.isFinite(v) ? v : 0)

export function metricsOf(rec, judgement = null) {
  const r = rec.result ?? {}
  const u = r.usage ?? {}
  const g = rec.grade ?? {}
  const inp = num(u.input_tokens), cw = num(u.cache_creation_input_tokens)
  const cr = num(u.cache_read_input_tokens), out = num(u.output_tokens)
  const billed = inp + cw + cr
  // A provider-priced cost, when the scenario declared rates, beats Claude Code's
  // Anthropic-priced guess by orders of magnitude.
  const cost = rec.trueCost != null ? num(rec.trueCost) : num(r.total_cost_usd)
  const passed = num(g.passed), total = num(g.total)
  return {
    arm: rec.arm, label: rec.label, levers: rec.levers ?? [], model: rec.model ?? null,
    tag: rec.tag ?? null, diff: rec.diff ?? [], same: !!rec.same, params: rec.params ?? null,
    // [[parameter, value], …] — everything the run set, for the side-by-side table
    paramTable: rec.paramTable ?? null,
    pricing: rec.pricing ?? null, reportedCost: num(r.total_cost_usd),
    sandboxId: rec.sandboxId, failures: g.failures ?? [], importOk: g.import_ok !== false,
    cost, turns: num(r.num_turns), out, inp, cw, cr, billed,
    apiSec: r.duration_ms ? r.duration_ms / 1000 : num(rec.steps?.agent?.wallSec),
    wallSec: num(rec.totalWallSec), lines: rec.linesOfCode || '—',
    passed, total, pass: total ? passed / total : 0,
    // rubric-graded rather than suite-graded: documents, and artifact runs
    // replayed from a real session where there is no hidden suite to run.
    isDoc: rec.grade?.kind === 'document' || rec.grade?.kind === 'artifacts',
    gradeKind: rec.grade?.kind ?? 'suite',
    rubricScore: judgement?.totals?.[rec.arm] ?? null,
    rubricMax: (judgement?.rubric?.length ?? 0) * 10 || null,
    cacheHit: billed ? cr / billed : 0,
    // rubric-graded runs price per rubric point; suite-graded ones per passing test
    costPerPass: passed ? cost / passed
      : (/^(document|artifacts)$/.test(rec.grade?.kind ?? '') && judgement?.totals?.[rec.arm])
        ? cost / judgement.totals[rec.arm] : null,
  }
}

// six axes; `dir` says which direction is better
export const AXES = [
  { key: 'correctness', label: 'Quality',        sub: 'graded score',          dir: 'up',
    val: (m) => (m.isDoc ? (m.rubricMax ? (m.rubricScore ?? 0) / m.rubricMax : 0) : m.pass),
    fmt: (m) => (m.isDoc ? (m.rubricScore != null ? `${m.rubricScore}/${m.rubricMax}` : 'not judged')
                         : `${m.passed}/${m.total}`) },
  { key: 'cost',        label: 'Cost efficiency', sub: 'total spend',           dir: 'down',
    val: (m) => m.cost,     fmt: (m) => `$${m.cost.toFixed(4)}` },
  { key: 'tokens',      label: 'Token economy',   sub: 'output tokens',         dir: 'down',
    val: (m) => m.out,      fmt: (m) => m.out.toLocaleString('en-US') },
  { key: 'turns',       label: 'Turn economy',    sub: 'assistant turns',       dir: 'down',
    val: (m) => m.turns,    fmt: (m) => String(m.turns) },
  { key: 'cache',       label: 'Cache reuse',     sub: 'prompt-cache hit rate', dir: 'up',
    val: (m) => m.cacheHit, fmt: (m) => `${(m.cacheHit * 100).toFixed(1)}%` },
  { key: 'speed',       label: 'Speed',           sub: 'agent wall time',       dir: 'down',
    val: (m) => m.apiSec,   fmt: (m) => `${Math.round(m.apiSec)}s` },
]

/** Normalise so 1.0 = best arm on that axis. Outward is always better. */
export function normalise(rows) {
  return AXES.map((ax) => {
    const vals = rows.map(ax.val)
    const pos = vals.filter((v) => v > 0)
    const best = ax.dir === 'up' ? Math.max(...vals, 0) : (pos.length ? Math.min(...pos) : 0)
    const scores = vals.map((v) => {
      if (ax.dir === 'up') return best > 0 ? v / best : 0
      if (!(v > 0)) return best > 0 ? 1 : 0   // zero cost/turns = unbeatable, not worst
      return best > 0 ? best / v : 0
    })
    return { ...ax, vals, scores: scores.map((s) => Math.max(0, Math.min(1, s))) }
  })
}

// ---------------------------------------------------------------- svg radar
/**
 * One colour per arm. The first two keep the original control/optimized pair so
 * two-armed benchmark reports look exactly as they did; the rest exist because
 * the auto-grid path produces three or four arms, and colouring every arm after
 * the first the same green made two polygons indistinguishable.
 */
/** "baseline", "exp1 · model" — short enough for an axis, specific enough to trust. */
const armName = (m, i) => (m?.arm ?? (i ? `exp${i}` : 'baseline')) + (m?.tag ? ` \u00b7 ${m.tag}` : '')
const ARM_VARS = ['--armA', '--armB', '--armC', '--armD', '--armE']
const armVar = (i) => ARM_VARS[i % ARM_VARS.length]
const armColor = (i) => `var(${armVar(i)})`
const armSoft = (i) => `var(${armVar(i)}-soft)`
const CX = 360, CY = 292, R = 186, RINGS = 4
const pt = (i, n, f) => {
  const a = -Math.PI / 2 + (i * 2 * Math.PI) / n
  return [CX + Math.cos(a) * R * f, CY + Math.sin(a) * R * f]
}
const poly = (i, n, f) => pt(i, n, f).map((v) => v.toFixed(1)).join(',')

function radarSvg(axes, rows) {
  const n = axes.length
  // Fills stack. Two translucent shapes read fine; three or more turn the middle
  // into a single wash, so past two arms the outline carries it.
  const fillOp = rows.length > 2 ? 0.06 : 0.14
  
  const rings = Array.from({ length: RINGS }, (_, k) => {
    const f = (k + 1) / RINGS
    const pts = Array.from({ length: n }, (_, i) => poly(i, n, f)).join(' ')
    return `<polygon points="${pts}" fill="none" stroke="var(--rule)" stroke-width="1"/>`
  }).join('\n        ')

  const spokes = Array.from({ length: n }, (_, i) => {
    const [x, y] = pt(i, n, 1)
    return `<line x1="${CX}" y1="${CY}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--rule)" stroke-width="1"/>`
  }).join('\n        ')

  const shapes = rows.map((m, ri) => {
    const pts = axes.map((ax, i) => poly(i, n, ax.scores[ri])).join(' ')
    const dots = axes.map((ax, i) => {
      const [x, y] = pt(i, n, ax.scores[ri])
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" fill="${armColor(ri)}"/>`
    }).join('')
    return `<polygon points="${pts}" fill="${armColor(ri)}" fill-opacity="${fillOp}" stroke="${armColor(ri)}" stroke-width="2" stroke-linejoin="round"/>\n        ${dots}`
  }).join('\n        ')

  const labels = axes.map((ax, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n
    const lx = CX + Math.cos(a) * (R + 30), ly = CY + Math.sin(a) * (R + 30)
    const anchor = Math.abs(Math.cos(a)) < 0.2 ? 'middle' : Math.cos(a) > 0 ? 'start' : 'end'
    const dy = Math.sin(a) < -0.5 ? -6 : Math.sin(a) > 0.5 ? 14 : 0
    const vals = rows.map((m, ri) => `<tspan fill="${armColor(ri)}">${ax.fmt(m)}</tspan>`).join('<tspan fill="var(--muted)">  ·  </tspan>')
    return `<text x="${lx.toFixed(0)}" y="${(ly + dy).toFixed(0)}" text-anchor="${anchor}" font-size="12.5" font-weight="700" fill="var(--ink)">${ax.label}</text>
        <text x="${lx.toFixed(0)}" y="${(ly + dy + 16).toFixed(0)}" text-anchor="${anchor}" font-size="10.5" fill="var(--muted)">${ax.sub}</text>
        <text x="${lx.toFixed(0)}" y="${(ly + dy + 31).toFixed(0)}" text-anchor="${anchor}" font-size="11" font-weight="700">${vals}</text>`
  }).join('\n        ')

  return `<svg viewBox="0 0 720 620" role="img" aria-label="Radar chart comparing ${rows.length} arm${rows.length === 1 ? '' : 's'}: ${rows.map((m, i) => esc(armName(m, i))).join(', ')}. Axes are quality, cost efficiency, token economy, turn economy, cache reuse and speed, each normalised independently so the best arm on it sits at the outer edge; outward is better on every axis, including the four where a lower raw number wins.">
        <g font-family="JetBrains Mono, monospace">
        ${rings}
        ${spokes}
        <circle cx="${CX}" cy="${CY}" r="2" fill="var(--rule-strong)"/>
        ${shapes}
        ${labels}
        </g>
      </svg>`
}

// ---------------------------------------------------------------- html
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
const pct = (b, a) => (a ? ((b - a) / a) * 100 : 0)
const signed = (v, d = 1) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`
const fmtNum = (v) => (v == null ? '—' : Number(v).toLocaleString('en-US'))

export function buildHtml({ id, data }) {
  const rows = (data.arms ?? []).map((a) => metricsOf(a, data.judgement))
  const axes = normalise(rows)
  const [A, B] = rows
  const ran = rows.some((m) => m.total > 0 || m.cost > 0)
  // an arm whose parameters match the baseline measures variance, not a lever
  const dupes = rows.filter((m) => m.same)

  // One descriptor per metric, evaluated per arm. The old form was a literal
  // list of [label, A, B, delta] tuples, which is why a three-armed run showed
  // only its first two arms and dropped the third from the table entirely.
  const isRubric = rows.some((m) => m.isDoc)
  const METRICS = !rows.length ? [] : [
    { label: 'Model', val: (m) => esc(m.model ?? '—') },
    isRubric
      ? { label: 'Quality (blind rubric)', higherBetter: true, num: (m) => m.rubricScore,
          val: (m) => (m.rubricScore != null ? `${m.rubricScore}/${m.rubricMax}` : 'not judged') }
      : { label: 'Correctness', higherBetter: true, num: (m) => m.pass,
          val: (m) => `${m.passed}/${m.total}` },
    { label: 'Cost (USD)', num: (m) => m.cost, val: (m) => `$${m.cost.toFixed(4)}` },
    ...(rows.some((m) => m.pricing) ? [
      { label: '— rate ($/M in, out)',
        val: (m) => (m.pricing ? `${m.pricing.inPerM}, ${m.pricing.outPerM}` : 'Anthropic') },
      { label: '— Claude Code\u2019s own figure', val: (m) => `$${m.reportedCost.toFixed(4)}` },
    ] : []),
    { label: isRubric ? 'Cost per rubric point' : 'Cost per passing test', num: (m) => m.costPerPass,
      val: (m) => (m.costPerPass == null ? '—' : `$${m.costPerPass.toFixed(4)}`) },
    { label: 'Assistant turns', num: (m) => m.turns, val: (m) => String(m.turns) },
    { label: 'Output tokens', num: (m) => m.out, val: (m) => m.out.toLocaleString('en-US') },
    { label: 'Input tokens (fresh)', num: (m) => m.inp, val: (m) => m.inp.toLocaleString('en-US') },
    { label: 'Cache writes', val: (m) => m.cw.toLocaleString('en-US') },
    { label: 'Cache reads', val: (m) => m.cr.toLocaleString('en-US') },
    { label: 'Prompt-cache hit rate', higherBetter: true, num: (m) => m.cacheHit,
      val: (m) => `${(m.cacheHit * 100).toFixed(1)}%` },
    { label: 'Agent wall time', num: (m) => m.apiSec, val: (m) => `${Math.round(m.apiSec)}s` },
    { label: 'Sandbox wall time', val: (m) => `${Math.round(m.wallSec)}s` },
    { label: 'Delivered lines', val: (m) => String(m.lines).replace(/\s*total$/, '') },
  ]

  const deltaCell = (d, higherBetter) => {
    if (d == null || !Number.isFinite(d)) return '<td class="d">—</td>'
    const good = higherBetter ? d > 0 : d < 0
    const cls = Math.abs(d) < 0.05 ? 'd' : good ? 'd good' : 'd bad'
    return `<td class="${cls}">${signed(d)}</td>`
  }
  // Every arm after the control gets its own value column and its own delta
  // against the control, so the table widens with the grid instead of hiding it.
  const ctl = rows[0]
  const metricRow = (mt) => `<tr><td>${esc(mt.label)}</td>` + rows.map((m, i) => {
    const cell = `<td>${mt.val(m)}</td>`
    if (i === 0) return cell
    if (!mt.num) return cell + '<td class="d">—</td>'
    const a = mt.num(ctl), b = mt.num(m)
    const d = (a == null || b == null) ? null : pct(b, a)
    return cell + deltaCell(d, !!mt.higherBetter)
  }).join('') + '</tr>'
  const metricHead = '<tr><th>Metric</th>' + rows.map((m, i) =>
    `<th style="color:${armColor(i)}">${esc(armName(m, i))}</th>`
    + (i ? '<th>&Delta;</th>' : '')).join('') + '</tr>'

  const failRows = rows.map((m, ri) => {
    const by = {}
    for (const f of m.failures) { const k = f.split('.').slice(-2)[0] || 'other'; (by[k] ||= []).push(f.split('.').pop()) }
    const keys = Object.keys(by)
    const body = keys.length
      ? keys.map((k) => `<li><b>${esc(k)}</b> <span>${by[k].map(esc).join(', ')}</span></li>`).join('')
      : `<li class="clean">all ${m.total} tests passed</li>`
    return `<div class="fail" style="border-top-color:${armColor(ri)}">
        <h3>${esc(m.label)}</h3>
        <p class="score">${m.passed} / ${m.total}${m.importOk ? '' : ' · module failed to import'}</p>
        <ul>${body}</ul>
      </div>`
  }).join('\n      ')

  // Every parameter any arm set, one row each, arms side by side; a row whose values differ is what changed.
  const pnames = [...new Set(rows.flatMap((m) => (m.paramTable ?? []).map(([k]) => k)))]
  const pval = (m, k) => (m.paramTable ?? []).find(([n]) => n === k)?.[1] ?? '—'
  const pchanged = (k) => new Set(rows.map((m) => pval(m, k))).size > 1
  const nchg = pnames.filter(pchanged).length
  const paramSection = !pnames.length ? '' : `<section>
    <h2>Parameters, side by side</h2>
    <div class="card">
      <table>
        <thead><tr><th>Parameter</th>${rows.map((m, i) => `<th style="color:${armColor(i)}">${esc(armName(m, i))}</th>`).join('')}</tr></thead>
        <tbody>
          ${pnames.map((k) => `<tr class="${pchanged(k) ? 'pchg' : 'psame'}"><td>${esc(k)}</td>${rows.map((m) => `<td>${esc(pval(m, k))}</td>`).join('')}</tr>`).join('\n          ')}
        </tbody>
      </table>
      <p class="src">${nchg} of ${pnames.length} parameters differ (highlighted); the rest are the same on every arm.</p>
    </div>
  </section>`

  const leverRows = rows.map((m, ri) => `<div class="lev" style="border-top-color:${armColor(ri)}">
        <h3>${esc(m.label)}</h3>
        <ul>${m.levers.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
        <p class="sbx">${esc(m.sandboxId ?? '')}</p>
      </div>`).join('\n      ')

  // ---- document comparison (only for document tasks) ----------------------
  const J = data.judgement
  const docM = rows.map((m) => (data.arms ?? []).find((a) => a.arm === m.arm)?.grade?.metrics ?? null)
  const isDoc = docM.some(Boolean)
  const isArt = rows.some((m) => m.gradeKind === 'artifacts')
  const rubricMax = rows.find((m) => m.rubricMax)?.rubricMax ?? 60
  const docRow = (label, key, fmt = (v) => (v ?? '—')) =>
    `<tr><td>${esc(label)}</td>${docM.map((d) => `<td>${fmt(d?.[key])}</td>`).join('')}</tr>`
  const measureRows = isArt ? `
          ${docRow('Files changed', 'files', fmtNum)}
          ${docRow('Lines added', 'added', fmtNum)}
          ${docRow('Lines removed', 'removed', fmtNum)}
          ${docRow('Bytes written', 'bytes', fmtNum)}
          ${docRow('Tests written', 'testFiles', fmtNum)}` : `
          ${docRow('Words', 'words', fmtNum)}
          ${docRow('Headings', 'headings', fmtNum)}
          ${docRow('Top-level sections', 'h2', fmtNum)}
          ${docRow('Bullets', 'bullets', fmtNum)}
          ${docRow('Table rows', 'tableRows', fmtNum)}
          ${docRow('Code blocks', 'codeBlocks', fmtNum)}
          ${docRow('Quantified claims', 'quantifiedClaims', fmtNum)}
          ${docRow('Names accuracy risk', 'addressesAccuracyRisk', (v) => (v ? 'yes' : 'no'))}`
  const docSection = !isDoc ? '' : `
  <section>
    <h2>${isArt ? 'What each arm delivered' : 'The two documents'}</h2>
    <div class="card">
      <table>
        <thead><tr><th>Measure</th>${rows.map((m, i) => `<th style="color:${armColor(i)}">${esc(armName(m, i))}</th>`).join('')}</tr></thead>
        <tbody>${measureRows}
        </tbody>
      </table>
    </div>
    ${!J || J.error ? `<p class="src">${esc(J?.error ?? 'not judged')}</p>` : `
    <div class="card" style="margin-top:16px">
      <h3 style="font-family:var(--display);font-size:16px;margin:0 0 12px">Blind rubric judgement</h3>
      <table>
        <thead><tr><th>Criterion</th>${rows.map((m, i) =>
          `<th style="color:${armColor(i)}">${esc(armName(m, i))}</th>` + (i ? '<th>&Delta;</th>' : '')).join('')}</tr></thead>
        <tbody>
          ${(J.rubric ?? []).map((k) => {
            const a = J.scores?.[rows[0]?.arm]?.[k]
            return `<tr><td>${esc(k.replace(/_/g, ' '))}</td>` + rows.map((m, i) => {
              const v = J.scores?.[m.arm]?.[k]
              const cell = `<td>${v ?? '—'}</td>`
              if (!i) return cell
              if (v == null || a == null) return cell + '<td class="d">—</td>'
              const d = v - a
              return cell + `<td class="${d === 0 ? 'd' : d > 0 ? 'd good' : 'd bad'}">${d > 0 ? '+' : ''}${d}</td>`
            }).join('') + '</tr>'
          }).join('\n          ')}
          <tr><td><b>Total</b></td>${rows.map((m, i) =>
            `<td><b>${J.totals?.[m.arm] ?? '—'}/${rubricMax}</b></td>` + (i ? '<td class="d"></td>' : '')).join('')}</tr>
        </tbody>
      </table>
      <p style="margin-top:14px"><b>Winner: ${esc(J.winner)}</b> <span class="src">(${esc(J.margin)} margin)</span></p>
      <p class="src">${esc(J.why ?? '')}</p>
      <p class="src">Presented first to the judge: <b>${esc(J.presentedFirst)}</b> — order was randomised and arm identities withheld.</p>
    </div>`}
  </section>`

  return `<meta charset="utf-8">
<title>Baseline vs Optimized</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=JetBrains+Mono:wght@400;500;700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap">
<style>
  :root{
    --ground:#F3F5F5; --surface:#FFFFFF; --ink:#12181A; --muted:#5A6B6E;
    --rule:#D7DEDE; --rule-strong:#B4BFBF;
    --armA:#A8611F; --armA-soft:#F7EDE1;
    --armB:#0E6E65; --armB-soft:#E1F0EE;
    --armC:#5B4BA8; --armC-soft:#EAE7F6;
    --armD:#2A5C8F; --armD-soft:#E3EDF6;
    --armE:#96356A; --armE-soft:#F8E8F1;
    --good:#0E6E65; --bad:#A8611F;
    --display:'Archivo',system-ui,sans-serif;
    --body:'Source Serif 4',Georgia,serif;
    --mono:'JetBrains Mono',ui-monospace,Menlo,monospace;
  }
  @media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
    --ground:#0D1214; --surface:#151B1E; --ink:#E3EAE9; --muted:#8B9C9E;
    --rule:#232D30; --rule-strong:#37474A;
    --armA:#E2A462; --armA-soft:#2B2015; --armB:#46BFAF; --armB-soft:#0E2A27;
    --armC:#A99AF2; --armC-soft:#1D1930; --armD:#79ADE0; --armD-soft:#141F2C; --armE:#E58BBC; --armE-soft:#2B1522;
    --good:#46BFAF; --bad:#E2A462;
  }}
  :root[data-theme="dark"]{
    --ground:#0D1214; --surface:#151B1E; --ink:#E3EAE9; --muted:#8B9C9E;
    --rule:#232D30; --rule-strong:#37474A;
    --armA:#E2A462; --armA-soft:#2B2015; --armB:#46BFAF; --armB-soft:#0E2A27;
    --armC:#A99AF2; --armC-soft:#1D1930; --armD:#79ADE0; --armD-soft:#141F2C; --armE:#E58BBC; --armE-soft:#2B1522;
    --good:#46BFAF; --bad:#E2A462;
  }
  *{box-sizing:border-box}
  body{background:var(--ground);color:var(--ink);font-family:var(--body);font-size:16px;
       line-height:1.6;-webkit-font-smoothing:antialiased}
  .wrap{max-width:1000px;margin:0 auto;padding:48px 24px 80px;display:flex;flex-direction:column;gap:44px}
  .eyebrow{font-family:var(--mono);font-size:11px;font-weight:500;letter-spacing:.14em;
           text-transform:uppercase;color:var(--muted)}
  h1{font-family:var(--display);font-weight:700;font-size:clamp(30px,5vw,46px);line-height:1.06;
     letter-spacing:-.02em;margin:8px 0 0;text-wrap:balance}
  .lede{font-size:18px;color:var(--muted);max-width:62ch;margin:12px 0 0}
  .lede b{color:var(--ink);font-weight:600}
  .meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
  .chip{font-family:var(--mono);font-size:11px;padding:5px 10px;border:1px solid var(--rule);
        background:var(--surface);color:var(--muted);white-space:nowrap}
  h2{font-family:var(--display);font-weight:600;font-size:21px;letter-spacing:-.01em;margin:0 0 14px}
  .card{background:var(--surface);border:1px solid var(--rule);padding:24px;overflow-x:auto}
  svg{display:block;width:100%;height:auto;min-width:600px;margin:0 auto}
  .legend{display:flex;gap:24px;justify-content:center;flex-wrap:wrap;margin-top:8px;
          font-family:var(--mono);font-size:12px}
  .legend span{display:flex;align-items:center;gap:8px}
  .sw{display:inline-block;width:14px;height:14px;border-width:2px;border-style:solid;flex:none}
  .legend b{font-weight:600;color:var(--ink)}
  figcaption{font-size:15px;color:var(--muted);max-width:72ch;margin:14px auto 0;text-align:center}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--rule)}
  thead th{font-family:var(--mono);font-size:10.5px;font-weight:700;letter-spacing:.1em;
           text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--rule-strong)}
  td:not(:first-child){font-family:var(--mono);font-size:13px;
           font-variant-numeric:tabular-nums;text-align:right}
  th:not(:first-child){text-align:right}
  td.d{color:var(--muted)} td.good{color:var(--good);font-weight:700} td.bad{color:var(--bad);font-weight:700}
  tbody tr:last-child td{border-bottom:none}
  .cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:20px}
  .fail,.lev{background:var(--surface);border:1px solid var(--rule);padding:20px;border-top-width:3px}

  .fail h3,.lev h3{font-family:var(--display);font-size:15px;font-weight:600;margin:0 0 6px}
  .score{font-family:var(--mono);font-size:13px;color:var(--muted);margin:0 0 12px}
  .fail ul,.lev ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:7px}
  .fail li,.lev li{font-family:var(--mono);font-size:11.5px;line-height:1.5;color:var(--ink)}
  .fail li span{color:var(--muted)}
  .fail li.clean{color:var(--good)}
  .lev li{color:var(--muted)}
  .lev li::before{content:'— ';color:var(--rule-strong)}
  .sbx{font-family:var(--mono);font-size:10.5px;color:var(--muted);margin:14px 0 0}
  td.chg{font-family:var(--body);font-size:14px;text-align:left}
  .ref{color:var(--muted)}
  .warnflag{color:var(--bad);font-weight:600}
  .dupe{margin:16px 0 0;border-left:2px solid var(--bad);padding:2px 0 2px 16px;font-size:14.5px;
        color:var(--muted);max-width:74ch}
  .dupe b{color:var(--ink)}
  .note{border-left:2px solid var(--armA);padding:2px 0 2px 18px;font-size:15px;color:var(--muted);max-width:72ch}
  .note b{color:var(--ink);font-weight:600}
  footer{font-family:var(--mono);font-size:11.5px;color:var(--muted);border-top:1px solid var(--rule);padding-top:16px}
  tr.pchg td{background:var(--armB-soft)} tr.pchg td:first-child{font-weight:600}
  .story{display:grid;grid-template-columns:minmax(110px,max-content) 1fr;gap:10px 18px;margin:0}
  .story dt{font-family:var(--mono);font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);padding-top:3px}
  .story dd{margin:0;min-width:0} .story ul{margin:0;padding-left:18px} .story li+li{margin-top:4px}
  .story .res li{font-weight:600}
  @media (max-width:640px){.story{grid-template-columns:1fr;gap:4px}.story dd{margin-bottom:10px}}
  tr.psame td{color:var(--muted)}
</style>

<div class="wrap">
  <header>
    <div class="eyebrow">${esc(data.eyebrow ?? 'E2B sandbox benchmark · session comparison')}</div>
    <h1>Baseline vs Optimized</h1>
    <p class="lede">${esc(data.lede ?? 'Two identical cloud microVMs, the same spec, the same base task prompt.')}
    ${data.headline ? esc(data.headline) : rows.length > 2
      ? `The <b>control</b> runs <b>${esc(A?.model ?? '—')}</b>; ${rows.length - 1} variants are measured against it`
      : `The <b>baseline</b> is ${A?.model && B?.model && A.model !== B.model
          ? `<b>${esc(A.model)}</b>; the <b>optimized</b> arm runs <b>${esc(B.model)}</b>`
          : `a default Claude Code session on <b>${esc(A?.model ?? '—')}</b>; the <b>optimized</b> arm changes exactly one thing`}`}${data.description ? ` — ${esc(data.description.replace(/\.$/, ''))}` : ''}.
    ${A?.total ? `A ${A.total}-test suite neither session could see grades both.` : 'Both deliverables are compared below.'}</p>
    <div class="meta">
      ${(data.chips ?? [id, `experiment ${data.experiment ?? '—'}`, `task ${data.task ?? '—'}`, data.auth ?? '—', 'n = 1 per arm'])
        .map((c) => `<span class="chip">${esc(c)}</span>`).join('\n      ')}
    </div>
  </header>

  ${data.story ? `<section>
    <h2>The experiment</h2>
    <div class="card"><dl class="story">
      <dt>Question</dt><dd>${esc(data.story.question)}</dd>
      ${data.story.task ? `<dt>Task</dt><dd>${esc(data.story.task)}</dd>` : ''}
      <dt>What changed</dt><dd><ul>${data.story.changed.map((x) => `<li>${esc(x)}</li>`).join('') || '<li>nothing</li>'}</ul></dd>
      ${data.story.used.length ? `<dt>What was used</dt><dd><ul>${data.story.used.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></dd>` : ''}
      <dt>Result</dt><dd><ul class="res">${data.story.result.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></dd>
      <dt>How sure</dt><dd>${esc(data.story.confidence)}</dd>
    </dl></div>
  </section>` : ''}

  <figure style="margin:0">
    <h2>All six metrics at once</h2>
    <div class="card">
      ${radarSvg(axes, rows)}
      <div class="legend">
        ${rows.map((m, i) => `<span><i class="sw" style="border-color:${armColor(i)};background:${armSoft(i)}"></i><b>${esc(armName(m, i))}</b></span>`).join('\n        ')}
      </div>
    </div>
    <figcaption>Each axis is normalised independently so the better session touches the outer ring —
    <b>outward is always better</b>, including on the four axes where a lower raw number wins. Raw
    values sit beside every axis label; the table below carries them unnormalised.</figcaption>
  </figure>

  ${paramSection}

  ${paramSection ? '' : `<section>
    <h2>The arms</h2>
    <div class="card">
      <table>
        <thead><tr><th>Arm</th><th>Model</th><th>Compaction</th><th>Effort</th><th>Changed vs baseline</th></tr></thead>
        <tbody>
          ${rows.map((m, i) => `<tr><td style="color:${armColor(i)};font-family:var(--mono);font-size:13px">${esc(armName(m, i))}</td>
            <td>${esc(m.params?.model ?? m.model ?? '—')}</td>
            <td>${m.params ? (m.params.compaction ? 'on' : 'off') : '—'}</td>
            <td>${esc(m.params?.effort ?? '—')}</td>
            <td class="chg">${i === 0 ? '<span class="ref">reference</span>'
              : m.same ? '<span class="warnflag">nothing &mdash; identical to baseline</span>'
              : esc(m.diff.join(', ') || '—')}</td></tr>`).join('\n          ')}
        </tbody>
      </table>
      ${dupes.length ? `<p class="dupe"><b>${dupes.map((m, i) => esc(armName(m, rows.indexOf(m)))).join(', ')}</b>
        ${dupes.length > 1 ? 'vary' : 'varies'} nothing the baseline did not already do. Whatever
        ${dupes.length > 1 ? 'they' : 'it'} scored is run-to-run variance on the same configuration &mdash;
        read it as a noise floor for this task, not as a result.</p>` : ''}
    </div>
  </section>`}

  <section>
    <h2>Raw numbers</h2>
    <div class="card">
      <table>
        <thead>${metricHead}</thead>
        <tbody>
          ${METRICS.map(metricRow).join('\n          ')}
        </tbody>
      </table>
    </div>
  </section>

  <section>
    <h2>What each session was given</h2>
    <div class="cols">
      ${leverRows}
    </div>
  </section>

  ${docSection}

  <section${isDoc ? ' hidden' : ''}>
    <h2>Which tests each session missed</h2>
    <div class="cols">
      ${failRows}
    </div>
  </section>

  ${data.caveat ? `<section>
    <h2>Read this carefully</h2>
    <p class="note">${esc(data.caveat)}</p>
  </section>` : `<section>
    <h2>Read this carefully</h2>
    <p class="note"><b>n = 1 per arm.</b> Agent runs vary substantially between passes. This shows the
    shape of a difference, not a defensible number — three repeats per arm is the minimum before
    quoting any figure. ${ran ? '' : '<b>This run produced no usable measurements</b>, so the chart above is empty. '}The
    optimized arm is <b>expected</b> to win on cost; that is the hypothesis, not a finding. The open
    questions are whether correctness survives, and by how much the gap moves. ${A?.model && B?.model && A.model !== B.model
      ? `The two arms run <b>different models</b>, so this <b>is</b> a measurement of model routing and of nothing else — any prompt or scaffolding difference would confound it.`
      : `The model is held fixed across both arms, so nothing here measures model routing — which was the single largest lever in the source material.`}
    ${dupes.length ? `<b>One arm in this run varied nothing.</b> Its delta against the baseline is the
    spread you get from running the same configuration twice, which is worth knowing &mdash; it is the
    floor below which no result here means anything &mdash; but it is not a finding. ` : ''}A task that
    rewards planning can rank two configurations differently from one that rewards editing. And the optimized arm's scaffolding cost a human time to write, which this comparison
    prices at zero.</p>
  </section>`}

  <footer>${esc(data.footer ?? 'task: sheet.py formula engine · grader: 47 hidden tests injected post-exit')} · results/${esc(id)}/</footer>
</div>
`
}

// ---------------------------------------------------------------- main
if (import.meta.url === `file://${process.argv[1]}`) {
  const run = loadRun(process.argv[2])
  const out = path.join(run.dir, 'report.html')
  fs.writeFileSync(out, buildHtml(run))
  console.log(`wrote ${path.relative(ROOT, out)}`)
}
