/**
 * The hub's HTTP surface (hub.mjs, and hub-demo.mjs for the read-only deploy).
 * Types cover what the page reads; payloads carry more, hence the index signatures.
 */

export type Kind = 'code' | 'doc' | 'debug' | 'explore' | 'other' | (string & {})
export type Phase = 'starting' | 'running' | 'judging' | 'done' | 'error' | 'stopped' | 'stopping' | 'stale' | (string & {})
export const DONE_PHASES: Phase[] = ['done', 'error', 'stopped', 'stale']

export interface Artifact { name: string; bytes?: number; [k: string]: unknown }

export interface Potential {
  band: string; lo: number; hi: number; usdLo: number; usdHi: number
  methods: { id: string; title?: string; mark?: string; why?: string; usdLo?: number; usdHi?: number; [k: string]: unknown }[]
  basis: string; gateNote: string | null; [k: string]: unknown
}

export interface Session {
  id: string; model: string; modelTier: string; intent: string
  durationMin: number; startedAt: string; endedAt: string
  cost: number; turns: number; outTokens: number; inTokens: number
  ctxPeak: number; ctxMedian: number; ctxLast: number; ctxRequests: number
  freshInTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cacheHit: number
  thinkingTokens: number; compactions: number; toolCalls: number
  toolCounts: Record<string, number>; toolSeries: (string | null)[]
  artifacts: Artifact[]; topArtifact: string; artifactBytes: number; hasArtifact: boolean
  kind: Kind; cwd: string; entry: string; humanPrompts: number; costBucket: string
  live: boolean; secrets: boolean; status?: 'live' | 'open' | 'idle' | 'closed' | string
  ageMs?: number; pids?: number[]
  roi?: any; roiRaw?: any; potential?: Potential
  /** sandbox: a Claude Code session that ran in an `opt claude optimize` sandbox; run is its run id */
  where?: 'local' | 'sandbox'; run?: string | null
  tags?: any; shanaTova?: any
  [k: string]: any
}

export interface SessionsPayload {
  generatedAt: string
  totals: { count: number; cost: number; withArtifacts: number; live: number; open: number; shown: number
    byKind: Record<string, number>; byModel: Record<string, number>; roiMedian: number }
  counts: Record<string, number>; countsAll: Record<string, number>
  processes: unknown[]
  sessions: Session[]
}

export interface SeriesPoint { i: number; ts: number; ctx: number; costCum: number; out: number; think: number; fresh: number; cr: number; cw: number; [k: string]: number }
export interface SessionDetail extends Partial<Session> { id: string; series: SeriesPoint[]; live?: boolean }

export interface Arm {
  label: string; armId: string; model: string; role: string; compaction?: boolean; effort?: unknown
  cost: number; turns: number; secs: number; artifacts?: unknown; isError?: boolean; err?: string; score?: number
  [k: string]: any
}
export interface Run {
  run: string; kind: string; experiment?: string; goal?: string; scoreMax?: number
  session: string; sessionShort?: string; intent?: string; phase: Phase
  startedAt?: string; finishedAt?: string; updatedAt?: string
  originalCost?: number; originalModel?: string; rationale?: string; hypothesis?: string; gate?: string; risk?: string
  arms?: Arm[]; failed?: number; totalCost?: number
  verdict?: { rubric?: string[]; scores?: Record<string, any>; totals?: Record<string, number>; why?: string; winner?: string
    winnerArm?: string; margin?: string; presentedFirst?: string; best?: number; configs?: string[]; [k: string]: any }
  best?: string; headline?: { text: string; tone: string; detail?: string }; report?: string
  [k: string]: any
}
export interface RunsPayload { runs: Run[]; bySession: Record<string, Run> }
export type LiveMap = Record<string, Partial<Run> & { phase?: Phase }>

export interface Experiment {
  id: string; title: string; family?: string; summary?: string
  runnable?: boolean; control?: boolean; approximation?: boolean
  requires?: unknown; hypothesis?: string; risk?: string; gate?: string
  arm?: Record<string, unknown>; [k: string]: any
}
export interface Catalog { version?: string; updated?: string; error?: unknown; experiments: Experiment[] }

