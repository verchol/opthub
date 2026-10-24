/**
 * Analytics → Percentiles · Classes · Similar. Spliced into the hub page (lib/hub-page.mjs);
 * reads /api/sessions (already loaded as DATA) and /api/insights (lib/insights.mjs).
 * No template literals in the client code: PAGE is a String.raw template.
 */
export const INSIGHTS_CSS = String.raw`
.asub{display:flex;gap:6px;margin:6px 0 14px;flex-wrap:wrap}
.asub button{font-family:var(--m);font-size:11.5px;padding:5px 11px;border:1px solid var(--rule);background:var(--card);color:var(--mut);cursor:pointer}
.asub button.on{color:var(--ink);border-color:var(--ac);box-shadow:inset 0 -2px 0 var(--ac)}
.itable{width:100%;border-collapse:collapse;font-family:var(--m);font-size:12px;background:var(--card);border:1px solid var(--rule)}
.itable th{text-align:left;font-weight:500;color:var(--mut);font-size:10px;text-transform:uppercase;letter-spacing:.06em;padding:8px 10px;border-bottom:1px solid var(--rule);cursor:pointer;white-space:nowrap;user-select:none}
.itable th.num,.itable td.num{text-align:right}
.itable th.on{color:var(--ink)}
.itable td{padding:7px 10px;border-bottom:1px solid var(--rule);white-space:nowrap}
.itable tr.grp{cursor:pointer}.itable tr.grp:hover td{background:var(--rail)}
.itable tr.thin td{color:var(--mut)}
.itable tr.open td{background:var(--rail)}
.itable td.cat{max-width:260px;overflow:hidden;text-overflow:ellipsis}
.badge{font-size:9.5px;padding:1px 6px;margin-left:6px;border:1px solid var(--ac);color:var(--ac);text-transform:uppercase;letter-spacing:.05em}
.rng{display:block}
.isess{padding:6px 10px 12px 22px;font-family:var(--m);font-size:11.5px}
.isess div{display:flex;gap:10px;padding:2px 0;align-items:baseline}
.isess .c{min-width:64px;text-align:right}.isess .t{color:var(--mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.isess .h{color:var(--mut);font-size:10px;text-transform:uppercase;letter-spacing:.06em;margin-top:6px}
.inote{font-family:var(--m);font-size:11px;color:var(--mut);margin:8px 0 0}
.livebar{display:flex;align-items:center;gap:8px;font-family:var(--m);font-size:11.5px;color:var(--mut);margin-bottom:14px}
.pulse{width:8px;height:8px;border-radius:50%;background:var(--ac);animation:pl 2s infinite}
@keyframes pl{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--ac) 60%,transparent)}70%{box-shadow:0 0 0 8px transparent}100%{box-shadow:0 0 0 0 transparent}}
.sigrow{display:grid;grid-template-columns:110px 1fr 70px;gap:10px;align-items:center;font-family:var(--m);font-size:11.5px;padding:3px 4px;cursor:pointer}
.sigrow:hover{background:var(--rail)}.sigrow.on{outline:1px solid var(--ac)}
.sigrow .bar{height:10px;background:var(--rule);position:relative}
.sigrow .bar i{position:absolute;left:0;top:0;bottom:0;background:var(--ac)}
.sigrow.size .bar i{background:var(--mut);opacity:.5}.sigrow.size{color:var(--mut)}
.ggrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}
.gcard{background:var(--card);border:1px solid var(--rule);padding:14px;cursor:pointer;border-top:3px solid var(--gc,var(--ac))}
.gcard:hover{border-color:var(--ac)}.gcard.on{outline:2px solid var(--ac)}
.gcard h4{font-family:var(--d);font-size:15px;margin:0 0 2px;overflow-wrap:anywhere}
.gcard .m{font-family:var(--m);font-size:11px;color:var(--mut)}
.gcard .share{height:5px;background:var(--rule);margin:8px 0}.gcard .share i{display:block;height:100%;background:var(--gc,var(--ac))}
.gcard .chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px}
.chip{font-family:var(--m);font-size:10px;padding:1px 6px;border:1px solid var(--rule);color:var(--mut);border-radius:2px}
.chip b{color:var(--ink);font-weight:500}
.gcard .ex{font-size:12px;color:var(--mut);margin-top:8px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.simwrap{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:14px}
@media(max-width:1100px){.simwrap{grid-template-columns:1fr}}
.simbox{position:relative;background:var(--card);border:1px solid var(--rule);height:640px;overflow:hidden}
.simbox svg{width:100%;height:100%;display:block;cursor:grab}
.simbox svg.drag{cursor:grabbing}
.simbox .e{stroke:var(--mut)}
.simbox .n{stroke:var(--card);stroke-width:1.5;cursor:pointer;transition:opacity .15s}
.simbox .n.hl{stroke:var(--ink);stroke-width:2.5}
.simbox .dim{opacity:.12}
.simbox .lbl{font-family:var(--m);font-size:10px;fill:var(--ink);pointer-events:none;paint-order:stroke;stroke:var(--card);stroke-width:3px}
.simbox .clbl{font-family:var(--d);font-size:13px;font-weight:700;fill:var(--mut);pointer-events:none;opacity:.55}
.simtip{position:absolute;pointer-events:none;background:var(--card);border:1px solid var(--rule);padding:8px 10px;font-family:var(--m);font-size:11px;max-width:300px;box-shadow:0 4px 14px rgba(0,0,0,.18);display:none;z-index:3}
.simlegend{display:flex;flex-wrap:wrap;gap:6px 12px;font-family:var(--m);font-size:11px;margin:8px 0 0}
.simlegend span{display:inline-flex;align-items:center;gap:5px;cursor:pointer}
.simlegend span.off{opacity:.35}
.simlegend i{width:10px;height:10px;border-radius:50%;display:inline-block}
.simside{background:var(--card);border:1px solid var(--rule);padding:14px;max-height:640px;overflow:auto;font-size:13px}
.simside h4{font-family:var(--d);margin:0 0 4px;font-size:15px}
.nb{border-top:1px solid var(--rule);padding:8px 0}
.nb .top{display:flex;gap:8px;align-items:center;font-family:var(--m);font-size:11px}
.nb .sb{flex:0 0 60px;height:6px;background:var(--rule)}.nb .sb i{display:block;height:100%;background:var(--ac)}
.nb .it{font-size:12px;margin:4px 0;cursor:pointer}.nb .it:hover{color:var(--ac)}
.simctl input[type=range]{vertical-align:middle;width:110px}
.simctl label{font-family:var(--m);font-size:11.5px;color:var(--mut);display:inline-flex;align-items:center;gap:6px}
`

