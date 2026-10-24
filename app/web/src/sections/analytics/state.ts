/**
 * Analytics → Percentiles · Classes · Similar. All three read the same classification
 * from /api/insights, refreshed whenever a transcript moves, filtered by the same insF.
 */
import { create } from 'zustand'
import type { Attrs, Insights, Session } from '@/lib/api'
import { fmtM, tok, usd } from '@/lib/format'
import { useHub } from '@/store'

export const METRICS: [string, string, (s: Session) => number][] = [
  ['cost', 'cost per session', (s) => s.cost],
  ['perturn', 'cost per turn', (s) => s.cost / Math.max(s.turns, 1)],
  ['perprompt', 'cost per typed prompt', (s) => s.cost / Math.max(s.humanPrompts || 0, 1)],
  ['dur', 'duration (min)', (s) => s.durationMin],
  ['ctx', 'median context', (s) => s.ctxMedian],
]
export const DATES: [string, string][] = [['all', 'all time'], ['7d', 'last 7 days'], ['30d', 'last 30 days'], ['90d', 'last 90 days']]

export interface InsF { dim: string; metric: string; date: string; tier: string; driver: string; q: string; minN: number; sort: string; dir: number }
export interface GrpF { k1: string; k2: string; open: string | null }
export interface SimF { color: string; min: number; proj: string; q: string; focus: string | null; hidden: Record<string, boolean>; labels: boolean }

interface AnalyticsState {
  insF: InsF; grpF: GrpF; simF: SimF
  /** the open row in Percentiles */
  insOpen: string | null
  /** bumped by "re-layout": the graph drops its remembered positions */
  layoutGen: number
  setInsF: (p: Partial<InsF>) => void
  setGrpF: (p: Partial<GrpF>) => void
  setSimF: (p: Partial<SimF>) => void
  set: (p: Partial<Pick<AnalyticsState, 'insOpen' | 'layoutGen'>>) => void
}

export const useAnalytics = create<AnalyticsState>()((set) => ({
  insF: { dim: '', metric: 'cost', date: 'all', tier: '', driver: '', q: '', minN: 1, sort: 'p50', dir: 1 },
  grpF: { k1: '', k2: '', open: null },
  // the graph is about what sessions were for, so it colours by purpose unless told otherwise
  simF: { color: 'purpose', min: 0.35, proj: '', q: '', focus: null, hidden: {}, labels: true },
  insOpen: null,
  layoutGen: 0,
  setInsF: (p) => set((s) => ({ insF: { ...s.insF, ...p } })),
  setGrpF: (p) => set((s) => ({ grpF: { ...s.grpF, ...p } })),
  setSimF: (p) => set((s) => ({ simF: { ...s.simF, ...p } })),
  set: (p) => set(p),
}))

/** the n-th most explanatory work attribute (size attributes explain cost by construction) */
export const topWork = (ins: Insights | null, i: number) => {
  const r = (ins ? ins.ranking : []).filter((x) => x.group !== 'size')
  return r[i] ? r[i].key : 'purpose'
}
export const attrLabel = (ins: Insights | null, k: string) => ins?.ranking.find((x) => x.key === k)?.label ?? k
export const valuesOf = (ins: Insights, k: string) => {
  const c: Record<string, number> = {}
  for (const a of Object.values(ins.attrs)) c[a[k]] = (c[a[k]] || 0) + 1
  return Object.keys(c).sort()
}
export const metricFn = (f: InsF) => (METRICS.find((m) => m[0] === f.metric) || METRICS[0])[2]
export const fmtMetric = (f: InsF, v: number) => (f.metric === 'dur' ? fmtM(v) : f.metric === 'ctx' ? tok(v) : usd(v))

export interface InsRow { s: Session; a: Attrs }
/** sessions in view, each with its attributes */
export function insRows(sessions: Session[] | undefined, ins: Insights | null, f: InsF): InsRow[] {
  if (!sessions || !ins) return []
  const q = f.q.toLowerCase(), days = ({ '7d': 7, '30d': 30, '90d': 90 } as Record<string, number>)[f.date], now = Date.now()
  return sessions.filter((s) => ins.attrs[s.id]).map((s) => ({ s, a: ins.attrs[s.id] })).filter(({ s, a }) =>
    (!days || (s.startedAt && now - new Date(s.startedAt).getTime() < days * 864e5))
    && (!f.tier || a.tier === f.tier) && (!f.driver || a.driver === f.driver)
    && (!q || (s.intent + ' ' + a.project).toLowerCase().includes(q)))
}

/** fill the defaults that depend on the ranking, once it has arrived */
useHub.subscribe((h, prev) => {
  if (!h.ins || h.ins === prev.ins) return
  const a = useAnalytics.getState()
  if (!a.insF.dim) a.setInsF({ dim: topWork(h.ins, 0) })
  if (!a.grpF.k1) a.setGrpF({ k1: topWork(h.ins, 0) })
})

/** open Similar focused on one session, from anywhere */
export function simFocus(id: string) {
  useAnalytics.getState().setSimF({ focus: id })
  useHub.setState({ section: 'analytics', asub: 'sim' })
}
