/**
 * The hub's state: what the server said, what is selected, and the actions that move
 * between sections or spend money. Per-section UI state (filters, sorts) lives beside
 * each section in sections/<name>/state.ts, so sections never edit each other's slice.
 */
import { create } from 'zustand'
import { toast } from 'sonner'
import {
  DONE_PHASES, getJSON, post, q,
  type Catalog, type Insights, type LiveMap, type ProfilesPayload, type Run, type RunsPayload,
  type SessionDetail, type SessionsPayload, type TriagePayload,
} from '@/lib/api'

export type Section = 'overview' | 'sessions' | 'triage' | 'analytics' | 'optimization' | 'graph'
export type Subtab = 'sessions' | 'runs' | 'catalog' | 'models' | 'profiles'
export type Goal = 'cost' | 'latency' | 'accuracy'
export type Theme = 'auto' | 'light' | 'dark' | 'black'
export type Asub = 'pct' | 'grp' | 'sim' | 'beh' | 'session'

export const SECTIONS: [Section, string][] = [['overview', 'Overview'], ['sessions', 'Sessions'], ['triage', 'Triage'], ['analytics', 'Analytics'], ['optimization', 'Optimize']]
export const SUBTABS: [Subtab, string][] = [['sessions', 'Sessions'], ['runs', 'Experiments'], ['catalog', 'Catalog'], ['models', 'Models'], ['profiles', 'Profiles']]
/** what the person wants from an optimization; every run records it */
export const GOALS: [Goal, string, string][] = [
  ['cost', 'Cost', 'spend less for the same result'],
  ['latency', 'Latency', 'get the answer sooner'],
  ['accuracy', 'Accuracy', 'keep the answer as good — least risky levers first'],
]

/** Read-only deploy: hub-demo.mjs sets window.HUB_DEMO. The UI is identical; what spends money is disabled and labelled. */
export const DEMO = !!(window as any).HUB_DEMO

export interface Sel { sessions?: string | null; exp?: string | null; run?: string | null; catalog?: string | null; triage?: string | null; profile?: string | null; lever?: string | null; model?: string | null }

interface Pending { kind: string; experiment: string | null; goal: Goal; startedAt: string }

const store = <T,>(k: string, d: T, parse: (s: string) => T = (s) => s as unknown as T): T => {
  try { const v = localStorage.getItem(k); return v == null ? d : parse(v) } catch { return d }
}
const save = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* private window */ } }

export interface HubState {
  data: SessionsPayload | null
  runs: RunsPayload
  live: LiveMap
  cat: Catalog
  tri: TriagePayload | null
  ins: Insights | null
  insAt: number
  prof: ProfilesPayload | null
  profTarget: string
  profProject: string
  profLoading: boolean
  /** the per-turn series for the session being analysed */
  sdetail: SessionDetail | null

  section: Section
  subtab: Subtab
  asub: Asub
  sel: Sel
  goal: Goal
  graphSid: string
  pendingRun: string | null
  pending: Record<string, Pending>

  theme: Theme
  railShut: boolean
  detailShut: boolean
  watching: boolean

  set: (p: Partial<HubState>) => void
  select: (p: Sel, opts?: { open?: boolean }) => void
  go: (section: Section, subtab?: Subtab) => void
  setTheme: (t: Theme) => void
  setRail: (shut: boolean) => void
  setDetail: (open: boolean) => void
  toggleWatch: () => void

  load: () => Promise<void>
  refresh: () => Promise<void>
  refreshSessions: () => Promise<boolean>
  loadTriage: () => Promise<void>
  loadInsights: () => Promise<void>
  loadProf: (p?: { target?: string; project?: string }) => Promise<void>
  loadSeries: (id: string, force?: boolean) => Promise<void>

  openAnalytics: (id: string) => void
  openGraph: (sid: string) => void
  goOptimize: (id: string) => void
  toRuns: (id: string, kind: string, experiment: string | null) => void
  runOpt: (id: string) => Promise<void>
  runExp: (id: string) => Promise<void>
  stopRun: (id: string) => Promise<void>
}

/* cheap signature: has anything a viewer would notice actually moved? */
const sig = (d: SessionsPayload | null) => !d ? '' : d.totals.count + '/' + d.totals.cost + '/' + d.totals.live + '/'
  + d.sessions.slice(0, 6).map((s) => s.id.slice(0, 8) + ':' + s.turns + ':' + s.cost).join(',')

const POLLS: Record<string, ReturnType<typeof setInterval>> = {}
let seriesFor = ''

