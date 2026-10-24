/**
 * Triage's vocabulary: tiers, groupings, the values each column sorts by, and the small
 * cells (method chips, model needed, scenario totals) the list and the detail share.
 */
import { DONE_PHASES, type LiveMap, type Run, type RunsPayload, type Session, type TriagePayload, type TriageSession } from '@/lib/api'
import { Pill } from '@/components/hub'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export const TIER: Record<string, [string, string]> = { frontier: ['Opus', '$5/$25'], mid: ['Sonnet', '$2/$10'], small: ['Haiku', '$1/$5'] }
export const TRI_AXES = ['capability', 'delegation', 'context', 'reasoning', 'deferral', 'latency', 'urgency']
export const TRI_SHORT: Record<string, string> = { route: 'model', 'side-calls': 'subagents', context: 'context', effort: 'effort', batch: 'batch', 'fast-mode': 'fast' }
export const TRI_GROUPS: [string, string][] = [['dir', 'working dir'], ['kind', 'type'], ['model', 'model needed'], ['urgency', 'urgency'], ['latency', 'latency'], ['deferral', 'deferral'], ['context', 'context'],
  ['reasoning', 'reasoning'], ['delegation', 'delegation'], ['cc_effort', 'Claude Code effort'], ['cc_perm', 'permission mode'], ['cc_entry', 'entry point'], ['cc_model', 'model used']]

