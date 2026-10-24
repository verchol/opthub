/**
 * `opt status ui` — a live view of a run, served locally and refreshed in place.
 * Shows the shared task, per-arm progress against an ETA learned from past runs,
 * and a metrics comparison that fills in while the agents work.
 */
import http from 'node:http'
import { STATE } from './lib/state.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const DEFAULT_ETA = 260   // seconds, until history says otherwise

/** Median agent duration for this scenario+arm across previous completed runs. */
export function etaFor(resultsDir, scenario, armId) {
  const secs = []
  if (fs.existsSync(resultsDir)) {
    for (const d of fs.readdirSync(resultsDir)) {
      if (d.startsWith('0000')) continue
      try {
        const r = JSON.parse(fs.readFileSync(path.join(resultsDir, d, 'run.json'), 'utf8'))
        if (r.experiment !== scenario) continue
        const a = r.arms?.find((x) => x.arm === armId)
        const ms = a?.result?.duration_ms
        if (ms > 0) secs.push(ms / 1000)
      } catch {}
    }
  }
  if (!secs.length) return { seconds: DEFAULT_ETA, samples: 0 }
  secs.sort((a, b) => a - b)
  return { seconds: secs[Math.floor(secs.length / 2)], samples: secs.length }
}

/** Everything the page needs, recomputed on each poll. */
/** Newest run, preferring one still in flight. Re-evaluated on every poll. */
export function resolveRunId(ROOT) {
  const RESULTS = path.join(STATE, 'results')
  if (!fs.existsSync(RESULTS)) return null
  const ids = fs.readdirSync(RESULTS)
    .filter((d) => !d.startsWith('.') && !d.startsWith('0000') &&
                   fs.existsSync(path.join(RESULTS, d, 'status.json'))).sort()
  if (!ids.length) return null
  const live = ids.filter((d) => !fs.existsSync(path.join(RESULTS, d, 'run.json')))
  return live.length ? live[live.length - 1] : ids[ids.length - 1]
}

export function snapshot(ROOT, runId) {
  const RESULTS = path.join(STATE, 'results')
  const dir = path.join(RESULTS, runId)
  const rd = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { return null } }
  const status = rd('status.json')
  const final = rd('run.json')
  const scenario = final?.experiment ?? status?.experiment ?? '—'

  const taskName = final?.task ?? status?.task ?? 'sheet'
  let task = { title: final?.taskTitle ?? 'the shared task', bullets: [] }
  try {
    const spec = fs.readFileSync(path.join(ROOT, 'tasks', taskName, 'SPEC.md'), 'utf8')
    task.title = (/^#\s*(.+)$/m.exec(spec)?.[1] ?? 'the shared task').replace(/^Task:\s*/, '')
    task.bullets = [...spec.matchAll(/^\|\s*`?([A-Z]+)`?\s*\|/gm)].map((m) => m[1])
  } catch {}

  const arms = (final?.arms ?? Object.values(status?.arms ?? {})).map((a) => {
    const fromFinal = !!final
    const res = a.result ?? null
    const u = res?.usage ?? a.live ?? {}
    const startedAt = a.agentStartedAt ?? a.startedAt ?? null
    const elapsed = res?.duration_ms ? res.duration_ms / 1000
      : startedAt ? (Date.now() - Date.parse(startedAt)) / 1000 : null
    const eta = etaFor(RESULTS, scenario, a.arm)
    return {
      arm: a.arm, label: a.label ?? a.arm,
      step: fromFinal ? (a.fatal && !a.grade ? 'failed' : 'done') : a.step,
      finished: fromFinal || a.step === 'done' || a.step === 'failed',
      sandboxId: a.sandboxId ?? null,
      turns: res?.num_turns ?? a.turns ?? a.live?.turns ?? 0,
      lastTool: a.live?.lastTool ?? null,
      cost: res?.total_cost_usd ?? null,
      out: u.output_tokens ?? u.out ?? 0,
      cacheRead: u.cache_read_input_tokens ?? u.cacheRead ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? u.cacheWrite ?? 0,
      passed: a.grade?.passed ?? null, total: a.grade?.total ?? null,
      elapsed, eta: eta.seconds, etaSamples: eta.samples,
    }
  })

  return {
    runId, scenario, model: final?.model ?? status?.model ?? '—',
    description: final?.description ?? null,
    complete: !!final, updatedAt: status?.updatedAt ?? null,
    task, arms, now: Date.now(),
  }
}