export const useHub = create<HubState>()((set, get) => ({
  data: null,
  runs: { runs: [], bySession: {} },
  live: {},
  cat: { experiments: [] },
  tri: null,
  ins: null,
  insAt: 0,
  prof: null,
  profTarget: 'local',
  profProject: '',
  profLoading: false,
  sdetail: null,

  // the landing page: summary and opportunities first
  section: 'overview',
  subtab: 'sessions',
  asub: 'pct',
  sel: {},
  goal: 'cost',
  graphSid: '',
  pendingRun: null,
  pending: {},

  theme: store<Theme>('hub-theme', 'auto'),
  railShut: store<string>('hub-rail', 'open') === 'shut',
  detailShut: store<string>('hub-detail', 'open') === 'shut',
  watching: store<string>('hub-watch', 'off') === 'on',

  set: (p) => set(p),
  select: (p, opts) => set((s) => ({ sel: { ...s.sel, ...p }, ...(opts?.open === false ? {} : { detailShut: false }) })),
  go: (section, subtab) => {
    const s = get()
    set({ section, ...(subtab ? { subtab } : {}), ...(section === 'analytics' && s.asub === 'session' ? { asub: 'pct' } : {}) })
    if (section === 'analytics') get().loadInsights()
    if (section === 'optimization' && (subtab ?? s.subtab) === 'profiles' && !s.prof) get().loadProf()
  },
  setTheme: (t) => { save('hub-theme', t); set({ theme: t }) },
  setRail: (shut) => { save('hub-rail', shut ? 'shut' : 'open'); set({ railShut: shut }) },
  setDetail: (open) => { save('hub-detail', open ? 'open' : 'shut'); set({ detailShut: !open }) },
  toggleWatch: () => {
    const watching = !get().watching
    save('hub-watch', watching ? 'on' : 'off')
    const sec = get().section
    set({ watching, ...(watching && sec !== 'sessions' && sec !== 'optimization' ? { section: 'sessions' as Section } : {}) })
    liveTick()
  },

  load: async () => {
    const data = await getJSON<SessionsPayload>('/api/sessions')
    set({ data })
    try { set({ cat: await getJSON<Catalog>('/api/catalog') }) } catch { /* catalog is optional */ }
    await get().loadTriage()
    get().loadInsights()
    await get().refresh()
    liveTick()
  },
  refresh: async () => {
    try { set({ runs: await getJSON<RunsPayload>('/api/runs') }) } catch { /* keep the last */ }
    try {
      const live = await getJSON<LiveMap>('/api/optimize/all')
      // a run launched here but not yet on disk stays visible until the server reports it
      for (const [id, p] of Object.entries(get().pending)) if (!live[id]) live[id] = { phase: 'starting', session: id, kind: p.kind, experiment: p.experiment ?? undefined, startedAt: p.startedAt }
      set({ live })
    } catch { /* keep the last */ }
  },
  refreshSessions: async () => {
    let d: SessionsPayload
    try { d = await getJSON<SessionsPayload>('/api/sessions') } catch { return false }
    if (!d?.sessions) return false
    const before = sig(get().data)
    if (sig(d) === before) return false
    set({ data: d })
    return true
  },
  loadTriage: async () => {
    try { set({ tri: await getJSON<TriagePayload>('/api/triage') }) } catch { set({ tri: { sessions: [], missing: true } }) }
  },
  loadInsights: async () => {
    try { set({ ins: await getJSON<Insights>('/api/insights'), insAt: Date.now() }) } catch { /* keep the last */ }
  },
  loadProf: async (p) => {
    const target = p?.target ?? get().profTarget, project = p?.project ?? get().profProject
    set({ profTarget: target, profProject: project, profLoading: true })
    try { set({ prof: await getJSON<ProfilesPayload>('/api/profiles?' + q({ target, project })) }) } catch { set({ prof: { profiles: [], rendered: [] } }) }
    set({ profLoading: false })
  },
  loadSeries: async (id, force) => {
    if (!id) return
    if (!force && (get().sdetail?.id === id || seriesFor === id)) return
    seriesFor = id
    try { set({ sdetail: await getJSON<SessionDetail>('/api/session?' + q({ id })) }) } catch { set({ sdetail: { id, series: [] } }) }
    seriesFor = ''
  },

  /* analytics is entered from a session, never from the rail, so it always knows which session it is about */
  openAnalytics: (id) => {
    set((s) => ({ sel: { ...s.sel, sessions: id }, section: 'analytics', asub: 'session', sdetail: s.sdetail?.id === id ? s.sdetail : null }))
    get().loadSeries(id, true)
  },
  /* the Graph view, entered from a Triage session: full width, the opthub graph page in a frame */
  openGraph: (sid) => set({ graphSid: sid, section: 'graph' }),
  goOptimize: (id) => set((s) => ({ sel: { ...s.sel, sessions: id, exp: null, lever: null }, section: 'optimization', subtab: 'sessions' })),

  /* a launched run is shown where it lives: Optimize → Experiments, selected */
  toRuns: (id, kind, experiment) => {
    const p: Pending = { kind, experiment, goal: get().goal, startedAt: new Date().toISOString() }
    set((s) => ({
      pending: { ...s.pending, [id]: p },
      live: { ...s.live, [id]: { phase: 'starting', session: id, kind, experiment: experiment ?? undefined, startedAt: p.startedAt } },
      pendingRun: id, section: 'optimization', subtab: 'runs', sel: { ...s.sel, run: 'pending:' + id }, detailShut: false,
    }))
    poll(id)
  },
  runOpt: async (id) => {
    get().toRuns(id, 'optimize', null)
    try { await post('/api/optimize?' + q({ session: id, goal: get().goal })) } catch { /* the poll reports it */ }
  },
  runExp: async (id) => {
    const exp = get().sel.lever || '__auto'
    if (exp === '__auto') return get().runOpt(id)
    get().toRuns(id, 'experiment', exp)
    try {
      const res = await post('/api/experiment?' + q({ session: id, experiment: exp, goal: get().goal }))
      if (!res.ok) {
        const msg = await res.text()
        set((s) => ({ live: { ...s.live, [id]: { phase: 'error', session: id } }, pendingRun: null }))
        toast.error(msg)
      }
    } catch { /* the poll reports it */ }
  },
  stopRun: async (id) => {
    await post('/api/optimize/stop?' + q({ session: id }))
    set((s) => ({ live: { ...s.live, [id]: { ...(s.live[id] || {}), phase: 'stopping' } } }))
  },
}))

