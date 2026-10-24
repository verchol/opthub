/**
 * Analytics → Behaviour: how Claude Code sessions run, turn by turn — Claude working, the person
 * idle between turns, cache re-writes after idle, interrupts, permission waits. Read from the
 * LangSmith tracing plugin's traces and from Claude Code's own OTEL telemetry (opt monitor on).
 */
import { Fragment, useEffect } from 'react'
import { create } from 'zustand'
import { RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ChartIcon, Empty, Head, MiniButton, SortHead, Stats } from '@/components/hub'
import { Legend } from '@/components/charts'
import { getJSON, q, type BehaviourPayload, type BehSession } from '@/lib/api'
import { modelOf, pct, usd } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useHub } from '@/store'
import { ChartCard, Filters, Pick } from './controls'

const MONO = 'var(--font-mono)'
const AWAY_MS = 30 * 60e3

/** 850 ms → "0.9s", 95 s → "1m35s", 3 h → "3.0h" */
export function dur(ms: number | null | undefined) {
  if (ms == null) return '—'
  const s = ms / 1000
  if (s < 10) return s.toFixed(1) + 's'
  if (s < 90) return Math.round(s) + 's'
  if (s < 3600) return Math.floor(s / 60) + 'm' + String(Math.round(s % 60)).padStart(2, '0') + 's'
  return (s / 3600).toFixed(1) + 'h'
}
const since = (ms: number | null | undefined) => (ms ? dur(Date.now() - ms) + ' ago' : 'never')

interface BehState {
  days: number; project: string; data: BehaviourPayload | null; loading: boolean; error: string | null
  open: string | null; sort: string; dir: number
  set: (p: Partial<BehState>) => void
  load: () => Promise<void>
}
export const useBehaviour = create<BehState>()((set, get) => ({
  days: 7, project: '', data: null, loading: false, error: null, open: null, sort: 'start', dir: -1,
  set: (p) => set(p),
  load: async () => {
    const { days, project } = get()
    set({ loading: true })
    try { set({ data: await getJSON<BehaviourPayload>('/api/behaviour?' + q({ days, project })), error: null }) }
    catch (e) { set({ error: String((e as Error)?.message ?? e) }) }
    finally { set({ loading: false }) }
  },
}))

export function BehaviourView() {
  const b = useBehaviour(), d = b.data
  useEffect(() => {
    void useBehaviour.getState().load()
    // the server caches a minute, so this never reaches LangSmith more often than that
    const t = setInterval(() => void useBehaviour.getState().load(), 60e3)
    return () => clearInterval(t)
  }, [b.days, b.project])

  return (
    <>
      <Filters>
        <Pick value={String(b.days)} onChange={(v) => b.set({ days: Number(v), open: null })}
          options={[['1', 'last 24 hours'], ['7', 'last 7 days'], ['30', 'last 30 days'], ['90', 'last 90 days']]} />
        <Pick value={b.project} onChange={(v) => b.set({ project: v, open: null })}
          options={[['', 'every project'], ...(d?.projects ?? []).map((p) => [p, p] as [string, string])]} />
        <Button variant="ghost" size="icon-sm" title="refresh" onClick={() => void b.load()} disabled={b.loading}>
          <RefreshCw className={cn(b.loading && 'animate-spin')} />
        </Button>
        {d && <Sources d={d} />}
      </Filters>
      {b.error && <Empty title={'could not load: ' + b.error} />}
      {!d ? (!b.error && <Empty title="reading traces…" />) : !d.sessions.length ? <NoData d={d} /> : <Body d={d} />}
    </>
  )
}

function Sources({ d }: { d: BehaviourPayload }) {
  const l = d.sources.langsmith, o = d.sources.otel
  return (
    <div className="ml-auto flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className={cn('font-mono', l.ok ? 'text-ok' : 'text-muted-foreground')}>
            LangSmith · {l.ok ? `${l.runs} runs${l.truncated ? ' (cut)' : ''}` : 'off'}
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          {l.ok ? <>project <b>{l.project}</b> at {l.endpoint}; last trace {since(l.last)}</> : l.error ?? 'not configured'}
          {!l.tracing && <><br />the tracing plugin is off (TRACE_TO_LANGSMITH)</>}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className={cn('font-mono', o.records ? 'text-ok' : 'text-muted-foreground')}>
            OTEL · {o.records ? `${o.spans} spans` : 'none'}
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          {o.records ? <>{o.records} records from Claude Code, last {since(o.last)}</> : <>nothing received yet: run <b>opt monitor on</b>, then start a new Claude Code session</>}
        </TooltipContent>
      </Tooltip>
      <span>read {since(d.at)}</span>
    </div>
  )
}

