/** The Optimization Hub page. Rail on the left, list in the middle, the selected item on the right. */
import { ICON_SVG, FAVICON } from './icon.mjs'
import { INSIGHTS_CSS, INSIGHTS_JS } from './hub-insights.mjs'
export const PAGE = String.raw`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Optimization Hub</title>
<link rel="icon" href="${FAVICON}">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;700;800&family=JetBrains+Mono:wght@400;500;700&family=Source+Serif+4:opsz,wght@8..60,400&display=swap">
<style>
:root{--bg:#F3F5F5;--card:#FFF;--rail:#ECEFEF;--ink:#12181A;--mut:#5A6B6E;--rule:#D7DEDE;--ac:#0E6E65;--warn:#A8611F;--bad:#B3402B;
 --d:'Archivo',system-ui,sans-serif;--m:'JetBrains Mono',ui-monospace,monospace;--b:'Source Serif 4',Georgia,serif}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0D1214;--card:#151B1E;--rail:#101618;--ink:#E3EAE9;--mut:#8B9C9E;--rule:#232D30;--ac:#46BFAF;--warn:#E2A462;--bad:#E58B72}}
:root[data-theme=dark]{--bg:#0D1214;--card:#151B1E;--rail:#101618;--ink:#E3EAE9;--mut:#8B9C9E;--rule:#232D30;--ac:#46BFAF;--warn:#E2A462;--bad:#E58B72}
:root[data-theme=black]{--bg:#000;--card:#0A0A0A;--rail:#050505;--ink:#F2F2F2;--mut:#7C7C7C;--rule:#1C1C1C;--ac:#3DD6C4;--warn:#F0A868;--bad:#E58B72}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--b);font-size:15px}
a{color:var(--ac)}
.app{display:grid;grid-template-columns:212px minmax(0,1fr) 400px;height:100vh;overflow:hidden}
.app.nodetail{grid-template-columns:212px minmax(0,1fr) 0}
.app.railshut{grid-template-columns:0 minmax(0,1fr) 400px}
.app.railshut.nodetail{grid-template-columns:0 minmax(0,1fr) 0}
/* a 0-width track still renders the pane's padding and border, so zero those too.
   display:none would re-flow the grid and shift the remaining panes a column left. */
.app.nodetail .detail{padding:0;border-left:none;overflow:hidden}
.app.railshut .rail{padding:0;border-right:none;overflow:hidden}
.app.railshut .mid{padding-left:56px}   /* clear the floating restore button */

/* ---- rail ---------------------------------------------------------- */
.rail{background:var(--rail);border-right:1px solid var(--rule);display:flex;flex-direction:column;overflow:auto}
.brand{padding:20px 16px 16px;border-bottom:1px solid var(--rule);display:flex;align-items:flex-start;gap:7px}
.brand .who{flex:1;min-width:0}
.brandmark{display:flex;align-items:center;flex:none;color:var(--mut);padding-top:2px}
.brandmark .mark{display:block}
.railbtn{font-family:var(--m);font-size:12px;line-height:1;padding:4px 7px;border:1px solid var(--rule);
 background:var(--card);color:var(--mut);cursor:pointer}
.railbtn:hover{color:var(--ink);border-color:var(--ac)}
.railopen{position:fixed;top:12px;left:12px;z-index:6;display:none}
.app.railshut ~ .railopen{display:block}
.brand h1{font-family:var(--d);font-weight:800;font-size:13.5px;letter-spacing:-.02em;margin:0;white-space:nowrap}
.brand .s{font-family:var(--m);font-size:10px;color:var(--mut);margin-top:4px;letter-spacing:.04em}
nav{padding:10px 8px;display:flex;flex-direction:column;gap:1px}
nav button{font-family:var(--m);font-size:12px;text-align:left;padding:8px 10px;border:none;border-left:2px solid transparent;
 background:none;color:var(--mut);cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:8px}
nav button:hover{color:var(--ink)}
nav button.on{color:var(--ink);background:var(--card);border-left-color:var(--ac)}
nav .sub{display:flex;flex-direction:column;gap:1px;margin:1px 0 3px}
nav .sub button{font-size:11.5px;padding:6px 10px 6px 22px;border-left:2px solid var(--rule);color:var(--mut)}
nav .sub button:before{content:'';position:absolute}
nav .sub button.on{background:none;border-left-color:var(--ac);color:var(--ink)}
nav .sub button:hover{background:color-mix(in srgb,var(--ac) 6%,transparent)}
nav .n{font-size:10px;color:var(--mut);font-variant-numeric:tabular-nums}
.railfoot{margin-top:auto;padding:12px 10px;border-top:1px solid var(--rule)}
.theme{display:flex;gap:2px}
.theme button{font-family:var(--m);font-size:10px;padding:4px 8px;border:1px solid var(--rule);background:none;color:var(--mut);cursor:pointer;flex:1}
.theme button.on{color:var(--ac);border-color:var(--ac)}

/* ---- middle -------------------------------------------------------- */
.mid{overflow:auto;padding:20px 22px 60px;min-width:0}
.midhead{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:4px}
.midhead h2{font-family:var(--d);font-size:20px;font-weight:800;letter-spacing:-.02em;margin:0}
.sub{color:var(--mut);font-size:12.5px;margin:0 0 16px;font-family:var(--m)}
.crumb{font-family:var(--m);font-size:11px;color:var(--mut);border:1px solid var(--rule);padding:3px 9px}
.stats{display:flex;flex-wrap:wrap;gap:1px;background:var(--rule);border:1px solid var(--rule);margin-bottom:18px}
.stat{background:var(--card);padding:10px 15px;flex:1;min-width:104px}
.stat .v{font-family:var(--d);font-size:19px;font-weight:800;letter-spacing:-.02em}
.stat .k{font-family:var(--m);font-size:9.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut)}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.filters input,.filters select{font-family:var(--m);font-size:12px;padding:6px 10px;border:1px solid var(--rule);background:var(--card);color:var(--ink)}
.filters input[type=date]{font-size:11.5px;padding:5px 8px}
table{width:100%;border-collapse:collapse;font-size:13px;background:var(--card);border:1px solid var(--rule);
 min-width:760px}
th,td{text-align:left;padding:8px 11px;border-bottom:1px solid var(--rule);white-space:nowrap}
th{font-family:var(--m);font-size:9.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);cursor:pointer;user-select:none}
th:hover{color:var(--ink)}
tr:last-child td{border-bottom:none}
tbody tr{cursor:pointer}
tbody tr:hover{background:color-mix(in srgb,var(--ac) 7%,transparent)}
tbody tr.on{background:color-mix(in srgb,var(--ac) 11%,transparent);box-shadow:inset 2px 0 0 var(--ac)}
/* while watching, running rows stay findable without the list being cut down */
tbody tr.w-live{background:color-mix(in srgb,var(--ac) 7%,transparent);box-shadow:inset 3px 0 0 var(--ac)}
tbody tr.w-open{box-shadow:inset 3px 0 0 var(--warn)}
tbody tr.on.w-live,tbody tr.on.w-open{background:color-mix(in srgb,var(--ac) 13%,transparent)}
td.num{font-family:var(--m);text-align:right;font-variant-numeric:tabular-nums}
td.intent{white-space:normal;width:29%;min-width:24ch;font-size:12.5px;overflow-wrap:anywhere}
/* artifact names are long and unwrappable: cap the column so it can't starve the intent */
td.arts{width:17%;min-width:12ch;overflow:hidden;text-overflow:ellipsis}
.pill{font-family:var(--m);font-size:10px;padding:2px 7px;border:1px solid var(--rule);border-radius:2px;color:var(--mut);white-space:nowrap}
.pill.code{color:var(--ac);border-color:var(--ac)} .pill.doc{color:#7A5AF8;border-color:#7A5AF8}
.pill.debug,.pill.explore{color:var(--warn);border-color:var(--warn)}
.pill.improved{color:var(--ac);border-color:var(--ac)}
.pill.degraded{color:var(--bad);border-color:var(--bad)}
.pill.flat{color:var(--mut)}
.model{font-family:var(--m);font-size:11px}
.art{font-family:var(--m);font-size:11.5px} .art.none{color:var(--mut)} .art .n{color:var(--mut)}
.spark{vertical-align:middle}
.card{background:var(--card);border:1px solid var(--rule);padding:20px;margin-bottom:18px}
.card h3{font-family:var(--d);font-size:16px;margin:0 0 4px}
.card p{color:var(--mut);font-size:13px;margin:0 0 14px}
svg{display:block;max-width:100%}
.legend{font-family:var(--m);font-size:11px;color:var(--mut);margin-top:10px;display:flex;gap:16px;flex-wrap:wrap;align-items:center}
.legend span{display:flex;align-items:center;gap:6px}
.legend .sw{display:inline-block;width:11px;height:11px;flex:none}
.legend b{color:var(--ink)}
.roi{font-family:var(--m);font-weight:700;font-variant-numeric:tabular-nums}
.roibar{display:inline-block;height:8px;background:var(--ac);vertical-align:middle;margin-left:6px}
.roi-none{color:var(--mut)}
.hide{display:none!important}

/* ---- detail -------------------------------------------------------- */
.detail{background:var(--card);border-left:1px solid var(--rule);overflow:auto;padding:20px 20px 60px;min-width:0;position:relative}
.detshut{position:absolute;top:10px;right:12px;z-index:3}
.detopen{position:fixed;top:12px;right:12px;z-index:6;display:none}
.app.nodetail ~ .detopen{display:block}
.detail .eyebrow{font-family:var(--m);font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--mut)}
.detail h3{font-family:var(--d);font-size:17px;font-weight:800;letter-spacing:-.02em;margin:6px 0 10px;overflow-wrap:anywhere}
.detail .body{font-size:13.5px;line-height:1.5;overflow-wrap:anywhere}
.kv{width:100%;border:none;background:none;font-family:var(--m);font-size:11.5px;margin:0 0 16px}
.kv td{border:none;padding:3px 0;white-space:normal;overflow-wrap:anywhere}
.kv td.k{color:var(--mut);width:9.5em;padding-right:10px}
.blk{border:1px solid var(--rule);border-left:2px solid var(--rule);padding:10px 12px;margin-bottom:12px}
.blk.ac{border-left-color:var(--ac)} .blk.warn{border-left-color:var(--warn)} .blk.bad{border-left-color:var(--bad)}
.blk .k{font-family:var(--m);font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--mut);margin-bottom:5px}
.blk .v{font-size:13px;line-height:1.45}
pre{margin:0;font-family:var(--m);font-size:11px;white-space:pre-wrap;word-break:break-word;background:var(--bg);
 padding:9px 10px;border:1px solid var(--rule);max-height:260px;overflow:auto}
.actions{display:flex;flex-direction:column;gap:8px;margin:16px 0}
.actions .row{display:flex;gap:6px;align-items:center}
button.go{font-family:var(--m);font-size:11px;padding:6px 12px;border:1px solid var(--ac);background:none;color:var(--ac);cursor:pointer}
button.go:disabled{opacity:.45;cursor:default}
button.stop{font-family:var(--m);font-size:11px;padding:6px 12px;border:1px solid var(--warn);background:none;color:var(--warn);cursor:pointer}
select.exp{font-family:var(--m);font-size:11px;padding:6px 8px;border:1px solid var(--rule);background:var(--bg);color:var(--ink);flex:1;min-width:0}
.rep{font-family:var(--m);font-size:11px}
.empty{color:var(--mut);font-family:var(--m);font-size:12px;padding:30px 0;text-align:center}
.backlink{font-family:var(--m);font-size:11px;color:var(--mut);background:none;border:1px solid var(--rule);padding:4px 10px;cursor:pointer;margin-bottom:14px}
.backlink:hover{color:var(--ink);border-color:var(--ac)}
.acards{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}
.acards .card{margin-bottom:0}
.pill.warnpill{color:var(--warn);border-color:var(--warn)}
.mini{font-family:var(--m);line-height:0;padding:4px 6px;border:1px solid var(--rule);background:none;
 color:var(--mut);cursor:pointer;display:inline-flex;align-items:center}
.mini:hover{color:var(--ac);border-color:var(--ac)}
/* the global svg{max-width:100%} collapses to nothing inside a 1%-wide cell */
.mini svg{width:12px;height:12px;max-width:none;flex:none}
td:has(.mini){width:1%;white-space:nowrap;padding-left:6px;padding-right:10px}
.tags{display:flex;flex-direction:column;gap:6px;margin-top:9px}
.tagrow{display:flex;flex-wrap:wrap;gap:4px;align-items:center}
.tg{font-family:var(--m);font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--mut);width:4.2em;flex:none}
.tag{font-family:var(--m);font-size:10.5px;padding:2px 7px;border:1px solid var(--rule);border-radius:2px;
 color:var(--mut);cursor:help;white-space:nowrap}
.tag.t-work{color:var(--ac);border-color:color-mix(in srgb,var(--ac) 45%,transparent)}
.tag.t-shape{color:var(--ink);border-color:var(--rule)}
.tag.t-cost{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 45%,transparent)}
.tag.t-tools{color:#7A5AF8;border-color:color-mix(in srgb,#7A5AF8 45%,transparent)}
.tag.t-flag{color:var(--bad);border-color:var(--bad)}
.tag.t-festive{color:#B8860B;border-color:#B8860B}
:root[data-theme=dark] .tag.t-festive,:root[data-theme=black] .tag.t-festive{color:#E8C56B;border-color:#E8C56B}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]) .tag.t-festive{color:#E8C56B;border-color:#E8C56B}}
.pom{border:1px solid #B8860B;padding:12px 14px;margin-bottom:12px}
.pom .k{font-family:var(--m);font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:#B8860B;margin-bottom:6px}
.pom .big{font-family:var(--d);font-size:15px;font-weight:700}
.pom .rows{display:flex;flex-direction:column;gap:3px;margin-top:8px;font-family:var(--m);font-size:11.5px;color:var(--mut)}
.pom .why{font-size:12.5px;color:var(--mut);margin-top:9px;line-height:1.45}
.pom .wish{font-family:var(--d);font-size:15px;font-weight:700;color:#B8860B;margin-top:10px;direction:rtl;text-align:right}
:root[data-theme=dark] .pom,:root[data-theme=black] .pom{border-color:#E8C56B}
:root[data-theme=dark] .pom .k,:root[data-theme=black] .pom .k,
:root[data-theme=dark] .pom .wish,:root[data-theme=black] .pom .wish{color:#E8C56B}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]) .pom{border-color:#E8C56B}
 :root:not([data-theme=light]) .pom .k,:root:not([data-theme=light]) .pom .wish{color:#E8C56B}}
.mlist{display:flex;flex-direction:column;gap:9px;margin-top:11px}
.m{border-top:1px solid var(--rule);padding-top:8px}
.mt{display:flex;justify-content:space-between;gap:8px;font-family:var(--d);font-size:12.5px;font-weight:700}
.mt .mk-pri{color:var(--ac);font-family:var(--m);font-weight:500}
.mt .mk-gue{color:var(--warn);font-family:var(--m);font-weight:500}
.mt .mk-det{color:var(--mut);font-family:var(--m);font-weight:500}
.mw{font-size:12px;line-height:1.45;color:var(--mut);margin-top:3px}
.m .mk{font-family:var(--m);font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--mut);margin-top:5px}
.m .mid{color:var(--ac);text-transform:none;letter-spacing:0}
.spin{color:var(--ac);animation:pulse 1.4s ease-in-out infinite}
.livedot{color:var(--ac);font-size:9px;vertical-align:1px;animation:pulse 1.6s ease-in-out infinite}
.opendot{color:var(--warn);font-size:9px;vertical-align:1px}
.pill.st-live{color:var(--ac);border-color:var(--ac)}
.pill.st-open{color:var(--warn);border-color:var(--warn)}
.pill.st-idle{color:var(--mut)}
.watchbtn{font-family:var(--m);font-size:12px;padding:6px 11px;border:1px solid var(--rule);
 background:var(--card);color:var(--mut);cursor:pointer}
.watchbtn:hover{color:var(--ink);border-color:var(--ac)}
.watchbtn.on{color:var(--ac);border-color:var(--ac);background:color-mix(in srgb,var(--ac) 9%,transparent)}
@media(prefers-reduced-motion:reduce){.spin,.livedot{animation:none}}
@keyframes pulse{0%,100%{opacity:.25}50%{opacity:1}}
.armlist{display:flex;flex-direction:column;gap:8px;margin-bottom:14px}
.arm{border:1px solid var(--rule);border-top:2px solid var(--rule);padding:9px 11px}
.arm.best{border-top-color:var(--ac)} .arm.err{border-top-color:var(--bad)}
.arm .t{font-family:var(--d);font-size:13px;font-weight:700;display:flex;justify-content:space-between;gap:8px}
.arm .m{font-family:var(--m);font-size:10.5px;color:var(--mut);margin-top:3px}
.arm .e{font-family:var(--m);font-size:10.5px;color:var(--bad);margin-top:5px;overflow-wrap:anywhere}
/* two-class selectors outrank .app, so every variant has to be restated per breakpoint */
@media(max-width:1180px){.app{grid-template-columns:180px minmax(0,1fr) 330px}
 .app.nodetail{grid-template-columns:180px minmax(0,1fr) 0}
 .app.railshut{grid-template-columns:0 minmax(0,1fr) 330px}
 .app.railshut.nodetail{grid-template-columns:0 minmax(0,1fr) 0}}
@media(max-width:900px){.app,.app.nodetail,.app.railshut,.app.railshut.nodetail{grid-template-columns:1fr;height:auto;overflow:auto}
 .detail{border-left:none;border-top:1px solid var(--rule)}}
.tri-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:10px 0 14px}
.tri-tiles>div{background:var(--card);border:1px solid var(--rule);padding:10px 12px;display:flex;flex-direction:column;gap:3px}
.tri-tiles b{font-family:var(--m);font-size:18px}.tri-tiles .tri-act{justify-content:center;align-items:flex-start;gap:6px}
.tri-k{font-family:var(--m);font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--mut)}
.tri-mut{color:var(--mut);font-size:11.5px}.tri-save{color:var(--ac)}.tri-loss{color:var(--bad)}.tri-zero{color:var(--mut)}
.tri-graph{float:right;text-transform:none;letter-spacing:0}
.tri-graph[disabled]{opacity:.4;cursor:default}
.graphframe{display:block;width:100%;height:calc(100vh - 120px);border:1px solid var(--line);background:#000}
.tri-sec{font-family:var(--m);font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--mut);margin:14px 0 6px}
.tri-note{color:var(--mut);font-size:12px;line-height:1.5;margin:12px 0;max-width:80ch}
.tri-modes{display:inline-flex;border:1px solid var(--rule)}.tri-modes button{font-family:var(--m);font-size:11px;padding:4px 10px;border:none;background:none;color:var(--mut);cursor:pointer}
.tri-modes button.on{background:var(--ac);color:var(--card)}
#trigroup,#trigroup2{font-family:var(--m);font-size:11px;padding:3px 6px;border:1px solid var(--rule);background:var(--card);color:var(--ink)}
th[data-ts]{cursor:pointer;user-select:none}th[data-ts]:hover{color:var(--ink)}
tr[data-tg]{cursor:pointer}
.tri-dir{display:inline-block;max-width:26em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom}
.tri-filter{font-size:12.5px;margin:0 0 10px;display:flex;gap:8px;align-items:center}.tri-filter button{font-family:var(--m);font-size:11px;border:1px solid var(--rule);background:none;color:var(--mut);cursor:pointer;padding:2px 8px}
.tri-list{margin:0 0 6px;padding-left:18px;font-size:12px;line-height:1.5}.tri-list li{overflow-wrap:anywhere}
.tri-meth{margin:0 0 14px}.tri-meth td{vertical-align:middle}.tri-meth tr[data-tmeth]{cursor:pointer}
.tri-meth code,.tri-knob{font-family:var(--m);font-size:10.5px;color:var(--ac)}
.tri-bar{display:inline-block;width:64px;height:7px;background:var(--rule);vertical-align:middle;margin-right:6px;position:relative}
.tri-bar>i{position:absolute;left:0;top:0;bottom:0;background:var(--ac)}.tri-bar.spend>i{background:var(--bad)}
.tri-chips{display:flex;flex-wrap:wrap;gap:3px}
.tri-chip{font-family:var(--m);font-size:10px;padding:1px 5px;border:1px solid var(--rule);color:var(--mut);white-space:nowrap;border-radius:2px}
.tri-chip.hi{color:var(--ink)}.tri-chip.on{border-color:var(--ac);color:var(--ac);font-weight:700}.tri-chip.spend.on{border-color:var(--bad);color:var(--bad)}
.exprow td{background:var(--rail);font-size:12px}.exprow td.intent{padding-left:22px}
.goalpick{display:flex;gap:0;border:1px solid var(--rule);margin:6px 0 4px}.goalpick button{flex:1;font-family:var(--m);font-size:11.5px;padding:7px 6px;border:none;background:none;color:var(--mut);cursor:pointer}
.goalpick button.on{background:var(--ac);color:var(--card)}
.strat{border:1px solid var(--rule);padding:8px 10px;margin:0 0 6px;display:flex;gap:8px;cursor:pointer;background:var(--card)}
.strat.on{border-color:var(--ac);box-shadow:inset 3px 0 0 var(--ac)}.strat.no{opacity:.5;cursor:default}
.strat .t{font-weight:700;font-size:13px}.strat .d{font-size:11.5px;color:var(--mut);line-height:1.45;margin-top:2px}
.spider{width:100%;max-width:360px;margin:6px auto 0}.spider text{font-family:var(--m)}
.sgraph svg{width:100%}
.tri-subtabs{display:flex;gap:0;border-bottom:1px solid var(--rule);margin:10px 0 4px}
.tri-subtabs button{font-family:var(--m);font-size:11px;padding:6px 12px;border:none;border-bottom:2px solid transparent;background:none;color:var(--mut);cursor:pointer;margin-bottom:-1px}
.tri-subtabs button.on{color:var(--ink);border-bottom-color:var(--ac)}
.tri-risk{font-family:var(--m);font-size:11px;border:1px solid var(--rule);background:none;color:var(--mut);cursor:pointer;padding:3px 9px}.tri-risk.on{border-color:var(--bad);color:var(--bad)}
.mini-go{font-size:10.5px;padding:3px 8px}
.tri-big{font-family:var(--m);font-size:13px;font-weight:700}
.tri-pre{font-family:var(--m);font-size:11px;line-height:1.45;background:var(--rail);border:1px solid var(--rule);padding:8px 10px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:340px;overflow:auto;margin:0 0 6px}
#profproj,#proftry{font-family:var(--m);font-size:11px;padding:3px 6px;border:1px solid var(--rule);background:var(--card);color:var(--ink);max-width:100%}
.mp summary{cursor:pointer;font-family:var(--m);font-size:11px;color:var(--ac);margin-top:4px}
${INSIGHTS_CSS}
</style></head><body>
<div class="app" id="app">
  <aside class="rail">
    <div class="brand"><span class="brandmark">${ICON_SVG(20)}</span><div class="who"><h1>Optimization Hub</h1><div class="s" id="brandsub">loading…</div></div>
      <button class="railbtn" id="railshut" title="hide sidebar">&#171;</button></div>
    <nav id="nav"></nav>
    <div class="railfoot"><div class="theme" id="theme">
      <button data-th="auto">auto</button><button data-th="dark">dark</button><button data-th="black">black</button>
    </div></div>
  </aside>
  <section class="mid" id="mid"></section>
  <aside class="detail" id="detail"></aside>
</div>
<button class="railbtn railopen" id="railopen" title="show sidebar">&#187;</button>
<button class="railbtn detopen" id="detopen" title="show details">&#8249;</button>
<script>
const SECTIONS=[['sessions','Sessions'],['triage','Triage'],['analytics','Analytics'],['optimization','Optimize']]
const SUBTABS=[['sessions','Sessions'],['runs','Experiments'],['catalog','Catalog'],['profiles','Profiles']]
/* what the person wants from an optimization; every run records it */
const GOALS=[['cost','Cost','spend less for the same result'],['latency','Latency','get the answer sooner'],['accuracy','Accuracy','keep the answer as good — least risky levers first']]
let goal='cost', STRAT=null, SERIES_FOR=''
/* Read-only deploy (hub-demo.mjs sets window.HUB_DEMO before this script).
   The UI is identical; what spends money is disabled and labelled. */
const DEMO=!!window.HUB_DEMO
let DATA=null, RUNS={runs:[],bySession:{}}, CAT={experiments:[]}, LIVE={}, TRI=null
let section='sessions', subtab='sessions', sel={}, sortKey='endedAt', sortDir=-1
let lastView=''   // section+subject last drawn, so a view change can reset the scroll
let detailShut=false, SDETAIL=null   // SDETAIL: the per-turn series for the analysed session
let watching=false                   // watch mode: 2s polling, live and open only
let pendingRun=null   // session id of a run launched here but not yet on disk
let filters={q:'',kind:'',art:'',date:'',from:'',to:''}

const esc=(s)=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
const fmtM=(v)=>v>=60?(v/60).toFixed(1)+'h':Math.round(v)+'m'
const usd=(v)=>v==null?'—':'$'+Number(v).toFixed(Number(v)<10?(Number(v)<0.1?4:2):0)
const modelOf=(m)=>esc(String(m??'').replace(/^.*?anthropic\./,'').replace(/-v1.*|:.*/,'').replace(/claude-/,''))
const CHART_ICON='<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">'
 +'<rect x="0.5" y="7" width="2.6" height="5" fill="currentColor"/>'
 +'<rect x="4.7" y="3.5" width="2.6" height="8.5" fill="currentColor"/>'
 +'<rect x="8.9" y="0.5" width="2.6" height="11.5" fill="currentColor"/></svg>'
const tok=(n)=>{n=Number(n||0);return n>=1e6?(n/1e6).toFixed(2)+'M':n>=1000?(n/1000).toFixed(n>=1e5?0:1)+'k':String(n)}
const ago=(iso)=>{if(!iso)return '—';const s=(Date.now()-new Date(iso))/1000
  return s<90?Math.round(s)+'s ago':s<5400?Math.round(s/60)+'m ago':s<172800?Math.round(s/3600)+'h ago':Math.round(s/86400)+'d ago'}
function sparkline(series){
  const w=80,n=(series||[]).length; if(!n)return ''
  const cell=Math.max(1,Math.min(4,Math.floor(w/n))); let x=0,out=''
  for(const t of series){const on=!!t;out+='<rect x="'+x+'" y="'+(on?2:7)+'" width="'+(cell-0.5)+'" height="'+(on?12:2)+'" fill="'+(on?'var(--ac)':'var(--rule)')+'"/>';x+=cell}
  return '<svg class="spark" width="'+x+'" height="16" viewBox="0 0 '+x+' 16">'+out+'</svg>'
}
/* the phase a session's most recent run is in, live status winning over disk */
const liveOf=(id)=>LIVE[id]||null
function runState(id){
  const l=liveOf(id), r=RUNS.bySession[id]
  if(l&&l.phase&&!['done','error','stopped','stale'].includes(l.phase))return {phase:l.phase,live:true,run:r}
  return {phase:r?r.phase:null,live:false,run:r}
}

/* ------------------------------------------------------------------ rail */
function rail(){
  const live=Object.values(LIVE).filter(x=>x&&x.phase&&!['done','error','stopped','stale'].includes(x.phase)).length
  const counts={sessions:DATA?DATA.sessions.length:0,
                optimization:live?RUNS.runs.length+' ·'+live:RUNS.runs.length,
                analytics:INS?Object.keys(INS.attrs).length:'',
                triage:TRI&&TRI.sessions?TRI.sessions.length:''}
  const optOn=section==='optimization'
  document.getElementById('nav').innerHTML=SECTIONS.map(([id,label])=>{
    const btn='<button data-s="'+id+'" class="'+(section===id?'on':'')+'">'+label+'<span class="n">'+(counts[id]||'')+'</span></button>'
    if(id!=='optimization'||!optOn)return btn
    return btn+'<div class="sub">'+SUBTABS.map(([x,l])=>
      '<button data-x="'+x+'" class="'+(subtab===x?'on':'')+'">'+l
      +'<span class="n">'+(x==='catalog'?CAT.experiments.length:x==='runs'?RUNS.runs.length:x==='profiles'?(PROF?(PROF.profiles||[]).length:''):'')+'</span></button>').join('')+'</div>'
  }).join('')
   +(section==='graph'?'<button data-s="graph" class="on">Graph<span class="n">1</span></button>':'')
  document.querySelectorAll('#nav button[data-s]').forEach(b=>b.onclick=()=>{section=b.dataset.s;if(section==='analytics'&&asub==='session')asub='pct';draw();if(section==='analytics')loadInsights()})
  document.querySelectorAll('#nav .sub button').forEach(b=>b.onclick=()=>{subtab=b.dataset.x;section='optimization';draw()})
}

/* -------------------------------------------------------------- sessions */
function sessionRows(){
  const q=filters.q.toLowerCase()
  let list=DATA.sessions.filter(s=>(!q||(s.intent+' '+s.model).toLowerCase().includes(q))
    &&(!filters.kind||s.kind===filters.kind)&&(!filters.art||(filters.art==='y'?s.hasArtifact:!s.hasArtifact))
    &&inDateRange(s))
  list.sort((a,b)=>{const x=a[sortKey],y=b[sortKey];const c=typeof x==='number'?x-y:String(x).localeCompare(String(y));return c*sortDir})
  return list
}
function sessionsView(inOpt){
  const st=DATA.totals, list=sessionRows()
  const bands={};for(const x of DATA.sessions){const b=POT(x).band;bands[b]=(bands[b]||0)+1}
  const stats=inOpt
   ?[['sessions',st.count],['high potential',bands.high||0],['medium',bands.medium||0],
     ['below ROI gate',bands['below-gate']||0],['experiments',RUNS.runs.length]]
   :[['sessions',st.count],['live now',st.live||0],['still open',st.open||0],
     ['total cost','$'+st.cost],['experiments',RUNS.runs.length]]
  const kinds=Object.keys(st.byKind)
  const cols=inOpt
   ?'<th data-s="model">Model</th><th data-s="kind">Kind</th><th data-s="intent">Intent</th>'
    +'<th data-s="ctxMedian">Context</th><th data-s="cost">Cost</th><th data-s="turns">Turns</th>'
    +'<th data-s="artifactBytes">Artifacts</th><th data-s="potPct">Potential</th>'+(watching?'<th>State</th>':'')+'<th>Experiment</th><th></th>'
   :'<th data-s="model">Model</th><th data-s="kind">Kind</th><th data-s="intent">Intent</th>'
    +'<th data-s="cost">Cost</th><th data-s="turns">Turns</th><th data-s="durationMin">Duration</th>'
    +'<th data-s="artifactBytes">Artifacts</th><th data-s="roi" title="artifact value per dollar, 1–100 among sessions that produced a file">ROI</th>'+(watching?'<th>State</th>':'')+'<th></th>'
  return '<div class="midhead"><h2>'+(inOpt?'Optimize':'Sessions')+'</h2>'+(inOpt?'<span class="crumb">pick a session, choose a goal, run a strategy</span>':'<span class="crumb">past and live · experiments nested under the session they ran on</span>')+'</div>'
   +'<p class="sub">'+subLine(list,inOpt)+'</p>'
   +'<div class="stats">'+stats.map(([k,v])=>'<div class="stat"><div class="v">'+v+'</div><div class="k">'+k+'</div></div>').join('')+'</div>'
   +'<div class="filters"><input id="q" placeholder="filter intent / model…" size="24" value="'+esc(filters.q)+'">'
   +'<select id="fkind"><option value="">all kinds</option>'+kinds.map(k=>'<option'+(filters.kind===k?' selected':'')+'>'+k+'</option>').join('')+'</select>'
   +'<select id="fart"><option value="">artifacts: any</option><option value="y"'+(filters.art==='y'?' selected':'')+'>has artifact</option>'
   +'<option value="n"'+(filters.art==='n'?' selected':'')+'>none</option></select>'
   +'<select id="fdate" title="filter by when the session was created">'
   +DATE_OPTS.map(([v,l])=>'<option value="'+v+'"'+(filters.date===v?' selected':'')+'>'+l+'</option>').join('')+'</select>'
   +(filters.date==='custom'
     ?'<input id="dfrom" type="date" value="'+esc(filters.from)+'" title="created on or after">'
      +'<input id="dto" type="date" value="'+esc(filters.to)+'" title="created on or before">'
     :'')
   +'<button class="watchbtn'+(watching?' on':'')+'" onclick="toggleWatch()" '
   +'title="Re-read the transcripts every 2s instead of every 8-30s, so a session going live '
   +'\u2014 or a brand new one \u2014 appears as it happens. Nothing is filtered out.">'
   +(watching?'\u25cf watching':'watch live')+'</button></div>'
   +'<table><thead><tr>'+cols+'</tr></thead><tbody id="srows">'
   +sessionBody(list,inOpt)+'</tbody></table>'
}
/* the tbody alone, so a keystroke in the filter never rebuilds the filter.
   The run state is a column only under Optimization — the Sessions tab does not
   launch runs, so a column about them there is answering a question it does not
   let you ask. */
function sessionBody(list,inOpt){
  return list.map(s=>{
    let badge=''
    if(inOpt){
      const rs=runState(s.id)
      badge='<td>'+(!rs.phase?'<span class="pill flat">—</span>'
        :rs.live?'<span class="pill">'+esc(rs.phase)+'…</span>'
        :'<span class="pill '+(rs.run?rs.run.headline.tone:'flat')+'">'+esc(rs.phase)+'</span>')+'</td>'
    }
    const cls=[sel.sessions===s.id?'on':'',
               watching&&(s.status==='live'||s.status==='open')?'w-'+s.status:''].filter(Boolean).join(' ')
    return '<tr data-id="'+s.id+'" class="'+cls+'">'
     +'<td class="model">'+statusDot(s)+modelOf(s.model)+'</td>'
     +'<td><span class="pill '+esc(s.kind)+'">'+esc(s.kind)+'</span></td>'
     +'<td class="intent">'+esc(s.intent.slice(0,120))+(!inOpt&&expsOf(s.id).length?' <span class="pill code">'+expsOf(s.id).length+' exp</span>':'')+'</td>'
     +(inOpt?'<td class="num" title="median per request · peak '+tok(s.ctxPeak)+'">'+tok(s.ctxMedian)+'</td>':'')
     +'<td class="num">'+usd(s.cost)+'</td>'
     +'<td class="num">'+s.turns+'</td>'
     +(inOpt?'':'<td class="num">'+fmtM(s.durationMin||0)+'</td>')
     +'<td class="arts">'+artCell(s)+'</td>'
     +(inOpt?'<td>'+bandPill(POT(s))+'</td>':'<td class="num">'+(s.roi==null?'<span class="roi-none">—</span>':'<span class="roi">'+s.roi+'</span>')+'</td>')
     +(watching?'<td>'+statusPill(s)+'</td>':'')
     +badge
     +'<td><button class="mini" title="analytics for this session" onclick="event.stopPropagation();openAnalytics(\''+s.id+'\')">'+CHART_ICON+'</button></td>'
     +'</tr>'
     +(inOpt?'':expsOf(s.id).map(expRow).join(''))}).join('')
}
/* live / open / idle, from lib/watch.mjs — each says which signal it stands on */
const STATUS_WHY={
  live:'wrote to its transcript in the last 90 seconds',
  open:'a claude process is running in this directory and this is its newest session',
  idle:'wrote in the last 30 minutes, but nothing is running there now',
  closed:'no recent writes, no process',
}
function statusDot(s){
  if(s.status==='live')return '<span class="livedot" title="'+STATUS_WHY.live+'">\u25cf</span> '
  if(s.status==='open')return '<span class="opendot" title="'+STATUS_WHY.open+'">\u25cb</span> '
  return ''
}
const statusPill=(s)=>!s.status||s.status==='closed'?'<span class="pill flat">closed</span>'
  :'<span class="pill st-'+s.status+'" title="'+STATUS_WHY[s.status]+'">'+s.status+'</span>'

/* the files a session wrote: biggest one named, the rest behind a +n, all of them on hover */
function artCell(s){
  if(!s.hasArtifact)return '<span class="art none">none</span>'
  const names=s.artifacts.map(a=>a.name), top=names[0], more=names.length-1
  return '<span class="art" title="'+esc(names.join(', '))+'">'
   +esc(top.length>24?top.slice(0,23)+'…':top)+(more>0?' <span class="n">+'+more+'</span>':'')+'</span>'
}
/* Created-date filter, on startedAt: when the session began, which is not the
   same as when it last wrote. A resumed session is days old and still going,
   and "what did I start this week" is the question people actually ask. */
const DAY=86400000
function dateBounds(){
  const now=Date.now(), sod=(t)=>{const d=new Date(t);d.setHours(0,0,0,0);return d.getTime()}
  switch(filters.date){
    case 'today':     return {from:sod(now),to:sod(now)+DAY-1}
    case 'yesterday': return {from:sod(now)-DAY,to:sod(now)-1}
    case '7d':        return {from:now-7*DAY,to:null}
    case '30d':       return {from:now-30*DAY,to:null}
    case 'custom':    return {from:filters.from?sod(Date.parse(filters.from+'T00:00')):null,
                              to:filters.to?sod(Date.parse(filters.to+'T00:00'))+DAY-1:null}
    default:          return {from:null,to:null}
  }
}
function inDateRange(s){
  const {from,to}=dateBounds()
  if(from==null&&to==null)return true
  const t=s.startedAt?Date.parse(s.startedAt):NaN
  if(!Number.isFinite(t))return false
  return (from==null||t>=from)&&(to==null||t<=to)
}
const DATE_OPTS=[['','any date','' ],['today','created today','created today'],
                 ['yesterday','created yesterday','created yesterday'],
                 ['7d','last 7 days','created in the last 7 days'],
                 ['30d','last 30 days','created in the last 30 days'],
                 ['custom','custom range…',null]]
const shownCost=(list)=>list.reduce((a,s)=>a+s.cost,0).toFixed(2)
/* The one summary line. sessionsView renders it and refilter rewrites it, so it
   lives here — the two copies is how the date label went missing. */
function subLine(list,inOpt){
  const st=DATA.totals, filtered=list.length!==st.count
  const running=list.filter(s=>s.status==='live'||s.status==='open').length
  return list.length+' of '+st.count+' · $'+(filtered?shownCost(list)+' shown of $':'')+st.cost
   +(watching?' · watching every 2s · '+running+' running':'')
   +(filters.date&&dateLabel()?' · '+dateLabel():'')
   +' · '+(inOpt?'open one and run a lever against it':'click a row to open it on the right')
}
function dateLabel(){
  if(filters.date!=='custom')return (DATE_OPTS.find(([v])=>v===filters.date)||[,,''])[2]||''
  if(filters.from&&filters.to)return 'created '+filters.from+' → '+filters.to
  if(filters.from)return 'created on or after '+filters.from
  if(filters.to)return 'created on or before '+filters.to
  return 'custom range (no dates set)'
}

/* computed server-side in /api/sessions — the pricing model stays in node */
const NOPOT={band:'none',lo:0,hi:0,usdLo:0,usdHi:0,methods:[],basis:'',gateNote:null}
const POT=(s)=>s.potential||NOPOT
/* /atlas, opened with this session's workload: measured from its transcript, classified by Jev */
const atlasLink=(s,p)=>{
  const b64=btoa(JSON.stringify(p.atlas.workload)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')
  const label=String(s.intent||'').slice(0,50)+' · '+s.id.slice(0,8)+' · $'+Number(s.cost||0).toFixed(2)
  return '/atlas?w='+b64+'&s='+encodeURIComponent(label)
}
function bandPill(p){
  if(p.band==='none')return '<span class="pill flat">—</span>'
  if(p.band==='below-gate')return '<span class="pill flat" title="'+esc(p.gateNote||'')+'">below gate</span>'
  const cls=p.band==='high'?'improved':p.band==='medium'?'warnpill':'flat'
  return '<span class="pill '+cls+'" title="'+esc(p.head?p.head.name+' · '+p.head.evidence:'')+'">'+p.lo.toFixed(0)+'–'+p.hi.toFixed(0)+'%</span>'
}
/* refilter in place: tbody and the count line only */
function refilter(){
  const tb=document.getElementById('srows'); if(!tb)return draw()
  const list=sessionRows()
  tb.innerHTML=sessionBody(list,section==='optimization')
  const sub=document.querySelector('#mid .sub')
  if(sub)sub.textContent=subLine(list,section==='optimization')
  tb.querySelectorAll('tr[data-id]').forEach(tr=>tr.onclick=()=>{sel.sessions=tr.dataset.id;detailShut=false;draw()})
}

/* --------------------------------------------------------- session detail */
/* withRun is false in the Sessions tab: that tab reports, it does not spend. */
/* runs launched against one session, newest first: these are its experiments */
const expsOf=(id)=>runRows().filter(r=>r.session===id).sort((a,b)=>String(b.startedAt).localeCompare(String(a.startedAt)))
const runArm=(r)=>(r.arms||[]).find(a=>a.role!=='baseline')||(r.arms||[])[0]||null
const expTitle=(r)=>{const e=CAT.experiments.find(x=>x.id===r.experiment);return e?e.title:(r.experiment||'auto grid')}
function expRow(r){
  const a=runArm(r)
  return '<tr data-exp="'+esc(r.run)+'" class="exprow'+(sel.exp===r.run?' on':'')+'">'
   +'<td class="model">'+(a?esc(a.model):'—')+'</td><td><span class="pill code">experiment</span></td>'
   +'<td class="intent">↳ '+esc(expTitle(r))+' · goal '+esc(r.goal||'cost')+' · <span class="pill '+esc(r.headline.tone)+'">'+esc(r.headline.text.slice(0,40))+'</span></td>'
   +'<td class="num">'+usd(r.totalCost)+'</td><td class="num">'+(a?a.turns:'—')+'</td><td class="num">'+(a&&a.secs!=null?a.secs+'s':'—')+'</td>'
   +'<td class="arts">'+(a?a.artifacts.length+' file(s)':'—')+'</td><td></td>'+(watching?'<td></td>':'')+'<td></td></tr>'
}
/* the per-turn series behind the session graph: fetched once per selected session */
function ensureSeries(id){
  if(!id||(SDETAIL&&SDETAIL.id===id)||SERIES_FOR===id)return
  SERIES_FOR=id
  fetch('/api/session?id='+encodeURIComponent(id)).then(r=>r.json()).then(d=>{SDETAIL=d;if(sel.sessions===id)draw()}).catch(()=>{})
}
function sessionGraph(s){
  if(!SDETAIL||SDETAIL.id!==s.id){ensureSeries(s.id);return '<div class="blk"><div class="k">session graph</div><div class="v" style="color:var(--mut)">reading the transcript…</div></div>'}
  const S=SDETAIL.series||[]
  if(!S.length)return '<div class="blk"><div class="k">session graph</div><div class="v" style="color:var(--mut)">no billed requests to chart</div></div>'
  return '<div class="blk sgraph"><div class="k">cost, cumulative · turn 1 → '+S.length+'</div>'+lineChart(S,(d)=>d.costCum,(v)=>'$'+v.toFixed(v<1?3:1),'var(--warn)')+'</div>'
   +'<div class="blk sgraph"><div class="k">context carried per request</div>'+lineChart(S.filter((d)=>d.ctx>0),(d)=>d.ctx,(v)=>tok(v),'var(--ac)')+'</div>'
}
function expList(s){
  const ex=expsOf(s.id)
  if(!ex.length)return ''
  return '<div class="blk"><div class="k">experiments on this session</div>'+ex.map(r=>
    '<div class="v" style="margin:4px 0"><a href="#" onclick="event.preventDefault();sel.exp=\''+esc(r.run)+'\';section=\'sessions\';draw()">'+esc(expTitle(r))+'</a>'
    +' <span class="tri-mut">goal '+esc(r.goal||'cost')+' · '+ago(r.startedAt)+'</span> <span class="pill '+esc(r.headline.tone)+'">'+esc(r.headline.text.slice(0,40))+'</span></div>').join('')+'</div>'
}
function goOptimize(id){sel.sessions=id;sel.exp=null;section='optimization';subtab='sessions';STRAT=null;draw()}
function sessionDetail(withRun){
  const s=DATA.sessions.find(x=>x.id===sel.sessions)
  if(!s)return placeholder('Pick a session',withRun
    ?'Choose a goal, pick a strategy from what the analysis found, and run it. The result comes back as an experiment on this session.'
    :'Its summary, its graph, and the experiments run on it.')
  return withRun?optimizeDetail(s):summaryDetail(s)
}
function summaryDetail(s){
  const inTri=TRI&&TRI.sessions&&TRI.sessions.some(x=>x.session===s.id)
  return '<div class="eyebrow">session '+esc(s.id.slice(0,8))
   +(s.live?' <span class="livedot">\u25cf</span> live \u00b7 still being written':'')+'</div>'
   +'<h3>'+esc(s.intent.slice(0,150))+'</h3>'
   +'<div class="actions"><div class="row">'
   +'<button class="go" onclick="goOptimize(\''+s.id+'\')">Optimize ▸</button>'
   +(inTri?'<button class="backlink" onclick="sel.triage=(TRI.sessions.find(x=>x.session===\''+s.id+'\')||{}).key;section=\'triage\';draw()">triage ▸</button>':'')
   +'<button class="backlink" onclick="openAnalytics(\''+s.id+'\')">full graphs ▸</button></div></div>'
   +'<table class="kv">'
   +kv('model',modelOf(s.model))+kv('kind',s.kind)+kv('cost',usd(s.cost))
   +kv('turns',s.turns)+kv('duration',fmtM(s.durationMin))+kv('ended',ago(s.endedAt))
   +kv('context','median '+tok(s.ctxMedian)+' · peak '+tok(s.ctxPeak)+' · cache reuse '+(s.cacheHit*100).toFixed(0)+'%')
   +kv('artifacts',s.hasArtifact?s.artifacts.map(a=>esc(a.name)).join(', '):'<span style="color:var(--mut)">none</span>')
   +(s.roi!=null?kv('ROI',s.roi+' <span style="color:var(--mut)">of 100</span>'):'')
   +'</table>'
   +tagBlock(s)+pomBlock(s)
   +sessionGraph(s)+expList(s)
}
/* goal -> strategies -> run. The strategies come from what is already known about the
   session (its own tokens, priced by lib/goals.mjs) with Jev's per-method score beside them. */
function loadStrat(id){
  const key=id+'|'+goal
  if(STRAT&&STRAT.key===key)return
  STRAT={key,loading:true}
  fetch('/api/strategies?session='+encodeURIComponent(id)+'&goal='+goal).then(r=>r.json()).then(d=>{
    STRAT={key,...d}
    const pick=(d.considered||[]).find(c=>c.id===d.pick&&c.runnable)
    sel.lever=pick?pick.id:'__auto'
    if(sel.sessions===id)draw()}).catch(()=>{STRAT={key,error:true};draw()})
}
function optimizeDetail(s){
  const rs=runState(s.id), busy=rs.live
  loadStrat(s.id)
  const gp='<div class="goalpick">'+GOALS.map(([g,l])=>'<button data-goal="'+g+'" class="'+(goal===g?'on':'')+'">'+l+'</button>').join('')+'</div>'
   +'<div class="tri-mut">'+esc((GOALS.find(x=>x[0]===goal)||[])[2]||'')+'</div>'
  let list=''
  if(!STRAT||STRAT.loading)list='<div class="tri-mut">reading the analysis…</div>'
  else if(STRAT.error)list='<div class="tri-mut">no strategies for this session</div>'
  else{
    const C=STRAT.considered.slice().sort((a,b)=>(b.runnable-a.runnable)||((a.rank||99)-(b.rank||99)))
    list=C.map(c=>{
      const on=sel.lever===c.id, j=c.jev
      return '<div class="strat'+(on?' on':'')+(c.runnable?'':' no')+'"'+(c.runnable?' data-strat="'+esc(c.id)+'"':'')+'>'
       +'<div style="flex:1"><div class="t">'+(c.id===STRAT.pick?'★ ':'')+esc(c.title)
       +' <span class="pill '+(c.risk==='low'?'improved':c.risk==='high'?'degraded':'warnpill')+'">'+esc(c.risk)+' risk</span></div>'
       +'<div class="d">'+(c.runnable?'<b>best case:</b> '+esc(c.best.text)+(c.best.label?' <span class="tri-mut">('+esc(c.best.label)+')</span>':'')
         +'<br><b>can go wrong:</b> '+esc(c.worst)+' — caught by '+esc(c.caughtBy)
         +(j?'<br><b>Jev:</b> '+(c.jevAgainst?'<span class="tri-loss">says it does not apply</span>':j.score==null?'no answer':Math.round(100*j.score)+'% relevant')+(j.unlocked?' · unlocked':'')+' · priced '+triUsd(j.saving)+' ('+j.pct+'%)':'')
        :esc(c.why||'stacks two levers — run each one first'))+'</div></div></div>'}).join('')
    list+='<div class="strat'+(sel.lever==='__auto'?' on':'')+'" data-strat="__auto"><div><div class="t">Auto</div><div class="d">let a model propose a small grid with a control arm, when no single lever stands out</div></div></div>'
  }
  const runBtn=DEMO?'<button class="go" disabled title="read-only deploy — this would boot cloud sandboxes and spend">Run</button>'
    :'<button class="go" '+(busy||!STRAT||STRAT.loading?'disabled':'')+' onclick="runStrategy(\''+s.id+'\')">'+(busy?'running…':'Run')+'</button>'
     +(busy?' <button class="stop" onclick="stopRun(\''+s.id+'\')">stop</button>':'')
  return '<div class="eyebrow">optimize · session '+esc(s.id.slice(0,8))+'</div>'
   +'<h3>'+esc(s.intent.slice(0,150))+'</h3>'
   +'<table class="kv">'+kv('model',modelOf(s.model))+kv('cost',usd(s.cost))+kv('turns',s.turns)+kv('context','median '+tok(s.ctxMedian))+'</table>'
   +'<div class="tri-sec">1 · goal</div>'+gp
   +'<div class="tri-sec">2 · strategy · ★ recommended for '+esc(goal)+'</div>'+list
   +'<div class="tri-sec">3 · run</div><div class="actions"><div class="row">'+runBtn+'</div></div>'
   +'<div class="tri-mut">Replays this session’s task twice in a sandbox — the baseline and the strategy — and a blind judge scores both (≤ $3). The result appears as an experiment under this session, with a spider chart against the baseline.</div>'
   +expList(s)
}
function runStrategy(id){
  const v=sel.lever||'__auto'
  return v==='__auto'?runOpt(id):runExp(id)
}
/* the spider: each arm on cost, speed, accuracy and turns, scaled so the outside edge is the
   best value any arm reached. Arms are compared with each other, never with the original session. */
function spider(r){
  const A=(r.arms||[]).filter(a=>!a.isError)
  if(!A.length)return ''
  const low=(f)=>{const v=A.map(f).filter(x=>x!=null&&x>0);const m=v.length?Math.min(...v):null;return (a)=>{const x=f(a);return m&&x>0?m/x:null}}
  const AX=[['cost','Cost',low(a=>a.cost)],['latency','Speed',low(a=>a.secs)],
            ['accuracy','Accuracy',(a)=>a.score!=null&&r.scoreMax?a.score/r.scoreMax:null],['turns','Fewer turns',low(a=>a.turns)]]
  const W=360,H=270,cx=180,cy=135,R=92,n=AX.length
  const pt=(i,v)=>{const t=-Math.PI/2+i*2*Math.PI/n;return [cx+Math.cos(t)*R*v,cy+Math.sin(t)*R*v]}
  let g=''
  for(const f of [.25,.5,.75,1])g+='<polygon points="'+AX.map((_,i)=>pt(i,f).map(x=>x.toFixed(1)).join(',')).join(' ')+'" fill="none" stroke="var(--rule)"/>'
  AX.forEach(([k,l],i)=>{const [x,y]=pt(i,1),[lx,ly]=pt(i,1.2)
    g+='<line x1="'+cx+'" y1="'+cy+'" x2="'+x.toFixed(1)+'" y2="'+y.toFixed(1)+'" stroke="var(--rule)"/>'
      +'<text x="'+lx.toFixed(1)+'" y="'+(ly+4).toFixed(1)+'" text-anchor="'+(Math.abs(lx-cx)<2?'middle':lx<cx?'end':'start')+'" font-size="'+(k===(r.goal||'cost')?12:10.5)+'" font-weight="'+(k===(r.goal||'cost')?700:400)+'" fill="'+(k===(r.goal||'cost')?'var(--ink)':'var(--mut)')+'">'+l+(k===(r.goal||'cost')?' ★':'')+'</text>'})
  const COL=['var(--ac)','var(--warn)','#7A5AF8'], opt=A.filter(a=>a.role!=='baseline')
  const colOf=(a)=>a.role==='baseline'?'var(--mut)':COL[opt.indexOf(a)%COL.length]
  A.forEach((a)=>{const c=colOf(a)
    g+='<polygon points="'+AX.map(([,,f],i)=>pt(i,f(a)||0).map(x=>x.toFixed(1)).join(',')).join(' ')+'" fill="'+c+'" fill-opacity=".14" stroke="'+c+'" stroke-width="2"'+(a.role==='baseline'?' stroke-dasharray="4 3"':'')+'/>'})
  const key=A.map((a)=>{const c=colOf(a)
    return '<span style="display:inline-flex;align-items:center;gap:5px;margin-right:12px;font-size:11.5px"><span style="width:12px;height:3px;background:'+c+'"></span>'+esc(a.label)+'</span>'}).join('')
  return '<svg class="spider" viewBox="0 0 '+W+' '+H+'">'+g+'</svg><div style="text-align:center;margin:2px 0 8px">'+key+'</div>'
}
function experimentDetail(r){
  if(!r)return placeholder('Pick an experiment','Its goal, the spider chart against the baseline, and the verdict.')
  const busy=!['done','error','stopped','stale'].includes(r.phase)
  const A=(r.arms||[])
  const num=A.length?'<table class="kv">'+'<tr><td class="k"></td><td>'+A.map(a=>'<b>'+esc(a.label)+'</b>').join(' · ')+'</td></tr>'
    +kv('cost',A.map(a=>a.isError?'error':usd(a.cost)).join(' · '))
    +kv('time',A.map(a=>a.secs!=null?a.secs+'s':'—').join(' · '))
    +kv('accuracy',A.map(a=>a.score!=null?a.score+(r.scoreMax?'/'+r.scoreMax:''):'not judged').join(' · '))
    +kv('turns',A.map(a=>a.turns).join(' · '))+'</table>':''
  return '<div class="eyebrow">experiment · session '+esc(r.sessionShort)+' · '+ago(r.startedAt)+'</div>'
   +'<h3>'+esc(expTitle(r))+'</h3>'
   +'<div class="actions"><div class="row"><span class="pill code">goal: '+esc(r.goal||'cost')+'</span> <span class="pill '+esc(r.headline.tone)+'">'+esc(r.headline.text)+'</span>'
   +(busy?' <span class="spin">●</span> '+esc(r.phase):'')+'</div></div>'
   +(busy&&!A.length?'<div class="blk"><div class="v" style="color:var(--mut)">running — the spider appears when the arms report.</div></div>':spider(r))
   +num
   +(r.headline.detail?'<div class="blk"><div class="v" style="font-size:12.5px">'+esc(r.headline.detail)+'</div></div>':'')
   +'<div class="tri-mut" style="margin:6px 0 10px">Both arms replay the same task in the sandbox, so they are compared with each other; the outside edge of the spider is the best value either reached. '
   +'The original session ('+(r.originalCost!=null?usd(r.originalCost):'—')+') is context, not a baseline — a replay finishes in a few turns what the real session took many for. One run is one data point, not a finding: repeat it three times before trusting it.</div>'
   +'<div class="actions"><div class="row">'
   +(r.report?'<a class="rep" href="/'+esc(r.report)+'" target="_blank">report ▸</a> · ':'')
   +'<a class="rep" href="/optlog?session='+encodeURIComponent(r.session)+'" target="_blank">log ▸</a>'
   +' · <a href="#" onclick="event.preventDefault();sel.sessions=\''+esc(r.session)+'\';sel.exp=null;section=\'sessions\';draw()">session ▸</a>'
   +(busy?' <button class="stop" onclick="stopRun(\''+r.session+'\')">stop</button>':'')+'</div></div>'
}
/* Every chip carries the number that produced it, on hover — a classification
   you cannot interrogate is decoration. */
const TAGORDER=['work','shape','cost','tools','festive','flag']
function tagBlock(s){
  const tags=s.tags||[]
  if(!tags.length)return ''
  const byGroup=TAGORDER.map(g=>[g,tags.filter(t=>t.group===g)]).filter(([,v])=>v.length)
  return '<div class="blk"><div class="k">classification</div><div class="tags">'
   +byGroup.map(([g,list])=>'<div class="tagrow"><span class="tg">'+esc(g)+'</span>'
     +list.map(t=>'<span class="tag t-'+esc(t.group)+'" title="'+esc(t.why)+'">'+esc(t.tag)+'</span>').join('')
     +'</div>').join('')
   +'</div><div class="v" style="color:var(--mut);font-size:11.5px;margin-top:9px">'
   +'Hover any chip for the measurement behind it. Only <b>'+esc(s.kind)+'</b> is a guess from wording; the rest are counted.</div></div>'
}
/* The one lever that pays for itself. Fires only on a session that asked this
   agent for a New Year card, which it cannot draw. */
function pomBlock(s){
  const p=s.shanaTova
  if(!p||!p.hit)return ''
  return '<div class="pom"><div class="k">\u05e9\u05e0\u05d4 \u05d8\u05d5\u05d1\u05d4 detector \u00b7 confidence '+p.confidence+'</div>'
   +'<div class="big">$'+p.perCard.toFixed(2)+' per greeting card</div>'
   +'<div class="rows">'
   +'<span>'+p.attempts+' attempt(s) \u00b7 $'+p.cost.toFixed(2)+' total</span>'
   +'<span>'+p.pomegranates.toFixed(1)+' actual pomegranates at the same price</span>'
   +'<span>'+p.honeyJars.toFixed(1)+' jars of honey</span>'
   +'<span style="color:var(--ink)">'+esc(p.verdict)+'</span>'
   +'</div>'
   +'<div class="why">'+esc(p.note)+'</div>'
   +'<div class="wish">'+esc(p.wish)+'</div></div>'
}
const kv=(k,v)=>'<tr><td class="k">'+k+'</td><td>'+v+'</td></tr>'
const placeholder=(t,s)=>'<div class="empty">'+esc(t)+'<div style="margin-top:6px;max-width:26em;margin-left:auto;margin-right:auto;line-height:1.5">'+esc(s)+'</div></div>'
const blk=(k,v,cls)=>'<div class="blk '+(cls||'')+'"><div class="k">'+esc(k)+'</div><div class="v">'+esc(v)+'</div></div>'

/* ---------------------------------------------------------- optimization */
function optimizationView(){
  const label=(SUBTABS.find(([x])=>x===subtab)||[,''])[1]
  const head='<div class="midhead"><h2>Optimize</h2><span class="crumb">'+esc(label)+'</span></div>'
  if(subtab==='catalog')return head+catalogView()
  if(subtab==='runs')return head+runsView()
  if(subtab==='profiles')return head+profilesView()
  return sessionsView(true)
}
function optimizationDetail(){
  if(subtab==='catalog')return catalogDetail()
  if(subtab==='runs')return runsDetail()
  if(subtab==='profiles')return profilesDetail()
  return sessionDetail(true)
}

function catalogView(){
  const rows=CAT.experiments.map(e=>
    '<tr data-cat="'+esc(e.id)+'" class="'+(sel.catalog===e.id?'on':'')+'">'
    +'<td class="model">'+esc(e.id)+'</td><td><span class="pill">'+esc(e.family)+'</span></td>'
    +'<td class="intent">'+esc(e.summary.slice(0,130))+'</td>'
    +'<td>'+(e.control?'<span class="pill flat">control</span>':e.runnable
        ?'<span class="pill improved">runnable</span>':'<span class="pill degraded">needs gateway</span>')+'</td>'
    +'<td class="model">'+(e.kong?esc(e.kong.plugin):'<span style="color:var(--mut)">—</span>')+'</td></tr>').join('')
  return '<p class="sub">config/optimizations.json · v'+esc(CAT.version||'?')+' · every lever, and the Kong plugin that owns it</p>'
   +'<table><thead><tr><th>Id</th><th>Family</th><th>What it changes</th><th>Status</th><th>Kong plugin</th></tr></thead><tbody>'
   +rows+'</tbody></table>'
}
function catalogDetail(){
  const e=CAT.experiments.find(x=>x.id===sel.catalog)
  if(!e)return placeholder('Pick a lever','What it changes, what it risks, and the gate it has to pass.')
  const arm=e.arm?Object.entries(e.arm).map(([k,v])=>k+': '+(typeof v==='string'&&v.length>60?v.slice(0,60)+'…':JSON.stringify(v))).join('\n'):null
  return '<div class="eyebrow">'+esc(e.family)+(e.approximation?' · approximation':'')+'</div><h3>'+esc(e.title)+'</h3>'
   +'<div class="body" style="color:var(--mut);margin-bottom:14px">'+esc(e.summary)+'</div>'
   +(e.hypothesis?blk('hypothesis',e.hypothesis,'ac'):'')
   +(e.risk?blk('risk',e.risk,'warn'):'')
   +(e.gate?blk('gate',e.gate,''):'')
   +(arm?'<div class="blk"><div class="k">arm</div><pre>'+esc(arm)+'</pre></div>':'')
   +(e.kong?'<div class="blk"><div class="k">kong · '+esc(e.kong.plugin)+'</div><pre>'
      +esc(Object.entries(e.kong.params).map(([k,v])=>k+': '+(typeof v==='object'?JSON.stringify(v):v)).join('\n'))+'</pre>'
      +(e.kong.note?'<div class="v" style="margin-top:8px;font-size:12px;color:var(--mut)">'+esc(e.kong.note)+'</div>':'')+'</div>'
    :e.kongNote?blk('no gateway equivalent',e.kongNote,''):'')
   +(!e.runnable&&!e.control?'<div class="blk bad"><div class="k">not runnable here</div><div class="v">Needs '+esc(e.requires||'a gateway in the request path')+'. Build it with <code>sandbox/e2b/kong/build.sh</code>.</div></div>':'')
   +(e.runnable?'<div class="blk ac"><div class="k">to run it</div><div class="v" style="font-size:12.5px">Open <b>Optimization → Sessions</b>, pick a session, choose <b>'+esc(e.title)+'</b> and press run. It executes against its own baseline arm on that session’s files.</div></div>':'')
}

/* rows for Runs: what is on disk, plus anything launched here that has not
   written its status.json yet, so a run appears the instant it is asked for */
function runRows(){
  const rows=[...RUNS.runs]
  for(const [sid,st] of Object.entries(LIVE)){
    if(!st||!st.phase||['done','error','stopped','stale'].includes(st.phase))continue
    if(rows.some(r=>r.session===sid&&!['done','error','stopped','stale'].includes(r.phase)))continue
    const sess=DATA.sessions.find(x=>x.id===sid), pend=PENDING[sid]||{}
    rows.unshift({run:'pending:'+sid,pending:true,kind:pend.kind||st.kind||'optimize',
      experiment:pend.experiment||st.experiment||null,goal:pend.goal||'cost',
      session:sid,sessionShort:sid.slice(0,8),intent:sess?sess.intent:'',phase:st.phase,
      startedAt:pend.startedAt||st.startedAt||new Date().toISOString(),updatedAt:new Date().toISOString(),
      arms:[],failed:0,totalCost:0,verdict:null,best:null,report:null,
      originalCost:sess?sess.cost:null,originalModel:sess?sess.model:null,
      headline:{text:st.phase+'…',tone:'flat'}})
  }
  return rows
}
function runsView(){
  const rows=runRows()
  // a pending row becomes the real one as soon as optimize.mjs writes its dir
  if(pendingRun){
    const real=rows.find(r=>r.session===pendingRun&&!r.pending)
    if(real){sel.run=real.run;pendingRun=null}
    else{const pend=rows.find(r=>r.session===pendingRun);if(pend)sel.run=pend.run}
  }
  const body=rows.map(r=>
    '<tr data-run="'+esc(r.run)+'" class="'+(sel.run===r.run?'on':'')+'">'
    +'<td class="model">'+esc(r.sessionShort)+'</td>'
    +'<td><span class="pill '+(r.kind==='experiment'?'code':'')+'">'+esc(expTitle(r))+'</span></td><td><span class="pill">'+esc(r.goal||'cost')+'</span></td>'
    +'<td class="intent">'+esc(String(r.intent).slice(0,110))+'</td>'
    +'<td class="num">'+r.arms.length+'</td>'
    +'<td class="num">'+usd(r.totalCost)+'</td>'
    +'<td><span class="pill '+esc(r.headline.tone)+'">'+esc(r.headline.text.slice(0,44))+'</span></td>'
    +'<td class="model">'+ago(r.startedAt)+'</td></tr>').join('')
  return '<p class="sub">'+rows.length+' experiment(s) · each one replays one real session: a baseline arm and the strategy, judged blind</p>'
   +(rows.length?'<table><thead><tr><th>Session</th><th>Strategy</th><th>Goal</th><th>Intent</th><th>Arms</th><th>Cost</th><th>Verdict</th><th>Started</th></tr></thead><tbody>'
     +body+'</tbody></table>':'<div class="empty">No experiments yet. Open <b>Optimize → Sessions</b>, pick one, choose a goal and a strategy, and press Run.</div>')
}
function runsDetail(){return experimentDetail(runRows().find(x=>x.run===sel.run))}

/* ------------------------------------------------------------- analytics */
/* Always about one named session. The old view charted every session at once
   with no way to tell which line was yours, and approximated per-turn cost by
   spreading the total evenly — a shape that was drawn, not measured. This reads
   the real per-turn series from /api/session. */
function sessionAnalyticsView(){
  const s=DATA.sessions.find(x=>x.id===sel.sessions)
  if(!s)return '<div class="midhead"><h2>Analytics</h2></div>'
    +placeholder('No session chosen','Analytics is always about one session. Open one in Sessions and press analytics.')
  const head='<button class="backlink" onclick="section=\'sessions\';draw()">‹ back to sessions</button>'
   +'<div class="midhead"><h2>Analytics</h2><span class="crumb">session '+esc(s.id.slice(0,8))+'</span></div>'
   +'<p class="sub">'+esc(s.intent.slice(0,150))+'</p>'
  if(!SDETAIL||SDETAIL.id!==s.id)return head+'<div class="empty">reading the transcript…</div>'
  const S=SDETAIL.series
  if(!S.length)return head+'<div class="empty">This session billed no requests, so there is nothing to chart.</div>'
  return head
   +'<div class="stats">'+[['turns charted',S.length],['peak context',tok(s.ctxPeak)],
      ['cache reuse',(s.cacheHit*100).toFixed(1)+'%'],['cost','$'+s.cost.toFixed(2)],
      ['thinking',tok(s.thinkingTokens)]]
      .map(([k,v])=>'<div class="stat"><div class="v">'+v+'</div><div class="k">'+k+'</div></div>').join('')+'</div>'
   +'<div class="acards">'
   +card('Context carried, per request','Every request re-sends the conversation. This is what the model was handed each turn — the line that decides the bill. Turns that billed no context are left out; drawing them as zero invents cliffs that never happened.',
       lineChart(S.filter((d)=>d.ctx>0),(d)=>d.ctx,(v)=>tok(v),'var(--ac)'))
   +card('Cost, cumulative','Where the money actually accrued. A steep stretch is worth more attention than a long flat one.',
       lineChart(S,(d)=>d.costCum,(v)=>'$'+v.toFixed(v<1?3:1),'var(--warn)'))
   +card('What the input was made of','Cache reads bill at a tenth of fresh input and writes at 1.25×, so the mix matters more than the total.',
       mixChart(s))
   +card('Output, per turn','Thinking is billed as output. The dark part of each bar is the part you never read.',
       barsChart(S))
   +'</div>'
   +'<div class="card"><h3>Where this session sits</h3><p>Every session on this machine by cost; this one marked.</p>'
   +rankChart(s)+'</div>'
}
const card=(t,p,body)=>'<div class="card"><h3>'+esc(t)+'</h3><p>'+esc(p)+'</p>'+body+'</div>'

function axes(W,H,padL,padB,padT,padR,maxY,fmt){
  return [0,.25,.5,.75,1].map(f=>{const v=maxY*f,y=H-padB-f*(H-padT-padB)
    return '<line x1="'+padL+'" y1="'+y+'" x2="'+(W-padR)+'" y2="'+y+'" stroke="var(--rule)"/>'
     +'<text x="'+(padL-6)+'" y="'+(y+3)+'" text-anchor="end" font-size="10" fill="var(--mut)" font-family="monospace">'+esc(fmt(v))+'</text>'}).join('')
}
function lineChart(S,get,fmt,col){
  const W=640,H=220,padL=58,padB=26,padT=10,padR=10
  const maxY=Math.max(...S.map(get),1e-9), n=S.length
  const xf=(i)=>padL+(n<2?0:(i/(n-1))*(W-padL-padR)), yf=(v)=>H-padB-(v/maxY)*(H-padT-padB)
  const pts=S.map((d,i)=>xf(i).toFixed(1)+','+yf(get(d)).toFixed(1)).join(' ')
  const area='M'+xf(0).toFixed(1)+','+(H-padB)+' L'+pts.split(' ').join(' L')+' L'+xf(n-1).toFixed(1)+','+(H-padB)+' Z'
  return '<svg viewBox="0 0 '+W+' '+H+'">'+axes(W,H,padL,padB,padT,padR,maxY,fmt)
   +'<path d="'+area+'" fill="'+col+'" opacity="0.12"/>'
   +'<polyline points="'+pts+'" fill="none" stroke="'+col+'" stroke-width="1.5"/>'
   +'<text x="'+(W/2)+'" y="'+(H-4)+'" text-anchor="middle" font-size="10" fill="var(--mut)" font-family="monospace">turn 1 → '+n+'</text></svg>'
}
function mixChart(s){
  // priced, not just counted: cache reads bill 0.1x and writes 1.25x
  const W=640,H=132,r=s.modelTier==='opus'?{i:15,o:75}:s.modelTier==='haiku'?{i:1,o:5}:{i:3,o:15}
  const parts=[['fresh input',s.freshInTokens*r.i/1e6,'var(--ac)'],
               ['cache writes',s.cacheWriteTokens*1.25*r.i/1e6,'var(--warn)'],
               ['cache reads',s.cacheReadTokens*0.1*r.i/1e6,'var(--mut)'],
               ['output',(s.outTokens-s.thinkingTokens)*r.o/1e6,'#7A5AF8'],
               ['thinking',s.thinkingTokens*r.o/1e6,'#B3402B']].filter(x=>x[1]>0)
  const tot=parts.reduce((a,x)=>a+x[1],0)||1
  let x=0,bar='',key=''
  for(const [k,v,c] of parts){const w=(v/tot)*W
    bar+='<rect x="'+x.toFixed(1)+'" y="0" width="'+Math.max(0,w-1).toFixed(1)+'" height="34" fill="'+c+'" opacity="0.8"/>'
    key+='<span><i class="sw" style="background:'+c+'"></i>'+esc(k)+' $'+v.toFixed(2)+' · '+((v/tot)*100).toFixed(0)+'%</span>'
    x+=w}
  return '<svg viewBox="0 0 '+W+' 34" style="height:34px">'+bar+'</svg><div class="legend">'+key+'</div>'
}
function barsChart(S){
  const W=640,H=180,padL=58,padB=26,padT=10,padR=10
  const maxY=Math.max(...S.map(d=>d.out),1), n=S.length, bw=Math.max(1,(W-padL-padR)/n-0.5)
  let out=''
  S.forEach((d,i)=>{const x=padL+(i/n)*(W-padL-padR)
    const h=(d.out/maxY)*(H-padT-padB), th=(d.think/maxY)*(H-padT-padB)
    out+='<rect x="'+x.toFixed(1)+'" y="'+(H-padB-h).toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+h.toFixed(1)+'" fill="var(--ac)" opacity="0.55"/>'
    if(th>0)out+='<rect x="'+x.toFixed(1)+'" y="'+(H-padB-th).toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+th.toFixed(1)+'" fill="var(--warn)" opacity="0.9"/>'})
  return '<svg viewBox="0 0 '+W+' '+H+'">'+axes(W,H,padL,padB,padT,padR,maxY,tok)+out
   +'</svg><div class="legend"><span><i class="sw" style="background:var(--ac);opacity:.55"></i>output</span>'
   +'<span><i class="sw" style="background:var(--warn)"></i>thinking</span></div>'
}
function rankChart(s){
  const all=[...DATA.sessions].sort((a,b)=>b.cost-a.cost)
  const top=all.slice(0,18), here=all.indexOf(s)
  const rows=top.includes(s)?top:[...top.slice(0,17),s]
  // Three fixed columns — intent, bar, price — so no label's position depends
  // on how wide its own text turns out to be. The bar can never reach PRICE,
  // and PRICE stops well short of the viewBox edge: the old layout put the
  // label immediately after the bar, which meant the single longest bar (the
  // priciest session on the machine) was the one row that drew no number.
  const W=1000,BAR=300,PRICE=880,max=Math.max(...rows.map(x=>x.cost),0.01)
  let y=0,out=''
  for(const x of rows){const w=(x.cost/max)*(PRICE-BAR-80), me=x.id===s.id
    out+='<g transform="translate(0,'+y+')"><rect x="'+BAR+'" y="4" width="'+Math.max(1,w).toFixed(0)+'" height="18" fill="'+(me?'var(--ac)':'var(--mut)')+'" opacity="'+(me?0.95:0.35)+'"/>'
     // a caret in the gutter, so the marked row is found by shape and not by hue
     +(me?'<text x="0" y="17" font-size="11" fill="var(--ac)" font-family="monospace" font-weight="700">\u25b8</text>':'')
     +'<text x="12" y="17" font-size="11" fill="'+(me?'var(--ink)':'var(--mut)')+'" font-family="monospace"'+(me?' font-weight="700"':'')+'>'+esc(x.intent.slice(0,40))+'</text>'
     // right-aligned in a fixed price column: a label placed after the bar has
     // to be measured to stay inside the viewBox, and the longest bar is
     // exactly the one that loses that bet — the priciest row drew no number.
     +'<text x="'+PRICE+'" y="17" text-anchor="end" font-size="11" fill="'+(me?'var(--ink)':'var(--mut)')+'" font-family="monospace"'+(me?' font-weight="700"':'')+'>$'+x.cost.toFixed(2)+'</text></g>';y+=26}
  return '<svg viewBox="0 0 '+W+' '+(y+4)+'">'+out+'</svg>'
   +'<div class="legend"><span>rank '+(here+1)+' of '+all.length+' by cost</span></div>'
}

/* ---------------------------------------------------------------- triage */
/* The session classification from the opthub repo (experiments/session-triage):
   five classes per session from Jev, what they would save, and — where Jev could
   not tell which model the work needed — the re-run on Sonnet that answers it. */
const TIER={frontier:['Opus','$5/$25'],mid:['Sonnet','$2/$10'],small:['Haiku','$1/$5']}
const TRI_AX=['urgency','latency','deferral','context']
let triDetTab='judgment', triRisk=false
try{triRisk=localStorage.getItem('tri-risk')==='on'}catch(e){}
function triSetRisk(on){triRisk=on;try{localStorage.setItem('tri-risk',on?'on':'off')}catch(e){};draw()}
const TRI_AXES=['capability','delegation','context','reasoning','deferral','latency','urgency']
const TRI_SHORT={route:'model','side-calls':'subagents',context:'context',effort:'effort',batch:'batch','fast-mode':'fast'}
const triPct=(v)=>v==null?'—':Math.round(100*v)+'%'
const triBar=(v,spend)=>'<span class="tri-bar'+(spend?' spend':'')+'"><i style="width:'+Math.round(100*Math.max(0,Math.min(1,v||0)))+'%"></i></span>'
const triM=(s,id)=>(s.methods||[]).find(m=>m.id===id)
/* one chip per method: its score, bold when Jev's answer unlocked it */
function triChips(s){
  if(!s.methods)return '<span class="tri-mut">not scored</span>'
  return '<div class="tri-chips">'+s.methods.filter(m=>m.score||m.unlocked).map(m=>
    '<span class="tri-chip'+(m.unlocked?' on':'')+(m.id==='fast-mode'?' spend':'')+((m.score||0)>=0.5?' hi':'')+'" title="'+esc(m.title+' · score '+triPct(m.score)+' · '+(m.id==='fast-mode'?'spend ':'saving ')+triUsd(Math.abs(m.saving))+' ('+Math.abs(m.pct)+'%)'+(m.unlocked?' · unlocked':''))+'">'
    +esc(TRI_SHORT[m.id]||m.id)+' '+triPct(m.score)+'</span>').join('')+'</div>'
}
const triCC=(s)=>s.claudeCode||{}
/* sorting works like the Sessions table: click a header to sort by it, click it again to flip */
let triSortKey='gap', triSortDir=-1, triMode='list', triGroup='kind', triGroup2='', triFilter=null
const TRI_GROUPS=[['dir','working dir'],['kind','type'],['model','model needed'],['urgency','urgency'],['latency','latency'],['deferral','deferral'],['context','context'],
  ['reasoning','reasoning'],['delegation','delegation'],['cc_effort','Claude Code effort'],['cc_perm','permission mode'],['cc_entry','entry point'],['cc_model','model used']]
function triModelName(s){const c=(s.labels||{}).capability;return c&&TIER[c]?TIER[c][0]:'unclear → re-run'}
/* the working dir from the ledger key (ISO start|cwd, home already written as ~) */
const triDir=(s)=>String(s.key||'').split('|').slice(1).join('|')||s.project
const triGroupName=(g)=>(TRI_GROUPS.find(x=>x[0]===g)||[,g])[1]
function triClassOf(s,g){
  if(g==='dir')return triDir(s)
  if(g==='kind'){const h=triSess(s.session);return h?h.kind:'unknown'}
  if(g==='model')return triModelName(s)
  if(g.startsWith('cc_')){const c=triCC(s);return String({cc_effort:c.effort,cc_perm:c.permission_mode,cc_entry:c.entrypoint,cc_model:c.model}[g]||'not recorded')}
  return (s.labels||{})[g]||'unclear'
}
/* the session's start: the Sessions-tab record when there is one, else the ledger key (ISO start|cwd) */
const triStart=(s)=>{const h=triSess(s.session);return (h&&h.startedAt)||String(s.key||'').split('|')[0]+'Z'}
const triDate=(s)=>{const d=new Date(triStart(s));return isNaN(d)?'—':d.toLocaleDateString('en-GB',{day:'2-digit',month:'short'})+' '+d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}
function triVal(s,k){
  const h=triSess(s.session)
  switch(k){
    case 'project':return s.project
    case 'date':return triStart(s)
    case 'cost':return s.cost
    case 'bestCost':return s.cost-s.best
    case 'worstCost':return s.cost-s.worst
    case 'gap':return s.best
    case 'artifacts':return h?(h.artifacts||[]).length:-1
    case 'model':return triModelName(s)
    case 'expected':return s.expected||0
    case 'cc':return [triCC(s).effort,triCC(s).permission_mode].join(' ')
    default:return (s.labels||{})[k]||'unclear'
  }
}
const triSortRows=(list,val)=>list.sort((a,b)=>{const x=val(a,triSortKey),y=val(b,triSortKey)
  const c=typeof x==='number'?x-y:String(x).localeCompare(String(y));return c*triSortDir})
const triTh=(k,label)=>'<th data-ts="'+k+'">'+label+(triSortKey===k?(triSortDir>0?' ▲':' ▼'):'')+'</th>'
const triUsd=(v)=>(v<0?'−$':'$')+Math.abs(v).toFixed(2)
const triCls=(v)=>v>0.005?'tri-save':v<-0.005?'tri-loss':'tri-zero'
const triTot=(v)=>'$'+Math.max(0,v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})
/* a scenario total, coloured against what was actually spent: green below it, red above it */
const triVs=(v,actual)=>'<span class="'+(v<actual-0.005?'tri-save':v>actual+0.005?'tri-loss':'tri-zero')+'">'+triTot(v)+'</span>'
const triSess=(id)=>id&&DATA?DATA.sessions.find(x=>x.id===id):null
function triArt(h){
  if(!h)return '<span class="tri-mut">—</span>'
  if(!h.hasArtifact)return '<span class="tri-mut">none</span>'
  const n=(h.artifacts||[]).length
  return '<span class="pill improved">✓ '+n+' file'+(n===1?'':'s')+'</span><div class="tri-mut">'+esc(h.topArtifact||'')+'</div>'
}
function triRun(id){
  const exp=TRI&&TRI.rerunExperiment
  const rs=(RUNS.runs||[]).filter(r=>r.session===id&&r.experiment===exp)
    .sort((a,b)=>String(b.startedAt).localeCompare(String(a.startedAt)))[0]
  const lv=liveOf(id)
  if(lv&&lv.experiment===exp&&lv.phase&&!['done','error','stopped','stale'].includes(lv.phase))return {phase:lv.phase,live:true}
  return rs||null
}
function triModel(s){
  const c=(s.labels||{}).capability
  if(c&&c!=='unclear'&&TIER[c])return '<span class="pill improved">'+TIER[c][0]+'</span> <span class="tri-mut">'+TIER[c][1]+'</span>'
  const r=triRun(s.session)
  if(!s.session)return '<span class="tri-mut">unclear · no session id</span>'
  if(!r)return '<span class="pill warnpill">re-run on Sonnet · queued</span>'
  if(r.live||!['done','error','stopped','stale'].includes(r.phase))return '<span class="pill warnpill">re-run on Sonnet · '+esc(r.phase)+'…</span>'
  return '<span class="pill '+esc((r.headline&&r.headline.tone)||'flat')+'">re-run: '+esc((r.headline&&r.headline.text)||r.phase)+'</span>'
}
function triageView(){
  const head='<div class="midhead"><h2>Triage</h2><span class="crumb">sessions classified by Jev · saving per class</span>'
    +'<button class="tri-risk'+(triRisk?' on':'')+'" onclick="triSetRisk('+!triRisk+')" title="the cost if batching loses the prompt cache">'+(triRisk?'hide':'show')+' potential risk</button>'
    +'<span class="tri-modes"><button data-tm="list" class="'+(triMode==='list'?'on':'')+'">sessions</button><button data-tm="group" class="'+(triMode==='group'?'on':'')+'">by class</button></span>'
    +(triMode==='group'?'<select id="trigroup">'+TRI_GROUPS.map(([k,l])=>'<option value="'+k+'"'+(k===triGroup?' selected':'')+'>group by '+l+'</option>').join('')+'</select>'
      +'<select id="trigroup2"><option value="">then by — nothing</option>'+TRI_GROUPS.filter(([k])=>k!==triGroup).map(([k,l])=>'<option value="'+k+'"'+(k===triGroup2?' selected':'')+'>then by '+l+'</option>').join('')+'</select>':'')
    +'</div>'
  if(!TRI)return head+'<div class="empty">loading…</div>'
  if(TRI.missing||!TRI.sessions.length)return head+placeholder('No classification yet',
    'Run the session triage in the opthub repo: experiments/session-triage — run.py with --arms rules,jev, then export_hub.py.')
  const S=TRI.sessions, actual=S.reduce((a,s)=>a+s.cost,0)
  const bestTot=S.reduce((a,s)=>a+s.cost-s.best,0), worstTot=S.reduce((a,s)=>a+s.cost-s.worst,0)
  const queued=S.filter(s=>s.rerun&&s.rerun.needed&&s.session&&!triRun(s.session)).length
  const busy=TRI.rerun&&TRI.rerun.running
  const btn=DEMO?'<button class="go" disabled title="read-only deploy — this would boot cloud sandboxes and spend">re-run 3 on Sonnet</button>'
    :busy&&TRI.rerun.elsewhere?'<span class="tri-mut">a re-run batch is running from another hub or shell</span>'
    :busy?'<button class="stop" onclick="triStop()">stop re-runs</button> <a href="/api/triage/log" target="_blank" class="tri-mut">log ▸</a>'
    :'<button class="go" '+(queued?'':'disabled')+' onclick="triGo(3)" title="the 3 most expensive queued sessions, one at a time, ≤$6 each">re-run 3 on Sonnet</button>'
  const sc=TRI.score||{}
  const scoreBtn=DEMO?'<button class="go" disabled title="read-only deploy">Score with Jev</button>'
    :sc.running?'<span class="pill warnpill">scoring · '+esc(sc.step||'starting')+'</span> <a href="/api/triage/score/log" target="_blank" class="tri-mut">log ▸</a>'
    :'<button class="go" '+(sc.available===false?'disabled title="score.py not found — set OPTHUB_HOME"':'')+' onclick="triScore(30)" title="'
      +(sc.jev?'last 30 days · one Jev call per session (paid) · everything else runs locally':'no JEV_API_KEY in the environment or the repo .env — scores with rules only, no egress')+'">'
      +(sc.jev?'Score with Jev':'Score (rules — no Jev key)')+'</button> <a href="/api/triage/score/log" target="_blank" class="tri-mut">log ▸</a>'
  const expTot=S.reduce((a,s)=>a+(s.expected||0),0)
  const cls=TRI.classifier||{}
  const tiles='<div class="tri-tiles">'
    +'<div><span class="tri-k">actual cost</span><b>'+triTot(actual)+'</b><span class="tri-mut">'+S.length+' sessions, as they ran</span></div>'
    +'<div><span class="tri-k">optimization potential</span><b class="tri-save">'+triTot(actual-bestTot)+'</b><span class="tri-mut">'+(100*(actual-bestTot)/(actual||1)).toFixed(1)+'% of spend · if every unlocked method works</span></div>'
    +(triRisk?'<div><span class="tri-k">potential risk</span><b>'+triVs(worstTot,actual)+'</b><span class="tri-mut">cost if batching loses the prompt cache</span></div>':'')
    +'<div><span class="tri-k">model unclear</span><b>'+S.filter(s=>s.rerun&&s.rerun.needed).length+'</b><span class="tri-mut">'+queued+' queued for a re-run on Sonnet</span></div>'
    +'<div><span class="tri-k">expected saving</span><b class="tri-save">'+triTot(expTot)+'</b><span class="tri-mut">'+(100*expTot/(actual||1)).toFixed(1)+'% · score × saving, summed</span></div>'
    +'<div class="tri-act">'+scoreBtn+btn+'<span class="tri-mut">'+esc(cls.model||'')+(cls.arm?' · '+esc(cls.arm):'')+(TRI.generatedAt?' · '+esc(new Date(TRI.generatedAt).toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})):'')+'</span></div></div>'
  if(triMode==='group')return head+tiles+triGroupView(S)
  const match=(s)=>triFilter.m?(s.levers||[]).includes(triFilter.m)||(triFilter.m==='fast-mode'&&s.fastModeSpend>0)
    :triClassOf(s,triFilter.g)===triFilter.v&&(!triFilter.g2||triClassOf(s,triFilter.g2)===triFilter.v2)
  const shown=triFilter?S.filter(match):S.slice()
  const chip=triFilter&&triFilter.m?'<div class="tri-filter">showing '+shown.length+' sessions where <b>'+esc((TRI.methods.find(d=>d.id===triFilter.m)||{}).title||triFilter.m)+'</b> is unlocked <button data-tf="clear">× show all</button></div>'
    :triFilter?'<div class="tri-filter">showing '+shown.length+' sessions where '+esc(triGroupName(triFilter.g))+' = <b>'+esc(triFilter.v)+'</b>'
    +(triFilter.g2?' and '+esc(triGroupName(triFilter.g2))+' = <b>'+esc(triFilter.v2)+'</b>':'')+' <button data-tf="clear">× show all</button></div>':''
  const rows=triSortRows(shown,triVal).map(s=>
    '<tr data-tri="'+esc(s.key)+'" class="'+(sel.triage===s.key?'on':'')+'">'
    +'<td>'+esc(s.project)+(s.tasks?' <span class="pill">'+s.tasks.length+' tasks</span>':'')+'<div class="tri-mut">'+esc(s.model)+(triSess(s.session)?' · '+esc(triSess(s.session).kind):'')+'</div></td>'
    +'<td class="num">'+esc(triDate(s))+'</td><td class="num">'+triTot(s.cost)+'</td>'
    +'<td class="num">'+triBar(s.cost?s.best/s.cost:0)+'<b class="'+triCls(s.best)+'">'+triTot(s.best)+'</b> <span class="tri-mut">'+(s.cost?Math.round(100*s.best/s.cost):0)+'%</span></td>'
    +(triRisk?'<td class="num">'+triVs(s.cost-s.worst,s.cost)+'</td>':'')
    +'<td class="num"><span class="tri-save">'+triTot(s.expected||0)+'</span></td>'
    +'<td>'+triChips(s)+'</td><td>'+triModel(s)+'</td>'
    +'<td>'+(s.session&&triSess(s.session)?'<button class="go mini-go" onclick="event.stopPropagation();goOptimize(\''+esc(s.session)+'\')">Optimize ▸</button>':'')
      +(s.session&&!(TRI.graph&&TRI.graph.available===false)?' <button class="mini" title="task graph for this session" onclick="event.stopPropagation();openGraph(\''+esc(s.session)+'\')">graph</button>':'')+'</td>'
    +'</tr>').join('')
  return head+tiles+chip
    +'<table><thead><tr>'+triTh('project','session')+triTh('date','date')+triTh('cost','actual cost')+triTh('gap','optimization potential')+(triRisk?triTh('worstCost','potential risk'):'')
    +triTh('expected','expected saving')+'<th>method scores</th>'+triTh('model','model needed')+'<th></th>'
    +'</tr></thead><tbody>'+rows+'</tbody></table>'
    +'<div class="tri-note">Classes: Jev ('+esc((TRI.classifier||{}).model||'')+'), from session metadata and counts computed on this machine. Prompt text, paths and cost are never sent. '
    +'When Jev cannot tell which model the work needed, no model saving is counted and the session is re-run in the sandbox on Sonnet against the baseline, blind-judged. The re-run is the answer; it is not fed back to Jev. '+(triRisk?'Best case and potential risk are':'Best case is')+' what the same sessions would have cost: their real tokens re-priced, nothing re-run.'+' Green is below the actual cost, red is above it. Optimization potential is the saving if every method Jev’s answers unlock works, priced on the session’s own tokens. Rows open ordered by it; click any header to sort by it, click again to flip.</div>'
}
function triGroupView(S){
  const G={}, two=!!triGroup2&&triGroup2!==triGroup
  for(const s of S){
    const a=triClassOf(s,triGroup), b=two?triClassOf(s,triGroup2):''
    const k=a+'\u0001'+b
    const g=G[k]||(G[k]={cls:a,cls2:b,n:0,cost:0,bestCost:0,worstCost:0,rerun:0})
    g.n++;g.cost+=s.cost;g.bestCost+=s.cost-s.best;g.worstCost+=s.cost-s.worst;if(s.rerun&&s.rerun.needed)g.rerun++}
  const total=S.reduce((a,s)=>a+s.cost,0)
  const gv=(g,k)=>k==='project'?g.cls:k==='second'?g.cls2:k==='gap'?g.cost-g.bestCost:k==='share'?g.cost:g[k]
  const cell=(g,v)=>g==='dir'?'<span class="tri-dir" title="'+esc(v)+'">'+esc(String(v).replace(/^~\/workspace\//,''))+'</span>':'<span class="pill">'+esc(v)+'</span>'
  const rows=triSortRows(Object.values(G),gv).map(g=>
    '<tr data-tg="'+esc(g.cls)+'" data-tg2="'+esc(g.cls2)+'"><td>'+cell(triGroup,g.cls)+'</td>'+(two?'<td>'+cell(triGroup2,g.cls2)+'</td>':'')
    +'<td class="num">'+g.n+'</td><td class="num">'+triTot(g.cost)+'</td><td class="num">'+(100*g.cost/(total||1)).toFixed(1)+'%</td>'
    +'<td class="num">'+triVs(g.bestCost,g.cost)+'</td>'+(triRisk?'<td class="num">'+triVs(g.worstCost,g.cost)+'</td>':'')
    +'<td class="num">'+(g.rerun||'')+'</td></tr>').join('')
  return '<table><thead><tr>'+triTh('project',triGroupName(triGroup))+(two?triTh('second',triGroupName(triGroup2)):'')+triTh('n','sessions')
    +triTh('cost','actual cost')+triTh('share','share')+triTh('bestCost','best case cost')+(triRisk?triTh('worstCost','potential risk'):'')+triTh('rerun','model unclear')
    +'</tr></thead><tbody>'+rows+'</tbody></table>'
    +'<div class="tri-note">'+Object.keys(G).length+' groups. Type is the Sessions tab’s kind (code, explore, …); working dir is where the session ran; the rest are Jev’s classes. Click a group to see its sessions.</div>'
}
function triageDetail(){
  const s=TRI&&TRI.sessions.find(x=>x.key===sel.triage)
  if(!s)return placeholder('Pick a session','Its classes, the signals behind them, its tasks and its re-run.')
  const L=s.labels||{}, C=s.confidence||{}, r=s.session?triRun(s.session):null
  const P=s.probabilities||{}
  const ans=TRI_AXES.filter(a=>a in L).map(a=>kv(a==='capability'?'model needed':a,
    esc(a==='capability'&&TIER[L[a]]?TIER[L[a]][0]+' '+TIER[L[a]][1]:(L[a]||'—'))+(C[a]!=null?' <span class="tri-mut">conf '+Number(C[a]).toFixed(2)+'</span>':'')
    +(P[a]?'<div class="tri-mut">'+Object.entries(P[a]).sort((x,y)=>y[1]-x[1]).map(([o,v])=>esc(o)+' '+triPct(v)).join(' · ')+'</div>':''))).join('')
  const meth=s.methods?'<table class="kv">'+s.methods.map(m=>'<tr><td class="k"><b>'+esc(m.title)+'</b>'+(m.unlocked?' <span class="pill '+(m.id==='fast-mode'?'degraded':'improved')+'">unlocked</span>':'')
      +'<div class="tri-knob">'+esc(m.knob)+'</div></td><td>'+triBar(m.score,m.id==='fast-mode')+'<b>'+triPct(m.score)+'</b>'
      +'<div>'+(m.id==='fast-mode'?'<span class="tri-loss">+'+triUsd(-m.saving)+' spend</span>':'<span class="'+triCls(m.saving)+'">'+triUsd(m.saving)+'</span> <span class="tri-mut">'+m.pct+'%</span>'
        +(m.savingFloor!=null&&triRisk?' <span class="tri-mut">risk </span><span class="'+triCls(m.savingFloor)+'">'+triUsd(m.savingFloor)+'</span>':''))
      +(m.expected!=null&&m.id!=='fast-mode'?' <span class="tri-mut">· expected '+triUsd(m.expected)+'</span>':'')+'</div>'
      +'<div class="tri-mut">'+esc(triRisk?m.note:m.note.replace(/ — floor .*$/,''))+' · '+esc(triRisk?m.label:m.label.replace(/ · guess floor$/,''))+'</div></td></tr>').join('')+'</table>'
    +'<div class="tri-mut">Score: probability on the answers that unlock the method. Saving: marginal, in applied order (top to bottom), on this session’s own tokens.</div>':''
  const CCN={entrypoint:'entry point',version:'version',model:'model',effort:'reasoning effort',effort_high_share:'share of turns at high effort',permission_mode:'permission mode',
    fast_mode_share:'share of turns in fast mode',advisor_on:'advisor on',compactions:'context compactions',hooks_active:'hooks ran',mcp_servers:'MCP servers used',subagent_request_share:'subagent share of requests'}
  const cc=s.claudeCode?'<div class="tri-sec">Claude Code settings · what the session ran with</div><table class="kv">'
    +Object.entries(s.claudeCode).map(([k,v])=>kv(esc(CCN[k]||k),esc(v==null?'—':typeof v==='boolean'?(v?'yes':'no'):v))).join('')+'</table>'
    :'<div class="tri-sec">Claude Code settings</div><div class="tri-mut">not recorded for this run — press Score with Jev to extract them.</div>'
  const saw=s.sentToJev?'<details><summary class="tri-sec" style="cursor:pointer">What '+esc((TRI.classifier||{}).arm||'the classifier')+' saw ▸</summary><pre class="tri-pre">'+esc(JSON.stringify(s.sentToJev,null,1))+'</pre>'
    +'<div class="tri-mut">Counts, flags and settings computed on this machine. No prompt text, no path, no cost.</div></details>':''

  const SIGNAME={files_touched:'files touched',lines_changed:'lines changed',files_edited_3plus_times:'files edited 3+ times',
    test_runs:'test runs',test_runs_failed:'test runs that failed',tool_errors:'failed tool calls',git_commits:'git commits / reverts'}
  const sig=s.signals?Object.entries(s.signals).map(([k,v])=>kv(esc(SIGNAME[k]||k.replace(/_/g,' ')),esc(v))).join(''):''
  const h=triSess(s.session)
  const tools=h&&h.toolCounts?Object.entries(h.toolCounts).sort((a,b)=>b[1]-a[1])
    .map(([k,v])=>kv(esc(k.replace(/^mcp__([^_]+(?:-[^_]+)*)__/,'mcp · $1 · ')),String(v))).join(''):''
  const hs=h?'<div class="tri-sec">From the Sessions tab</div><table class="kv">'
    +kv('first request',esc(String(h.intent||'').slice(0,220)))+kv('kind',esc(h.kind))+kv('turns',esc(h.turns))
    +kv('duration',fmtM(h.durationMin||0))+kv('tool calls',esc(h.toolCalls))+kv('status',esc(h.status))+'</table>'
    +(tools?'<div class="tri-sec">Tools used</div><table class="kv">'+tools+'</table>':'')
    +'<div class="tri-sec">Artifacts created</div>'+(h.hasArtifact?'<table class="kv">'
      +(h.artifacts||[]).slice(0,12).map(a=>kv(esc(a.name),esc(tok(a.bytes))+'B')).join('')
      +((h.artifacts||[]).length>12?kv('…','+'+((h.artifacts||[]).length-12)+' more'):'')+'</table>'
      :'<div class="tri-mut">none — the session wrote no files</div>'):''
  const busy=r&&(r.live||!['done','error','stopped','stale'].includes(r.phase))
  const rerun=s.rerun&&s.rerun.needed
    ?'<div class="tri-sec">Re-run on Sonnet</div><div class="tri-mut">'+esc(s.rerun.reason)+'.</div>'
      +(r&&!busy?'<table class="kv">'+kv('result',esc((r.headline&&r.headline.text)||r.phase))+kv('spent',usd(r.totalCost))+'</table>':'')
      +(s.session?(DEMO?'<button class="go" disabled title="read-only deploy">re-run on Sonnet</button>'
        :'<button class="go" '+(busy?'disabled':'')+' onclick="triOne(\''+esc(s.session)+'\')">'+(busy?'running…':r?'re-run again':'re-run on Sonnet')+'</button>'):'')
    :'<div class="tri-sec">Model</div><div class="tri-mut">'+esc(s.rerun?s.rerun.reason:'')+' — priced, not re-run.</div>'
  const tasks=s.tasks?'<div class="tri-sec">'+s.tasks.length+' tasks · split where the person paused over 30 min</div><table class="kv">'
    +s.tasks.map(t=>kv(esc(t.start),usd(t.cost)+' · '+esc(t.title))).join('')+'</table>':''
  const head='<h3>'+esc(s.project)+'</h3><div class="tri-mut">'+esc(s.started)+' · '+esc(s.model)+' · '+usd(s.cost)+(s.session?' · '+esc(s.session.slice(0,8)):'')+'</div>'
    +(s.session&&triSess(s.session)?'<div class="actions"><div class="row"><button class="go" onclick="goOptimize(\''+esc(s.session)+'\')">Optimize this session ▸</button>'
      +'<span class="tri-mut">potential '+triTot(s.best)+' · '+(s.cost?Math.round(100*s.best/s.cost):0)+'% of '+triTot(s.cost)+'</span></div></div>':'')
    +'<div class="tri-subtabs"><button data-tdt="judgment" class="'+(triDetTab==='judgment'?'on':'')+'">Jev judgment</button><button data-tdt="details" class="'+(triDetTab==='details'?'on':'')+'">Details</button></div>'
  if(triDetTab==='judgment')return head
    +'<div class="tri-sec">Optimization methods · this session</div>'+(meth||'<div class="tri-mut">not scored per method — press Score with Jev.</div>')
    +'<div class="tri-sec">'+esc(/^jev/.test((TRI.classifier||{}).arm||'')?'Jev’s answers':'Answers ('+((TRI.classifier||{}).arm||'')+')')
      // a null graph is fine: the hub rebuilds it from the transcript on demand
      +(s.session&&!(TRI.graph&&TRI.graph.available===false)?'<button class="backlink tri-graph" onclick="openGraph(\''+esc(s.session)+'\')">graph ▸</button>'
        :'<button class="backlink tri-graph" disabled title="'+(s.session?'no session-graph template in the opthub checkout — set OPTHUB_DIR':'no session id, so no transcript to graph')+'">graph ▸</button>')+'</div><table class="kv">'+ans+'</table>'
  return head
    +'<div class="tri-sec">Cost</div><table class="kv">'+kv('actual',triTot(s.cost))+kv('best case',triVs(s.cost-s.best,s.cost))+(triRisk?kv('potential risk',triVs(s.cost-s.worst,s.cost)):'')+kv('expected saving',triUsd(s.expected||0))+kv('unlocked',esc((s.levers||[]).join(', ')||'none'))+'</table>'
    +cc+saw
    +rerun+tasks
    +(sig?'<div class="tri-sec">Work signals sent to Jev</div><table class="kv">'+sig+'</table>'
      +'<div class="tri-mut">A failed tool call is a tool that returned an error: a command that exited non-zero, an edit whose text was not found, a missing file, a call the permission system refused.</div>':'')
    +hs
}
async function loadTriage(){try{TRI=await(await fetch('/api/triage',{cache:'no-store'})).json()}catch(e){TRI={sessions:[],missing:true}}}
async function triGo(n){
  try{await fetch('/api/triage/rerun?limit='+n,{method:'POST'})}catch(e){}
  await loadTriage();draw()
  const t=setInterval(async()=>{await refresh();await loadTriage();draw();if(!(TRI.rerun&&TRI.rerun.running))clearInterval(t)},6000)
}
async function triScore(days){
  try{await fetch('/api/triage/score?days='+days,{method:'POST'})}catch(e){}
  await loadTriage();draw()
  const t=setInterval(async()=>{await loadTriage();draw();if(!(TRI.score&&TRI.score.running))clearInterval(t)},3000)
}
async function triStop(){await fetch('/api/triage/rerun/stop',{method:'POST'});await loadTriage();draw()}
function triOne(id){
  const exp=TRI.rerunExperiment; toRuns(id,'experiment',exp)
  fetch('/api/experiment?session='+encodeURIComponent(id)+'&experiment='+encodeURIComponent(exp)+'&goal='+goal,{method:'POST'}).catch(()=>{})
}

/* -------------------------------------------------------------- profiles */
/* LLM Light profiles (config/llmlight-profiles.json): one bundle of classifier, routing, cache,
   budget and audit, rendered for a laptop or a sandbox, optionally with a project's Triage
   classes baked in. Applied with llmlight.mjs; tried against a real session as an experiment. */
let PROF=null, profTarget='local', profProject='', profLoading=false
async function loadProf(){
  profLoading=true
  try{PROF=await(await fetch('/api/profiles?target='+profTarget+'&project='+encodeURIComponent(profProject),{cache:'no-store'})).json()}catch(e){PROF={profiles:[],rendered:[]}}
  profLoading=false; draw()
}
const profR=(id)=>PROF&&(PROF.rendered||[]).find(r=>r.id===id)
function profDirs(){
  const W={}; for(const s of (TRI&&TRI.sessions)||[]){const d=triDir(s);W[d]=(W[d]||0)+s.cost}
  return Object.entries(W).sort((a,b)=>b[1]-a[1]).map(([d,c])=>[d,c])
}
function profilesView(){
  if(!PROF&&!profLoading)loadProf()
  const ctl='<div class="tri-filter"><span class="tri-modes"><button data-pt="local" class="'+(profTarget==='local'?'on':'')+'">laptop</button><button data-pt="sandbox" class="'+(profTarget==='sandbox'?'on':'')+'">sandbox</button></span>'
    +'<select id="profproj"><option value="">no project — rules only</option>'+profDirs().map(([d,c])=>'<option value="'+esc(d)+'"'+(d===profProject?' selected':'')+'>'+esc(d.replace(/^~\/workspace\//,''))+' · '+triTot(c)+'</option>').join('')+'</select>'
    +(PROF&&PROF.classes&&PROF.classes._sessions?'<span class="tri-mut">Triage classes from '+PROF.classes._sessions+' sessions baked in</span>':'')+'</div>'
  if(!PROF)return ctl+'<div class="empty">loading…</div>'
  const rows=(PROF.profiles||[]).map(p=>{
    const r=profR(p.id)||{}, b=p.budget||{}, rt=p.routing||{}
    const tierLbl=(t)=>(r.tiers&&r.tiers[t])||t
    return '<tr data-prof="'+esc(p.id)+'" class="'+(sel.profile===p.id?'on':'')+'"><td><b>'+esc(p.title)+'</b><div class="tri-mut">'+esc(p.id)+' · '+esc(p.for)+'</div></td>'
      +'<td>'+esc(tierLbl(rt.default||'frontier'))+'</td>'
      +'<td class="num">'+(rt.rules||[]).length+(rt.neverDowngrade&&rt.neverDowngrade.length?' · guard':'')+'</td>'
      +'<td><span class="pill">'+esc((p.classifier||{}).source||'rules')+'</span></td>'
      +'<td class="num">'+(b.perRunUsd?'$'+b.perRunUsd+'/run':b.perDayUsd?'$'+b.perDayUsd+'/day':'—')+(b.maxTurns?' · '+b.maxTurns+' turns':'')+'</td>'
      +'<td><span class="pill">'+esc((p.audit||{}).log||'off')+'</span></td></tr>'}).join('')
  return ctl+'<table><thead><tr><th>profile</th><th>main loop</th><th>rules</th><th>classifier</th><th>budget</th><th>audit</th></tr></thead><tbody>'+rows+'</tbody></table>'
    +'<div class="tri-note">A profile routes each request to a tier inside LiteLLM (assets/llmlight_router.py): the decision is local and costs no model call. Profiles that read Triage use the project’s classes as Jev answered them, baked in when applied. Every decision and result is audited as numbers and names, never text.</div>'
}
function profilesDetail(){
  const p=PROF&&(PROF.profiles||[]).find(x=>x.id===sel.profile)
  if(!p)return placeholder('Pick a profile','Its rules, the exact LiteLLM config and Claude Code settings it renders to, how to apply it, and a sandbox test against a real session.')
  const r=profR(p.id)||{}
  const apply='node llmlight.mjs apply '+p.id+' --project='+(profProject||'<dir>')+' --target='+profTarget+' --start'
  const cands=((TRI&&TRI.sessions)||[]).filter(s=>s.session&&(!profProject||triDir(s)===profProject)).sort((a,b)=>b.cost-a.cost).slice(0,15)
  const tryIt=DEMO?'<button class="go" disabled title="read-only deploy">try in sandbox</button>'
    :cands.length?'<select id="proftry">'+cands.map(s=>'<option value="'+esc(s.session)+'">'+esc(s.project)+' · '+esc(triDate(s))+' · '+triTot(s.cost)+'</option>').join('')+'</select> <button class="go" onclick="profTry(\''+esc(p.id)+'\')">try in sandbox</button>'
    :'<span class="tri-mut">no Triage session to try it on</span>'
  return '<h3>'+esc(p.title)+'</h3><div class="tri-mut">'+esc(p.summary)+'</div>'
    +'<div class="tri-sec">What it does · '+(profTarget==='local'?'laptop, Anthropic API':'sandbox, Bedrock')+'</div><ul class="tri-list">'+(r.summary||[]).map(l=>'<li>'+esc(l)+'</li>').join('')+'</ul>'
    +'<div class="tri-sec">Classifier</div><table class="kv">'+kv('source',esc((p.classifier||{}).source))+kv('when Jev said unclear',esc((p.classifier||{}).unclear))+((p.classifier||{}).model?kv('model',esc(p.classifier.model)):'')+'</table>'
    +'<div class="tri-sec">Apply to a project</div><pre class="tri-pre">'+esc(apply)+'</pre><div class="tri-mut">Writes .opthub/llmlight/ and the env in .claude/settings.local.json of that project, starts LiteLLM on :4000. Undo with <code>node llmlight.mjs revert --project=…</code>. Target local bills the Anthropic API key, not a subscription.</div>'
    +'<div class="tri-sec">Test it first · sandbox, blind-judged against baseline</div>'+tryIt
    +'<div class="tri-sec">Claude Code env</div><table class="kv">'+Object.entries(r.env||{}).map(([k,v])=>kv(esc(k),esc(v))).join('')+(r.flags?kv('flags',esc(r.flags)):'')+'</table>'
    +'<div class="tri-sec">litellm.yaml</div><pre class="tri-pre">'+esc(r.yaml||r.error||'')+'</pre>'
    +'<div class="tri-sec">llmlight_profile.json (what the hook reads)</div><pre class="tri-pre">'+esc(JSON.stringify(r.hook||{},null,2))+'</pre>'
}
function profTry(id){
  const s=document.getElementById('proftry'); if(!s||!s.value)return
  toRuns(s.value,'experiment','profile-'+id)
  fetch('/api/experiment?session='+encodeURIComponent(s.value)+'&experiment='+encodeURIComponent('profile-'+id),{method:'POST'}).catch(()=>{})
}

${INSIGHTS_JS}
/* ------------------------------------------------------------------ draw */
function draw(){
  rail()
  const mid=document.getElementById('mid'), det=document.getElementById('detail')
  if(!DATA){mid.innerHTML='<div class="empty">loading…</div>';return}
  if(section==='roi')section='sessions'
  if(section==='sessions'){mid.innerHTML=sessionsView(false);det.innerHTML=detailChrome(sel.exp?experimentDetail(runRows().find(x=>x.run===sel.exp)):sessionDetail(false))}
  else if(section==='optimization'){mid.innerHTML=optimizationView();det.innerHTML=detailChrome(optimizationDetail())}
  else if(section==='triage'){mid.innerHTML=triageView();det.innerHTML=detailChrome(triageDetail())}
  // the live poll redraws every few seconds: rebuilding the frame would reload the graph and lose its state
  else if(section==='graph'){if(!mid.querySelector('iframe.graphframe[data-sid="'+graphSid+'"]'))mid.innerHTML=graphView();det.innerHTML=''}
  // the similarity graph keeps its layout, zoom and focus across the poll's redraws
  else {const g=document.getElementById('simsvg')
    if(!(asub==='sim'&&g&&g.dataset.sig===simSig()))mid.innerHTML=analyticsView()
    det.innerHTML=''; if(asub==='sim')simMount()}
  /* #mid is the scroll container, and swapping its innerHTML keeps the old
     offset. Coming from a long sessions table that dropped you into the middle
     of Analytics — under the rank chart, whose top bar is the priciest session
     on the machine, with this session's own header scrolled off. Reset on a
     view change only: watch mode redraws every 2s and must not fight the
     reader's scroll. */
  const view=section+'|'+subtab+'|'+(section==='analytics'?(sel.sessions||''):section==='graph'?graphSid:'')
  if(view!==lastView){mid.scrollTop=0;lastView=view}
  // analytics owns the full width; elsewhere the pane is the user's to close
  document.getElementById('app').classList.toggle('nodetail',section==='analytics'||section==='graph'||detailShut)
  document.getElementById('brandsub').textContent=DATA.totals.count+' sessions · $'+DATA.totals.cost
   +(DEMO?' · read-only snapshot':'')
  wire()
}
const detailChrome=(html)=>'<button class="railbtn detshut" onclick="setDetail(false)" title="hide details">&#215;</button>'+html
/* Watch mode: poll every 2s and narrow the list to what is still going. */
function toggleWatch(){
  watching=!watching
  try{localStorage.setItem('hub-watch',watching?'on':'off')}catch(e){}
  if(watching&&section!=='sessions'&&section!=='optimization')section='sessions'
  draw(); liveTick()
}
function setDetail(open){
  detailShut=!open
  try{localStorage.setItem('hub-detail',detailShut?'shut':'open')}catch(e){}
  draw()
}
/* analytics is entered from a session, never from the rail, so it always knows
   which session it is about */
async function openAnalytics(id){
  sel.sessions=id; section='analytics'; asub='session'; SDETAIL=null; draw()
  try{SDETAIL=await(await fetch('/api/session?id='+encodeURIComponent(id))).json()}catch(e){SDETAIL={id,series:[]}}
  if(section==='analytics')draw()
}
/* the Graph view, entered from a Triage session the way analytics is from Sessions:
   full width, the opthub graph page in a frame */
let graphSid=''
function openGraph(sid){graphSid=sid;section='graph';draw()}
function graphView(){
  const s=TRI&&TRI.sessions.find(x=>x.session===graphSid)
  return '<div class="midhead"><h2>Graph</h2><span class="crumb">'+esc(s?s.project+' · ':'')+'session '+esc(graphSid.slice(0,8))+'</span>'
    +'<button class="backlink" onclick="section=\'triage\';draw()">◂ triage</button>'
    +' <a class="tri-mut" href="/triage/'+encodeURIComponent(graphSid)+'/graph" target="_blank">open in a tab ▸</a></div>'
    +'<iframe class="graphframe" data-sid="'+esc(graphSid)+'" src="/triage/'+encodeURIComponent(graphSid)+'/graph#embed" onload="graphTheme()"></iframe>'
}
/* the graph page follows the Hub's theme switch, not only the OS: it knows light and dark, so black reads as dark */
function graphTheme(){
  const t=document.documentElement.getAttribute('data-theme')
  document.querySelectorAll('iframe.graphframe').forEach(f=>{try{const r=f.contentDocument.documentElement
    if(t)r.setAttribute('data-theme',t==='black'?'dark':t);else r.removeAttribute('data-theme')}catch(e){}})
}
function wire(){
  document.querySelectorAll('#mid tbody tr[data-id]').forEach(tr=>tr.onclick=()=>{sel.sessions=tr.dataset.id;sel.exp=null;detailShut=false;draw()})
  document.querySelectorAll('#mid tbody tr[data-exp]').forEach(tr=>tr.onclick=()=>{sel.exp=tr.dataset.exp;detailShut=false;draw()})
  document.querySelectorAll('#detail [data-goal]').forEach(b=>b.onclick=()=>{goal=b.dataset.goal;draw()})
  document.querySelectorAll('#detail [data-strat]').forEach(b=>b.onclick=()=>{sel.lever=b.dataset.strat;draw()})
  document.querySelectorAll('#mid tbody tr[data-run]').forEach(tr=>tr.onclick=()=>{sel.run=tr.dataset.run;detailShut=false;draw()})
  document.querySelectorAll('#mid tbody tr[data-cat]').forEach(tr=>tr.onclick=()=>{sel.catalog=tr.dataset.cat;detailShut=false;draw()})
  document.querySelectorAll('#mid tbody tr[data-tri]').forEach(tr=>tr.onclick=()=>{sel.triage=tr.dataset.tri;detailShut=false;draw()})
  document.querySelectorAll('#mid th[data-ts]').forEach(th=>th.onclick=()=>{const k=th.dataset.ts;triSortDir=triSortKey===k?-triSortDir:1;triSortKey=k;draw()})
  document.querySelectorAll('#mid [data-tm]').forEach(b=>b.onclick=()=>{triMode=b.dataset.tm;triSortKey=triMode==='group'?'cost':'gap';triSortDir=-1;draw()})
  document.querySelectorAll('#mid tbody tr[data-tg]').forEach(tr=>tr.onclick=()=>{
    const two=!!triGroup2&&triGroup2!==triGroup
    triFilter={g:triGroup,v:tr.dataset.tg,...(two?{g2:triGroup2,v2:tr.dataset.tg2}:{})};triMode='list';triSortKey='gap';triSortDir=-1;draw()})
  document.querySelectorAll('[data-tdt]').forEach(b=>b.onclick=()=>{triDetTab=b.dataset.tdt;draw()})
  document.querySelectorAll('#mid tr[data-tmeth]').forEach(tr=>tr.onclick=()=>{triFilter={m:tr.dataset.tmeth};triMode='list';triSortKey='expected';triSortDir=-1;draw()})
  const tf=document.querySelector('#mid [data-tf]');if(tf)tf.onclick=()=>{triFilter=null;draw()}
  document.querySelectorAll('#mid tbody tr[data-prof]').forEach(tr=>tr.onclick=()=>{sel.profile=tr.dataset.prof;detailShut=false;draw()})
  document.querySelectorAll('#mid [data-pt]').forEach(b=>b.onclick=()=>{profTarget=b.dataset.pt;loadProf()})
  const pp=document.getElementById('profproj');if(pp)pp.onchange=()=>{profProject=pp.value;loadProf()}
  const tgs=document.getElementById('trigroup');if(tgs)tgs.onchange=()=>{triGroup=tgs.value;if(triGroup2===triGroup)triGroup2='';draw()}
  const tg2=document.getElementById('trigroup2');if(tg2)tg2.onchange=()=>{triGroup2=tg2.value;draw()}
  document.querySelectorAll('#mid th[data-s]').forEach(th=>th.onclick=()=>{
    const k=th.dataset.s;sortDir=sortKey===k?-sortDir:1;sortKey=k
    document.getElementById('srows')?refilter():draw()})
  const q=document.getElementById('q')
  if(q){q.oninput=()=>{filters.q=q.value;refilter()}}
  const fk=document.getElementById('fkind');if(fk)fk.onchange=()=>{filters.kind=fk.value;refilter()}
  const fa=document.getElementById('fart');if(fa)fa.onchange=()=>{filters.art=fa.value;refilter()}
  // switching to or from "custom" adds or removes inputs, so it needs a full draw
  const fd=document.getElementById('fdate')
  if(fd)fd.onchange=()=>{const was=filters.date;filters.date=fd.value
    ;(was==='custom'||fd.value==='custom')?draw():refilter()}
  const df=document.getElementById('dfrom');if(df)df.onchange=()=>{filters.from=df.value;refilter()}
  const dt=document.getElementById('dto');if(dt)dt.onchange=()=>{filters.to=dt.value;refilter()}
}

/* ----------------------------------------------------------------- fetch */
async function refresh(){
  try{RUNS=await(await fetch('/api/runs',{cache:'no-store'})).json()}catch(e){}
  try{LIVE=await(await fetch('/api/optimize/all',{cache:'no-store'})).json()}catch(e){}
}
/* cheap signature: has anything a viewer would notice actually moved? */
const sig=(d)=>!d?'':d.totals.count+'/'+d.totals.cost+'/'+d.totals.live+'/'
  +d.sessions.slice(0,6).map(s=>s.id.slice(0,8)+':'+s.turns+':'+s.cost).join(',')
/**
 * A session being written to right now is the one most worth watching, and the
 * old page fetched /api/sessions exactly once — so a running session's numbers
 * were frozen at page load and a session started afterwards never appeared.
 */
async function refreshSessions(){
  // never redraw the table out from under a cursor or an open menu
  const el=document.activeElement
  if(el&&(el.tagName==='INPUT'||el.tagName==='SELECT'))return false
  let d=null
  try{d=await(await fetch('/api/sessions',{cache:'no-store'})).json()}catch(e){return false}
  if(!d||!d.sessions)return false
  const before=sig(DATA)
  DATA=d
  return sig(DATA)!==before
}
async function load(){
  DATA=await(await fetch('/api/sessions')).json()
  try{CAT=await(await fetch('/api/catalog')).json()}catch(e){}
  await loadTriage()
  loadInsights()
  await refresh()
  draw()
  liveTick()
}
/* Poll fast while something is running, slowly when the machine is idle. */
let liveTimer=null
async function liveTick(){
  clearTimeout(liveTimer)
  const changed=await refreshSessions()
  if(changed||watching){
    // classification is continuous: a new or growing session is reclassified on the next pass
    if(section==='analytics'&&asub!=='session')await loadInsights()
    // a live session's analytics should move too
    if(section==='analytics'&&sel.sessions&&SDETAIL&&SDETAIL.id===sel.sessions&&SDETAIL.live){
      try{SDETAIL=await(await fetch('/api/session?id='+encodeURIComponent(sel.sessions),{cache:'no-store'})).json()}catch(e){}
    }
    draw()
  }
  const hot=DATA&&(DATA.totals.live>0||DATA.totals.open>0)
  liveTimer=setTimeout(liveTick,watching?2000:hot?8000:30000)
}
/* a launched run is shown where it lives: Optimization -> Runs, selected */
const PENDING={}   // survives refresh(), which replaces LIVE wholesale
function toRuns(id,kind,experiment){
  PENDING[id]={kind,experiment,goal,startedAt:new Date().toISOString()}
  LIVE[id]={phase:'starting',session:id,kind,experiment,startedAt:PENDING[id].startedAt}
  pendingRun=id; section='optimization'; subtab='runs'; sel.run='pending:'+id
  draw(); poll(id)
}
async function runOpt(id){
  toRuns(id,'optimize',null)
  try{await fetch('/api/optimize?session='+encodeURIComponent(id)+'&goal='+goal,{method:'POST'})}catch(e){}
}
async function runExp(id){
  const exp=sel.lever||'__auto'
  if(exp==='__auto')return runOpt(id)
  toRuns(id,'experiment',exp)
  try{const res=await fetch('/api/experiment?session='+encodeURIComponent(id)+'&experiment='+encodeURIComponent(exp)+'&goal='+goal,{method:'POST'})
    if(!res.ok){LIVE[id]={phase:'error',session:id};pendingRun=null;alert(await res.text());draw()}}catch(e){}
}
async function stopRun(id){
  await fetch('/api/optimize/stop?session='+encodeURIComponent(id),{method:'POST'})
  LIVE[id]={...(LIVE[id]||{}),phase:'stopping'};draw()
}
const POLLS={}
function poll(id){
  if(POLLS[id])return
  POLLS[id]=setInterval(async()=>{
    await refresh()
    const st=LIVE[id]
    if(!st||['done','error','stopped','stale'].includes(st.phase)){clearInterval(POLLS[id]);delete POLLS[id];delete PENDING[id]}
    draw()
  },4000)
}
function applyTheme(t){
  if(t==='auto')document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme',t)
  try{localStorage.setItem('hub-theme',t)}catch(e){}
  graphTheme()
  document.querySelectorAll('.theme button').forEach(b=>b.classList.toggle('on',b.dataset.th===t))
}
function setRail(shut){
  document.getElementById('app').classList.toggle('railshut',shut)
  try{localStorage.setItem('hub-rail',shut?'shut':'open')}catch(e){}
}
document.getElementById('railshut').onclick=()=>setRail(true)
document.getElementById('railopen').onclick=()=>setRail(false)
document.getElementById('detopen').onclick=()=>setDetail(true)
let det0='open';try{det0=localStorage.getItem('hub-detail')||'open'}catch(e){}
detailShut=det0==='shut'
try{watching=localStorage.getItem('hub-watch')==='on'}catch(e){}
let rail0='open';try{rail0=localStorage.getItem('hub-rail')||'open'}catch(e){}
setRail(rail0==='shut')
document.querySelectorAll('.theme button').forEach(b=>b.onclick=()=>applyTheme(b.dataset.th))
let saved='auto';try{saved=localStorage.getItem('hub-theme')||'auto'}catch(e){}
applyTheme(saved)
load()
setInterval(async()=>{
  if(Object.keys(POLLS).length)return
  if(document.activeElement&&document.activeElement.tagName==='INPUT')return   // never redraw under a cursor
  await refresh();draw()
},15000)
</script></body></html>`
