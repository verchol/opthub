/**
 * Triage: the session classification from the opthub repo (experiments/session-triage):
 * five classes per session from Jev, what they would save, and — where Jev could not tell
 * which model the work needed — the re-run on Sonnet that answers it.
 */
import { useEffect, useMemo, type ComponentProps, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Empty, Head, Kv, MidHead, Pill, SortHead } from '@/components/hub'
import { post, q, type TriageSession } from '@/lib/api'
import { fmtM, tok, usd } from '@/lib/format'
import { cn } from '@/lib/utils'
import { DEMO, useHub } from '@/store'
import { useTriage } from './state'
import {
  TIER, TRI_AXES, TRI_GROUPS, TriBar, TriChips, TriModel, TriVs, runBusy, sortRows, triCls, triClassOf, triDate,
  triGroupName, triPct, triRun, triSess, triTot, triUsd, triVal, type SessIndex,
} from './helpers'

type Row = [ReactNode, ReactNode]
const NONE = '__none'
const rowCls = (on: boolean) => cn('cursor-pointer hover:bg-primary/[0.07]', on && 'bg-primary/[0.11] shadow-[inset_2px_0_0_var(--primary)]')
const Mut = ({ children, className }: { children: ReactNode; className?: string }) => <span className={cn('text-[11.5px] text-muted-foreground', className)}>{children}</span>
const Sec = ({ children }: { children: ReactNode }) => <div className="mt-3.5 mb-1.5 font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase">{children}</div>
const Note = ({ children }: { children: ReactNode }) => <div className="my-3 max-w-[80ch] text-xs leading-relaxed text-muted-foreground">{children}</div>
const GoBtn = ({ className, ...p }: ComponentProps<typeof Button>) =>
  <Button variant="outline" size="xs" {...p} className={cn('border-primary font-mono text-[11px] text-primary hover:text-primary', className)} />

function useSessIndex(): SessIndex {
  const data = useHub((h) => h.data)
  return useMemo(() => new Map((data?.sessions || []).map((s) => [s.id, s])), [data])
}

/* a re-run batch or a scoring pass runs for minutes: poll while either is going */
function useTriagePolling() {
  const rerunning = useHub((h) => !!h.tri?.rerun?.running), scoring = useHub((h) => !!h.tri?.score?.running)
  useEffect(() => {
    if (!rerunning) return
    const t = setInterval(async () => { const h = useHub.getState(); await h.refresh(); await h.loadTriage() }, 6000)
    return () => clearInterval(t)
  }, [rerunning])
  useEffect(() => {
    if (!scoring) return
    const t = setInterval(() => useHub.getState().loadTriage(), 3000)
    return () => clearInterval(t)
  }, [scoring])
}

async function triGo(n: number) {
  try { await post('/api/triage/rerun?' + q({ limit: n })) } catch { /* the poll reports it */ }
  await useHub.getState().loadTriage()
}
async function triScore(days: number) {
  try { await post('/api/triage/score?' + q({ days })) } catch { /* the poll reports it */ }
  await useHub.getState().loadTriage()
}
async function triStop() {
  await post('/api/triage/rerun/stop')
  await useHub.getState().loadTriage()
}
function triOne(id: string) {
  const h = useHub.getState(), exp = h.tri?.rerunExperiment ?? ''
  h.toRuns(id, 'experiment', exp)
  post('/api/experiment?' + q({ session: id, experiment: exp, goal: h.goal })).catch(() => {})
}

function TriSelect({ value, onChange, items }: { value: string; onChange: (v: string) => void; items: [string, string][] }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" className="font-mono text-[11px]"><SelectValue /></SelectTrigger>
      <SelectContent>{items.map(([k, l]) => <SelectItem key={k} value={k} className="font-mono text-[11px]">{l}</SelectItem>)}</SelectContent>
    </Select>
  )
}

