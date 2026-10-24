/**
 * Overview: the page the hub opens on. What the last 30 days cost and where it went, what could be
 * saved (each saving labelled measured / priced / guess), and what has been proven on this machine
 * by opt claude -p --compare, with its claims audit.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { ArrowRight, Cpu, FlaskConical, Terminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Empty, Head, MidHead, Pill } from '@/components/hub'
import { Legend } from '@/components/charts'
import { getJSON, STALE_HUB, type ClaudeRun, type Opportunity, type OverviewPayload } from '@/lib/api'
import { pct, usd } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useHub } from '@/store'
import { ChartCard } from '@/sections/analytics/controls'

const MONO = 'var(--font-mono)'

export function OverviewView() {
  const [d, setD] = useState<OverviewPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let on = true
    const load = () => getJSON<OverviewPayload>('/api/overview').then((x) => on && (setD(x), setError(null))).catch((e) => on && setError(String(e?.message ?? e)))
    load()
    const t = setInterval(load, 60e3)
    return () => { on = false; clearInterval(t) }
  }, [])
  if (error && !d) return (
    <>
      <MidHead title="Overview" crumb="last 30 days" />
      <Empty title={error === STALE_HUB ? 'This hub was started before the Overview existed' : 'could not load the overview'}>
        {error === STALE_HUB ? <>Stop the running hub (ctrl-c in its terminal) and start it again: <code className="text-primary">opt hub start</code></> : error}
      </Empty>
    </>
  )
  if (!d) return <><MidHead title="Overview" crumb="last 30 days" /><Empty title="adding up the last 30 days…" /></>
  const k = d.kpi
  return (
    <>
      <MidHead title="Overview" crumb={`${k.sessions} sessions · ${k.projects} projects in the last ${d.days} days`} />
      <Hero d={d} />
      <div className="mb-4 grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <ChartCard title={d.months.months.some((r) => r.saved) ? 'Spend and saving per month' : 'Spend per month'}
          note={<>Every session's tokens at list rates, by the month it started, split by model. This month is projected from its days so far.{d.months.months.some((r) => r.saved) && <> Hatched: what optimize mode saved.</>}</>}>
          <MonthChart m={d.months} />
        </ChartCard>
        <TriageCard t={d.triage} />
      </div>
      <div className="mb-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <ErrorsCard e={d.errors} days={d.days} />
        <ChartCard title="Where the money went" note={`Last ${d.days} days, by project and by model.`}>
          <div className="grid gap-5 sm:grid-cols-2">
            <Shares rows={d.byProject} total={k.spend} />
            <Shares rows={d.byModel.map((r) => ({ ...r, key: r.key.replace(/^claude-/, '') }))} total={k.spend} />
          </div>
        </ChartCard>
      </div>
      <Leaders l={d.leaders} days={d.days} />
      <Opportunities items={d.opportunities} />
      <Proven runs={d.runs} />
      <div className="grid gap-4 md:grid-cols-2">
        <StartHere />
        <LocalModels local={d.local} />
      </div>
      <p className="mt-3 font-mono text-[11px] text-muted-foreground">
        Spend is <b>priced</b>: transcript tokens at list rates, not your invoice. Triage savings are Jev's classes priced per session: <b>potential</b> if every unlocked method works, <b>expected</b> weighted by each method's score. Errors are read from the transcripts. A <b>priced</b> saving is a ceiling; a <b>guess</b> has a stated basis and nothing measured; <b>measured</b> comes from opt claude -p --compare with every claim audited. Levers overlap: never add their savings.
      </p>
    </>
  )
}

const FAMILY: [string, string][] = [['opus', 'var(--primary)'], ['sonnet', 'var(--violet)'], ['fable', 'var(--gold)'], ['haiku', 'var(--warn)'], ['other', 'var(--muted-foreground)']]
const monthName = (m: string, long = false) => new Date(m + '-15').toLocaleDateString(undefined, { month: long ? 'long' : 'short', ...(long ? {} : { year: '2-digit' }) })
const dur = (ms: number | null | undefined) => (ms == null ? '—' : ms < 60e3 ? Math.round(ms / 1000) + 's' : ms < 3600e3 ? Math.round(ms / 60e3) + 'm' : (ms / 3600e3).toFixed(1) + 'h')

/** four headline numbers, each with what it is measured against */
function Hero({ d }: { d: OverviewPayload }) {
  const m = d.months, t = d.triage, e = d.errors, l = d.leaders
  const prev = m.previous?.cost ?? null, proj = m.current.projected ?? null
  const errTotal = e.api + e.shownTotal + e.tool
  const tile = (label: string, big: ReactNode, sub: ReactNode, accent: string, onClick?: () => void) => (
    <button onClick={onClick} disabled={!onClick} className={cn('relative overflow-hidden rounded-xl border bg-card px-5 py-4 text-left transition-colors', onClick && 'hover:border-primary/60')}>
      <span className="absolute inset-x-0 top-0 h-1" style={{ background: accent }} />
      <div className="eyebrow">{label}</div>
      <div className="mt-1 font-heading text-[30px] leading-tight font-extrabold tracking-tight">{big}</div>
      <div className="mt-1 text-[12.5px] leading-snug text-muted-foreground">{sub}</div>
    </button>
  )
  const go = useHub.getState().go
  return (
    <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {tile(`spend · ${monthName(m.current.month, true)} so far`, usd(m.current.cost),
        <>{proj != null && <>on pace for <b className="text-foreground">{usd(proj)}</b></>}{prev != null && <> · {monthName(m.previous!.month, true)} {usd(prev)}{proj != null && <span className={cn('ml-1', proj > prev ? 'text-bad' : 'text-ok')}>{proj > prev ? '▲' : '▼'} {Math.abs(100 * (proj - prev) / prev).toFixed(0)}%</span>}</>}</>,
        'var(--primary)')}
      {tile('potential saving · triage', t ? <span className="text-primary">{usd(t.expected)}</span> : '—',
        t ? <>expected, of <b className="text-foreground">{usd(t.cost)}</b> triaged ({pct(t.expected / t.cost)}) · up to {usd(t.best)} if every method works</> : 'no Triage pass yet',
        'var(--ok)', () => go('triage'))}
      {tile(`Claude Code errors · ${d.days} days`, <span className={cn(errTotal && 'text-bad')}>{errTotal.toLocaleString('en')}</span>,
        <>{e.api} API retries · <b className="text-foreground">{e.shownTotal} shown to you</b> · {e.tool} tool errors ({pct(e.toolErrorRate)} of calls)</>, 'var(--bad)')}
      {tile(`top 5% of sessions · ${d.days} days`, <>{pct(l.costShare)}<span className="text-base font-bold text-muted-foreground"> of spend</span></>,
        <>{l.topCount} sessions at or above the p95 cost of <b className="text-foreground">{usd(l.costP95)}</b></>, 'var(--gold)')}
    </div>
  )
}