// ---------------------------------------------------------------- page
const PAGE = String.raw`<!doctype html><html><head><meta charset="utf-8">
<title>run · live</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;700;800&family=JetBrains+Mono:wght@400;500;700&family=Source+Serif+4:opsz,wght@8..60,400&display=swap">
<style>
:root{--ground:#F3F5F5;--surface:#FFF;--ink:#12181A;--muted:#5A6B6E;--rule:#D7DEDE;--rs:#B4BFBF;
 --a:#A8611F;--as:#F7EDE1;--b:#0E6E65;--bs:#E1F0EE;
 --d:'Archivo',system-ui,sans-serif;--bd:'Source Serif 4',Georgia,serif;--m:'JetBrains Mono',ui-monospace,monospace}
@media (prefers-color-scheme:dark){:root{--ground:#0D1214;--surface:#151B1E;--ink:#E3EAE9;--muted:#8B9C9E;
 --rule:#232D30;--rs:#37474A;--a:#E2A462;--as:#2B2015;--b:#46BFAF;--bs:#0E2A27}}
*{box-sizing:border-box}body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--bd);font-size:15px;line-height:1.55}
.wrap{max-width:1000px;margin:0 auto;padding:36px 22px 64px;display:flex;flex-direction:column;gap:26px}
.eyebrow{font-family:var(--m);font-size:10.5px;letter-spacing:.15em;text-transform:uppercase;color:var(--muted)}
h1{font-family:var(--d);font-weight:800;font-size:32px;letter-spacing:-.025em;margin:6px 0 0}
h2{font-family:var(--d);font-weight:700;font-size:16px;letter-spacing:-.01em;margin:0 0 10px}
.meta{display:flex;flex-wrap:wrap;gap:7px;margin-top:12px}
.chip{font-family:var(--m);font-size:10.5px;padding:4px 9px;border:1px solid var(--rule);background:var(--surface);color:var(--muted)}
.chip.live{color:var(--b);border-color:var(--b)}.chip.dead{color:var(--a);border-color:var(--a)}
.task{background:var(--surface);border:1px solid var(--rule);border-left:2px solid var(--rs);padding:16px 18px}
.task p{margin:0;color:var(--muted);font-size:14.5px}.task b{color:var(--ink)}
.task .fns{font-family:var(--m);font-size:11px;color:var(--muted);margin-top:8px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:720px){.cols{grid-template-columns:1fr}}
.pane{background:var(--surface);border:1px solid var(--rule);border-top:3px solid var(--rs);padding:16px 18px;display:flex;flex-direction:column;gap:10px}
.pane.pa{border-top-color:var(--a)}.pane.pb{border-top-color:var(--b)}
.pane h3{font-family:var(--d);font-size:15px;margin:0}
.pa h3{color:var(--a)}.pb h3{color:var(--b)}
.step{font-family:var(--m);font-size:11.5px;color:var(--muted)}
.bar{height:6px;background:var(--rule);position:relative;overflow:hidden}
.bar i{position:absolute;inset:0 auto 0 0;display:block}
.pa .bar i{background:var(--a)}.pb .bar i{background:var(--b)}
.times{display:flex;justify-content:space-between;font-family:var(--m);font-size:11px;color:var(--muted)}
.kv{display:grid;grid-template-columns:1fr auto;gap:3px 10px;font-family:var(--m);font-size:11.5px}
.kv span:nth-child(odd){color:var(--muted)}.kv span:nth-child(even){text-align:right;font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th,td{padding:7px 10px;border-bottom:1px solid var(--rule);text-align:left}
thead th{font-family:var(--m);font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--rs)}
td+td,th+th{text-align:right;font-family:var(--m);font-variant-numeric:tabular-nums}
th:nth-child(2){color:var(--a)}th:nth-child(3){color:var(--b)}
td.g{color:var(--b);font-weight:700}td.r{color:var(--a);font-weight:700}
.foot{font-family:var(--m);font-size:10.5px;color:var(--muted);border-top:1px solid var(--rule);padding-top:12px}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--b);margin-right:6px;animation:p 1.4s ease-in-out infinite}
@keyframes p{0%,100%{opacity:1}50%{opacity:.25}}
@media(prefers-reduced-motion:reduce){.dot{animation:none}}
</style></head><body><div class="wrap" id="root">loading…</div>
<script>
const fmt=(s)=>s==null?'—':s<90?Math.round(s)+'s':Math.floor(s/60)+'m'+String(Math.round(s%60)).padStart(2,'0')+'s';
const n=(v)=>(v??0).toLocaleString('en-US');
const pctD=(b,a)=>a?((b-a)/a*100):null;
const sgn=(v,d=1)=>(v>=0?'+':'')+v.toFixed(d)+'%';
function row(k,a,b,hb,fa,fb){
  const d=pctD(a,b)===null?null:pctD(b,a);
  let cls='',txt='—';
  if(d!==null&&isFinite(d)){txt=sgn(d);cls=Math.abs(d)<0.05?'':((hb?d>0:d<0)?'g':'r')}
  return '<tr><td>'+k+'</td><td>'+(fa??'—')+'</td><td>'+(fb??'—')+'</td><td class="'+cls+'">'+txt+'</td></tr>';
}
async function tick(){
  let s;try{s=await(await fetch('/data',{cache:'no-store'})).json()}catch(e){return}
  const [A,B]=s.arms;
  const pane=(x,i)=>{
    if(!x)return'';
    const p=x.finished?100:Math.min(97,Math.round((x.elapsed||0)/(x.eta||260)*100));
    const left=x.finished?null:Math.max(0,(x.eta||260)-(x.elapsed||0));
    return '<div class="pane '+(i?'pb':'pa')+'">'
      +'<h3>'+(i?'optimized · '+s.scenario:'control · regular session')+'</h3>'
      +'<div class="step">'+(x.finished?'':'<span class="dot"></span>')+x.step
      +(x.lastTool?' · '+x.lastTool:'')+'</div>'
      +'<div class="bar"><i style="width:'+p+'%"></i></div>'
      +'<div class="times"><span>'+fmt(x.elapsed)+' elapsed</span><span>'
      +(x.finished?'done':(left!=null?'~'+fmt(left)+' left':''))+'</span></div>'
      +'<div class="kv">'
      +'<span>turns</span><span>'+n(x.turns)+'</span>'
      +'<span>output tokens</span><span>'+n(x.out)+'</span>'
      +'<span>cache reads</span><span>'+n(x.cacheRead)+'</span>'
      +(x.cost!=null?'<span>cost</span><span>$'+x.cost.toFixed(4)+'</span>':'')
      +(x.total?'<span>hidden suite</span><span>'+x.passed+'/'+x.total+'</span>':'')
      +'</div>'
      +'<div class="step">'+(x.sandboxId??'')+'</div></div>';
  };
  const cmp=A&&B?'<section><h2>Metrics comparison</h2><table><thead><tr><th>Metric</th><th>control</th><th>'
    +s.scenario+'</th><th>&Delta;</th></tr></thead><tbody>'
    +row('Elapsed',A.elapsed,B.elapsed,false,fmt(A.elapsed),fmt(B.elapsed))
    +row('Turns',A.turns,B.turns,false,n(A.turns),n(B.turns))
    +row('Output tokens',A.out,B.out,false,n(A.out),n(B.out))
    +row('Cache reads',A.cacheRead,B.cacheRead,true,n(A.cacheRead),n(B.cacheRead))
    +(A.cost!=null&&B.cost!=null?row('Cost (USD)',A.cost,B.cost,false,'$'+A.cost.toFixed(4),'$'+B.cost.toFixed(4)):'')
    +(A.total&&B.total?row('Hidden suite',A.passed,B.passed,true,A.passed+'/'+A.total,B.passed+'/'+B.total):'')
    +'</tbody></table></section>':'';
  const fns=s.task.bullets.length?'<div class="fns">functions under test: '+s.task.bullets.join(' · ')+'</div>':'';
  document.getElementById('root').innerHTML=
    '<header><div class="eyebrow">live run</div><h1>'+(s.complete?'Finished':'Running')+' · '+s.scenario+'</h1>'
    +'<div class="meta"><span class="chip">'+s.runId+'</span><span class="chip">model '+s.model+'</span>'
    +'<span class="chip '+(s.complete?'dead':'live')+'">'+(s.complete?'complete':'in progress')+'</span>'
    +'<span class="chip">eta from '+(A?A.etaSamples:0)+' past run(s)</span></div></header>'
    +'<div class="task"><h2>Both sessions are building the same thing</h2>'
    +'<p><b>'+s.task.title+'</b> — one Python module, standard library only: a recursive-descent '
    +'formula parser with operator precedence, bijective base-26 columns, ranges whose corners may be '
    +'given in any order, aggregate functions, cycle detection that recovers, and four precisely '
    +'specified exception types. Graded by <b>47 hidden tests</b> written into each sandbox only '
    +'after the agent exits.</p>'+fns+'</div>'
    +'<div class="cols">'+pane(A,0)+pane(B,1)+'</div>'+cmp
    +'<div class="foot">refreshed '+new Date().toLocaleTimeString()+' · control differs from the optimized arm by one scenario file · '
    +(s.description??'')+'</div>';
}
tick();setInterval(tick,2000);
</script></body></html>`

export function startUi(ROOT, runId, { port = 8791, open = true } = {}) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/data')) {
      // follow the newest run unless one was named explicitly
      const id = runId ?? resolveRunId(ROOT)
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(id ? snapshot(ROOT, id) : { empty: true, arms: [], task: { title: '', bullets: [] } }))
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