function NoData({ d }: { d: BehaviourPayload }) {
  return (
    <Empty title={`no Claude Code turns in the last ${d.days === 1 ? '24 hours' : d.days + ' days'}`}>
      Behaviour reads the LangSmith tracing plugin's traces ({d.sources.langsmith.ok ? 'connected' : d.sources.langsmith.error ?? 'not connected'})
      and Claude Code's own telemetry: <b>opt monitor on</b>, then start a new session. <b>opt monitor status</b> shows both.
    </Empty>
  )
}

function Body({ d }: { d: BehaviourPayload }) {
  const k = d.kpi
  const errRate = k.toolCalls ? k.toolErrors / k.toolCalls : 0
  return (
    <>
      <Stats items={[
        ['sessions · turns', <>{k.sessions} <span className="text-muted-foreground">·</span> {k.turns}</>],
        ['Claude working', dur(k.busy)],
        ['you idle in-session', <>{dur(k.idle)} <span className="text-sm text-muted-foreground">{pct(k.idleShare)}</span></>],
        ['median reply gap', dur(k.medGap)],
        ['turn p50 · p90', <>{dur(k.p50Turn)} <span className="text-muted-foreground">·</span> {dur(k.p90Turn)}</>],
        ['cost (priced)', usd(k.cost)],
      ]} />
      <Stats items={[
        ['cold cache restarts', <span className={cn(k.cold && 'text-warn')}>{k.cold} <span className="text-sm text-muted-foreground">{usd(k.coldCost)}</span></span>],
        ['interrupts (Esc)', <span className={cn(k.interrupts && 'text-bad')}>{k.interrupts}</span>],
        ['waiting on you', <>{dur(k.waitMs)} <span className="text-sm text-muted-foreground">×{k.waits}</span></>],
        ['tool errors', <span className={cn(errRate > 0.05 && 'text-bad')}>{pct(errRate)} <span className="text-sm text-muted-foreground">of {k.toolCalls}</span></span>],
        ['cache hit', pct(k.cacheHit)],
        k.ttftP50 != null ? ['first token p50', dur(k.ttftP50)] : ['subagents', k.subagents],
      ]} />
      <div className="mb-4 grid gap-4 xl:grid-cols-2">
        <ChartCard title="Where the time goes"
          note={<>Claude's turns split into model calls, tool calls and the time between them (not covered by either trace), beside the time you spent between turns. Gaps over 30 minutes are breaks ({k.breaks}, {dur(k.away)}) and are left out.</>}>
          <TimeSplit d={d} />
        </ChartCard>
        <ChartCard title="Gaps between turns"
          note={<>How long each next prompt took. Claude's prompt cache lives 5 minutes, so a turn after a longer gap often re-writes the whole context: <span className="text-warn">orange</span> turns did.</>}>
          <GapChart d={d} />
        </ChartCard>
      </div>
      <div className="mb-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <ChartCard title="When Claude works" note="Minutes of Claude working, by weekday and hour (your local time).">
          <Heat heat={d.heat} />
        </ChartCard>
        <ChartCard title="Tools" note="Main-thread tool calls. Time includes any wait for your permission; the wait column is the part that was you.">
          <Tools d={d} />
        </ChartCard>
      </div>
      <OtelCard d={d} />
      <Sessions d={d} />
      <p className="mt-2 font-mono text-[11px] text-muted-foreground">
        Cost and cold-restart cost are <b>priced</b>: each model call's tokens at list rates (cache writes 1.25x input, reads 0.1x); a cold restart costs its write minus what a read would have.
        Idle is the time from one turn's end to the next prompt; it is your time, not Claude's.
      </p>
    </>
  )
}

/** one horizontal bar: model · tools · other (Claude) | you idle, plus the legend */
function TimeSplit({ d }: { d: BehaviourPayload }) {
  const k = d.kpi
  const llm = Math.min(k.llmMs, k.busy), tools = Math.min(k.toolMs, k.busy - llm), other = Math.max(0, k.busy - llm - tools)
  const parts = [
    { v: llm, c: 'var(--primary)', l: 'model calls' }, { v: tools, c: 'var(--violet)', l: 'tool calls' },
    { v: other, c: 'var(--gold)', l: 'between calls' }, { v: k.idle, c: 'var(--muted-foreground)', l: 'you, between turns', o: 0.35 },
  ]
  const tot = parts.reduce((a, p) => a + p.v, 0) || 1
  return (
    <>
      <div className="flex h-7 w-full overflow-hidden rounded-sm">
        {parts.map((p) => p.v > 0 && (
          <Tooltip key={p.l}>
            <TooltipTrigger asChild>
              <div style={{ width: (100 * p.v / tot) + '%', background: p.c, opacity: p.o }} className="h-full" />
            </TooltipTrigger>
            <TooltipContent>{p.l}: {dur(p.v)} · {pct(p.v / tot)}</TooltipContent>
          </Tooltip>
        ))}
      </div>
      <Legend items={parts.map((p) => ({ color: p.c, opacity: p.o, label: <>{p.l} <b className="text-foreground">{dur(p.v)}</b></> }))} />
      <div className="mt-3 grid grid-cols-3 gap-2 font-mono text-[11.5px]">
        <div><div className="eyebrow">model calls</div>{k.llmCalls} · {(k.llmCalls / Math.max(1, k.turns)).toFixed(1)} a turn</div>
        <div><div className="eyebrow">tool calls</div>{k.toolCalls} · {(k.toolCalls / Math.max(1, k.turns)).toFixed(1)} a turn</div>
        <div><div className="eyebrow">abandoned · errors</div>{k.abandoned} · {k.errors}</div>
      </div>
    </>
  )
}

/** a bar per gap bucket; the cold share stacked in warn; markers at the cache's life and at the break line */
function GapChart({ d }: { d: BehaviourPayload }) {
  const W = 560, H = 190, padL = 30, padB = 34, padT = 14, n = d.gapHist.length
  const max = Math.max(...d.gapHist.map((g) => g.n), 1), bw = (W - padL - 8) / n
  const y = (v: number) => H - padB - (v / max) * (H - padT - padB)
  const at = (label: string) => padL + d.gapHist.findIndex((g) => g.label === label) * bw
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block w-full">
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={padL} x2={W - 8} y1={y(max * f)} y2={y(max * f)} stroke="var(--border)" />
          <text x={padL - 5} y={y(max * f) + 3} textAnchor="end" fontSize={10} fill="var(--muted-foreground)" fontFamily={MONO}>{Math.round(max * f)}</text>
        </g>
      ))}
      {d.gapHist.map((g, i) => (
        <g key={g.label}>
          <rect x={padL + i * bw + 3} y={y(g.n)} width={bw - 6} height={H - padB - y(g.n)} fill="var(--primary)" opacity={0.55}><title>{g.label}: {g.n} gaps</title></rect>
          {g.cold > 0 && <rect x={padL + i * bw + 3} y={y(g.cold)} width={bw - 6} height={H - padB - y(g.cold)} fill="var(--warn)"><title>{g.cold} cold restarts</title></rect>}
          {g.n > 0 && <text x={padL + i * bw + bw / 2} y={y(g.n) - 3} textAnchor="middle" fontSize={10} fill="var(--foreground)" fontFamily={MONO}>{g.n}</text>}
          <text x={padL + i * bw + bw / 2} y={H - padB + 13} textAnchor="middle" fontSize={9.5} fill="var(--muted-foreground)" fontFamily={MONO}>{g.label}</text>
        </g>
      ))}
      {[['5–15m', 'cache expires'], ['30–60m', 'break']].map(([l, t]) => (
        <g key={l}>
          <line x1={at(l)} x2={at(l)} y1={padT - 4} y2={H - padB} stroke="var(--warn)" strokeDasharray="3 3" />
          <text x={at(l) + 4} y={padT + 4} fontSize={9.5} fill="var(--warn)" fontFamily={MONO}>{t}</text>
        </g>
      ))}
      <text x={W / 2} y={H - 4} textAnchor="middle" fontSize={10} fill="var(--muted-foreground)" fontFamily={MONO}>time from a turn's end to the next prompt</text>
    </svg>
  )
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
function Heat({ heat }: { heat: number[][] }) {
  const max = Math.max(...heat.flat(), 1)
  const W = 520, cw = (W - 34) / 24, ch = 17
  return (
    <svg viewBox={`0 0 ${W} ${7 * ch + 20}`} className="block w-full">
      {heat.map((row, di) => (
        <g key={di}>
          <text x={0} y={di * ch + 12} fontSize={10} fill="var(--muted-foreground)" fontFamily={MONO}>{DAYS[di]}</text>
          {row.map((v, h) => (
            <rect key={h} x={34 + h * cw} y={di * ch} width={cw - 2} height={ch - 2} rx={2}
              fill={v ? 'var(--primary)' : 'var(--border)'} opacity={v ? 0.15 + 0.85 * Math.sqrt(v / max) : 0.5}>
              <title>{DAYS[di]} {String(h).padStart(2, '0')}:00 · {Math.round(v)} min</title>
            </rect>
          ))}
        </g>
      ))}
      {[0, 6, 12, 18, 23].map((h) => <text key={h} x={34 + h * cw + cw / 2} y={7 * ch + 12} textAnchor="middle" fontSize={9.5} fill="var(--muted-foreground)" fontFamily={MONO}>{h}h</text>)}
    </svg>
  )
}

