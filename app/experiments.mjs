/**
 * experiments.mjs — what an experiment changed, what it cost, and what to do
 * about it.
 *
 * `opt experiments ls` answers "what ran". This answers the question after it:
 * one arm beat the other — by what, by how much, and what would I have to put in
 * my own project to get that?
 *
 * Three things are read for each run:
 *
 *   run.json         the arms, their levers, their results
 *   status.json      the same for a run still in flight
 *   scenarios/<id>.md  the definition — the flags, files, prompt and env that
 *                    made the optimized arm different, which is what "how to
 *                    apply this" actually means
 */
import http from 'node:http'
import { STATE } from './lib/state.mjs'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', c: '\x1b[36m', m: '\x1b[35m',
            d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }

const readIf = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } }
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }

/**
 * Metrics, and which direction is good. Correctness is the only one where more
 * is better; everything else is a cost of some kind.
 */
export const METRICS = [
  { key: 'pass', label: 'correctness', unit: 'ratio', higherIsBetter: true,
    note: 'share of the hidden suite that passed' },
  { key: 'cost', label: 'cost', unit: 'usd', higherIsBetter: false,
    note: 'what the arm billed' },
  { key: 'tokens', label: 'tokens', unit: 'count', higherIsBetter: false,
    note: 'everything billed, cache reads included' },
  { key: 'turns', label: 'turns', unit: 'count', higherIsBetter: false,
    note: 'assistant turns before it stopped' },
  { key: 'wallSec', label: 'wall time', unit: 'sec', higherIsBetter: false,
    note: 'start to finish for the arm' },
  { key: 'cacheHit', label: 'cache reuse', unit: 'ratio', higherIsBetter: true,
    note: 'share of input tokens served from cache' },
]

function armMetrics(rec) {
  const r = rec.result ?? {}
  const u = r.usage ?? {}
  const inp = u.input_tokens ?? 0, cw = u.cache_creation_input_tokens ?? 0
  const cr = u.cache_read_input_tokens ?? 0, out = u.output_tokens ?? 0
  const g = rec.grade ?? {}
  const billedIn = inp + cw + cr
  return {
    pass: g.total ? g.passed / g.total : null,
    passed: g.passed ?? null, total: g.total ?? null,
    cost: rec.trueCost ?? r.total_cost_usd ?? rec.cost ?? null,
    tokens: billedIn + out || null,
    turns: r.num_turns ?? rec.turns ?? rec.steps?.agent?.turns ?? null,
    wallSec: rec.totalWallSec ?? rec.wallSec ?? null,
    cacheHit: billedIn ? cr / billedIn : null,
    thinking: u.output_tokens_details?.thinking_tokens ?? null,
    linesOfCode: rec.linesOfCode ?? null,
    errored: !!(r.is_error || (rec.fatal && !(g.total > 0))),
    errorText: r.is_error ? String(r.result ?? '').slice(0, 300)
      : (rec.fatal ? String(rec.fatal).split('\n')[0] : null),
    // A fatal after grading is a harness problem worth showing, but it does not
    // invalidate the measurement it followed.
    harnessFatal: rec.fatal && g.total > 0 ? String(rec.fatal).split('\n')[0] : null,
  }
}

/** Frontmatter of a scenario file — the levers, in the form you would reuse. */
function scenarioConfig(ROOT, id) {
  const src = readIf(path.join(ROOT, 'scenarios', `${id}.md`))
  if (!src) return null
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(src)
  if (!m) return { strategy: src.trim() }
  const meta = {}
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim()
  }
  return {
    description: meta.description ?? '',
    flags: (meta.flags ?? '').trim(),
    files: (meta.files ?? '').split(/\s+/).filter(Boolean),
    agents: meta.agents ?? null,
    env: (meta.env ?? '').split(/\s+/).filter(Boolean),
    setup: meta.setup ?? null,
    service: meta.service ?? null,
    ready: meta.ready ?? null,
    teardown: meta.teardown ?? null,
    aws: /^(1|true|yes)$/i.test(meta.aws ?? ''),
    budget: meta.budget ?? null,
    strategy: (m[2] ?? '').trim(),
  }
}

/**
 * How you would actually get this configuration, as things you can paste.
 * A lever that lives in a prompt is not the same kind of change as one that
 * lives in a flag, so they are kept apart rather than flattened into prose.
 */