export const INSIGHTS_JS = String.raw`
/* ------------------------------------------------------- analytics: fleet */
/* Percentiles, Classes and Similar are about every session; Session is the
   per-session view opened from the Sessions tab. All three read the same
   classification from /api/insights, refreshed whenever a transcript moves. */
let INS=null, asub='pct', insOpen=null, insT=0
let insF={dim:'',metric:'cost',date:'all',tier:'',driver:'',q:'',minN:1,sort:'p50',dir:1}
let grpF={k1:'',k2:'',open:null}
let simF={color:'',min:0.35,proj:'',q:'',focus:null,hidden:{},labels:true}
const PAL=['#2A9D8F','#E76F51','#457B9D','#E9B949','#8E5EA2','#F4A261','#3FA34D','#D1495B','#00A6D6','#B07AA1','#7F8C3A','#C46A2F']
const METRICS=[['cost','cost per session',(s)=>s.cost],['perturn','cost per turn',(s)=>s.cost/Math.max(s.turns,1)],
  ['perprompt','cost per typed prompt',(s)=>s.cost/Math.max(s.humanPrompts||0,1)],['dur','duration (min)',(s)=>s.durationMin],
  ['ctx','median context',(s)=>s.ctxMedian]]
const metricFn=()=>(METRICS.find(m=>m[0]===insF.metric)||METRICS[0])[2]
const fmtMetric=(v)=>insF.metric==='dur'?fmtM(v):insF.metric==='ctx'?tok(v):usd(v)
const topWork=(i)=>{const r=(INS?INS.ranking:[]).filter(x=>x.group!=='size');return r[i]?r[i].key:'purpose'}
const attrLabel=(k)=>{const r=INS&&INS.ranking.find(x=>x.key===k);return r?r.label:k}
async function loadInsights(){
  try{INS=await(await fetch('/api/insights',{cache:'no-store'})).json();insT=Date.now()}catch(e){return}
  if(!insF.dim)insF.dim=topWork(0)
  if(!grpF.k1)grpF.k1=topWork(0)
  // the graph is about what sessions were for, so it colours by purpose unless told otherwise
  if(!simF.color)simF.color='purpose'
  if(section==='analytics'&&asub!=='session')draw()
}
/* sessions in view, each with its attributes */
function insRows(){
  if(!DATA||!INS)return []
  const q=insF.q.toLowerCase(), days={'7d':7,'30d':30,'90d':90}[insF.date], now=Date.now()
  return DATA.sessions.filter(s=>INS.attrs[s.id]).map(s=>({s,a:INS.attrs[s.id]})).filter(({s,a})=>
    (!days||(s.startedAt&&now-new Date(s.startedAt)<days*864e5))
    &&(!insF.tier||a.tier===insF.tier)&&(!insF.driver||a.driver===insF.driver)
    &&(!q||(s.intent+' '+a.project).toLowerCase().includes(q)))
}
/* nearest-rank percentile on a sorted array */
const pq=(v,q)=>v.length?v[Math.min(v.length-1,Math.max(0,Math.ceil(q*v.length)-1))]:0
function stats(vals){const v=[...vals].sort((a,b)=>a-b);return {n:v.length,min:v[0]||0,p50:pq(v,.5),p95:pq(v,.95),p99:pq(v,.99),max:v[v.length-1]||0,sum:v.reduce((a,b)=>a+b,0)}}
function asubBar(){
  const s=DATA.sessions.find(x=>x.id===sel.sessions)
  const tabs=[['pct','Percentiles'],['grp','Classes'],['sim','Similar']].concat(s?[['session','Session '+s.id.slice(0,6)]]:[])
  return '<div class="asub">'+tabs.map(([k,l])=>'<button class="'+(asub===k?'on':'')+'" onclick="setAsub(\''+k+'\')">'+l+'</button>').join('')+'</div>'
}
function setAsub(k){asub=k;if(k==='session'&&sel.sessions)return openAnalytics(sel.sessions);draw()}
function analyticsView(){
  if(asub==='session'&&DATA.sessions.find(x=>x.id===sel.sessions))return sessionAnalyticsView().replace('<p class="sub">',asubBar()+'<p class="sub">')
  if(asub==='session')asub='pct'
  const head='<div class="midhead"><h2>Analytics</h2><span class="crumb">'+(INS?Object.keys(INS.attrs).length+' sessions classified':'classifying…')+'</span></div>'+asubBar()
  if(!INS)return head+'<div class="empty">classifying sessions…</div>'
  return head+(asub==='grp'?groupsView():asub==='sim'?simView():pctView())
}
function selOpts(list,cur){return list.map(([v,l])=>'<option value="'+esc(v)+'"'+(v===cur?' selected':'')+'>'+esc(l)+'</option>').join('')}
function attrOpts(cur,prefix){return INS.ranking.map(r=>'<option value="'+r.key+'"'+(r.key===cur?' selected':'')+'>'+prefix+r.label+(r.group==='size'?' (size)':'')+'</option>').join('')}
function valuesOf(k){const c={};for(const a of Object.values(INS.attrs))c[a[k]]=(c[a[k]]||0)+1;return Object.keys(c).sort()}
function insFilters(){
  return '<div class="filters">'
   +'<select onchange="insF.dim=this.value;insOpen=null;draw()">'+attrOpts(insF.dim,'by ')+'</select>'
   +'<select onchange="insF.metric=this.value;draw()">'+selOpts(METRICS.map(m=>[m[0],m[1]]),insF.metric)+'</select>'
   +'<select onchange="insF.date=this.value;draw()">'+selOpts([['all','all time'],['7d','last 7 days'],['30d','last 30 days'],['90d','last 90 days']],insF.date)+'</select>'
   +'<select onchange="insF.tier=this.value;draw()"><option value="">all models</option>'+selOpts(valuesOf('tier').map(v=>[v,v]),insF.tier)+'</select>'
   +'<select onchange="insF.driver=this.value;draw()"><option value="">human + script</option>'+selOpts(valuesOf('driver').map(v=>[v,v]),insF.driver)+'</select>'
   +'<select onchange="insF.minN=+this.value;draw()">'+selOpts([[1,'any n'],[3,'n ≥ 3'],[5,'n ≥ 5'],[10,'n ≥ 10']].map(([v,l])=>[String(v),l]),String(insF.minN))+'</select>'
   +'<input placeholder="filter intent / project…" value="'+esc(insF.q)+'" onchange="insF.q=this.value;draw()">'
   +'</div>'
}
/* ---- Percentiles: which category is cheapest, at the median and in the tail */
let PCT_GROUPS=[]
function pctView(){
  const f=metricFn(), rows=insRows(), by={}
  for(const r of rows)(by[r.a[insF.dim]]=by[r.a[insF.dim]]||[]).push(r)
  let groups=Object.entries(by).map(([k,list])=>({k,list,st:stats(list.map(r=>f(r.s)))})).filter(g=>g.st.n>=insF.minN)
  const key=insF.sort, d=insF.dir
  groups.sort((a,b)=>key==='k'?a.k.localeCompare(b.k)*d:(a.st[key]-b.st[key])*d)
  PCT_GROUPS=groups
  const all=stats(rows.map(r=>f(r.s)))
  const solid=groups.filter(g=>g.st.n>=3)
  const cheapest=(solid.length?solid:groups).slice().sort((a,b)=>a.st.p50-b.st.p50)[0]
  const tailBest=(solid.length?solid:groups).slice().sort((a,b)=>a.st.p95-b.st.p95)[0]
  // one log scale shared by every row, so bars compare across categories
  const pos=groups.flatMap(g=>[g.st.min,g.st.p99]).filter(v=>v>0)
  const lo=Math.log10(Math.min(...pos,1e9)||1e-3), hi=Math.log10(Math.max(...pos,1e-9)||1)
  const W=220, X=(v)=>v>0?6+(W-12)*(Math.log10(v)-lo)/Math.max(hi-lo,1e-6):6
  const range=(st)=>'<svg class="rng" width="'+W+'" height="16"><line x1="6" x2="'+(W-6)+'" y1="8" y2="8" stroke="var(--rule)"/>'
    +'<line x1="'+X(st.min)+'" x2="'+X(st.p99)+'" y1="8" y2="8" stroke="var(--mut)" stroke-width="1"/>'
    +'<line x1="'+X(st.p50)+'" x2="'+X(st.p95)+'" y1="8" y2="8" stroke="var(--warn)" stroke-width="4"/>'
    +'<line x1="'+X(st.p99)+'" x2="'+X(st.p99)+'" y1="2" y2="14" stroke="var(--bad)" stroke-width="2"/>'
    +'<circle cx="'+X(st.p50)+'" cy="8" r="4.5" fill="var(--ac)"/></svg>'
  const th=(k,l,num)=>'<th class="'+(num?'num ':'')+(insF.sort===k?'on':'')+'" onclick="insSort(\''+k+'\')">'+l+(insF.sort===k?(insF.dir>0?' ▲':' ▼'):'')+'</th>'
  const body=groups.map((g,i)=>{
    const open=insOpen===g.k
    const row='<tr class="grp'+(g.st.n<3?' thin':'')+(open?' open':'')+'" onclick="insToggle('+i+')"><td class="cat" title="'+esc(g.k)+'">'+(open?'▾ ':'▸ ')+esc(g.k)
      +(g===cheapest?'<span class="badge">cheapest p50</span>':'')+(g===tailBest&&g!==cheapest?'<span class="badge">tamest tail</span>':'')+'</td>'
      +'<td class="num">'+g.st.n+'</td><td class="num">'+fmtMetric(g.st.p50)+'</td><td class="num">'+fmtMetric(g.st.p95)+'</td><td class="num">'+fmtMetric(g.st.p99)+'</td>'
      +'<td class="num">'+(insF.metric==='cost'?usd(g.st.sum):'')+'</td><td>'+range(g.st)+'</td></tr>'
    if(!open)return row
    const sorted=g.list.slice().sort((a,b)=>f(a.s)-f(b.s))
    const line=(r)=>'<div><span class="c">'+fmtMetric(f(r.s))+'</span><span class="t">'+esc(r.s.intent)+'</span>'
      +'<button class="mini" title="analytics" onclick="event.stopPropagation();asub=\'session\';openAnalytics(\''+r.s.id+'\')">'+CHART_ICON+'</button>'
      +'<button class="mini" title="similar sessions" onclick="event.stopPropagation();simFocus(\''+r.s.id+'\')">◎</button></div>'
    return row+'<tr><td colspan="7" class="isess"><div class="h">cheapest</div>'+sorted.slice(0,5).map(line).join('')
      +(sorted.length>5?'<div class="h">the tail (p95 and up)</div>'+sorted.slice(-Math.min(3,sorted.length-5)).reverse().map(line).join(''):'')+'</td></tr>'
  }).join('')
  return insFilters()
   +'<div class="stats">'+[['sessions',rows.length],['p50 · all',fmtMetric(all.p50)],['p95 · all',fmtMetric(all.p95)],['p99 · all',fmtMetric(all.p99)],
      ['cheapest '+attrLabel(insF.dim),cheapest?esc(cheapest.k):'—'],['tamest tail (p95)',tailBest?esc(tailBest.k):'—']]
      .map(([k,v])=>'<div class="stat"><div class="v">'+v+'</div><div class="k">'+k+'</div></div>').join('')+'</div>'
   +'<table class="itable"><thead><tr>'+th('k',attrLabel(insF.dim))+th('n','n',1)+th('p50','p50',1)+th('p95','p95',1)+th('p99','p99',1)+th('sum',insF.metric==='cost'?'total':'',1)
   +'<th>min · <span style="color:var(--ac)">●</span> p50 · <span style="color:var(--warn)">▬</span> p95 · <span style="color:var(--bad)">|</span> p99 (log)</th></tr></thead><tbody>'+(body||'<tr><td colspan="7" class="empty">no category has enough sessions under these filters</td></tr>')+'</tbody></table>'
   +'<p class="inote">Cost is <b>priced</b>: transcript tokens at list rates. Percentiles are nearest-rank: under 20 sessions p95 and p99 are the top values, not a tail, and greyed rows have n &lt; 3. Click a row for its cheapest sessions and its tail.</p>'
}
function insSort(k){if(insF.sort===k)insF.dir=-insF.dir;else{insF.sort=k;insF.dir=k==='k'?1:1};draw()}
function insToggle(i){const g=PCT_GROUPS[i];insOpen=insOpen===g.k?null:g.k;draw()}
/* ---- Classes: continuous classification, grouped by what matters most */
let GRP_LIST=[]
function groupsView(){
  const rows=insRows(), f=(s)=>s.cost, total=rows.reduce((a,r)=>a+r.s.cost,0)||1
  const maxS=Math.max(...INS.ranking.map(r=>r.score),1e-6)
  const sig='<div class="card"><h3>Which classifications matter</h3><p>How much of the spread in cost each attribute explains (ω² on log cost, corrected for the number of groups). Size attributes explain cost by construction, so they are shown but never chosen for you. Click one to group by it.</p>'
    +INS.ranking.map(r=>'<div class="sigrow '+(r.group==='size'?'size ':'')+(grpF.k1===r.key?'on':'')+'" title="'+esc(r.why)+'" onclick="grpF.k1=\''+r.key+'\';grpF.open=null;draw()"><span>'+esc(r.label)+'</span><span class="bar"><i style="width:'+(100*r.score/maxS).toFixed(1)+'%"></i></span><span>'+(r.score*100).toFixed(1)+'% · '+r.groups+'g</span></div>').join('')+'</div>'
  const by={}
  for(const r of rows){const k=r.a[grpF.k1]+(grpF.k2?' · '+r.a[grpF.k2]:'');(by[k]=by[k]||[]).push(r)}
  const groups=Object.entries(by).map(([k,list])=>({k,list,st:stats(list.map(r=>f(r.s)))})).sort((a,b)=>b.st.sum-a.st.sum)
  GRP_LIST=groups
  // what else characterises a group: the value of each other work attribute that is most over-represented in it
  const others=INS.ranking.filter(r=>r.group!=='size'&&r.key!==grpF.k1&&r.key!==grpF.k2).slice(0,6).map(r=>r.key)
  const base={};for(const k of others){base[k]={};for(const r of rows)base[k][r.a[k]]=(base[k][r.a[k]]||0)+1/rows.length}
  const traits=(list)=>others.map(k=>{const c={};for(const r of list)c[r.a[k]]=(c[r.a[k]]||0)+1/list.length
    const [v,share]=Object.entries(c).sort((a,b)=>b[1]-a[1])[0];return {k,v,share,lift:share/(base[k][v]||1)}})
    .filter(t=>t.share>=0.5&&t.v!=='unlabelled').sort((a,b)=>b.lift-a.lift).slice(0,4)
  const cards=groups.map((g,i)=>{
    const ex=g.list.slice().sort((a,b)=>b.s.cost-a.s.cost)[0]
    return '<div class="gcard'+(grpF.open===g.k?' on':'')+'" style="--gc:'+PAL[i%PAL.length]+'" onclick="grpToggle('+i+')"><h4>'+esc(g.k)+'</h4>'
      +'<div class="m">'+g.st.n+' sessions · '+usd(g.st.sum)+' · '+(100*g.st.sum/total).toFixed(1)+'% of spend</div>'
      +'<div class="share"><i style="width:'+Math.max(1,100*g.st.sum/total).toFixed(1)+'%"></i></div>'
      +'<div class="m">p50 '+usd(g.st.p50)+' · p95 '+usd(g.st.p95)+'</div>'
      +'<div class="chips">'+traits(g.list).map(t=>'<span class="chip" title="'+Math.round(t.share*100)+'% of this group, '+t.lift.toFixed(1)+'× the fleet">'+esc(attrLabel(t.k))+' <b>'+esc(t.v)+'</b></span>').join('')+'</div>'
      +(ex?'<div class="ex">“'+esc(ex.s.intent)+'”</div>':'')+'</div>'
  }).join('')
  const open=groups.find(g=>g.k===grpF.open)
  const list=open?'<div class="card" style="margin-top:14px"><h3>'+esc(open.k)+'</h3><p>'+open.st.n+' sessions, most expensive first.</p><div class="isess" style="padding-left:0">'
    +open.list.slice().sort((a,b)=>b.s.cost-a.s.cost).map(r=>'<div><span class="c">'+usd(r.s.cost)+'</span><span class="t">'+esc(r.s.intent)+'</span>'
      +'<button class="mini" title="analytics" onclick="asub=\'session\';openAnalytics(\''+r.s.id+'\')">'+CHART_ICON+'</button>'
      +'<button class="mini" title="similar sessions" onclick="simFocus(\''+r.s.id+'\')">◎</button></div>').join('')+'</div></div>':''
  const changed=(INS.changed||[]).length
  return '<div class="livebar"><span class="pulse"></span>classifying continuously · '+Object.keys(INS.attrs).length+' sessions · last pass '
     +new Date(INS.classifiedAt).toLocaleTimeString()+(changed?' · <b style="color:var(--ink)">'+changed+' new or reclassified</b>':' · no change since the last pass')+'</div>'
   +sig
   +'<div class="filters"><select onchange="grpF.k1=this.value;grpF.open=null;draw()">'+attrOpts(grpF.k1,'group by ')+'</select>'
   +'<select onchange="grpF.k2=this.value;grpF.open=null;draw()"><option value="">then by — nothing</option>'+INS.ranking.filter(r=>r.key!==grpF.k1).map(r=>'<option value="'+r.key+'"'+(r.key===grpF.k2?' selected':'')+'>then by '+r.label+'</option>').join('')+'</select>'
   +'<button class="mini" onclick="grpF.k1=topWork(0);grpF.k2=topWork(1);grpF.open=null;draw()">auto: top two</button>'
   +'<select onchange="insF.date=this.value;draw()">'+selOpts([['all','all time'],['7d','last 7 days'],['30d','last 30 days'],['90d','last 90 days']],insF.date)+'</select></div>'
   +'<div class="ggrid">'+cards+'</div>'+list
}
function grpToggle(i){const g=GRP_LIST[i];grpF.open=grpF.open===g.k?null:g.k;draw()}
/* ---- Similar: sessions as a graph, an edge where two did the same kind of work */
let SIM={nodes:[],edges:[],byId:{},view:null}, POS={}
function simFocus(id){asub='sim';simF.focus=id;section='analytics';draw()}
function simSig(){return [simF.color,simF.min,simF.proj,simF.q,JSON.stringify(simF.hidden),insF.date,INS&&INS.classifiedAt].join('|')}
function simBuild(){
  const rows=insRows().filter(r=>!simF.proj||r.a.project===simF.proj)
  const ids=new Set(rows.map(r=>r.s.id)), seen={}, edges=[]
  for(const r of rows)for(const nb of INS.neighbours[r.s.id]||[]){
    if(!ids.has(nb.id)||nb.sim<simF.min)continue
    const k=r.s.id<nb.id?r.s.id+nb.id:nb.id+r.s.id; if(seen[k])continue; seen[k]=1
    edges.push({a:r.s.id,b:nb.id,sim:nb.sim})}
  const cats=[...new Set(rows.map(r=>r.a[simF.color]))]
  const count={};for(const r of rows)count[r.a[simF.color]]=(count[r.a[simF.color]]||0)+1
  cats.sort((x,y)=>count[y]-count[x])
  const col={};cats.forEach((c,i)=>col[c]=i<PAL.length?PAL[i]:'#8B9C9E')
  const nodes=rows.map(r=>({id:r.s.id,s:r.s,a:r.a,cat:r.a[simF.color],col:col[r.a[simF.color]],r:Math.min(22,4+Math.sqrt(r.s.cost)*1.6)}))
  SIM={nodes,edges,byId:Object.fromEntries(nodes.map(n=>[n.id,n])),cats,col,count,view:SIM.view}
  simLayout()
}
/* force layout, run to rest before drawing: repulsion, springs on edges weighted by
   similarity, and a pull towards each category's anchor so colours read as clusters */
function simLayout(){
  const W=1000,H=640,N=SIM.nodes,cats=SIM.cats,anch={}
  cats.forEach((c,i)=>{const t=2*Math.PI*i/Math.max(cats.length,1);anch[c]=[W/2+Math.cos(t)*W*0.3,H/2+Math.sin(t)*H*0.3]})
  SIM.anch=anch
  for(const n of N){const p=POS[n.id];if(p){n.x=p[0];n.y=p[1]}else{const a=anch[n.cat];n.x=a[0]+(Math.random()-.5)*80;n.y=a[1]+(Math.random()-.5)*80}n.vx=0;n.vy=0}
  const iters=N.every(n=>POS[n.id])?60:300
  for(let it=0;it<iters;it++){
    const alpha=1-it/iters
    for(let i=0;i<N.length;i++)for(let j=i+1;j<N.length;j++){
      const a=N[i],b=N[j];let dx=b.x-a.x,dy=b.y-a.y,d2=dx*dx+dy*dy+0.01
      if(d2>40000)continue
      const d=Math.sqrt(d2),min=a.r+b.r+4,f=(d<min?(min-d)*0.5:0)+900/d2
      dx/=d;dy/=d;a.vx-=dx*f;a.vy-=dy*f;b.vx+=dx*f;b.vy+=dy*f}
    for(const e of SIM.edges){const a=SIM.byId[e.a],b=SIM.byId[e.b];const dx=b.x-a.x,dy=b.y-a.y,d=Math.sqrt(dx*dx+dy*dy)||1
      const f=(d-(40+90*(1-e.sim)))*0.02*e.sim;a.vx+=dx/d*f;a.vy+=dy/d*f;b.vx-=dx/d*f;b.vy-=dy/d*f}
    for(const n of N){const a=anch[n.cat];n.vx+=(a[0]-n.x)*0.006;n.vy+=(a[1]-n.y)*0.006
      n.x+=n.vx*alpha*0.6;n.y+=n.vy*alpha*0.6;n.vx*=0.6;n.vy*=0.6}
  }
  for(const n of N)POS[n.id]=[n.x,n.y]
}
function simView(){
  const projs=valuesOf('project').map(p=>[p,p+' ('+Object.values(INS.attrs).filter(a=>a.project===p).length+')'])
  return '<div class="filters simctl">'
   +'<select onchange="simF.color=this.value;simF.hidden={};draw()">'+attrOpts(simF.color,'colour by ')+'</select>'
   +'<select onchange="simF.proj=this.value;draw()"><option value="">all projects</option>'+selOpts(projs,simF.proj)+'</select>'
   +'<select onchange="insF.date=this.value;draw()">'+selOpts([['all','all time'],['7d','last 7 days'],['30d','last 30 days'],['90d','last 90 days']],insF.date)+'</select>'
   +'<label>similarity ≥ <input type="range" min="0.3" max="0.8" step="0.05" value="'+simF.min+'" oninput="this.nextElementSibling.textContent=Math.round(this.value*100)+\'%\'" onchange="simF.min=+this.value;draw()"><span>'+Math.round(simF.min*100)+'%</span></label>'
   +'<input id="simq" placeholder="highlight intent…" value="'+esc(simF.q)+'" oninput="simF.q=this.value;simPaint()">'
   +'<label><input type="checkbox"'+(simF.labels?' checked':'')+' onchange="simF.labels=this.checked;draw()"> labels</label>'
   +'<button class="mini" onclick="SIM.view=null;POS={};draw()">re-layout</button></div>'
   +'<div class="simwrap"><div><div class="simbox" id="simbox"><svg id="simsvg" data-sig=""></svg><div class="simtip" id="simtip"></div></div>'
   +'<div class="simlegend" id="simlegend"></div>'
   +'<p class="inote">Each dot is a session, sized by cost and coloured by '+esc(attrLabel(simF.color))+'. An edge joins two sessions when they are among each other’s five nearest: half from shared purpose, artifact type, project, kind, tool style, model and scale; a third from the opening request’s words (TF-IDF); the rest from file types written. Drag to pan, scroll to zoom, click a dot for its neighbours.</p></div>'
   +'<div class="simside" id="simside"></div></div>'
}
/* the graph is drawn into the frame after the HTML lands, and kept across the hub's redraws */
function simMount(){
  const svg=document.getElementById('simsvg'); if(!svg)return
  const sig=simSig()
  if(svg.dataset.sig===sig&&svg.childNodes.length){simPaint();return}
  simBuild(); svg.dataset.sig=sig
  const NS='http://www.w3.org/2000/svg'
  if(!SIM.view){const xs=SIM.nodes.map(n=>n.x),ys=SIM.nodes.map(n=>n.y),pad=40
    const x0=Math.min(...xs,0)-pad,x1=Math.max(...xs,1000)+pad,y0=Math.min(...ys,0)-pad,y1=Math.max(...ys,640)+pad
    SIM.view=[x0,y0,x1-x0,y1-y0]}
  svg.setAttribute('viewBox',SIM.view.join(' '))
  let h='<g id="simE">'
  for(const e of SIM.edges){const a=SIM.byId[e.a],b=SIM.byId[e.b]
    h+='<line class="e" data-a="'+e.a+'" data-b="'+e.b+'" x1="'+a.x.toFixed(1)+'" y1="'+a.y.toFixed(1)+'" x2="'+b.x.toFixed(1)+'" y2="'+b.y.toFixed(1)+'" stroke-width="'+(0.5+3*(e.sim-0.3)).toFixed(2)+'" stroke-opacity="'+(0.15+0.6*(e.sim-0.3)).toFixed(2)+'"/>'}
  h+='</g><g id="simC">'
  for(const c of SIM.cats.slice(0,PAL.length)){const a=SIM.anch[c];if(SIM.count[c]>=3)h+='<text class="clbl" x="'+a[0].toFixed(0)+'" y="'+(a[1]-60).toFixed(0)+'" text-anchor="middle">'+esc(c)+'</text>'}
  h+='</g><g id="simN">'
  for(const n of SIM.nodes)h+='<circle class="n" data-id="'+n.id+'" cx="'+n.x.toFixed(1)+'" cy="'+n.y.toFixed(1)+'" r="'+n.r.toFixed(1)+'" fill="'+n.col+'"/>'
  h+='</g><g id="simL">'
  if(simF.labels)for(const n of SIM.nodes.slice().sort((a,b)=>b.s.cost-a.s.cost).slice(0,14))
    h+='<text class="lbl" data-id="'+n.id+'" x="'+(n.x+n.r+3).toFixed(1)+'" y="'+(n.y+3).toFixed(1)+'">'+esc(n.s.intent.slice(0,28))+'</text>'
  svg.innerHTML=h+'</g>'
  document.getElementById('simlegend').innerHTML=SIM.cats.map(c=>'<span class="'+(simF.hidden[c]?'off':'')+'" data-c="'+esc(c)+'"><i style="background:'+SIM.col[c]+'"></i>'+esc(c)+' · '+SIM.count[c]+'</span>').join('')
  document.querySelectorAll('#simlegend span').forEach(el=>el.onclick=()=>{const c=el.dataset.c;simF.hidden[c]=!simF.hidden[c];el.classList.toggle('off');simPaint()})
  simWire(svg); simPaint()
}
/* highlight, hide and focus without rebuilding the graph */
function simPaint(){
  const q=(simF.q||'').toLowerCase(), f=simF.focus&&SIM.byId[simF.focus]?simF.focus:null
  const near=new Set(f?[f].concat(SIM.edges.filter(e=>e.a===f||e.b===f).map(e=>e.a===f?e.b:e.a)):[])
  document.querySelectorAll('#simN .n').forEach(el=>{const n=SIM.byId[el.dataset.id]
    const hid=simF.hidden[n.cat], miss=q&&!n.s.intent.toLowerCase().includes(q), off=f&&!near.has(n.id)
    el.style.display=hid?'none':''; el.classList.toggle('dim',!!(miss||off)); el.classList.toggle('hl',n.id===f||(!!q&&!miss))})
  document.querySelectorAll('#simE .e').forEach(el=>{const a=SIM.byId[el.dataset.a],b=SIM.byId[el.dataset.b]
    el.style.display=simF.hidden[a.cat]||simF.hidden[b.cat]?'none':''
    el.classList.toggle('dim',!!(f&&el.dataset.a!==f&&el.dataset.b!==f)||!!q)
    el.style.stroke=f&&(el.dataset.a===f||el.dataset.b===f)?'var(--ac)':''})
  document.querySelectorAll('#simL .lbl').forEach(el=>{const n=SIM.byId[el.dataset.id];el.style.display=simF.hidden[n.cat]?'none':'';el.classList.toggle('dim',!!(f&&!near.has(n.id)))})
  const side=document.getElementById('simside'); if(side)side.innerHTML=simSide(f)
}
function simSide(f){
  if(!f){const iso=SIM.nodes.filter(n=>!SIM.edges.some(e=>e.a===n.id||e.b===n.id)).length
    return '<h4>Close sessions</h4><p class="sub" style="margin-bottom:10px">'+SIM.nodes.length+' sessions · '+SIM.edges.length+' links · '+iso+' with no close neighbour at ≥ '+Math.round(simF.min*100)+'%</p>'
      +'<div class="tri-note">Click a dot, or ◎ on any session in Percentiles or Classes, to see the sessions most like it and why.</div>'
      +'<div class="isess" style="padding-left:0"><div class="h">most connected</div>'+SIM.nodes.map(n=>[n,SIM.edges.filter(e=>e.a===n.id||e.b===n.id).length]).sort((a,b)=>b[1]-a[1]).slice(0,8)
        .map(([n,k])=>'<div style="cursor:pointer" onclick="simF.focus=\''+n.id+'\';simPaint()"><span class="c">'+k+' links</span><span class="t">'+esc(n.s.intent)+'</span></div>').join('')+'</div>'}
  const n=SIM.byId[f], nbs=(INS.neighbours[f]||[])
  const chip=(t)=>'<span class="chip">'+esc(t)+'</span>'
  return '<h4>'+esc(n.s.intent.slice(0,120))+'</h4><div class="m" style="font-family:var(--m);font-size:11px;color:var(--mut)">'+usd(n.s.cost)+' · '+n.s.turns+' turns · '+esc(n.a.project)+'</div>'
   +'<div class="chips" style="display:flex;flex-wrap:wrap;gap:4px;margin:8px 0">'+['purpose','artifact','kind','tools','tier'].map(k=>'<span class="chip">'+esc(attrLabel(k))+' <b>'+esc(n.a[k])+'</b></span>').join('')+'</div>'
   +'<div style="display:flex;gap:6px;margin-bottom:6px"><button class="mini" onclick="asub=\'session\';openAnalytics(\''+f+'\')">'+CHART_ICON+' analytics</button><button class="mini" onclick="simF.focus=null;simPaint()">clear</button></div>'
   +(nbs.length?nbs.map(x=>{const m=DATA.sessions.find(s=>s.id===x.id);if(!m)return ''
     return '<div class="nb"><div class="top"><span class="sb"><i style="width:'+Math.round(x.sim*100)+'%"></i></span>'+Math.round(x.sim*100)+'% similar · '+usd(m.cost)+'</div>'
      +'<div class="it" onclick="simF.focus=\''+x.id+'\';simPaint()">'+esc(m.intent.slice(0,140))+'</div>'
      +'<div style="display:flex;flex-wrap:wrap;gap:3px">'+x.why.shared.slice(0,4).map(chip).join('')+x.why.words.map(w=>chip('“'+w+'”')).join('')+x.why.files.map(chip).join('')+'</div></div>'}).join('')
     :'<div class="tri-note">No session is at least 30% like this one.</div>')
}
let drag=null, pan=null, moved=false
/* one window listener for the page's life: the svg is rebuilt, the listener is not */
window.addEventListener('mouseup',()=>{
  if(drag&&!moved){simF.focus=simF.focus===drag?null:drag;simPaint()}
  else if(pan&&!moved&&simF.focus){simF.focus=null;simPaint()}
  drag=null;pan=null;const svg=document.getElementById('simsvg');if(svg)svg.classList.remove('drag')})
function simWire(svg){
  const tip=document.getElementById('simtip'), box=document.getElementById('simbox')
  const pt=(ev)=>{const r=svg.getBoundingClientRect(),v=SIM.view;return [v[0]+(ev.clientX-r.left)/r.width*v[2],v[1]+(ev.clientY-r.top)/r.height*v[3]]}
  svg.addEventListener('mousemove',ev=>{
    if(drag){const [x,y]=pt(ev);const n=SIM.byId[drag];n.x=x;n.y=y;POS[drag]=[x,y];moved=true;simMove(n);return}
    if(pan){const r=svg.getBoundingClientRect(),v=SIM.view;v[0]=pan[2]-(ev.clientX-pan[0])/r.width*v[2];v[1]=pan[3]-(ev.clientY-pan[1])/r.height*v[3];svg.setAttribute('viewBox',v.join(' '));moved=true;return}
    const t=ev.target, id=t.dataset&&t.dataset.id
    if(id&&t.classList.contains('n')){const n=SIM.byId[id],b=box.getBoundingClientRect()
      tip.innerHTML='<b>'+esc(n.s.intent.slice(0,140))+'</b><br>'+usd(n.s.cost)+' · '+n.s.turns+' turns · '+esc(n.a.project)+'<br><span style="color:var(--mut)">'+esc(attrLabel(simF.color))+': '+esc(n.cat)+' · '+(INS.neighbours[id]||[]).length+' close</span>'
      tip.style.display='block';tip.style.left=Math.min(ev.clientX-b.left+14,b.width-310)+'px';tip.style.top=(ev.clientY-b.top+14)+'px'}
    else tip.style.display='none'})
  svg.addEventListener('mousedown',ev=>{moved=false;const id=ev.target.dataset&&ev.target.dataset.id
    if(id&&ev.target.classList.contains('n'))drag=id;else{pan=[ev.clientX,ev.clientY,SIM.view[0],SIM.view[1]];svg.classList.add('drag')}})
  svg.addEventListener('mouseleave',()=>{tip.style.display='none'})
  svg.addEventListener('wheel',ev=>{ev.preventDefault();const [x,y]=pt(ev),k=ev.deltaY>0?1.12:1/1.12,v=SIM.view
    v[0]=x-(x-v[0])*k;v[1]=y-(y-v[1])*k;v[2]*=k;v[3]*=k;svg.setAttribute('viewBox',v.join(' '))},{passive:false})
}
function simMove(n){
  const c=document.querySelector('#simN [data-id="'+n.id+'"]');if(c){c.setAttribute('cx',n.x);c.setAttribute('cy',n.y)}
  const l=document.querySelector('#simL [data-id="'+n.id+'"]');if(l){l.setAttribute('x',n.x+n.r+3);l.setAttribute('y',n.y+3)}
  document.querySelectorAll('#simE [data-a="'+n.id+'"]').forEach(e=>{e.setAttribute('x1',n.x);e.setAttribute('y1',n.y)})
  document.querySelectorAll('#simE [data-b="'+n.id+'"]').forEach(e=>{e.setAttribute('x2',n.x);e.setAttribute('y2',n.y)})
}
`