function Tools({ d }: { d: BehaviourPayload }) {
  const rows = d.tools.slice(0, 12), max = Math.max(...rows.map((r) => r.total), 1)
  return (
    <Table className="font-mono text-[11.5px]">
      <TableHeader>
        <TableRow><Head>tool</Head><Head className="text-right">calls</Head><Head className="text-right">err</Head><Head className="text-right">p50</Head><Head className="text-right">p95</Head><Head>total</Head><Head className="text-right">wait</Head></TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.name}>
            <TableCell className="max-w-[180px] truncate" title={r.name}>{r.name.replace(/^mcp__/, '')}</TableCell>
            <TableCell className="num">{r.calls}</TableCell>
            <TableCell className={cn('num', r.errors && 'text-bad')}>{r.errors ? pct(r.errors / r.calls) : '·'}</TableCell>
            <TableCell className="num">{dur(r.p50)}</TableCell>
            <TableCell className="num">{dur(r.p95)}</TableCell>
            <TableCell className="w-[22%]">
              <div className="flex items-center gap-1.5"><span className="h-2 bg-violet" style={{ width: (100 * r.total / max) + '%' }} /><span className="text-muted-foreground">{dur(r.total)}</span></div>
            </TableCell>
            <TableCell className={cn('num', r.wait && 'text-warn')}>{r.wait ? dur(r.wait) : '·'}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

/** what only Claude Code's telemetry knows; a setup hint until it arrives */
function OtelCard({ d }: { d: BehaviourPayload }) {
  const o = d.otel
  if (!o) return (
    <ChartCard className="mb-4" title="Claude Code telemetry" note="Active time, permission decisions, API errors and retries, compactions and lines changed come from Claude Code's own OpenTelemetry.">
      <p className="font-mono text-xs text-muted-foreground">Nothing received yet. Run <b className="text-foreground">opt monitor on</b> and start a new Claude Code session; the hub's collector stores it locally under OPT_HOME/otel. Prompts and tool inputs are not exported.</p>
    </ChartCard>
  )
  const list = (r: Record<string, number>) => Object.entries(r).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'
  const at = o.activeTime, act = (at.user ?? 0) + (at.cli ?? 0)
  return (
    <ChartCard className="mb-4" title="Claude Code telemetry" note={`From Claude Code's own OpenTelemetry: ${o.records} records, last ${since(o.last)}.`}>
      <div className="grid gap-x-6 gap-y-2 font-mono text-[11.5px] md:grid-cols-2">
        <div><div className="eyebrow">active time · you vs Claude</div>{dur((at.user ?? 0) * 1000)} you · {dur((at.cli ?? 0) * 1000)} Claude{act ? ` (${pct((at.cli ?? 0) / act)} Claude)` : ''}</div>
        <div><div className="eyebrow">lines · commits · PRs</div>+{o.lines.added ?? 0} −{o.lines.removed ?? 0} · {o.commits} · {o.prs}</div>
        <div><div className="eyebrow">permission decisions, by source</div>{list(o.decisionSources)}</div>
        <div><div className="eyebrow">edit decisions</div>{list(o.editDecisions)}</div>
        <div><div className="eyebrow">API errors by status · retries exhausted</div><span className={cn(Object.keys(o.apiErrors).length && 'text-bad')}>{list(o.apiErrors)}</span> · {o.retriesExhausted}</div>
        <div><div className="eyebrow">compactions · subagents done · retried calls</div>{o.compactions} · {o.subagentsDone} · {d.kpi.retries}</div>
        <div><div className="eyebrow">skills</div>{list(o.skills)}</div>
        <div><div className="eyebrow">permission mode changes</div>{list(o.modeChanges)}</div>
      </div>
    </ChartCard>
  )
}

/**
 * One session as a strip: each turn a block as wide as it ran, idle gaps as thin rule, breaks over
 * 30 minutes squeezed to a fixed notch so a session that spans a night still fits.
 */
function Strip({ s, height = 14, width = 260 }: { s: BehSession; height?: number; width?: number }) {
  const NOTCH = 8
  const segs: { kind: 'turn' | 'gap' | 'away'; ms: number; row?: BehSession['strip'][number] }[] = []
  s.strip.forEach((r, i) => {
    if (i) { const pe = s.strip[i - 1][1] ?? s.strip[i - 1][0], g = Math.max(0, r[0] - pe); segs.push({ kind: g >= AWAY_MS ? 'away' : 'gap', ms: g }) }
    segs.push({ kind: 'turn', ms: Math.max(1000, (r[1] ?? Date.now()) - r[0]), row: r })
  })
  const notches = segs.filter((x) => x.kind === 'away').length
  const scale = (width - notches * NOTCH) / Math.max(1, segs.filter((x) => x.kind !== 'away').reduce((a, x) => a + x.ms, 0))
  let x = 0
  return (
    <svg width={width} height={height} className="block" aria-label="turns over time">
      <line x1={0} x2={width} y1={height / 2} y2={height / 2} stroke="var(--border)" />
      {segs.map((g, i) => {
        const w = g.kind === 'away' ? NOTCH : Math.max(g.kind === 'turn' ? 2 : 0, g.ms * scale), x0 = x
        x += w
        if (g.kind === 'away') return <text key={i} x={x0 + NOTCH / 2} y={height / 2 + 3} textAnchor="middle" fontSize={9} fill="var(--muted-foreground)">⋯<title>break {dur(g.ms)}</title></text>
        if (g.kind === 'gap') return null
        const r = g.row!, fill = r[6] ? 'var(--bad)' : r[2] ? 'var(--warn)' : 'var(--primary)'
        return <rect key={i} x={x0} y={1} width={w} height={height - 2} rx={1.5} fill={fill} opacity={r[1] == null ? 0.5 : 0.9}>
          <title>{new Date(r[0]).toLocaleTimeString()} · {dur((r[1] ?? Date.now()) - r[0])} · {r[5]} model / {r[4]} tool calls · {usd(r[3])}{r[2] ? ' · cold cache' : ''}{r[6] ? ' · interrupted' : ''}</title>
        </rect>
      })}
    </svg>
  )
}

function Sessions({ d }: { d: BehaviourPayload }) {
  const b = useBehaviour(), data = useHub((h) => h.data)
  const known = Object.fromEntries((data?.sessions ?? []).map((s) => [s.id, s]))
  const key = b.sort as keyof BehSession
  const rows = d.sessions.slice().sort((x, y) => ((x[key] as number) - (y[key] as number)) * b.dir)
  const sort = (k: string) => b.set(b.sort === k ? { dir: -b.dir } : { sort: k, dir: -1 })
  const sh = (k: string, l: string) => <SortHead label={l} k={k} sortKey={b.sort} dir={b.dir} onSort={sort} className="text-right [&>span]:justify-end" />
  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <Table className="font-mono text-xs">
        <TableHeader>
          <TableRow>
            <SortHead label="session" k="start" sortKey={b.sort} dir={b.dir} onSort={sort} />
            <Head>turns over time</Head>
            {sh('turns', 'turns')}{sh('busy', 'Claude')}{sh('idleShare', 'idle')}{sh('medGap', 'reply')}{sh('cold', 'cold')}
            {sh('interrupts', 'esc')}{sh('waitMs', 'wait')}{sh('cost', 'cost')}<Head />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((s) => {
            const h = known[s.sid], open = b.open === s.sid
            return (
              <Fragment key={s.sid}>
                <TableRow onClick={() => b.set({ open: open ? null : s.sid })} className={cn('cursor-pointer', open && 'bg-rail')}>
                  <TableCell className="max-w-[240px]">
                    <div className="truncate" title={h?.intent}>{open ? '▾ ' : '▸ '}{h?.intent || s.sid.slice(0, 8)}</div>
                    <div className="text-[10.5px] text-muted-foreground">
                      {s.project || '—'} · {new Date(s.start).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · {modelOf(s.model)}
                      {s.open && <Badge variant="outline" className="ml-1 h-4 px-1 text-[9px] text-ok">open</Badge>}
                      {s.src === 'otel' && <Badge variant="outline" className="ml-1 h-4 px-1 text-[9px]">otel</Badge>}
                    </div>
                  </TableCell>
                  <TableCell><Strip s={s} /></TableCell>
                  <TableCell className="num">{s.turns}</TableCell>
                  <TableCell className="num">{dur(s.busy)}</TableCell>
                  <TableCell className="num">{pct(s.idleShare)}</TableCell>
                  <TableCell className="num">{dur(s.medGap)}</TableCell>
                  <TableCell className={cn('num', s.cold && 'text-warn')}>{s.cold || '·'}</TableCell>
                  <TableCell className={cn('num', s.interrupts && 'text-bad')}>{s.interrupts || '·'}</TableCell>
                  <TableCell className="num">{s.waitMs ? dur(s.waitMs) : '·'}</TableCell>
                  <TableCell className="num">{usd(s.cost)}</TableCell>
                  <TableCell>{h && <MiniButton title="session analytics" onClick={() => useHub.getState().openAnalytics(s.sid)}><ChartIcon /></MiniButton>}</TableCell>
                </TableRow>
                {open && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={11} className="pt-1 pb-4 pl-6 whitespace-normal">
                      <Strip s={s} height={26} width={900} />
                      <Legend items={[{ color: 'var(--primary)', label: 'turn' }, { color: 'var(--warn)', label: 'cold cache (re-wrote context)' }, { color: 'var(--bad)', label: 'interrupted' }, { color: 'var(--muted-foreground)', label: '⋯ break over 30 min' }]} />
                      <div className="mt-2.5 grid grid-cols-2 gap-x-6 gap-y-1.5 text-[11.5px] md:grid-cols-4">
                        <div><div className="eyebrow">wall · breaks</div>{dur(s.wall)} · {s.breaks} ({dur(s.away)})</div>
                        <div><div className="eyebrow">longest gap</div>{dur(s.longestGap)}</div>
                        <div><div className="eyebrow">cold restarts · after idle · priced</div>{s.cold} · {s.coldAfterIdle} · {usd(s.coldCost)}</div>
                        <div><div className="eyebrow">cache hit</div>{pct(s.cacheHit)}</div>
                        <div><div className="eyebrow">model · tool time</div>{dur(s.llmMs)} · {dur(s.toolMs)}</div>
                        <div><div className="eyebrow">calls a turn · model / tool</div>{(s.llmCalls / s.turns).toFixed(1)} / {(s.toolCalls / s.turns).toFixed(1)}</div>
                        <div><div className="eyebrow">subagents · their calls</div>{s.subagents} · {s.subLlm}</div>
                        <div><div className="eyebrow">tool errors · abandoned</div>{s.toolErrors} · {s.abandoned}</div>
                      </div>
                      <div className="mt-2 text-[10.5px] text-muted-foreground">{s.sid} · from {s.src === 'otel' ? 'Claude Code telemetry' : 'LangSmith'}</div>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