function howToApply(cfg) {
  if (!cfg) return []
  const out = []
  if (cfg.flags)
    out.push({ kind: 'CLI flags', how: `claude ${cfg.flags}`,
               note: 'add to the command, or set the equivalents in .claude/settings.json' })
  if (cfg.env.length)
    out.push({ kind: 'environment', how: cfg.env.join('\n'),
               note: 'exported before the agent starts' })
  if (cfg.files.length)
    out.push({ kind: 'workspace files', how: cfg.files.join('\n'),
               note: 'copied into the working directory from assets/' })
  if (cfg.agents)
    out.push({ kind: 'subagents', how: `--agents "$(cat ${cfg.agents})"`,
               note: 'a cheaper model for delegated work is the usual win here' })
  if (cfg.strategy)
    out.push({ kind: 'prompt', how: cfg.strategy,
               note: 'appended to the task prompt — the cheapest lever to try, and the easiest to get wrong' })
  if (cfg.setup)
    out.push({ kind: 'sandbox setup', how: cfg.setup, note: 'runs before the agent' })
  if (cfg.service)
    out.push({ kind: 'background service', how: cfg.service,
               note: 'the arm talks to this instead of the default endpoint' })
  return out
}

/**
 * A scenario id is a filename; it says nothing to anyone who has not read the
 * file. The description's first clause is what the experiment is actually
 * testing, so that becomes the name and the id becomes the subtitle.
 */
export function strategyTitle(cfg, id) {
  const d = (cfg?.description ?? '').trim()
  if (!d) return id.replace(/[-_]/g, ' ')
  const first = d.split(/(?<=[.;:])\s|\s[-\u2014]\s/)[0].trim().replace(/[.;:]$/, '')
  return first.length > 76 ? first.slice(0, 75).trimEnd() + '\u2026' : first
}

/**
 * What each arm was *given* — the inputs, before anything it did with them.
 *
 * Deliberately narrow: the model, how much prompt it had to read, and how much
 * that prompt asks for. Everything else an arm differs by is a lever, and levers
 * belong under "how to apply", not here.
 */
const words = (t) => (t ?? '').split(/\s+/).filter(Boolean).length

/**
 * A rough count of what the prompt actually demands: bullet and numbered items,
 * plus sentences that read as instructions. It is a proxy, not a measurement —
 * two prompts of the same length can ask for very different amounts, and this
 * is the cheapest signal that separates them.
 */
function directives(text) {
  if (!text) return 0
  const t = text.replace(/```[\s\S]*?```/g, ' ')
  const bullets = (t.match(/^\s*(?:[-*+]|\d+[.)])\s+/gm) ?? []).length
  const sentences = (t.match(/[^.!?\n]{12,}[.!?]/g) ?? []).length
  return bullets + sentences
}

/**
 * The model an arm actually talked to. When a scenario points Claude Code at a
 * proxy, the harness's `--model` is just the name on the request — the weights
 * answering are whatever the proxy routes to, and that is what belongs here.
 */
function effectiveModel({ ROOT, cfg, isBaseline, model }) {
  if (isBaseline || !cfg) return model ?? '—'
  const swapped = cfg.env.some((e) => e.startsWith('ANTHROPIC_BASE_URL=')) || cfg.service
  if (!swapped) return model ?? '—'
  for (const f of cfg.files ?? []) {
    const y = readIf(path.join(ROOT, 'assets', f))
    const m = y && /^\s*model:\s*(\S+)/m.exec(y)
    if (m) return m[1].replace(/^bedrock\//, '') + ' (via proxy)'
  }
  return `${model ?? 'claude'} → proxied`
}

export function armInputs({ ROOT, task, cfg, isBaseline, model }) {
  const base = readIf(path.join(ROOT, 'lib', 'BASE_PROMPT.md')) ?? ''
  const spec = task ? (readIf(path.join(ROOT, 'tasks', task, 'SPEC.md')) ?? '') : ''
  const strategy = isBaseline ? '' : (cfg?.strategy ?? '')
  const prompt = strategy ? `${base}\n\n${strategy}` : base

  return [
    { k: 'model', v: effectiveModel({ ROOT, cfg, isBaseline, model }) },
    { k: 'prompt size', v: `${words(prompt)} words${strategy ? ` (+${words(strategy)} strategy)` : ''}`,
      d: !strategy },
    { k: 'prompt complexity', v: `${directives(prompt)} directives${strategy ? ` (+${directives(strategy)})` : ''}`,
      d: !strategy },
    { k: 'spec', v: spec ? `${words(spec)} words, ${directives(spec)} directives` : 'none', d: true },
  ]
}

/** What the arm left behind, as pulled back from its sandbox. */
const BOOKKEEPING = new Set(['result.json', 'stream.jsonl', 'setup.txt', 'teardown.txt', 'claude.err'])
function armArtifacts(runDir, armId) {
  const dir = path.join(runDir, armId ?? '')
  if (!armId || !fs.existsSync(dir)) return []
  try {
    return fs.readdirSync(dir)
      .filter((f) => !f.startsWith('.') && !BOOKKEEPING.has(f))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f))
        if (!st.isFile()) return null
        let lines = null
        try { lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').length } catch {}
        return { name: f, bytes: st.size, lines }
      })
      .filter(Boolean)
      .sort((a, b) => b.bytes - a.bytes)
  } catch { return [] }
}