export const triPct = (v: number | null | undefined) => (v == null ? '—' : Math.round(100 * v) + '%')
export const triUsd = (v: number) => (v < 0 ? '−$' : '$') + Math.abs(v).toFixed(2)
export const triTot = (v: number) => '$' + Math.max(0, v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const triCls = (v: number) => (v > 0.005 ? 'text-primary' : v < -0.005 ? 'text-bad' : 'text-muted-foreground')
export const triGroupName = (g: string) => (TRI_GROUPS.find((x) => x[0] === g) || [, g])[1]
export const triCC = (s: TriageSession) => (s.claudeCode || {}) as Record<string, any>
export const triModelName = (s: TriageSession) => { const c = (s.labels || {}).capability; return c && TIER[c] ? TIER[c][0] : 'unclear → re-run' }
/** the working dir from the ledger key (ISO start|cwd, home already written as ~) */
export const triDir = (s: TriageSession) => String(s.key || '').split('|').slice(1).join('|') || s.project

/** Sessions-tab records by id: Triage rows join to them for kind, start, artifacts and tools */
export type SessIndex = Map<string, Session>
export const triSess = (ix: SessIndex, id: string | null | undefined) => (id ? ix.get(id) ?? null : null)

export function triClassOf(ix: SessIndex, s: TriageSession, g: string): string {
  if (g === 'dir') return triDir(s)
  if (g === 'kind') { const h = triSess(ix, s.session); return h ? h.kind : 'unknown' }
  if (g === 'model') return triModelName(s)
  if (g.startsWith('cc_')) {
    const c = triCC(s)
    return String(({ cc_effort: c.effort, cc_perm: c.permission_mode, cc_entry: c.entrypoint, cc_model: c.model } as Record<string, unknown>)[g] || 'not recorded')
  }
  return (s.labels || {})[g] || 'unclear'
}

/** the session's start: the Sessions-tab record when there is one, else the ledger key (ISO start|cwd) */
export const triStart = (ix: SessIndex, s: TriageSession) => triSess(ix, s.session)?.startedAt || String(s.key || '').split('|')[0] + 'Z'
export const triDate = (ix: SessIndex, s: TriageSession) => {
  const d = new Date(triStart(ix, s))
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

export function triVal(ix: SessIndex, s: TriageSession, k: string): string | number {
  const h = triSess(ix, s.session)
  switch (k) {
    case 'project': return s.project
    case 'date': return triStart(ix, s)
    case 'cost': return s.cost
    case 'bestCost': return s.cost - s.best
    case 'worstCost': return s.cost - s.worst
    case 'gap': return s.best
    case 'artifacts': return h ? (h.artifacts || []).length : -1
    case 'model': return triModelName(s)
    case 'expected': return s.expected || 0
    case 'cc': return [triCC(s).effort, triCC(s).permission_mode].join(' ')
    default: return (s.labels || {})[k] || 'unclear'
  }
}

export function sortRows<T>(list: T[], val: (x: T, k: string) => string | number, key: string, dir: number) {
  return list.sort((a, b) => {
    const x = val(a, key), y = val(b, key)
    const c = typeof x === 'number' ? x - (y as number) : String(x).localeCompare(String(y))
    return c * dir
  })
}

/** the latest Sonnet re-run of a session, live status winning over disk */
export function triRun(tri: TriagePayload | null, runs: RunsPayload, live: LiveMap, id: string): (Partial<Run> & { live?: boolean }) | null {
  const exp = tri?.rerunExperiment
  const rs = (runs.runs || []).filter((r) => r.session === id && r.experiment === exp)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0]
  const lv = live[id]
  if (lv && lv.experiment === exp && lv.phase && !DONE_PHASES.includes(lv.phase)) return { phase: lv.phase, live: true }
  return rs || null
}
export const runBusy = (r: { live?: boolean; phase?: string } | null) => !!r && (!!r.live || !DONE_PHASES.includes(r.phase as string))

/** a scenario total, coloured against what was actually spent: green below it, red above it */
export function TriVs({ v, actual }: { v: number; actual: number }) {
  return <span className={v < actual - 0.005 ? 'text-primary' : v > actual + 0.005 ? 'text-bad' : 'text-muted-foreground'}>{triTot(v)}</span>
}

/** a short bar: 0–1, red when it measures spend */
export function TriBar({ v, spend }: { v: number; spend?: boolean }) {
  return (
    <span className="relative mr-1.5 inline-block h-[7px] w-16 bg-border align-middle">
      <i className={cn('absolute inset-y-0 left-0', spend ? 'bg-bad' : 'bg-primary')} style={{ width: Math.round(100 * Math.max(0, Math.min(1, v || 0))) + '%' }} />
    </span>
  )
}

/** one chip per method: its score, bold when Jev's answer unlocked it */
export function TriChips({ s }: { s: TriageSession }) {
  if (!s.methods) return <span className="text-[11.5px] text-muted-foreground">not scored</span>
  return (
    <div className="flex flex-wrap gap-[3px]">
      {(s.methods as any[]).filter((m) => m.score || m.unlocked).map((m) => {
        const spend = m.id === 'fast-mode'
        return (
          <Tooltip key={m.id}>
            <TooltipTrigger asChild>
              <span className={cn('rounded-sm border px-[5px] py-px font-mono text-[10px] whitespace-nowrap text-muted-foreground',
                (m.score || 0) >= 0.5 && 'text-foreground',
                m.unlocked && (spend ? 'border-bad font-bold text-bad' : 'border-primary font-bold text-primary'))}>
                {(TRI_SHORT[m.id] || m.id) + ' ' + triPct(m.score)}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {m.title + ' · score ' + triPct(m.score) + ' · ' + (spend ? 'spend ' : 'saving ') + triUsd(Math.abs(m.saving)) + ' (' + Math.abs(m.pct) + '%)' + (m.unlocked ? ' · unlocked' : '')}
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}

/** the model the work needed, or where its Sonnet re-run stands */
export function TriModel({ s, run }: { s: TriageSession; run: ReturnType<typeof triRun> }) {
  const c = (s.labels || {}).capability
  if (c && c !== 'unclear' && TIER[c]) return <span className="whitespace-nowrap"><Pill tone="improved">{TIER[c][0]}</Pill> <span className="text-[11.5px] text-muted-foreground">{TIER[c][1]}</span></span>
  if (!s.session) return <span className="text-[11.5px] text-muted-foreground">unclear · no session id</span>
  if (!run) return <Pill tone="warn">re-run on Sonnet · queued</Pill>
  if (runBusy(run)) return <Pill tone="warn">re-run on Sonnet · {run.phase}…</Pill>
  return <Pill tone={run.headline?.tone || 'flat'}>re-run: {run.headline?.text || run.phase}</Pill>
}