export function TriageView() {
  useTriagePolling()
  const tri = useHub((h) => h.tri), runs = useHub((h) => h.runs), live = useHub((h) => h.live), sel = useHub((h) => h.sel.triage)
  const T = useTriage()
  const ix = useSessIndex()

  const head = (
    <MidHead title="Triage" crumb="sessions classified by Jev · saving per class">
      <Button variant="outline" size="xs" title="the cost if batching loses the prompt cache" onClick={() => T.setRisk(!T.risk)}
        className={cn('font-mono text-[11px] text-muted-foreground', T.risk && 'border-bad text-bad hover:text-bad')}>
        {T.risk ? 'hide' : 'show'} potential risk
      </Button>
      <ToggleGroup type="single" variant="outline" size="sm" value={T.mode}
        onValueChange={(v) => v && T.set({ mode: v as 'list' | 'group', sortKey: v === 'group' ? 'cost' : 'gap', sortDir: -1 })}>
        <ToggleGroupItem value="list" className="font-mono text-[11px]">sessions</ToggleGroupItem>
        <ToggleGroupItem value="group" className="font-mono text-[11px]">by class</ToggleGroupItem>
      </ToggleGroup>
      {T.mode === 'group' && <>
        <TriSelect value={T.group} onChange={(v) => T.set({ group: v, ...(T.group2 === v ? { group2: '' } : {}) })}
          items={TRI_GROUPS.map(([k, l]) => [k, 'group by ' + l])} />
        <TriSelect value={T.group2 || NONE} onChange={(v) => T.set({ group2: v === NONE ? '' : v })}
          items={[[NONE, 'then by — nothing'] as [string, string]].concat(TRI_GROUPS.filter(([k]) => k !== T.group).map(([k, l]) => [k, 'then by ' + l]))} />
      </>}
    </MidHead>
  )
  if (!tri) return <>{head}<Empty title="loading…" /></>
  if (tri.missing || !tri.sessions.length) return <>{head}<Empty title="No classification yet">
    Run the session triage in the opthub repo: experiments/session-triage — run.py with --arms rules,jev, then export_hub.py.</Empty></>

  const S = tri.sessions, actual = S.reduce((a, s) => a + s.cost, 0)
  const bestTot = S.reduce((a, s) => a + s.cost - s.best, 0), worstTot = S.reduce((a, s) => a + s.cost - s.worst, 0)
  const runOf = (id: string) => triRun(tri, runs, live, id)
  const queued = S.filter((s) => s.rerun?.needed && s.session && !runOf(s.session)).length
  const busy = tri.rerun?.running
  const logLink = (href: string) => <a href={href} target="_blank" className="text-[11.5px] text-muted-foreground">log ▸</a>
  const btn = DEMO ? <GoBtn disabled title="read-only deploy — this would boot cloud sandboxes and spend">re-run 3 on Sonnet</GoBtn>
    : busy && tri.rerun.elsewhere ? <Mut>a re-run batch is running from another hub or shell</Mut>
    : busy ? <span className="flex items-center gap-2">
        <Button variant="outline" size="xs" className="border-warn font-mono text-[11px] text-warn hover:text-warn" onClick={triStop}>stop re-runs</Button>
        {logLink('/api/triage/log')}
      </span>
    : <GoBtn disabled={!queued} onClick={() => triGo(3)} title="the 3 most expensive queued sessions, one at a time, ≤$6 each">re-run 3 on Sonnet</GoBtn>
  const sc = tri.score || {}
  const scoreBtn = DEMO ? <GoBtn disabled title="read-only deploy">Score with Jev</GoBtn>
    : sc.running ? <span className="flex items-center gap-2"><Pill tone="warn">scoring · {sc.step || 'starting'}</Pill> {logLink('/api/triage/score/log')}</span>
    : <span className="flex items-center gap-2">
        <GoBtn disabled={sc.available === false} onClick={() => triScore(30)}
          title={sc.available === false ? 'score.py not found — set OPTHUB_HOME'
            : sc.jev ? 'last 30 days · one Jev call per session (paid) · everything else runs locally' : 'no JEV_API_KEY in the environment or the repo .env — scores with rules only, no egress'}>
          {sc.jev ? 'Score with Jev' : 'Score (rules — no Jev key)'}
        </GoBtn>
        {logLink('/api/triage/score/log')}
      </span>
  const expTot = S.reduce((a, s) => a + (s.expected || 0), 0)
  const cls = tri.classifier || {}
  const tile = (k: string, v: ReactNode, sub: ReactNode) => (
    <div className="flex flex-col gap-0.5 rounded-lg border bg-card px-3 py-2.5">
      <span className="font-mono text-[10px] tracking-wider text-muted-foreground uppercase">{k}</span>
      <b className="font-mono text-lg">{v}</b><Mut>{sub}</Mut>
    </div>
  )
  const tiles = (
    <div className="my-2.5 mb-3.5 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2.5">
      {tile('actual cost', triTot(actual), S.length + ' sessions, as they ran')}
      {tile('optimization potential', <span className="text-primary">{triTot(actual - bestTot)}</span>, (100 * (actual - bestTot) / (actual || 1)).toFixed(1) + '% of spend · if every unlocked method works')}
      {T.risk && tile('potential risk', <TriVs v={worstTot} actual={actual} />, 'cost if batching loses the prompt cache')}
      {tile('model unclear', S.filter((s) => s.rerun?.needed).length, queued + ' queued for a re-run on Sonnet')}
      {tile('expected saving', <span className="text-primary">{triTot(expTot)}</span>, (100 * expTot / (actual || 1)).toFixed(1) + '% · score × saving, summed')}
      <div className="flex flex-col items-start justify-center gap-1.5 rounded-lg border bg-card px-3 py-2.5">
        {scoreBtn}{btn}
        <Mut>{(cls.model || '') + (cls.arm ? ' · ' + cls.arm : '') + (tri.generatedAt ? ' · ' + new Date(tri.generatedAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '')}</Mut>
      </div>
    </div>
  )
  if (T.mode === 'group') return <>{head}{tiles}<TriGroupView S={S} ix={ix} /></>

  const F = T.filter
  const match = (s: TriageSession) => !F ? true : 'm' in F && F.m ? (s.levers || []).includes(F.m) || (F.m === 'fast-mode' && s.fastModeSpend > 0)
    : 'g' in F && triClassOf(ix, s, F.g) === F.v && (!F.g2 || triClassOf(ix, s, F.g2) === F.v2)
  const shown = F ? S.filter(match) : S.slice()
  const clear = <Button variant="outline" size="xs" className="font-mono text-[11px] text-muted-foreground" onClick={() => T.set({ filter: null })}>× show all</Button>
  const chip = F && 'm' in F && F.m
    ? <div className="mb-2.5 flex items-center gap-2 text-[12.5px]">showing {shown.length} sessions where <b>{(tri.methods || []).find((d) => d.id === F.m)?.title || F.m}</b> is unlocked {clear}</div>
    : F && 'g' in F ? <div className="mb-2.5 flex items-center gap-2 text-[12.5px]">showing {shown.length} sessions where {triGroupName(F.g)} = <b>{F.v}</b>
        {F.g2 && <> and {triGroupName(F.g2)} = <b>{F.v2}</b></>} {clear}</div> : null
  const graphOff = tri.graph?.available === false
  const sh = (k: string, label: string, className?: string) => <SortHead k={k} label={label} sortKey={T.sortKey} dir={T.sortDir} onSort={T.sort} className={className} />

  return <>
    {head}{tiles}{chip}
    <div className="rounded-lg border bg-card">
      <Table className="min-w-[760px] text-[13px]">
        <TableHeader><TableRow>
          {sh('project', 'session')}{sh('date', 'date', 'text-right')}{sh('cost', 'actual cost', 'text-right')}{sh('gap', 'optimization potential', 'text-right')}
          {T.risk && sh('worstCost', 'potential risk', 'text-right')}
          {sh('expected', 'expected saving', 'text-right')}<Head>method scores</Head>{sh('model', 'model needed')}<Head />
        </TableRow></TableHeader>
        <TableBody>
          {sortRows(shown, (s, k) => triVal(ix, s, k), T.sortKey, T.sortDir).map((s) => {
            const h = triSess(ix, s.session)
            return (
              <TableRow key={s.key} className={rowCls(sel === s.key)} onClick={() => useHub.getState().select({ triage: s.key })}>
                <TableCell>
                  {s.project}{s.tasks && <> <Pill>{s.tasks.length} tasks</Pill></>}
                  <div className="text-[11.5px] text-muted-foreground">{s.model}{h ? ' · ' + h.kind : ''}</div>
                </TableCell>
                <TableCell className="num">{triDate(ix, s)}</TableCell>
                <TableCell className="num">{triTot(s.cost)}</TableCell>
                <TableCell className="num"><TriBar v={s.cost ? s.best / s.cost : 0} /><b className={triCls(s.best)}>{triTot(s.best)}</b> <Mut>{s.cost ? Math.round(100 * s.best / s.cost) : 0}%</Mut></TableCell>
                {T.risk && <TableCell className="num"><TriVs v={s.cost - s.worst} actual={s.cost} /></TableCell>}
                <TableCell className="num"><span className="text-primary">{triTot(s.expected || 0)}</span></TableCell>
                <TableCell className="whitespace-normal"><TriChips s={s} /></TableCell>
                <TableCell><TriModel s={s} run={s.session ? runOf(s.session) : null} /></TableCell>
                <TableCell>
                  <span className="flex items-center gap-1">
                    {s.session && h && <GoBtn className="h-5 px-2 text-[10.5px]" onClick={(e) => { e.stopPropagation(); useHub.getState().goOptimize(s.session) }}>Optimize ▸</GoBtn>}
                    {s.session && !graphOff && <Button variant="outline" size="xs" className="h-5 px-2 font-mono text-[10.5px] text-muted-foreground" title="task graph for this session"
                      onClick={(e) => { e.stopPropagation(); useHub.getState().openGraph(s.session) }}>graph</Button>}
                  </span>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
    <Note>
      Classes: Jev ({cls.model || ''}), from session metadata and counts computed on this machine. Prompt text, paths and cost are never sent.{' '}
      When Jev cannot tell which model the work needed, no model saving is counted and the session is re-run in the sandbox on Sonnet against the baseline, blind-judged. The re-run is the answer; it is not fed back to Jev.{' '}
      {T.risk ? 'Best case and potential risk are' : 'Best case is'} what the same sessions would have cost: their real tokens re-priced, nothing re-run.
      {' '}Green is below the actual cost, red is above it. Optimization potential is the saving if every method Jev’s answers unlock works, priced on the session’s own tokens. Rows open ordered by it; click any header to sort by it, click again to flip.
    </Note>
  </>
}

interface Group { cls: string; cls2: string; n: number; cost: number; bestCost: number; worstCost: number; rerun: number }

function TriGroupView({ S, ix }: { S: TriageSession[]; ix: SessIndex }) {
  const T = useTriage()
  const G: Record<string, Group> = {}, two = !!T.group2 && T.group2 !== T.group
  for (const s of S) {
    const a = triClassOf(ix, s, T.group), b = two ? triClassOf(ix, s, T.group2) : ''
    const k = a + '\u0001' + b
    const g = G[k] || (G[k] = { cls: a, cls2: b, n: 0, cost: 0, bestCost: 0, worstCost: 0, rerun: 0 })
    g.n++; g.cost += s.cost; g.bestCost += s.cost - s.best; g.worstCost += s.cost - s.worst; if (s.rerun?.needed) g.rerun++
  }
  const total = S.reduce((a, s) => a + s.cost, 0)
  const gv = (g: Group, k: string): string | number =>
    k === 'project' ? g.cls : k === 'second' ? g.cls2 : k === 'gap' ? g.cost - g.bestCost : k === 'share' ? g.cost : (g as unknown as Record<string, number>)[k]
  const cell = (g: string, v: string) => g === 'dir'
    ? <span className="inline-block max-w-[26em] truncate align-bottom" title={v}>{String(v).replace(/^~\/workspace\//, '')}</span>
    : <Pill>{v}</Pill>
  const sh = (k: string, label: string, className?: string) => <SortHead k={k} label={label} sortKey={T.sortKey} dir={T.sortDir} onSort={T.sort} className={className} />
  const open = (g: Group) => T.set({ filter: { g: T.group, v: g.cls, ...(two ? { g2: T.group2, v2: g.cls2 } : {}) }, mode: 'list', sortKey: 'gap', sortDir: -1 })
  return <>
    <div className="rounded-lg border bg-card">
      <Table className="min-w-[760px] text-[13px]">
        <TableHeader><TableRow>
          {sh('project', triGroupName(T.group))}{two && sh('second', triGroupName(T.group2))}{sh('n', 'sessions', 'text-right')}
          {sh('cost', 'actual cost', 'text-right')}{sh('share', 'share', 'text-right')}{sh('bestCost', 'best case cost', 'text-right')}
          {T.risk && sh('worstCost', 'potential risk', 'text-right')}{sh('rerun', 'model unclear', 'text-right')}
        </TableRow></TableHeader>
        <TableBody>
          {sortRows(Object.values(G), gv, T.sortKey, T.sortDir).map((g) => (
            <TableRow key={g.cls + '\u0001' + g.cls2} className={rowCls(false)} onClick={() => open(g)}>
              <TableCell>{cell(T.group, g.cls)}</TableCell>{two && <TableCell>{cell(T.group2, g.cls2)}</TableCell>}
              <TableCell className="num">{g.n}</TableCell><TableCell className="num">{triTot(g.cost)}</TableCell>
              <TableCell className="num">{(100 * g.cost / (total || 1)).toFixed(1)}%</TableCell>
              <TableCell className="num"><TriVs v={g.bestCost} actual={g.cost} /></TableCell>
              {T.risk && <TableCell className="num"><TriVs v={g.worstCost} actual={g.cost} /></TableCell>}
              <TableCell className="num">{g.rerun || ''}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
    <Note>{Object.keys(G).length} groups. Type is the Sessions tab’s kind (code, explore, …); working dir is where the session ran; the rest are Jev’s classes. Click a group to see its sessions.</Note>
  </>
}

const CCN: Record<string, string> = {
  entrypoint: 'entry point', version: 'version', model: 'model', effort: 'reasoning effort', effort_high_share: 'share of turns at high effort', permission_mode: 'permission mode',
  fast_mode_share: 'share of turns in fast mode', advisor_on: 'advisor on', compactions: 'context compactions', hooks_active: 'hooks ran', mcp_servers: 'MCP servers used', subagent_request_share: 'subagent share of requests',
}
const SIGNAME: Record<string, string> = {
  files_touched: 'files touched', lines_changed: 'lines changed', files_edited_3plus_times: 'files edited 3+ times',
  test_runs: 'test runs', test_runs_failed: 'test runs that failed', tool_errors: 'failed tool calls', git_commits: 'git commits / reverts',
}

export function TriageDetail() {
  const tri = useHub((h) => h.tri), selKey = useHub((h) => h.sel.triage), runs = useHub((h) => h.runs), live = useHub((h) => h.live)
  const T = useTriage()
  const ix = useSessIndex()
  const s = tri?.sessions.find((x) => x.key === selKey)
  if (!tri || !s) return <Empty title="Pick a session">Its classes, the signals behind them, its tasks and its re-run.</Empty>

  const L = s.labels || {}, C = s.confidence || {}, P = s.probabilities || {}
  const r = s.session ? triRun(tri, runs, live, s.session) : null
  const h = triSess(ix, s.session)
  const graphOff = tri.graph?.available === false
  const arm: string = tri.classifier?.arm || ''

  const answers: Row[] = TRI_AXES.filter((a) => a in L).map((a) => [
    a === 'capability' ? 'model needed' : a,
    <>
      {a === 'capability' && TIER[L[a]] ? TIER[L[a]][0] + ' ' + TIER[L[a]][1] : (L[a] || '—')}
      {C[a] != null && <Mut> conf {Number(C[a]).toFixed(2)}</Mut>}
      {P[a] && <div className="text-[11.5px] text-muted-foreground">{Object.entries(P[a] as Record<string, number>).sort((x, y) => y[1] - x[1]).map(([o, v]) => o + ' ' + triPct(v)).join(' · ')}</div>}
    </>,
  ])

  const meth = s.methods ? <>
    <table className="mb-3.5 w-full font-mono text-[11.5px]"><tbody>
      {(s.methods as any[]).map((m) => {
        const spend = m.id === 'fast-mode'
        return (
          <tr key={m.id}>
            <td className="w-[9.5em] py-1 pr-2.5 align-middle text-muted-foreground">
              <b className="text-foreground">{m.title}</b>{m.unlocked && <> <Pill tone={spend ? 'degraded' : 'improved'}>unlocked</Pill></>}
              <div className="text-[10.5px] text-primary">{m.knob}</div>
            </td>
            <td className="py-1 align-middle">
              <TriBar v={m.score} spend={spend} /><b>{triPct(m.score)}</b>
              <div>
                {spend ? <span className="text-bad">+{triUsd(-m.saving)} spend</span> : <>
                  <span className={triCls(m.saving)}>{triUsd(m.saving)}</span> <Mut>{m.pct}%</Mut>
                  {m.savingFloor != null && T.risk && <> <Mut>risk </Mut><span className={triCls(m.savingFloor)}>{triUsd(m.savingFloor)}</span></>}
                </>}
                {m.expected != null && !spend && <Mut> · expected {triUsd(m.expected)}</Mut>}
              </div>
              <div className="text-[11.5px] text-muted-foreground">
                {(T.risk ? m.note : String(m.note).replace(/ — floor .*$/, '')) + ' · ' + (T.risk ? m.label : String(m.label).replace(/ · guess floor$/, ''))}
              </div>
            </td>
          </tr>
        )
      })}
    </tbody></table>
    <Mut>Score: probability on the answers that unlock the method. Saving: marginal, in applied order (top to bottom), on this session’s own tokens.</Mut>
  </> : null

  const head = <>
    <h3 className="mt-1.5 mb-1 pr-6 font-heading text-[17px] font-extrabold tracking-tight break-words">{s.project}</h3>
    <Mut>{s.started} · {s.model} · {usd(s.cost)}{s.session ? ' · ' + s.session.slice(0, 8) : ''}</Mut>
    {s.session && h && (
      <div className="my-4 flex flex-wrap items-center gap-1.5">
        <GoBtn size="sm" onClick={() => useHub.getState().goOptimize(s.session)}>Optimize this session ▸</GoBtn>
        <Mut>potential {triTot(s.best)} · {s.cost ? Math.round(100 * s.best / s.cost) : 0}% of {triTot(s.cost)}</Mut>
      </div>
    )}
    <Tabs value={T.detTab} onValueChange={(v) => T.set({ detTab: v as 'judgment' | 'details' })} className="mt-2.5 mb-1">
      <TabsList variant="line">
        <TabsTrigger value="judgment" className="font-mono text-[11px]">Jev judgment</TabsTrigger>
        <TabsTrigger value="details" className="font-mono text-[11px]">Details</TabsTrigger>
      </TabsList>
    </Tabs>
  </>

  if (T.detTab === 'judgment') return <>
    {head}
    <Sec>Optimization methods · this session</Sec>
    {meth || <Mut>not scored per method — press Score with Jev.</Mut>}
    <div className="mt-3.5 mb-1.5 flex items-center justify-between font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase">
      {/^jev/.test(arm) ? 'Jev’s answers' : 'Answers (' + arm + ')'}
      {/* a null graph is fine: the hub rebuilds it from the transcript on demand */}
      <Button variant="outline" size="xs" className="font-mono text-[11px] tracking-normal normal-case text-muted-foreground"
        disabled={!s.session || graphOff} onClick={() => useHub.getState().openGraph(s.session)}
        title={!s.session ? 'no session id, so no transcript to graph' : graphOff ? 'no session-graph template in the opthub checkout — set OPTHUB_DIR' : undefined}>graph ▸</Button>
    </div>
    <Kv rows={answers} />
  </>

  const busy = runBusy(r)
  const tools: Row[] = h?.toolCounts ? Object.entries(h.toolCounts).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => [k.replace(/^mcp__([^_]+(?:-[^_]+)*)__/, 'mcp · $1 · '), String(v)]) : []
  const arts = h?.artifacts || []
  const fmtV = (v: unknown) => v == null ? '—' : typeof v === 'boolean' ? (v ? 'yes' : 'no') : typeof v === 'object' ? JSON.stringify(v) : String(v)

  return <>
    {head}
    <Sec>Cost</Sec>
    <Kv rows={[
      ['actual', triTot(s.cost)],
      ['best case', <TriVs v={s.cost - s.best} actual={s.cost} />],
      ...(T.risk ? [['potential risk', <TriVs v={s.cost - s.worst} actual={s.cost} />] as Row] : []),
      ['expected saving', triUsd(s.expected || 0)],
      ['unlocked', (s.levers || []).join(', ') || 'none'],
    ]} />
    {s.claudeCode ? <>
      <Sec>Claude Code settings · what the session ran with</Sec>
      <Kv rows={Object.entries(s.claudeCode as Record<string, unknown>).map(([k, v]) => [CCN[k] || k, fmtV(v)] as Row)} />
    </> : <>
      <Sec>Claude Code settings</Sec>
      <Mut>not recorded for this run — press Score with Jev to extract them.</Mut>
    </>}
    {s.sentToJev && (
      <details>
        <summary className="mt-3.5 mb-1.5 cursor-pointer font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase">What {arm || 'the classifier'} saw ▸</summary>
        <pre className="mb-1.5 max-h-[340px] overflow-auto rounded-md border bg-rail px-2.5 py-2 font-mono text-[11px] leading-snug break-words whitespace-pre-wrap">{JSON.stringify(s.sentToJev, null, 1)}</pre>
        <Mut>Counts, flags and settings computed on this machine. No prompt text, no path, no cost.</Mut>
      </details>
    )}
    {s.rerun?.needed ? <>
      <Sec>Re-run on Sonnet</Sec>
      <div className="mb-2"><Mut>{s.rerun.reason}.</Mut></div>
      {r && !busy && <Kv rows={[['result', r.headline?.text || r.phase], ['spent', usd(r.totalCost)]]} />}
      {s.session && (DEMO ? <GoBtn size="sm" disabled title="read-only deploy">re-run on Sonnet</GoBtn>
        : <GoBtn size="sm" disabled={busy} onClick={() => triOne(s.session)}>{busy ? 'running…' : r ? 're-run again' : 're-run on Sonnet'}</GoBtn>)}
    </> : <>
      <Sec>Model</Sec>
      <Mut>{s.rerun ? s.rerun.reason : ''} — priced, not re-run.</Mut>
    </>}
    {s.tasks && <>
      <Sec>{s.tasks.length} tasks · split where the person paused over 30 min</Sec>
      <Kv rows={(s.tasks as any[]).map((t) => [t.start, usd(t.cost) + ' · ' + t.title] as Row)} />
    </>}
    {s.signals && <>
      <Sec>Work signals sent to Jev</Sec>
      <Kv rows={Object.entries(s.signals as Record<string, unknown>).map(([k, v]) => [SIGNAME[k] || k.replace(/_/g, ' '), String(v)] as Row)} />
      <Mut>A failed tool call is a tool that returned an error: a command that exited non-zero, an edit whose text was not found, a missing file, a call the permission system refused.</Mut>
    </>}
    {h && <>
      <Sec>From the Sessions tab</Sec>
      <Kv rows={[
        ['first request', String(h.intent || '').slice(0, 220)], ['kind', h.kind], ['turns', h.turns],
        ['duration', fmtM(h.durationMin || 0)], ['tool calls', h.toolCalls], ['status', h.status],
      ]} />
      {tools.length > 0 && <><Sec>Tools used</Sec><Kv rows={tools} /></>}
      <Sec>Artifacts created</Sec>
      {h.hasArtifact
        ? <Kv rows={[
            ...arts.slice(0, 12).map((a) => [a.name, tok(a.bytes) + 'B'] as Row),
            ...(arts.length > 12 ? [['…', '+' + (arts.length - 12) + ' more'] as Row] : []),
          ]} />
        : <Mut>none — the session wrote no files</Mut>}
    </>}
  </>
}