/** One line for a table cell. */
export const paramsBrief = (params) => {
  const g = (k) => params.find((p) => p.k === k)?.v ?? ''
  return [g('model'), g('prompt size').replace(' words', 'w'),
          g('prompt complexity').replace(' directives', 'd')].filter(Boolean).join(' · ')
}

/** Every run on disk, newest first, with both arms compared. */
export function collectExperiments(ROOT) {
  const RESULTS = path.join(STATE, 'results')
  if (!fs.existsSync(RESULTS)) return []
  const out = []

  for (const runId of fs.readdirSync(RESULTS).filter((d) => !d.startsWith('.')).sort().reverse()) {
    const dir = path.join(RESULTS, runId)
    if (!fs.statSync(dir).isDirectory()) continue
    const final = readJson(path.join(dir, 'run.json'))
    const status = readJson(path.join(dir, 'status.json'))
    if (!final && !status) continue

    const scenario = final?.experiment ?? status?.experiment ?? '—'
    const arms = (final?.arms ?? Object.values(status?.arms ?? {})).map((a) => ({
      id: a.arm, label: a.label ?? a.arm, levers: a.levers ?? [],
      step: a.fatal && !a.grade ? 'failed' : (final ? 'done' : (a.step ?? 'unknown')),
      sandboxId: a.sandboxId ?? null,
      metrics: armMetrics(a),
    }))
    // The control is whichever arm is stock; a run may rename it.
    const baseIdx = Math.max(0, arms.findIndex((a) => /^(control|baseline)$/.test(a.id)))
    // The two arms are a baseline and an optimized variant of it, whatever the
    // run happened to call them. That relationship is the thing worth naming.
    arms.forEach((a, i) => { a.role = i === baseIdx ? 'baseline' : 'optimized' })
    const base = arms[baseIdx] ?? null
    const opt = arms.find((a, i) => i !== baseIdx) ?? null
    const cfg = scenarioConfig(ROOT, scenario)

    // An arm that errored spent less because it did less. Reporting that as a
    // cost improvement is the single most misleading thing this view could do,
    // so a run where either arm failed reports its numbers without a verdict.
    const unusable = !!(base?.metrics?.errored || opt?.metrics?.errored)
    const deltas = {}
    for (const m of METRICS) {
      const a = base?.metrics?.[m.key], b = opt?.metrics?.[m.key]
      if (a == null || b == null) { deltas[m.key] = null; continue }
      if (unusable) { deltas[m.key] = { base: a, opt: b, pct: null, verdict: 'n/a' }; continue }
      const pct = a === 0 ? (b === 0 ? 0 : null) : ((b - a) / Math.abs(a)) * 100
      const better = m.higherIsBetter ? b > a : b < a
      const same = a === b || (pct != null && Math.abs(pct) < 0.5)
      deltas[m.key] = { base: a, opt: b, pct, verdict: same ? 'flat' : (better ? 'improved' : 'degraded') }
    }

    out.push({
      runId, dir, scenario, task: final?.task ?? status?.task ?? null,
      taskTitle: final?.taskTitle ?? status?.taskTitle ?? null,
      description: final?.description ?? cfg?.description ?? null,
      model: final?.model ?? status?.model ?? null,
      auth: final?.auth ?? null,
      complete: !!final, updatedAt: status?.updatedAt ?? null,
      arms, baseline: base, optimized: opt, deltas, unusable,
      strategy: strategyTitle(cfg, scenario),
      baselineParams: armInputs({ ROOT, task: final?.task ?? status?.task, cfg, isBaseline: true,
                                  model: final?.model ?? status?.model }),
      optimizedParams: armInputs({ ROOT, task: final?.task ?? status?.task, cfg, isBaseline: false,
                                   model: final?.model ?? status?.model }),
      baselineArtifacts: armArtifacts(dir, base?.id),
      optimizedArtifacts: armArtifacts(dir, opt?.id),
      config: cfg, apply: howToApply(cfg),
      hasReport: fs.existsSync(path.join(dir, 'report.html')),
    })
  }
  return out
}

