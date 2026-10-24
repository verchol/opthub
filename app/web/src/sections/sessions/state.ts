/** Sessions list filters and sort: kept here so they survive a trip to another section. */
import { create } from 'zustand'
import type { Session } from '@/lib/api'

export interface Filters { q: string; kind: string; art: string; date: string; from: string; to: string }

interface SessionsState {
  filters: Filters
  sortKey: string
  sortDir: number
  setFilters: (p: Partial<Filters>) => void
  sortBy: (k: string) => void
}

export const useSessions = create<SessionsState>()((set) => ({
  filters: { q: '', kind: '', art: '', date: '', from: '', to: '' },
  sortKey: 'endedAt',
  sortDir: -1,
  setFilters: (p) => set((s) => ({ filters: { ...s.filters, ...p } })),
  // click a header to sort by it, click it again to flip
  sortBy: (k) => set((s) => ({ sortDir: s.sortKey === k ? -s.sortDir : 1, sortKey: k })),
}))

/* Created-date filter, on startedAt: when the session began, which is not the
   same as when it last wrote. A resumed session is days old and still going,
   and "what did I start this week" is the question people actually ask. */
const DAY = 86400000
export const DATE_OPTS: [string, string, string | null][] = [
  ['', 'any date', ''], ['today', 'created today', 'created today'],
  ['yesterday', 'created yesterday', 'created yesterday'],
  ['7d', 'last 7 days', 'created in the last 7 days'],
  ['30d', 'last 30 days', 'created in the last 30 days'],
  ['custom', 'custom range…', null],
]

function dateBounds(f: Filters): { from: number | null; to: number | null } {
  const now = Date.now(), sod = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime() }
  switch (f.date) {
    case 'today': return { from: sod(now), to: sod(now) + DAY - 1 }
    case 'yesterday': return { from: sod(now) - DAY, to: sod(now) - 1 }
    case '7d': return { from: now - 7 * DAY, to: null }
    case '30d': return { from: now - 30 * DAY, to: null }
    case 'custom': return {
      from: f.from ? sod(Date.parse(f.from + 'T00:00')) : null,
      to: f.to ? sod(Date.parse(f.to + 'T00:00')) + DAY - 1 : null,
    }
    default: return { from: null, to: null }
  }
}

function inDateRange(f: Filters, s: Session) {
  const { from, to } = dateBounds(f)
  if (from == null && to == null) return true
  const t = s.startedAt ? Date.parse(s.startedAt) : NaN
  if (!Number.isFinite(t)) return false
  return (from == null || t >= from) && (to == null || t <= to)
}

export function dateLabel(f: Filters) {
  if (f.date !== 'custom') return DATE_OPTS.find(([v]) => v === f.date)?.[2] || ''
  if (f.from && f.to) return 'created ' + f.from + ' → ' + f.to
  if (f.from) return 'created on or after ' + f.from
  if (f.to) return 'created on or before ' + f.to
  return 'custom range (no dates set)'
}

export function sessionRows(sessions: Session[], f: Filters, sortKey: string, sortDir: number) {
  const q = f.q.toLowerCase()
  const list = sessions.filter((s) => (!q || (s.intent + ' ' + s.model).toLowerCase().includes(q))
    && (!f.kind || s.kind === f.kind) && (!f.art || (f.art === 'y' ? s.hasArtifact : !s.hasArtifact))
    && inDateRange(f, s))
  list.sort((a, b) => {
    const x = a[sortKey], y = b[sortKey]
    const c = typeof x === 'number' ? x - y : String(x).localeCompare(String(y))
    return c * sortDir
  })
  return list
}
