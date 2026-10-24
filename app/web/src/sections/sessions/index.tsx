/** Sessions: every Claude Code session on this machine, filterable; the detail pane summarises one. */
import { useEffect, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Blk, ChartIcon, Empty, Head, Kv, MidHead, MiniButton, Pill, SortHead, Stats, SubLine } from '@/components/hub'
import { LineChart } from '@/components/charts'
import { ExperimentDetail } from '@/sections/optimize/experiment'
import type { Potential, Run, Session } from '@/lib/api'
import { ago, fmtM, modelOf, tok, usd } from '@/lib/format'
import { cn } from '@/lib/utils'
import { expsOf, expTitle, runArm, runRows, runState, useHub, type HubState } from '@/store'
import { DATE_OPTS, dateLabel, sessionRows, useSessions, type Filters as F } from './state'

/* live / open / idle, from lib/watch.mjs — each says which signal it stands on */
const STATUS_WHY: Record<string, string> = {
  live: 'wrote to its transcript in the last 90 seconds',
  open: 'a claude process is running in this directory and this is its newest session',
  idle: 'wrote in the last 30 minutes, but nothing is running there now',
  closed: 'no recent writes, no process',
}

function StatusDot({ s }: { s: Session }) {
  if (s.status === 'live') return <span className="mr-1 align-[1px] text-[9px] text-primary animate-hub-pulse" title={STATUS_WHY.live}>{'●'}</span>
  if (s.status === 'open') return <span className="mr-1 align-[1px] text-[9px] text-warn" title={STATUS_WHY.open}>{'○'}</span>
  return null
}

const StatusPill = ({ s }: { s: Session }) => !s.status || s.status === 'closed'
  ? <Pill tone="flat">closed</Pill>
  : <Pill tone={s.status} title={STATUS_WHY[s.status]}>{s.status}</Pill>

/* the files a session wrote: biggest one named, the rest behind a +n, all of them on hover */
function ArtCell({ s }: { s: Session }) {
  if (!s.hasArtifact) return <span className="font-mono text-[11.5px] text-muted-foreground">none</span>
  const names = s.artifacts.map((a) => a.name), top = names[0], more = names.length - 1
  return (
    <span className="font-mono text-[11.5px]" title={names.join(', ')}>
      {top.length > 24 ? top.slice(0, 23) + '…' : top}{more > 0 && <span className="text-muted-foreground"> +{more}</span>}
    </span>
  )
}

/* computed server-side in /api/sessions — the pricing model stays in node */
const NOPOT: Potential = { band: 'none', lo: 0, hi: 0, usdLo: 0, usdHi: 0, methods: [], basis: '', gateNote: null }
export const POT = (s: Session): Potential => s.potential || NOPOT

export function BandPill({ p }: { p: Potential }) {
  if (p.band === 'none') return <Pill tone="flat">—</Pill>
  if (p.band === 'below-gate') return <Pill tone="flat" title={p.gateNote || ''}>below gate</Pill>
  const tone = p.band === 'high' ? 'improved' : p.band === 'medium' ? 'warn' : 'flat'
  const head = p.head as { name: string; evidence: string } | undefined
  return <Pill tone={tone} title={head ? head.name + ' · ' + head.evidence : ''}>{p.lo.toFixed(0)}–{p.hi.toFixed(0)}%</Pill>
}

const shownCost = (list: Session[]) => list.reduce((a, s) => a + s.cost, 0).toFixed(2)

/** the one summary line */
function subLine(h: HubState, list: Session[], inOpt: boolean, f: F) {
  const st = h.data!.totals, filtered = list.length !== st.count
  const running = list.filter((s) => s.status === 'live' || s.status === 'open').length
  const dl = f.date ? dateLabel(f) : ''
  return list.length + ' of ' + st.count + ' · $' + (filtered ? shownCost(list) + ' shown of $' : '') + st.cost
    + (h.watching ? ' · watching every 2s · ' + running + ' running' : '')
    + (dl ? ' · ' + dl : '')
    + ' · ' + (inOpt ? 'open one and run a lever against it' : 'click a row to open it on the right')
}

const ANY = '__any'   // Radix Select cannot hold an empty value