function MonthChart({ m }: { m: OverviewPayload['months'] }) {
  const W = 640, H = 210, padL = 46, padB = 26, padT = 18
  const rows = m.months
  const max = Math.max(...rows.map((r) => Math.max(r.cost, r.projected ?? 0)), 1)
  // each month gets an equal slot across the width; the bar is a share of it, so 3 months fill the chart like 12
  const slot = (W - padL - 10) / Math.max(rows.length, 1), bw = Math.min(110, slot * 0.62) + 14
  const money0 = (v: number) => (v < 1 ? '$0' : usd(v))
  const y = (v: number) => H - padB - (v / max) * (H - padT - padB)
  const fams = FAMILY.filter(([f]) => rows.some((r) => r.byFamily[f]))
  // what optimize mode saved: a green bar beside the spend, the last two months picked out
  const savedRows = rows.filter((r) => r.saved)
  const sw = savedRows.length ? Math.min(30, (bw - 14) * 0.4) : 0
  const recent = new Set(rows.slice(-2).map((r) => r.month))
  return (
    <>
      {savedRows.length > 0 && <SavedStrip m={m} />}
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full">
        {/* saved is hatched: the theme's ok and primary are the same teal as the Opus bars */}
        <defs>
          <pattern id="saved-hatch" width={5} height={5} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width={5} height={5} fill="var(--ok)" opacity={0.18} /><line x1={0} y1={0} x2={0} y2={5} stroke="var(--ok)" strokeWidth={2.4} />
          </pattern>
        </defs>
        {rows.map((r, i) => r.saved && recent.has(r.month) && (
          <rect key={'bg' + r.month} x={padL + 8 + i * slot + 2} y={padT - 12} width={slot - 4} height={H - padB - padT + 12} fill="var(--ok)" opacity={0.07} rx={4} />
        ))}
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={padL} x2={W - 6} y1={y(max * f)} y2={y(max * f)} stroke="var(--border)" />
            <text x={padL - 6} y={y(max * f) + 3} textAnchor="end" fontSize={10} fill="var(--muted-foreground)" fontFamily={MONO}>{money0(max * f)}</text>
          </g>
        ))}
        {rows.map((r, i) => {
          const x = padL + 8 + i * slot + (slot - bw - (sw ? sw + 4 : 0)) / 2
          let acc = 0
          const cur = r.month === m.current.month
          const sx = x + bw - 14 + 4
          return (
            <g key={r.month}>
              {r.saved && (
                <g>
                  <rect x={sx} y={y(r.saved.total)} width={sw} height={Math.max(y(0) - y(r.saved.total), 1)} fill="url(#saved-hatch)" stroke="var(--ok)" strokeWidth={1.2} rx={2}>
                    <title>{monthName(r.month)} · saved {usd(r.saved.total)}: {r.saved.sessions} sessions in optimize mode, priced at their project's audited saving{r.saved.measured > 0 ? `; ${usd(r.saved.measured)} measured in comparisons` : ''}</title>
                  </rect>
                  <text x={sx + sw / 2} y={y(r.saved.total) - 5} textAnchor="middle" fontSize={recent.has(r.month) ? 11 : 9.5} fontWeight={700} fill="var(--ok)" fontFamily={MONO}>{usd(r.saved.total)}</text>
                </g>
              )}
              {cur && r.projected != null && r.projected > r.cost && (
                <rect x={x} y={y(r.projected)} width={bw - 14} height={y(r.cost) - y(r.projected)} fill="none" stroke="var(--primary)" strokeDasharray="4 3" rx={2}>
                  <title>projected {usd(r.projected)}</title>
                </rect>
              )}
              {fams.map(([f, c]) => {
                const v = r.byFamily[f] ?? 0
                if (!v) return null
                const y0 = y(acc + v), h = y(acc) - y0
                acc += v
                return <rect key={f} x={x} y={y0} width={bw - 14} height={Math.max(h, 0.5)} fill={c} opacity={cur ? 1 : 0.85}><title>{monthName(r.month)} · {f} {usd(v)}</title></rect>
              })}
              <text x={x + (bw - 14) / 2} y={y(Math.max(r.cost, cur ? r.projected ?? 0 : 0)) - 5} textAnchor="middle" fontSize={11} fontWeight={700} fill="var(--foreground)" fontFamily={MONO}>{usd(r.cost)}</text>
              <text x={x + (bw - 14) / 2} y={H - 8} textAnchor="middle" fontSize={10.5} fill={cur ? 'var(--foreground)' : 'var(--muted-foreground)'} fontFamily={MONO}>{monthName(r.month)}{cur ? ' ·' : ''}</text>
            </g>
          )
        })}
      </svg>
      <Legend items={[...fams.map(([f, c]) => ({ color: c, label: f })), ...(sw ? [{ color: 'repeating-linear-gradient(135deg, var(--ok) 0 2px, transparent 2px 4px)', label: 'saved by optimize mode' }] : []), { color: 'transparent', label: <span className="border border-dashed border-primary px-1">projected</span> }]} />
      <div className="mt-2 font-mono text-[11px] text-muted-foreground">{usd(m.total)} over {rows.length} months · {monthName(m.current.month, true)}: day {Math.floor(m.daysElapsed) + 1} of {m.daysInMonth}</div>
    </>
  )
}