function poll(id: string) {
  if (POLLS[id]) return
  POLLS[id] = setInterval(async () => {
    const h = useHub.getState()
    // the pending entry only bridges the gap before the server knows the run
    if (h.runs.runs.some((r) => r.session === id) || (h.live[id] && h.live[id].phase !== 'starting')) {
      const { [id]: _, ...rest } = h.pending; h.set({ pending: rest })
    }
    await h.refresh()
    const st = useHub.getState().live[id]
    if (!st || DONE_PHASES.includes(st.phase as string)) { clearInterval(POLLS[id]); delete POLLS[id] }
  }, 4000)
}

/* Poll fast while something is running, slowly when the machine is idle. */
let liveTimer: ReturnType<typeof setTimeout> | undefined
export async function liveTick() {
  clearTimeout(liveTimer)
  const h = useHub.getState()
  const changed = await h.refreshSessions()
  if (changed || h.watching) {
    // classification is continuous: a new or growing session is reclassified on the next pass
    if (h.section === 'analytics' && h.asub !== 'session') await h.loadInsights()
    // a live session's analytics should move too
    const sd = h.sdetail
    if (h.section === 'analytics' && h.sel.sessions && sd?.id === h.sel.sessions && sd.live) await h.loadSeries(sd.id, true)
  }
  const d = useHub.getState().data
  const hot = d && (d.totals.live > 0 || d.totals.open > 0)
  liveTimer = setTimeout(liveTick, useHub.getState().watching ? 2000 : hot ? 8000 : 30000)
}

/* the runs and live status refresh on their own, slower clock */
setInterval(() => { if (!Object.keys(POLLS).length) useHub.getState().refresh() }, 15000)

/* ---------------------------------------------------------------- selectors */

export const isLivePhase = (p?: string | null) => !!p && !DONE_PHASES.includes(p)

/** the phase a session's most recent run is in, live status winning over disk */
export function runState(h: Pick<HubState, 'live' | 'runs'>, id: string) {
  const l = h.live[id], r = h.runs.bySession[id]
  if (l && isLivePhase(l.phase)) return { phase: l.phase as string, live: true, run: r }
  return { phase: r ? r.phase : null, live: false, run: r }
}

/** rows for Experiments: what is on disk, plus anything launched here that has not
    written its status.json yet, so a run appears the instant it is asked for */
export function runRows(h: Pick<HubState, 'runs' | 'live' | 'data' | 'pending'>): (Run & { pending?: boolean })[] {
  const rows: (Run & { pending?: boolean })[] = [...h.runs.runs]
  for (const [sid, st] of Object.entries(h.live)) {
    if (!st || !isLivePhase(st.phase)) continue
    if (rows.some((r) => r.session === sid && isLivePhase(r.phase))) continue
    const sess = h.data?.sessions.find((x) => x.id === sid), pend = h.pending[sid]
    rows.unshift({
      run: 'pending:' + sid, pending: true, kind: pend?.kind || st.kind || 'optimize',
      experiment: pend?.experiment || st.experiment || undefined, goal: pend?.goal || 'cost',
      session: sid, sessionShort: sid.slice(0, 8), intent: sess ? sess.intent : '', phase: st.phase as string,
      startedAt: pend?.startedAt || st.startedAt || new Date().toISOString(), updatedAt: new Date().toISOString(),
      arms: [], failed: 0, totalCost: 0, verdict: undefined, best: undefined, report: undefined,
      originalCost: sess?.cost, originalModel: sess?.model,
      headline: { text: st.phase + '…', tone: 'flat' },
    })
  }
  return rows
}

/** runs launched against one session, newest first: these are its experiments */
export const expsOf = (h: Parameters<typeof runRows>[0], id: string) =>
  runRows(h).filter((r) => r.session === id).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
export const runArm = (r: Run) => (r.arms || []).find((a) => a.role !== 'baseline') || (r.arms || [])[0] || null
export const expTitle = (cat: Catalog, r: Run) => cat.experiments.find((x) => x.id === r.experiment)?.title ?? (r.experiment || 'auto grid')