/** The one-line verdict: what actually moved, and in which direction. */
export function headline(e) {
  const d = e.deltas
  if (!e.optimized || !e.baseline) return { text: 'single arm — nothing to compare', tone: 'flat' }
  const bo = e.baseline.metrics.errored, oo = e.optimized.metrics.errored
  if (bo || oo) {
    const who = bo && oo ? 'both arms' : (oo ? 'optimized arm' : 'baseline arm')
    return { text: `${who} errored`, tone: 'degraded',
             detail: 'an arm that fails spends less because it does less — the numbers are not comparable' }
  }
  const corr = d.pass
  const cost = d.cost
  if (corr && corr.verdict !== 'flat')
    return { text: `correctness ${corr.verdict} ${corr.pct > 0 ? '+' : ''}${corr.pct?.toFixed(0)}%`,
             tone: corr.verdict }
  if (cost && cost.verdict !== 'flat')
    return { text: `cost ${cost.verdict} ${cost.pct > 0 ? '+' : ''}${cost.pct?.toFixed(0)}%`,
             tone: cost.verdict, detail: 'correctness unchanged' }
  return { text: 'no measurable difference', tone: 'flat' }
}

// ---------------------------------------------------------------- browser

export function experimentsPayload(ROOT) {
  return {
    now: Date.now(),
    experiments: collectExperiments(ROOT).map((e) => ({
      ...e, headline: headline(e),
      baselineBrief: paramsBrief(e.baselineParams),
      optimizedBrief: paramsBrief(e.optimizedParams),
    })),
  }
}