/** The last two months' saving, in words: how much, from how many sessions, and how it was priced. */
function SavedStrip({ m }: { m: OverviewPayload['months'] }) {
  const last2 = m.months.slice(-2).filter((r) => r.saved)
  if (!last2.length) return null
  const total = last2.reduce((a, r) => a + r.saved!.total, 0)
  const spent = last2.reduce((a, r) => a + r.cost, 0)
  const sessions = last2.reduce((a, r) => a + r.saved!.sessions, 0)
  const measured = last2.reduce((a, r) => a + r.saved!.measured, 0)
  const cur = m.months.find((r) => r.month === m.current.month)
  const pace = cur?.saved && m.daysElapsed >= 1 ? (cur.saved.total / m.daysElapsed) * m.daysInMonth : null
  const s = m.saving
  return (
    <div className="mb-3 flex flex-wrap items-end gap-x-6 gap-y-2 rounded-md border border-ok/30 bg-ok/5 px-3 py-2.5">
      <div>
        <div className="font-heading text-2xl font-extrabold text-ok">{usd(total)}</div>
        <div className="eyebrow">saved · {last2.map((r) => monthName(r.month, true)).join(' + ')}</div>
      </div>
      <div className="font-mono text-[11.5px]">
        <b>{pct(total / (spent + total))}</b> <span className="text-muted-foreground">of what it would have cost</span>
        {pace != null && <><br /><span className="text-muted-foreground">{monthName(m.current.month, true)} on pace for</span> <b className="text-ok">{usd(pace)}</b></>}
      </div>
      <div className="min-w-[220px] flex-1 font-mono text-[10.5px] leading-snug text-muted-foreground">
        {sessions === 0 ? <>Measured in opt claude -p comparisons kept with every claim verified: plain minus optimized, per repeat. Sessions run in optimize mode add their estimated saving here.</> : <>
        {sessions} sessions in optimize mode, each priced at its project's saving in audited comparisons
        {s ? ` (${s.comparisons} kept, every claim verified; projects with a dropped comparison count $0)` : ''}.
        {measured > 0 && <> {usd(measured)} of it measured directly.</>} An estimate, not a bill.</>}
      </div>
    </div>
  )
}