export interface TriageSession { session: string; key: string; project: string; kind: string; cost: number; [k: string]: any }
export interface TriagePayload {
  generatedAt?: string; classifier?: any; methods?: any[]; total?: number; rerunExperiment?: string
  sessions: TriageSession[]; rerun?: any; score?: any; missing?: boolean
  [k: string]: any
}

export type Attrs = Record<string, string>
export interface Neighbour { id: string; sim: number; why: { shared: string[]; words: string[]; files: string[] } }
export interface RankingRow { key: string; label: string; why: string; group: string; score: number; eta: number; groups: number }
export interface Insights {
  classifiedAt: string
  attrs: Record<string, Attrs>
  ranking: RankingRow[]
  changed: string[]
  neighbours: Record<string, Neighbour[]>
}

export interface ProfilesPayload { profiles: any[]; rendered: any[]; target?: string; project?: string; classes?: any; [k: string]: any }

/** GET as JSON, never cached: every payload is computed from files that move. */
/** Thrown when the server answers an API path with the page: it predates this page. */
export const STALE_HUB = 'this hub server is older than the page: stop it and run opt hub start again'

export async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: 'no-store' })
  // a server started before an endpoint existed falls through to index.html (older builds) or 404s (newer)
  if (/text\/html/.test(r.headers.get('content-type') ?? '') || (r.status === 404 && /unknown API/.test(await r.clone().text()))) throw new Error(STALE_HUB)
  if (!r.ok) throw new Error(`${url}: ${r.status} ${await r.text()}`)
  return r.json() as Promise<T>
}

/** POST, returning the response so callers can surface the server's refusal text. */
export const post = (url: string) => fetch(url, { method: 'POST' })

export const q = (params: Record<string, string | number | undefined | null>) =>
  Object.entries(params).filter(([, v]) => v != null && v !== '').map(([k, v]) => k + '=' + encodeURIComponent(String(v))).join('&')

/** /api/behaviour: Claude Code sessions turn by turn, from LangSmith traces and the local OTEL store */
export interface BehSession {
  sid: string; project: string; src: 'langsmith' | 'otel'; start: number; end: number; open: boolean
  turns: number; wall: number; busy: number; idle: number; away: number; breaks: number; idleShare: number
  medGap: number | null; longestGap: number; cold: number; coldAfterIdle: number; coldCost: number
  llmMs: number; toolMs: number; cost: number; llmCalls: number; toolCalls: number; toolErrors: number
  subagents: number; subLlm: number; interrupts: number; errors: number; abandoned: number
  waitMs: number; waits: number; cacheHit: number; model: string
  /** per turn: start, end, cold, cost, tool calls, model calls, interrupted */
  strip: [number, number | null, number, number, number, number, number][]
}
export interface BehKpi {
  sessions: number; turns: number; wall: number; busy: number; idle: number; away: number; breaks: number; idleShare: number
  medGap: number | null; p50Turn: number | null; p90Turn: number | null; llmMs: number; toolMs: number; cost: number
  cold: number; coldAfterIdle: number; coldCost: number; toolCalls: number; toolErrors: number; llmCalls: number; subagents: number
  interrupts: number; errors: number; abandoned: number; waitMs: number; waits: number; cacheHit: number; ttftP50: number | null; retries: number
}
export interface BehOtel {
  activeTime: Record<string, number>; lines: Record<string, number>; commits: number; prs: number
  editDecisions: Record<string, number>; decisionSources: Record<string, number>; decisions: Record<string, number>
  apiErrors: Record<string, number>; retriesExhausted: number; compactions: number; subagentsDone: number
  skills: Record<string, number>; modeChanges: Record<string, number>; records: number; last: number | null
}
export interface BehaviourPayload {
  days: number; project: string; at: number; cacheTtlMs: number
  sources: {
    langsmith: { endpoint: string; project: string; key: boolean; tracing: boolean; ok: boolean; runs?: number; truncated?: boolean; last?: number | null; error?: string }
    otel: { records: number; spans: number; last: number | null }
  }
  kpi: BehKpi; sessions: BehSession[]
  gapHist: { label: string; hi: number | null; n: number; cold: number }[]
  tools: { name: string; calls: number; errors: number; p50: number | null; p95: number | null; total: number; wait: number; waits: number }[]
  heat: number[][]; projects: string[]; otel?: BehOtel
}