const PAGE = String.raw`<!doctype html><html><head><meta charset="utf-8">
<title>experiments</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;700;800&family=JetBrains+Mono:wght@400;500;700&family=Source+Serif+4:opsz,wght@8..60,400&display=swap">
<style>
:root{--ground:#F3F5F5;--surface:#FFF;--ink:#12181A;--muted:#5A6B6E;--rule:#D7DEDE;--rs:#B4BFBF;
 --a:#A8611F;--as:#F7EDE1;--b:#0E6E65;--bs:#E1F0EE;--bad:#B3402B;--bads:#FBECE8;
 --d:'Archivo',system-ui,sans-serif;--bd:'Source Serif 4',Georgia,serif;--m:'JetBrains Mono',ui-monospace,monospace}
@media (prefers-color-scheme:dark){:root{--ground:#0D1214;--surface:#151B1E;--ink:#E3EAE9;--muted:#8B9C9E;
 --rule:#232D30;--rs:#37474A;--a:#E2A462;--as:#2B2015;--b:#46BFAF;--bs:#0E2A27;--bad:#E58B72;--bads:#2C1714}}
*{box-sizing:border-box}body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--bd);font-size:15px;line-height:1.55}
.wrap{max-width:1400px;margin:0 auto;padding:36px 22px 64px;display:flex;flex-direction:column;gap:22px}
.eyebrow{font-family:var(--m);font-size:10.5px;letter-spacing:.15em;text-transform:uppercase;color:var(--muted)}
h1{font-family:var(--d);font-weight:800;font-size:32px;letter-spacing:-.025em;margin:6px 0 0}
.sub{color:var(--muted);font-size:14.5px;margin:8px 0 0;max-width:66ch}
table{width:100%;border-collapse:collapse;font-size:13.5px;background:var(--surface);border:1px solid var(--rule);table-layout:fixed}
col.c-run{width:15%}col.c-strategy{width:22%}col.c-task{width:7%}col.c-base{width:11%}
col.c-opt{width:17%}col.c-score{width:9%}col.c-cost{width:7%}col.c-verdict{width:12%}
td{overflow-wrap:anywhere}
.strat{font-size:13.5px;line-height:1.35}
.brief{font-family:var(--m);font-size:11.5px;line-height:1.5}
th,td{padding:9px 11px;border-bottom:1px solid var(--rule);text-align:left;vertical-align:top}
thead th{font-family:var(--m);font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--rs);white-space:nowrap;cursor:pointer;user-select:none}
thead th:hover{color:var(--ink)}thead th.sorted{color:var(--b)}
thead th .car{opacity:.55;margin-left:4px;font-size:9px}
tbody tr{cursor:pointer}tbody tr:hover{background:var(--bs)}tbody tr.on{background:var(--bs);box-shadow:inset 2px 0 0 var(--b)}
.mono{font-family:var(--m);font-size:12px;white-space:nowrap}
.num{text-align:right;font-family:var(--m);font-variant-numeric:tabular-nums;white-space:nowrap}
.num.good{color:var(--b);font-weight:700}
.num.bad{color:var(--bad);font-weight:700}
.pill{font-family:var(--m);font-size:11px;padding:2px 8px;border:1px solid var(--rule);display:inline-block}
.pill.improved{color:var(--b);border-color:var(--b);background:var(--bs)}
.pill.degraded{color:var(--bad);border-color:var(--bad);background:var(--bads)}
.pill.flat{color:var(--muted)}
.pill\.na,.pill.na{color:var(--muted);border-style:dashed}
.scrim{position:fixed;inset:0;background:rgba(10,16,18,.42);backdrop-filter:blur(2px);z-index:40;
 display:flex;align-items:flex-start;justify-content:center;padding:26px 18px;overflow:auto}
@media (prefers-color-scheme:dark){.scrim{background:rgba(0,0,0,.62)}}
.sheet{position:relative;width:100%;max-width:1080px;background:var(--surface);border:1px solid var(--rule);
 border-top:3px solid var(--b);box-shadow:0 26px 70px rgba(10,16,18,.28);margin:auto;padding:22px 24px 26px;
 display:flex;flex-direction:column;gap:20px}
.x{position:absolute;top:10px;right:12px;font-family:var(--m);font-size:16px;line-height:1;padding:5px 9px;
 border:1px solid var(--rule);background:var(--surface);color:var(--muted);cursor:pointer}
.x:hover{color:var(--ink);border-color:var(--rs)}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:18px}
@media(max-width:820px){.cols{grid-template-columns:1fr}}
.pane{border:1px solid var(--rule);border-top:2px solid var(--rs);padding:13px 15px}
.pane.base{border-top-color:var(--muted)}.pane.opt{border-top-color:var(--a)}
.pane h4{font-family:var(--d);font-size:14px;margin:0 0 8px;letter-spacing:.02em;text-transform:uppercase}
table.params{width:100%;border-collapse:collapse;font-family:var(--m);font-size:11.5px}
table.params td{padding:3px 0;border:none;vertical-align:top}
table.params .pk{color:var(--muted);width:11.5em;padding-right:12px;white-space:normal}
table.params .pv{overflow-wrap:anywhere}
table.params .pv.dim{color:var(--muted)}
.pane.opt h4{color:var(--a)}
.lev{font-family:var(--m);font-size:11.5px;color:var(--muted);display:flex;flex-direction:column;gap:4px}
.apply{border:1px solid var(--rule);border-left:2px solid var(--b);padding:11px 13px;display:flex;flex-direction:column;gap:6px}
.apply .k{font-family:var(--m);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--b)}
.apply pre{margin:0;font-family:var(--m);font-size:11.5px;white-space:pre-wrap;word-break:break-word;
 background:var(--ground);padding:9px 10px;border:1px solid var(--rule);max-height:220px;overflow:auto}
.apply .why{font-size:13px;color:var(--muted)}
.copy{align-self:flex-start;font-family:var(--m);font-size:10.5px;padding:3px 8px;border:1px solid var(--rule);
 background:var(--surface);color:var(--muted);cursor:pointer}
.copy:hover{color:var(--ink);border-color:var(--rs)}
.foot{font-family:var(--m);font-size:10.5px;color:var(--muted);border-top:1px solid var(--rule);padding-top:12px}
.note{font-family:var(--m);font-size:10.5px;color:var(--muted);border-left:2px solid var(--rule);padding-left:10px}
.empty{color:var(--muted);font-family:var(--m);font-size:12px}
</style></head><body><div class="wrap" id="root">loading…</div>
<script>
const esc=(s)=>String(s??'').replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const pct=(v)=>v==null?'—':(v>0?'+':'')+v.toFixed(v>=100||v<=-100?0:1)+'%';
const dur=(s)=>s==null?'—':s<90?Math.round(s)+'s':Math.floor(s/60)+'m'+String(Math.round(s%60)).padStart(2,'0')+'s';
const fmt=(key,v)=>{
  if(v==null)return '—';
  if(key==='pass'||key==='cacheHit')return (v*100).toFixed(1)+'%';
  if(key==='cost')return '$'+v.toFixed(4);
  if(key==='wallSec')return dur(v);
  return Math.round(v).toLocaleString('en-US');
};
let DATA=null, sel=0, open=false;
let sortKey='run', sortDir=-1;
// key, header, numeric, accessor
const COLUMNS=[
  ['run','run',false,(e)=>e.runId],
  ['strategy','strategy',false,(e)=>e.strategy],
  ['task','task',false,(e)=>e.task||''],
  ['base','baseline parameters',false,(e)=>e.baselineBrief],
  ['opt','optimized parameters',false,(e)=>e.optimizedBrief],
  ['score','score',true,(e)=>e.optimized&&e.optimized.metrics.pass!=null?e.optimized.metrics.pass:null],
  ['cost','cost Δ',true,(e)=>e.deltas.cost?e.deltas.cost.pct:null],
  ['verdict','verdict',false,(e)=>e.headline.text],
];
const COL=Object.fromEntries(COLUMNS.map((c)=>[c[0],c]));
function sortRows(rows){
  const [,,numeric,get]=COL[sortKey]||COL.run;
  return rows.slice().sort((a,b)=>{
    const x=get(a),y=get(b);
    const xm=x==null||x==='',ym=y==null||y==='';
    if(xm||ym)return xm&&ym?0:(xm?1:-1);
    return (numeric?(x-y):String(x).localeCompare(String(y),undefined,{numeric:true}))*sortDir;
  });
}

function metricsTable(e){
  const rows=DATA.metrics.map((m)=>{
    const d=e.deltas[m.key];
    if(!d)return '<tr><td>'+esc(m.label)+'</td><td class="num">—</td><td class="num">—</td><td class="num">—</td><td><span class="pill flat">no data</span></td></tr>';
    const tone=d.verdict==='improved'?'good':d.verdict==='degraded'?'bad':'';
    return '<tr><td>'+esc(m.label)+'<div style="font-size:12px;color:var(--muted)">'+esc(m.note)+'</div></td>'+
      '<td class="num">'+fmt(m.key,d.base)+'</td>'+
      '<td class="num '+tone+'">'+fmt(m.key,d.opt)+'</td>'+
      '<td class="num '+tone+'">'+pct(d.pct)+'</td>'+
      '<td><span class="pill '+(d.verdict==='n/a'?'na':d.verdict)+'">'+d.verdict+'</span></td></tr>';
  }).join('');
  return '<table><thead><tr><th>metric</th><th class="num">baseline</th><th class="num">optimized</th>'+
    '<th class="num">delta</th><th>verdict</th></tr></thead><tbody>'+rows+'</tbody></table>';
}

function pane(cls,title,arm,params){
  if(!arm)return '<div class="pane '+cls+'"><h4>'+title+'</h4><p class="empty">no arm</p></div>';
  const rows=(params||[]).map((p)=>
    '<tr><td class="pk">'+esc(p.k)+'</td><td class="pv'+(p.d?' dim':'')+'">'+esc(p.v)+'</td></tr>').join('');
  return '<div class="pane '+cls+'"><h4>'+title+'</h4>'+
    '<div class="mono" style="font-size:11px;color:var(--muted);margin:-4px 0 9px">ran as “'+esc(arm.id)+'”</div>'+
    '<table class="params">'+rows+'</table>'+
    (arm.levers.length?'<div class="lev" style="margin-top:10px">'+
      arm.levers.map((l)=>'<span>· '+esc(l)+'</span>').join('')+'</div>':'')+'</div>';
}

function artifactList(list){
  if(!list||!list.length)return '<p class="empty">nothing was produced</p>';
  return '<table class="params">'+list.map((a)=>
    '<tr><td class="pk" style="width:auto">'+esc(a.name)+'</td>'+
    '<td class="pv" style="text-align:right;white-space:nowrap">'+
    (a.lines!=null?a.lines+' lines · ':'')+(a.bytes/1024).toFixed(1)+' KB</td></tr>').join('')+'</table>';
}

function artifactsBlock(e){
  return '<div><div class="eyebrow">produced artifacts</div><div class="cols" style="margin-top:8px">'+
    '<div class="pane base"><h4>baseline</h4>'+artifactList(e.baselineArtifacts)+'</div>'+
    '<div class="pane opt"><h4>optimized</h4>'+artifactList(e.optimizedArtifacts)+'</div>'+
    '</div><p class="note" style="margin-top:10px">Pulled back from each sandbox when the arm finished. '+
    'Line counts are what the agent wrote, not what passed.</p></div>';
}

function sheet(e){
  const h=e.headline;
  return '<div class="scrim" id="scrim"><div class="sheet">'+
    '<button class="x" id="close" title="close (esc)">×</button>'+
    '<div><div class="eyebrow">experiment</div><h1 style="font-size:24px">'+esc(e.scenario)+
      ' <span style="color:var(--muted);font-weight:600">· '+esc(e.task||'')+'</span></h1>'+
      '<p class="sub">'+esc(e.description||'')+'</p>'+
      '<p style="margin:10px 0 0"><span class="pill '+h.tone+'">'+esc(h.text)+'</span></p></div>'+
    '<div><div class="eyebrow">baseline \u2192 optimized</div><div class="cols" style="margin-top:8px">'+
      pane('base','baseline',e.baseline,e.baselineParams)+
      pane('opt','optimized',e.optimizedParams?e.optimized:null,e.optimizedParams)+'</div></div>'+
    '<div><div class="eyebrow">what moved</div><div style="margin-top:8px">'+metricsTable(e)+'</div>'+
      '<p class="note" style="margin-top:10px">n = 1 per arm. A gap under ~15% in cost or turns is not '+
      'distinguishable from run-to-run variance; correctness differences of a test or two usually are not either.'+
      (e.unusable?' <b>One arm errored here</b> — it spent less because it did less, so no verdict is drawn.':'')+
      '</p></div>'+
    (e.apply.length
      ? '<div><div class="eyebrow">how to apply this</div><div style="display:flex;flex-direction:column;gap:10px;margin-top:8px">'+
        e.apply.map((a,i)=>'<div class="apply"><span class="k">'+esc(a.kind)+'</span>'+
          '<pre id="ap'+i+'">'+esc(a.how)+'</pre><span class="why">'+esc(a.note)+'</span>'+
          '<button class="copy" data-copy="ap'+i+'">copy</button></div>').join('')+'</div></div>'
      : '<p class="empty">this scenario declares no configuration — the arms differ only in what the harness did.</p>')+
    artifactsBlock(e)+
    '<div class="foot">'+esc(e.runId)+(e.hasReport?' · report.html in results/':'')+'</div>'+
  '</div></div>';
}

function draw(){
  const y=window.scrollY;
  const E=DATA.experiments;
  if(!E.length){document.getElementById('root').innerHTML='<h1>experiments</h1><p class="sub">nothing has run yet.</p>';return}
  if(sel>=E.length)sel=E.length-1;
  const view=sortRows(E);
  DATA.view=view;
  const score=(e)=>{
    const b=e.baseline&&e.baseline.metrics.total?e.baseline.metrics.passed+'/'+e.baseline.metrics.total:'—';
    const o=e.optimized&&e.optimized.metrics.total?e.optimized.metrics.passed+'/'+e.optimized.metrics.total:'—';
    return b+' → '+o;
  };
  const rows=view.map((e,i)=>'<tr data-i="'+i+'"'+(i===sel&&open?' class="on"':'')+'>'+
    '<td class="mono">'+esc(e.runId.length>22?e.runId.slice(0,22)+'…':e.runId)+'</td>'+
    '<td><div class="strat">'+esc(e.strategy)+'</div><div class="mono" style="color:var(--a);font-size:11px">'+esc(e.scenario)+'</div></td>'+
    '<td class="mono" style="color:var(--muted)">'+esc(e.task||'—')+'</td>'+
    '<td class="brief" style="color:var(--muted)">'+esc(e.baselineBrief)+'</td>'+
    '<td class="brief" style="color:var(--a)">'+esc(e.optimizedBrief)+'</td>'+
    '<td class="num'+(e.deltas.pass&&e.deltas.pass.verdict==='improved'?' good':e.deltas.pass&&e.deltas.pass.verdict==='degraded'?' bad':'')+'">'+score(e)+'</td>'+
    '<td class="num'+(e.deltas.cost?(e.deltas.cost.verdict==='improved'?' good':e.deltas.cost.verdict==='degraded'?' bad':''):'')+'">'+
      (e.deltas.cost?pct(e.deltas.cost.pct):'—')+'</td>'+
    '<td><span class="pill '+e.headline.tone+'">'+esc(e.headline.text)+'</span>'+
    (e.headline.detail?'<div style="font-size:11.5px;color:var(--muted);margin-top:4px">'+esc(e.headline.detail)+'</div>':'')+
    '</td></tr>').join('');

  const head=COLUMNS.map(([k,label,num])=>
    '<th data-k="'+k+'" class="'+(num?'num ':'')+(sortKey===k?'sorted':'')+'">'+label+
    (sortKey===k?'<span class="car">'+(sortDir<0?'▼':'▲')+'</span>':'')+'</th>').join('');
  const cols=COLUMNS.map(([k])=>'<col class="c-'+k+'">').join('');

  document.getElementById('root').innerHTML=
    '<div><div class="eyebrow">opt experiments</div><h1>what each experiment changed</h1>'+
    '<p class="sub">One row per run: the stock baseline, the optimized arm, and what actually moved between '+
    'them. Click a row for the two configurations side by side and what you would put in your own project to get it.</p></div>'+
    '<table>'+cols+'<thead><tr>'+head+'</tr></thead><tbody>'+rows+'</tbody></table>'+
    (open?sheet(view[sel]):'')+
    '<div class="foot">refreshes every 10s · click a row · click a column to sort · esc closes'+
      (sortKey!=='run'?' · sorted by '+COL[sortKey][1]+', '+(sortDir<0?'high to low':'low to high'):'')+'</div>';

  window.scrollTo(0,y);
  for(const tr of document.querySelectorAll('tbody tr'))
    tr.onclick=()=>{sel=+tr.dataset.i;open=true;draw()};
  for(const th of document.querySelectorAll('thead th'))
    th.onclick=()=>{const k=th.dataset.k;
      if(sortKey===k)sortDir=-sortDir; else{sortKey=k;sortDir=COL[k][2]?-1:1}
      open=false;draw()};
  const sc=document.getElementById('scrim');
  if(sc)sc.onclick=(ev)=>{if(ev.target===sc){open=false;draw()}};
  const x=document.getElementById('close');
  if(x)x.onclick=()=>{open=false;draw()};
  for(const b of document.querySelectorAll('.copy'))
    b.onclick=()=>{const el=document.getElementById(b.dataset.copy);
      navigator.clipboard.writeText(el.textContent).then(()=>{b.textContent='copied';setTimeout(()=>b.textContent='copy',1200)}).catch(()=>{})};
}

document.addEventListener('keydown',(e)=>{
  if(!DATA)return;
  if(e.key==='Escape'&&open){open=false;draw();e.preventDefault()}
  if(e.key==='ArrowDown'){sel=Math.min((DATA.view||DATA.experiments).length-1,sel+1);draw();e.preventDefault()}
  if(e.key==='ArrowUp'){sel=Math.max(0,sel-1);draw();e.preventDefault()}
});

async function tick(){
  try{const r=await fetch('/data',{cache:'no-store'});DATA=await r.json();draw()}catch(e){}
}
tick();setInterval(tick,10000);
</script></body></html>`

export function startExperimentsUi(ROOT, { port = 8794, open = true } = {}) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/data')) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ...experimentsPayload(ROOT), metrics: METRICS }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  })
  return new Promise((resolve) => {
    server.on('error', () => resolve({ error: `port ${port} busy` }))
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${port}/`
      if (open) {
        const o = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
        try { spawn(o, [url], { detached: true, stdio: 'ignore' }).unref() } catch {}
      }
      resolve({ url, server })
    })
  })
}