function TriageCard({ t }: { t: OverviewPayload['triage'] }) {
  const go = useHub((h) => h.go)
  if (!t) return (
    <ChartCard title="Potential saving · Triage" note="Jev's classes, each method priced on each session.">
      <div className="font-mono text-xs text-muted-foreground">No Triage pass yet: Triage → score.</div>
    </ChartCard>
  )
  const max = Math.max(...t.methods.map((m) => m.saving), 1)
  return (
    <ChartCard title="Potential saving · Triage"
      note={<>{t.sessions} sessions classified by {t.classifier ?? 'Jev'}, {new Date(t.generatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}. Each method priced on each session it unlocks.</>}>
      <div className="mb-3 grid grid-cols-3 gap-2">
        <div><div className="font-heading text-2xl font-extrabold text-primary">{usd(t.expected)}</div><div className="eyebrow">expected · {pct(t.expected / t.cost)}</div></div>
        <div><div className="font-heading text-2xl font-extrabold">{usd(t.best)}</div><div className="eyebrow">potential · {pct(t.best / t.cost)}</div></div>
        <div><div className="font-heading text-2xl font-extrabold text-muted-foreground">{usd(t.cost)}</div><div className="eyebrow">triaged spend</div></div>
      </div>
      <div className="space-y-2">
        {t.methods.map((m) => (
          <div key={m.id} className="font-mono text-[11.5px]">
            <div className="flex justify-between gap-2"><span className="truncate" title={m.knob}>{m.title} <span className="text-muted-foreground">· {m.sessions} sessions · {m.label}</span></span><span><b className="text-primary">{usd(m.expected)}</b> <span className="text-muted-foreground">/ {usd(m.saving)}</span></span></div>
            <div className="relative mt-1 h-2 bg-border">
              <i className="absolute inset-y-0 left-0 bg-primary/35" style={{ width: (100 * m.saving / max) + '%' }} />
              <i className="absolute inset-y-0 left-0 bg-primary" style={{ width: (100 * m.expected / max) + '%' }} />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] text-muted-foreground">
        <span><b className="text-primary">■</b> expected <b className="text-primary/40">■</b> potential · methods overlap per session, so they do not add up</span>
        <Button variant="link" size="sm" className="h-auto px-0 font-mono text-[11px]" onClick={() => go('triage')}>open Triage <ArrowRight /></Button>
      </div>
    </ChartCard>
  )
}

function ErrorsCard({ e, days }: { e: OverviewPayload['errors']; days: number }) {
  const openAnalytics = useHub((h) => h.openAnalytics), known = useHub((h) => h.data?.sessions)
  const kinds = (r: Record<string, number>) => Object.entries(r).sort((a, b) => b[1] - a[1])
  const maxTool = Math.max(...e.topTools.map((x) => x.n), 1)
  return (
    <ChartCard title="Claude Code errors" note={`Last ${days} days, from the transcripts of ${e.sessions} sessions; ${e.withErrors} had at least one.`}>
      <div className="mb-3 grid grid-cols-4 gap-2">
        {([['API retries', e.api, ''], ['shown to you', e.shownTotal, 'text-bad'], ['tool errors', e.tool, ''], ['interrupts', e.interrupts, '']] as const).map(([l, v, c]) => (
          <div key={l}><div className={cn('font-heading text-2xl font-extrabold', v ? c : 'text-muted-foreground')}>{v}</div><div className="eyebrow">{l}</div></div>
        ))}
      </div>
      <div className="grid gap-4 font-mono text-[11.5px] sm:grid-cols-2">
        <div>
          <div className="eyebrow mb-1">API errors, by kind</div>
          {kinds(e.apiErrors).map(([k, n]) => <div key={k} className="flex justify-between"><span>{k}</span><span>{n}{e.shown[k] ? <span className="text-bad"> · {e.shown[k]} shown</span> : ''}</span></div>)}
          {kinds(e.shown).filter(([k]) => !e.apiErrors[k]).map(([k, n]) => <div key={k} className="flex justify-between"><span>{k}</span><span className="text-bad">{n} shown</span></div>)}
          {!e.api && !e.shownTotal && <div className="text-muted-foreground">none</div>}
        </div>
        <div>
          <div className="eyebrow mb-1">failing tools · {pct(e.toolErrorRate)} of {e.toolCalls.toLocaleString('en')} calls</div>
          {e.topTools.map((t) => (
            <div key={t.name} className="mb-0.5 grid grid-cols-[minmax(0,1fr)_34px] items-center gap-2">
              <div><div className="truncate" title={t.name}>{t.name.replace(/^mcp__/, '')}</div><div className="h-1 bg-border"><i className="block h-full bg-bad/70" style={{ width: (100 * t.n / maxTool) + '%' }} /></div></div>
              <span className="text-right">{t.n}</span>
            </div>
          ))}
        </div>
      </div>
      {e.worst.length > 0 && (
        <div className="mt-3 border-t pt-2 font-mono text-[11.5px]">
          <div className="eyebrow mb-1">most errors</div>
          {e.worst.slice(0, 4).map((w) => {
            const has = known?.some((s) => s.id === w.sid)
            return (
              <div key={w.sid} className={cn('flex justify-between gap-2 rounded-sm px-1', has && 'cursor-pointer hover:bg-rail')} onClick={() => has && openAnalytics(w.sid)}>
                <span className="truncate">{w.intent || w.sid.slice(0, 8)} <span className="text-muted-foreground">{w.project}</span></span>
                <span className="shrink-0">{w.api ? `${w.api} api · ` : ''}{w.shown ? <span className="text-bad">{w.shown} shown · </span> : ''}{w.tool} tool</span>
              </div>
            )
          })}
        </div>
      )}
    </ChartCard>
  )
}

/** the sessions at the 95th percentile: what they cost, and how long Claude took to answer their prompts */
function Leaders({ l, days }: { l: OverviewPayload['leaders']; days: number }) {
  const openAnalytics = useHub((h) => h.openAnalytics)
  const table = (rows: OverviewPayload['leaders']['byCost'], latency: boolean) => (
    <Table className="font-mono text-xs">
      <TableHeader><TableRow>
        <Head>session</Head><Head className="text-right">cost</Head><Head className="text-right">turn p95</Head><Head className="text-right">length</Head><Head className="text-right">turns</Head>
      </TableRow></TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.id} className="cursor-pointer" onClick={() => openAnalytics(r.id)}>
            <TableCell className="max-w-[260px]">
              <div className="truncate" title={r.intent}>{r.intent || r.id.slice(0, 8)}</div>
              <div className="text-[10.5px] text-muted-foreground">{r.project} · {(r.startedAt || '').slice(5, 10)} · {r.model.replace(/^claude-/, '')}</div>
            </TableCell>
            <TableCell className={cn('num', !latency && 'font-bold')}>{usd(r.cost)}</TableCell>
            <TableCell className={cn('num', latency && 'font-bold', latency && (r as { aboveP95?: boolean }).aboveP95 && 'text-bad')}>{dur(r.turnP95)}</TableCell>
            <TableCell className="num">{r.durationMin >= 60 ? (r.durationMin / 60).toFixed(1) + 'h' : Math.round(r.durationMin) + 'm'}</TableCell>
            <TableCell className="num">{r.turns}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
  return (
    <div className="mb-4 grid gap-4 xl:grid-cols-2">
      <ChartCard title="Leading sessions · cost p95" note={<>The {l.topCount} sessions at or above <b>{usd(l.costP95)}</b>, the 95th percentile of the last {days} days: <b>{pct(l.costShare)}</b> of all spend. Click one for its analytics.</>}>
        {table(l.byCost, false)}
      </ChartCard>
      <ChartCard title="Leading sessions · latency p95" note={<>Each session's 95th-percentile time to answer one prompt (Claude Code's turn timing; {l.sessionsWithTiming} sessions, {l.turnsTimed} turns). All turns: median {dur(l.turnMedian)}, p95 {dur(l.turnP95All)}. Red: at or above the sessions' p95.</>}>
        {l.byLatency.length ? table(l.byLatency, true) : <div className="font-mono text-xs text-muted-foreground">No turn timing in these transcripts yet.</div>}
      </ChartCard>
    </div>
  )
}

const KIND: Record<Opportunity['kind'], { tone: string; label: string }> = {
  measured: { tone: 'improved', label: 'measured' }, priced: { tone: 'code', label: 'priced' }, guess: { tone: 'flat', label: 'guess' },
}

function Opportunities({ items }: { items: Opportunity[] }) {
  const go = useHub((h) => h.go)
  if (!items.length) return null
  const max = Math.max(...items.map((o) => o.usdHi ?? 0), 1)
  return (
    <ChartCard className="mb-4" title="Optimization opportunities"
      note="Ranked by the saving's worst case over your last 30 days. Each one on its own: they overlap, so never add them up.">
      <div className="divide-y">
        {items.map((o) => (
          <div key={o.id} className="grid gap-x-4 gap-y-1 py-2.5 md:grid-cols-[minmax(0,1fr)_220px]">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-heading text-[14.5px] font-bold">{o.title}</span>
                <Pill tone={KIND[o.kind].tone}>{KIND[o.kind].label}</Pill>
                {o.sessions > 0 && <span className="font-mono text-[11px] text-muted-foreground">{o.source === 'claude-p' ? `n = ${o.sessions} a side` : o.source === 'behaviour' ? `${o.sessions} turns` : `${o.sessions} sessions`}</span>}
              </div>
              {o.why && <div className="mt-0.5 text-[12.5px] leading-snug text-muted-foreground">{o.why}</div>}
              <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[11px]">
                <code className="rounded bg-rail px-1.5 py-0.5 text-primary">{o.how}</code>
                {o.risk && <span className="text-muted-foreground">risk: {o.risk}</span>}
              </div>
            </div>
            <div className="self-center">
              {o.usdHi != null ? (
                <>
                  <div className="font-heading text-lg font-extrabold">{usd(o.usdLo)}<span className="text-sm text-muted-foreground"> – {usd(o.usdHi)}</span></div>
                  <div className="relative mt-1 h-2 bg-border">
                    <i className="absolute inset-y-0 left-0 bg-primary/40" style={{ width: (100 * (o.usdHi ?? 0) / max) + '%' }} />
                    <i className="absolute inset-y-0 left-0 bg-primary" style={{ width: (100 * (o.usdLo ?? 0) / max) + '%' }} />
                  </div>
                  <div className="eyebrow mt-1">worst – best case, 30 days</div>
                </>
              ) : o.pct != null ? (
                <>
                  <div className="font-heading text-lg font-extrabold text-ok">{Math.abs(o.pct).toFixed(0)}% cheaper</div>
                  <div className="eyebrow">same input, plain vs optimized</div>
                </>
              ) : null}
              {o.source === 'behaviour' && <Button variant="link" size="sm" className="h-auto px-0 font-mono text-[11px]" onClick={() => { go('analytics'); useHub.setState({ asub: 'beh' }) }}>open Behaviour <ArrowRight /></Button>}
            </div>
          </div>
        ))}
      </div>
    </ChartCard>
  )
}

function Shares({ rows, total }: { rows: { key: string; cost: number; sessions: number }[]; total: number }) {
  return (
    <div className="space-y-1.5 font-mono text-[11.5px]">
      {rows.map((r) => (
        <div key={r.key} className="grid grid-cols-[minmax(0,1fr)_64px] items-center gap-2">
          <div className="min-w-0">
            <div className="flex justify-between gap-2"><span className="truncate" title={r.key}>{r.key}</span><span className="text-muted-foreground">{r.sessions}</span></div>
            <div className="mt-0.5 h-1.5 bg-border"><i className="block h-full bg-primary" style={{ width: (100 * r.cost / Math.max(total, 1e-9)) + '%' }} /></div>
          </div>
          <span className="text-right">{usd(r.cost)}</span>
        </div>
      ))}
    </div>
  )
}

/** opt claude -p --compare runs, each re-audited: a verdict is only shown with the claims behind it */
function Proven({ runs }: { runs: ClaudeRun[] }) {
  return (
    <ChartCard className="mb-4" title="Measured on this machine"
      note={<>The same input through plain <code>claude -p</code> and through optimize mode, then every claim checked against the evidence the run left. A run whose audit fails any claim is not counted as proof.</>}>
      {!runs.length ? (
        <div className="font-mono text-xs text-muted-foreground">Nothing measured yet. <code className="text-primary">opt claude example</code> runs the repo's example both ways in about a minute, then audits it.</div>
      ) : (
        <Table className="font-mono text-xs">
          <TableHeader><TableRow>
            <Head>run</Head><Head>project · rung</Head><Head className="text-right">plain</Head><Head className="text-right">optimized</Head><Head>verdict</Head><Head>check</Head><Head>claims audit</Head>
          </TableRow></TableHeader>
          <TableBody>
            {runs.map((r) => {
              const v = r.verdict?.verdict, trusted = !!r.claims && r.claims.failed === 0
              return (
                <TableRow key={r.run}>
                  <TableCell>{r.run.slice(3, 16)}<div className="text-[10.5px] text-muted-foreground">n = {r.repeats} a side</div></TableCell>
                  <TableCell>{r.project.split('/').slice(-2).join('/')}<div className="text-[10.5px] text-muted-foreground">{r.level}</div></TableCell>
                  <TableCell className="num">{usd(r.plainCost)}</TableCell>
                  <TableCell className="num">{usd(r.optCost)}</TableCell>
                  <TableCell className="max-w-[260px] whitespace-normal">
                    <span className={cn(v === 'keep' ? 'text-ok' : v === 'drop' ? 'text-bad' : 'text-warn')}>{v === 'keep' ? 'optimized wins' : v === 'drop' ? 'plain wins' : v}</span>
                    <div className="text-[10.5px] text-muted-foreground">{r.verdict?.reason}</div>
                  </TableCell>
                  <TableCell>{r.check ? `${r.plainPass} · ${r.optPass}` : '—'}</TableCell>
                  <TableCell className="whitespace-normal">
                    {r.claims && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className={cn('cursor-help', trusted ? 'text-ok' : 'text-bad')}>{r.claims.verified} ✓ · {r.claims.failed} ✗{trusted ? '' : ' — not proof'}</span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-sm">
                          {r.failed.length ? r.failed.map((f) => <div key={f.id} className="mb-1"><b>✗ {f.claim}</b>{f.detail && <div>{f.detail}</div>}</div>) : 'every claim verified against the run’s own evidence'}
                          <div className="mt-1 opacity-70">opt claude audit {r.run}</div>
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
    </ChartCard>
  )
}

function StartHere() {
  const rows: [string, string][] = [
    ['opt claude example', 'the repo’s example, plain and optimized, audited: about a minute'],
    ['opt claude -p "…" --compare', 'your own task, both ways, with a hidden --check if you have one'],
    ['opt claude profile', 'the profile rung this project is on, and why'],
    ['opt monitor on', 'Claude Code telemetry into Analytics → Behaviour'],
  ]
  return (
    <ChartCard title={<span className="flex items-center gap-2"><Terminal className="size-4" />Start here</span>} note="Four commands from nothing to a measured, audited result.">
      <div className="space-y-1.5 font-mono text-[11.5px]">
        {rows.map(([c, w]) => <div key={c} className="grid gap-x-3 sm:grid-cols-[230px_1fr]"><code className="text-primary">{c}</code><span className="text-muted-foreground">{w}</span></div>)}
      </div>
    </ChartCard>
  )
}

function LocalModels({ local }: { local: OverviewPayload['local'] }) {
  const go = useHub((h) => h.go)
  return (
    <ChartCard title={<span className="flex items-center gap-2"><Cpu className="size-4" />Local models</span>}
      note="What the gateway can send side calls to, free per token.">
      <div className="font-mono text-xs">
        {local.up ? <>Ollama is up with <b>{local.models}</b> models; the gateway's local target is <b className="text-primary">{local.routerModel}</b>.</> : <span className="text-warn">Ollama is not running: <code>ollama serve</code>.</span>}
        <div className="mt-2"><Button variant="outline" size="sm" className="font-mono text-xs" onClick={() => go('optimization', 'models')}><FlaskConical />Optimize → Models</Button></div>
      </div>
    </ChartCard>
  )
}