/** /api/overview: the landing page */
export interface Opportunity {
  id: string; title: string; kind: 'measured' | 'priced' | 'guess'; evidence: string; source: 'atlas' | 'behaviour' | 'claude-p'
  usdLo: number | null; usdHi: number | null; pct?: number; sessions: number; why?: string; how: string; risk?: string; caveat?: string
}
export interface ClaudeRun {
  run: string; at: string; project: string; level: string; compare: boolean; repeats: number
  plainCost: number | null; optCost: number | null; verdict: { verdict: string; reason: string; pct?: number } | null
  check: string | null; plainPass: string | null; optPass: string | null; move: { from: string; to: string; why: string } | null
  claims: { verified: number; failed: number; notProven: number; notes: number } | null
  failed: { id: string; claim: string; detail: string }[]
}
export interface OverviewPayload {
  days: number; at: number
  kpi: { sessions: number; spend: number; prevSpend: number; deltaPct: number | null; perSession: number | null; projects: number; activeDays: number; cacheHit: number; humanShare: number }
  byProject: { key: string; cost: number; sessions: number }[]; byModel: { key: string; cost: number; sessions: number }[]
  byDay: { day: string; cost: number }[]; opportunities: Opportunity[]; runs: ClaudeRun[]
  months: {
    months: MonthSpend[]; current: MonthSpend; previous: MonthSpend | null; total: number; daysElapsed: number; daysInMonth: number
    saving?: { fleet: number | null; comparisons: number; rates: Record<string, { rate: number; own: boolean; last: string | null }> }
  }
  triage: {
    generatedAt: string; classifier: string | null; sessions: number; cost: number; best: number; expected: number; risk: number
    methods: { id: string; title: string; label: string; knob: string; saving: number; expected: number; sessions: number }[]
    projects: { project: string; cost: number; best: number; expected: number; sessions: number }[]
  } | null
  errors: {
    sessions: number; withErrors: number; api: number; shownTotal: number; tool: number; toolCalls: number; toolErrorRate: number
    apiErrors: Record<string, number>; shown: Record<string, number>; interrupts: number; hookErrors: number; compactions: number
    topTools: { name: string; n: number }[]
    worst: { sid: string; intent: string; project: string; api: number; shown: number; tool: number; interrupts: number; total: number }[]
  }
  leaders: {
    costP95: number; topCount: number; costShare: number; byCost: Leader[]
    latencyP95: number | null; turnMedian: number | null; turnP95All: number | null; sessionsWithTiming: number; turnsTimed: number
    byLatency: (Leader & { aboveP95: boolean })[]
  }
  local: { up: boolean; models?: number; routerModel?: string; note?: string }
}

/** /api/models: every model the gateway can use */
export interface CatalogModel {
  id: string; label: string; provider: string; where: 'remote' | 'local'; priceIn: number; priceOut: number
  family?: string | null; params?: string | null; paramsB?: number | null; quant?: string | null; sizeBytes?: number | null
  context?: number | null; capabilities?: string[]; loaded?: boolean; router?: boolean; roles: string[]; maxOutput?: number | null; thinking?: string | null
}
/** One model's routing record from the router audits (lib/model-scores.mjs) */
export interface ModelScore {
  id: string; where: 'local' | 'remote'; verdict: string; demote?: boolean
  requests: number; attempted: number; answered: number; answerRate: number | null; shadow: number
  refused: Record<string, number>; failed: Record<string, number>; caughtFallbacks?: number
  ttftP50: number | null; latencyP50: number | null; outTokens: number; costUsd: number; savedUsd: number
}
export interface ModelsPayload {
  at: number; router: { localModel: string | null; localEnabled: boolean; routes: Record<string, string> }
  providers: { id: string; label: string; kind: string; status: string; note: string; models: CatalogModel[] }[]
  scores?: { window_days: number; budget_ms: number; models: ModelScore[] }
}
export interface MonthSpend {
  month: string; cost: number; sessions: number; byFamily: Record<string, number>; projected?: number
  /** what optimize mode saved that month: measured in audited comparisons, estimated for the rest */
  saved?: { measured: number; estimated: number; total: number; sessions: number; runs: number }
}
export interface Leader {
  id: string; intent: string; project: string; cost: number; durationMin: number; turns: number; model: string
  turnP95: number | null; turnN: number; startedAt: string
}