function FilterSelect({ value, onChange, options, title, className }: {
  value: string; onChange: (v: string) => void; options: [string, string][]; title?: string; className?: string
}) {
  return (
    <Select value={value || ANY} onValueChange={(v) => onChange(v === ANY ? '' : v)}>
      <SelectTrigger size="sm" title={title} className={cn('bg-card font-mono text-xs', className)}><SelectValue /></SelectTrigger>
      <SelectContent>
        {options.map(([v, l]) => <SelectItem key={v || ANY} value={v || ANY} className="font-mono text-xs">{l}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}

function Filters() {
  const h = useHub()
  const { filters: f, setFilters } = useSessions()
  const kinds = Object.keys(h.data!.totals.byKind)
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <Input placeholder="filter intent / model…" value={f.q} onChange={(e) => setFilters({ q: e.target.value })}
        className="h-7 w-56 bg-card font-mono text-xs" />
      <FilterSelect value={f.kind} onChange={(v) => setFilters({ kind: v })} options={[['', 'all kinds'], ...kinds.map((k) => [k, k] as [string, string])]} />
      <FilterSelect value={f.art} onChange={(v) => setFilters({ art: v })} options={[['', 'artifacts: any'], ['y', 'has artifact'], ['n', 'none']]} />
      <FilterSelect value={f.date} onChange={(v) => setFilters({ date: v })} title="filter by when the session was created"
        options={DATE_OPTS.map(([v, l]) => [v, l] as [string, string])} />
      {f.date === 'custom' && <>
        <Input type="date" value={f.from} title="created on or after" onChange={(e) => setFilters({ from: e.target.value })} className="h-7 w-auto bg-card font-mono text-[11.5px]" />
        <Input type="date" value={f.to} title="created on or before" onChange={(e) => setFilters({ to: e.target.value })} className="h-7 w-auto bg-card font-mono text-[11.5px]" />
      </>}
      <Button variant="outline" size="sm" onClick={h.toggleWatch}
        className={cn('font-mono text-xs text-muted-foreground', h.watching && 'border-primary bg-primary/10 text-primary')}
        title={'Re-read the transcripts every 2s instead of every 8-30s, so a session going live — or a brand new one — appears as it happens. Nothing is filtered out.'}>
        {h.watching ? '● watching' : 'watch live'}
      </Button>
    </div>
  )
}

/* while watching, running rows stay findable without the list being cut down */
const rowCls = (on: boolean, watchTone?: string) => cn(
  'cursor-pointer text-[13px] hover:bg-primary/[.07]',
  watchTone === 'live' && 'bg-primary/[.07] shadow-[inset_3px_0_0_var(--primary)]',
  watchTone === 'open' && 'shadow-[inset_3px_0_0_var(--warn)]',
  on && 'bg-primary/[.11] shadow-[inset_2px_0_0_var(--primary)]',
  on && watchTone && 'bg-primary/[.13]',
)

function ExpRow({ r }: { r: Run }) {
  const h = useHub()
  const a = runArm(r)
  const files = a && Array.isArray(a.artifacts) ? a.artifacts.length : 0
  return (
    <TableRow className={cn(rowCls(h.sel.exp === r.run), 'bg-rail text-xs')} onClick={() => h.select({ exp: r.run })}>
      <TableCell className="font-mono text-[11px]">{a ? a.model : '—'}</TableCell>
      <TableCell><Pill tone="code">experiment</Pill></TableCell>
      <TableCell className="w-[29%] min-w-[24ch] pl-5 whitespace-normal break-words">
        ↳ {expTitle(h.cat, r)} · goal {r.goal || 'cost'} · <Pill tone={r.headline?.tone}>{(r.headline?.text ?? '').slice(0, 40)}</Pill>
      </TableCell>
      <TableCell className="num">{usd(r.totalCost)}</TableCell>
      <TableCell className="num">{a ? a.turns : '—'}</TableCell>
      <TableCell className="num">{a && a.secs != null ? a.secs + 's' : '—'}</TableCell>
      <TableCell className="font-mono text-[11.5px]">{a ? files + ' file(s)' : '—'}</TableCell>
      <TableCell />
      {h.watching && <TableCell />}
      <TableCell />
    </TableRow>
  )
}

/* The run state is a column only under Optimization — the Sessions tab does not
   launch runs, so a column about them there is answering a question it does not
   let you ask. */
function SessionRow({ s, inOpt }: { s: Session; inOpt: boolean }) {
  const h = useHub()
  const exps = inOpt ? [] : expsOf(h, s.id)
  const rs = inOpt ? runState(h, s.id) : null
  const watchTone = h.watching && (s.status === 'live' || s.status === 'open') ? s.status : undefined
  return (
    <>
      <TableRow className={rowCls(h.sel.sessions === s.id, watchTone)} onClick={() => h.select({ sessions: s.id, exp: null })}>
        <TableCell className="font-mono text-[11px]"><StatusDot s={s} />{modelOf(s.model)}</TableCell>
        <TableCell><Pill tone={s.kind}>{s.kind}</Pill>{s.where === 'sandbox' && <Pill tone="code" className="ml-1" title={`ran in the sandbox of ${s.run}`}>sandbox</Pill>}</TableCell>
        <TableCell className="w-[29%] min-w-[24ch] text-[12.5px] whitespace-normal break-words">
          {s.intent.slice(0, 120)}{!inOpt && exps.length > 0 && <> <Pill tone="code">{exps.length} exp</Pill></>}
        </TableCell>
        {inOpt && <TableCell className="num" title={'median per request · peak ' + tok(s.ctxPeak)}>{tok(s.ctxMedian)}</TableCell>}
        <TableCell className="num">{usd(s.cost)}</TableCell>
        <TableCell className="num">{s.turns}</TableCell>
        {!inOpt && <TableCell className="num">{fmtM(s.durationMin || 0)}</TableCell>}
        <TableCell className="max-w-[17ch] min-w-[12ch] overflow-hidden text-ellipsis"><ArtCell s={s} /></TableCell>
        {inOpt
          ? <TableCell><BandPill p={POT(s)} /></TableCell>
          : <TableCell className="num">{s.roi == null ? <span className="text-muted-foreground">—</span> : <span className="font-bold">{String(s.roi)}</span>}</TableCell>}
        {h.watching && <TableCell><StatusPill s={s} /></TableCell>}
        {rs && <TableCell>
          {!rs.phase ? <Pill tone="flat">—</Pill>
            : rs.live ? <Pill>{rs.phase}…</Pill>
            : <Pill tone={rs.run ? rs.run.headline?.tone : 'flat'}>{rs.phase}</Pill>}
        </TableCell>}
        <TableCell className="w-[1%] pr-2.5 pl-1.5">
          <MiniButton title="analytics for this session" onClick={() => h.openAnalytics(s.id)}><ChartIcon /></MiniButton>
        </TableCell>
      </TableRow>
      {exps.map((r) => <ExpRow key={r.run} r={r} />)}
    </>
  )
}

/** inOpt: shown under Optimize → Sessions, where a row leads to running an experiment */
export function SessionsView({ inOpt }: { inOpt: boolean }) {
  const h = useHub()
  const { filters, sortKey, sortDir, sortBy } = useSessions()
  const data = h.data!
  const st = data.totals
  const list = sessionRows(data.sessions, filters, sortKey, sortDir)
  const bands: Record<string, number> = {}
  for (const x of data.sessions) { const b = POT(x).band; bands[b] = (bands[b] || 0) + 1 }
  const stats: [string, string | number][] = inOpt
    ? [['sessions', st.count], ['high potential', bands.high || 0], ['medium', bands.medium || 0],
      ['below ROI gate', bands['below-gate'] || 0], ['experiments', h.runs.runs.length]]
    : [['sessions', st.count], ['live now', st.live || 0], ['still open', st.open || 0],
      ['total cost', '$' + st.cost], ['experiments', h.runs.runs.length]]
  const sh = (label: string, k: string, title?: string, cls?: string) =>
    <SortHead label={<span title={title}>{label}</span>} k={k} sortKey={sortKey} dir={sortDir} onSort={sortBy} className={cls} />
  return (
    <>
      <MidHead title={inOpt ? 'Optimize' : 'Sessions'}
        crumb={inOpt ? 'pick a session, choose a goal, run a strategy' : 'past and live · experiments nested under the session they ran on'} />
      <SubLine>{subLine(h, list, inOpt, filters)}</SubLine>
      <Stats items={stats} />
      <Filters />
      <div className="rounded-lg border bg-card">
        <Table className="min-w-[760px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {sh('Model', 'model')}{sh('Kind', 'kind')}{sh('Intent', 'intent')}
              {inOpt && sh('Context', 'ctxMedian', undefined, 'text-right')}
              {sh('Cost', 'cost', undefined, 'text-right')}{sh('Turns', 'turns', undefined, 'text-right')}
              {!inOpt && sh('Duration', 'durationMin', undefined, 'text-right')}
              {sh('Artifacts', 'artifactBytes')}
              {inOpt ? sh('Potential', 'potPct') : sh('ROI', 'roi', 'artifact value per dollar, 1–100 among sessions that produced a file', 'text-right')}
              {h.watching && <Head>State</Head>}
              {inOpt && <Head>Experiment</Head>}
              <Head />
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((s) => <SessionRow key={s.id} s={s} inOpt={inOpt} />)}
          </TableBody>
        </Table>
      </div>
    </>
  )
}

/* ------------------------------------------------------------- detail */

/* Every chip carries the number that produced it, on hover — a classification
   you cannot interrogate is decoration. */
const TAGORDER = ['work', 'shape', 'cost', 'tools', 'festive', 'flag']
const TAG_TONE: Record<string, string> = {
  work: 'text-primary border-primary/45', shape: 'text-foreground border-border', cost: 'text-warn border-warn/45',
  tools: 'text-violet border-violet/45', flag: 'text-bad border-bad', festive: 'text-gold border-gold',
}
interface Tag { tag: string; group: string; why: string }

function TagBlock({ s }: { s: Session }) {
  const tags: Tag[] = Array.isArray(s.tags) ? s.tags : []
  if (!tags.length) return null
  const byGroup = TAGORDER.map((g) => [g, tags.filter((t) => t.group === g)] as const).filter(([, v]) => v.length)
  return (
    <Blk k="classification">
      <div className="mt-1 flex flex-col gap-1.5">
        {byGroup.map(([g, list]) => (
          <div key={g} className="flex flex-wrap items-center gap-1">
            <span className="w-[4.2em] flex-none font-mono text-[9px] tracking-widest text-muted-foreground uppercase">{g}</span>
            {list.map((t, i) => (
              <Tooltip key={i}>
                <TooltipTrigger asChild>
                  <span className={cn('cursor-help rounded-sm border px-1.5 py-px font-mono text-[10.5px] whitespace-nowrap text-muted-foreground', TAG_TONE[t.group])}>{t.tag}</span>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">{t.why}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        ))}
      </div>
      <div className="mt-2.5 text-[11.5px] text-muted-foreground">
        Hover any chip for the measurement behind it. Only <b>{s.kind}</b> is a guess from wording; the rest are counted.
      </div>
    </Blk>
  )
}

/* The one lever that pays for itself. Fires only on a session that asked this
   agent for a New Year card, which it cannot draw. */
function PomBlock({ s }: { s: Session }) {
  const p = s.shanaTova
  if (!p || !p.hit) return null
  return (
    <div className="mb-3 rounded-md border border-gold px-3.5 py-3">
      <div className="mb-1.5 font-mono text-[9.5px] tracking-widest text-gold uppercase">{'שנה טובה detector · confidence '}{p.confidence}</div>
      <div className="font-heading text-[15px] font-bold">${p.perCard.toFixed(2)} per greeting card</div>
      <div className="mt-2 flex flex-col gap-0.5 font-mono text-[11.5px] text-muted-foreground">
        <span>{p.attempts} attempt(s) {'·'} ${p.cost.toFixed(2)} total</span>
        <span>{p.pomegranates.toFixed(1)} actual pomegranates at the same price</span>
        <span>{p.honeyJars.toFixed(1)} jars of honey</span>
        <span className="text-foreground">{p.verdict}</span>
      </div>
      <div className="mt-2 text-[12.5px] leading-snug text-muted-foreground">{p.note}</div>
      <div dir="rtl" className="mt-2.5 text-right font-heading text-[15px] font-bold text-gold">{p.wish}</div>
    </div>
  )
}

/* the per-turn series behind the session graph: fetched once per selected session */
function SessionGraph({ s }: { s: Session }) {
  const sdetail = useHub((h) => h.sdetail), loadSeries = useHub((h) => h.loadSeries)
  useEffect(() => { loadSeries(s.id) }, [s.id, loadSeries])
  if (!sdetail || sdetail.id !== s.id)
    return <Blk k="session graph"><span className="text-muted-foreground">reading the transcript…</span></Blk>
  const S = sdetail.series || []
  if (!S.length) return <Blk k="session graph"><span className="text-muted-foreground">no billed requests to chart</span></Blk>
  return (
    <>
      <Blk k={'cost, cumulative · turn 1 → ' + S.length}>
        <LineChart series={S} get={(d) => d.costCum} fmt={(v) => '$' + v.toFixed(v < 1 ? 3 : 1)} color="var(--warn)" />
      </Blk>
      <Blk k="context carried per request">
        <LineChart series={S.filter((d) => d.ctx > 0)} get={(d) => d.ctx} fmt={(v) => tok(v)} color="var(--primary)" />
      </Blk>
    </>
  )
}

function ExpList({ s }: { s: Session }) {
  const h = useHub()
  const ex = expsOf(h, s.id)
  if (!ex.length) return null
  return (
    <Blk k="experiments on this session">
      {ex.map((r) => (
        <div key={r.run} className="my-1">
          <a href="#" className="text-primary hover:underline"
            onClick={(e) => { e.preventDefault(); useHub.setState((st) => ({ sel: { ...st.sel, exp: r.run }, section: 'sessions', detailShut: false })) }}>
            {expTitle(h.cat, r)}
          </a>{' '}
          <span className="text-[11.5px] text-muted-foreground">goal {r.goal || 'cost'} · {ago(r.startedAt)}</span>{' '}
          <Pill tone={r.headline?.tone}>{(r.headline?.text ?? '').slice(0, 40)}</Pill>
        </div>
      ))}
    </Blk>
  )
}

const actionBtn = 'font-mono text-[11px] text-muted-foreground'

function SummaryDetail({ s }: { s: Session }) {
  const h = useHub()
  const tri = h.tri?.sessions?.find((x) => x.session === s.id)
  const rows: [ReactNode, ReactNode][] = [
    ['model', modelOf(s.model)], ['kind', s.kind], ['cost', usd(s.cost)],
    ['turns', s.turns], ['duration', fmtM(s.durationMin)], ['ended', ago(s.endedAt)],
    ['context', 'median ' + tok(s.ctxMedian) + ' · peak ' + tok(s.ctxPeak) + ' · cache reuse ' + (s.cacheHit * 100).toFixed(0) + '%'],
    ['artifacts', s.hasArtifact ? s.artifacts.map((a) => a.name).join(', ') : <span className="text-muted-foreground">none</span>],
  ]
  if (s.roi != null) rows.push(['ROI', <>{String(s.roi)} <span className="text-muted-foreground">of 100</span></>])
  return (
    <>
      <div className="eyebrow">
        session {s.id.slice(0, 8)}
        {s.live && <> <span className="text-[9px] text-primary animate-hub-pulse">{'●'}</span> live {'·'} still being written</>}
      </div>
      <h3 className="mt-1.5 mb-2.5 font-heading text-[17px] font-extrabold tracking-tight break-words">{s.intent.slice(0, 150)}</h3>
      <div className="my-4 flex flex-wrap items-center gap-1.5">
        <Button variant="outline" size="sm" className="border-primary font-mono text-[11px] text-primary" onClick={() => h.goOptimize(s.id)}>Optimize ▸</Button>
        {tri && <Button variant="outline" size="sm" className={actionBtn}
          onClick={() => useHub.setState((st) => ({ section: 'triage', sel: { ...st.sel, triage: tri.key } }))}>triage ▸</Button>}
        <Button variant="outline" size="sm" className={actionBtn} onClick={() => h.openAnalytics(s.id)}>full graphs ▸</Button>
      </div>
      <Kv rows={rows} />
      <TagBlock s={s} />
      <PomBlock s={s} />
      <SessionGraph s={s} />
      <ExpList s={s} />
    </>
  )
}

/* The Sessions tab reports, it does not spend: Optimize → Sessions has its own detail. */
export function SessionsDetail() {
  const h = useHub()
  if (h.sel.exp) return <ExperimentDetail run={runRows(h).find((x) => x.run === h.sel.exp)} />
  const s = h.data?.sessions.find((x) => x.id === h.sel.sessions)
  if (!s) return <Empty title="Pick a session">Its summary, its graph, and the experiments run on it.</Empty>
  return <SummaryDetail s={s} />
}
