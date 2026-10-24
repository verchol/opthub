/**
 * `opt analyse` — load every session from a source and classify it.
 *
 *   source       claude-code (default): ~/.claude/projects, through lib/sessions-index.mjs
 *   classifier   jev-local (default): Jev's Choice contract served by Ollama at /v1/systemone (model tev1)
 *                jev: the hosted TypeSafe endpoint, needs JEV_API_KEY
 *                rules: no model at all
 *
 * Three labels per session:
 *   mode      interactive | non-interactive   — only non-interactive sessions are eligible for `opt claude -p --session`
 *   work      coding | debugging | review | research | writing | operations
 *   strategy  the catalog lever to try first, picked by rules from the labels and the numbers
 *
 * What a classifier sees is counts and booleans only: no prompt text, no paths, no cost
 * (the same privacy contract as experiments/session-triage in the opthub repo).
 * Results are cached per session in $OPT_HOME/analysis/sessions.json and re-classified
 * only when the session has grown or the classifier changed.
 */
import fs from 'node:fs'
import path from 'node:path'
import { STATE } from './state.mjs'
import { buildIndex } from './sessions-index.mjs'
import { validAnswer } from './ult/jev.mjs'
import { propose } from './goals.mjs'

export const SOURCES = ['claude-code']
export const CLASSIFIERS = {
  'jev-local': { endpoint: process.env.OPT_JEV_LOCAL_URL ?? 'http://127.0.0.1:11434/v1/systemone', model: process.env.OPT_JEV_LOCAL_MODEL ?? 'tev1', key: null },
  'jev': { endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-1.13.0', key: 'JEV_API_KEY' },
  'rules': null,
}
export const CACHE_FILE = path.join(STATE, 'analysis', 'sessions.json')

const MODE = {
  'interactive': 'A person typed several prompts during the session and read the replies before continuing.',
  'non-interactive': 'Started by a script, SDK, hook or scheduler with one instruction, and ran to the end without a person replying.',
  'unclear': 'The evidence does not decide.',
}
const WORK = {
  'coding': 'Writing or changing code: many file edits.',
  'debugging': 'Finding and fixing a failure: many commands run, edits follow test or error output.',
  'review': 'Reading code or changes and reporting on them: many reads, few or no edits.',
  'research': 'Gathering information: web lookups and file reads, no code changed.',
  'writing': 'Producing documents or prose: few files written, mostly text, little command use.',
  'operations': 'Running commands to operate systems: mostly shell, few edits.',
  'unclear': 'The evidence does not decide.',
}

const sum = (o, keys) => keys.reduce((a, k) => a + (o?.[k] ?? 0), 0)

/** Counts and booleans only. This object is all a classifier ever receives. */
export function publicFeatures(s) {
  const t = s.toolCounts ?? {}
  return {
    entry_point: s.entry ?? 'unknown',
    follow_up_prompts: Math.max(0, (s.humanPrompts ?? 0) - 1),
    assistant_turns: s.turns,
    tool_calls: s.toolCalls,
    file_edits: sum(t, ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']),
    file_reads: sum(t, ['Read', 'Grep', 'Glob', 'LS']),
    shell_commands: sum(t, ['Bash', 'BashOutput']),
    subagents: sum(t, ['Task', 'Agent']),
    web_lookups: sum(t, ['WebFetch', 'WebSearch']),
    files_produced: (s.artifacts ?? []).length,
    duration_minutes: Math.round(s.durationMin ?? 0),
    median_context_k_tokens: Math.round((s.ctxMedian ?? 0) / 1000),
    compactions: s.compactions ?? 0,
  }
}

/** Rules: the fallback, and the second opinion every Jev label is checked against. */
export function rulesClassify(f) {
  let mode
  if (f.entry_point === 'sdk-cli') mode = { label: 'non-interactive', confidence: 0.9 }
  else if (f.follow_up_prompts >= 1) mode = { label: 'interactive', confidence: 0.85 }
  else if (f.entry_point === 'cli' || f.entry_point === 'claude-desktop') mode = { label: 'interactive', confidence: 0.6 }
  else mode = { label: 'unclear', confidence: 0.3 }

  let work
  const edits = f.file_edits, sh = f.shell_commands, rd = f.file_reads
  if (f.web_lookups > 0 && edits === 0) work = 'research'
  else if (edits === 0 && rd > sh) work = 'review'
  else if (edits === 0 && sh > 0) work = 'operations'
  else if (sh > edits * 2 && edits > 0) work = 'debugging'
  else if (edits > 0 && f.files_produced > 0 && sh === 0) work = 'writing'
  else if (edits > 0) work = 'coding'
  else work = 'unclear'
  return { mode, work: { label: work, confidence: work === 'unclear' ? 0.3 : 0.6 } }
}

/** One Jev request, two questions. Returns null on any failure — the caller falls back to rules. */
export async function jevClassify(f, cfg, { apiKey, timeoutMs = 60000, fetchImpl = fetch } = {}) {
  const body = {
    model: cfg.model,
    state: {
      session: f,
      note: 'Counts describing one finished coding-agent session, computed locally. No prompt text, file paths or cost are included. ' +
            'entry_point: "cli" means a person started it in a terminal, "sdk-cli" means a script or SDK started it with `claude -p`, ' +
            '"claude-desktop" means the desktop app. follow_up_prompts counts messages a person typed after the opening instruction; 0 means nobody replied during the run.',
    },
    questions: {
      mode: { type: 'choice', instructions: 'Was a person driving this session turn by turn? Choose exactly one option; choose unclear when the evidence does not decide.', criteria: MODE },
      work: { type: 'choice', instructions: 'Which kind of work did the session mostly do? Choose exactly one option; choose unclear when the evidence does not decide.', criteria: WORK },
    },
  }
  const t0 = Date.now()
  try {
    const res = await fetchImpl(cfg.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return { error: `http-${res.status}`, ms: Date.now() - t0 }
    const raw = await res.json()
    const a = raw?.answers ?? {}
    const pick = (ans, set) => validAnswer(ans, new Set(Object.keys(set))) ? { label: ans.choice, confidence: +ans.confidence.toFixed(3) } : null
    return { mode: pick(a.mode, MODE), work: pick(a.work, WORK), ms: Date.now() - t0 }
  } catch (e) {
    return { error: e?.name === 'TimeoutError' ? 'timeout' : 'unavailable', ms: Date.now() - t0 }
  }
}

/** The lever to try first. Deterministic, so the audit log can explain every pick. */
export function suggestStrategy(s, mode, work) {
  if (work === 'review' || work === 'debugging') return { id: 'effort-medium', why: 'review and debugging are never routed to a cheaper model; effort is the safe lever' }
  if ((s.ctxMedian ?? 0) >= 150000) return { id: 'context-compaction', why: 'median context ≥ 150k: most of the cost is re-reading history' }
  if ((s.toolCounts?.Task ?? 0) + (s.toolCounts?.Agent ?? 0) > 0) return { id: 'litellm-route-side-calls', why: 'uses subagents: route them to a cheaper model, keep the main loop' }
  if (work === 'research' || work === 'writing') return { id: 'route-cheaper-frontier', why: 'non-coding work: a cheaper frontier model is the first thing to try' }
  if ((s.thinkingTokens ?? 0) > 0.25 * (s.outTokens || 1)) return { id: 'effort-medium', why: 'thinking is over a quarter of output' }
  return { id: 'effort-medium', why: 'lowest-risk lever when nothing else stands out' }
}

function loadCache() { try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) } catch { return { sessions: {} } } }
function saveCache(c) { fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 1)) }

/** Latest analysis of one session, or null if it was never analysed. */
/** Every analysed session, newest first. */
export function allAnalysed() { return Object.values(loadCache().sessions).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))) }

export function analysisFor(id) {
  const c = loadCache().sessions
  return c[id] ?? Object.values(c).find((r) => r.id.startsWith(id)) ?? null
}

/**
 * Load, classify, cache. `onEach(record, fromCache)` is called per session so the
 * caller can audit and show progress. Returns every record in the window.
 */
export async function analyse({ source = 'claude-code', classifier = 'jev-local', cfg, apiKey, range, project = null, fresh = false, limit = 500, concurrency = 4, onEach } = {}) {
  if (!SOURCES.includes(source)) throw new Error(`unknown source '${source}' — supported: ${SOURCES.join(', ')}`)
  const { sessions } = buildIndex({ limit })
  const inRange = range && (range.from != null || range.to != null)
    ? sessions.filter((s) => { const t = Date.parse(s.startedAt ?? ''); return Number.isFinite(t) && (range.from == null || t >= range.from) && (range.to == null || t <= range.to) })
    : sessions
  // a subagent's transcript is part of the session that spawned it, not a session of its own
  const own = inRange.filter((s) => !s.id.startsWith('agent-'))
  const home = process.env.HOME ?? ''
  const inProject = project ? own.filter((s) => (s.cwd ?? '').replace(/^~/, home).startsWith(project)) : own
  const cache = loadCache()
  const tag = (classifier === 'rules' ? 'rules' : `${classifier}:${cfg.model}`) + ':p2'   // bump when the proposal engine changes
  const out = new Array(inProject.length)
  let next = 0, jevDown = false

  async function one(i) {
    const s = inProject[i]
    const hit = cache.sessions[s.id]
    if (!fresh && hit && hit.turns === s.turns && hit.classifier === tag && !s.live) { out[i] = { ...hit, cost: s.cost, intent: s.intent }; onEach?.(out[i], true); return }
    const f = publicFeatures(s)
    const rules = rulesClassify(f)
    let jev = null
    if (classifier !== 'rules' && !jevDown) {
      jev = await jevClassify(f, cfg, { apiKey })
      if (jev.error === 'unavailable') jevDown = true          // stop hammering a dead endpoint
    }
    const decide = (q) => {
      const j = jev?.[q]
      if (j && j.label !== 'unclear') return { ...j, by: classifier, agree: j.label === rules[q].label }
      return { ...rules[q], by: 'rules', agree: null }
    }
    const mode = decide('mode'), work = decide('work')
    // the default proposal: goal cost at balanced temperature (opt claude plan shows the others)
    const p = propose(s, { goal: 'cost', temperature: 'balanced', work: work.label })
    const strategy = p.pick ? { id: p.pick.id, risk: p.pick.risk, best: p.pick.best.text, why: `goal cost · balanced: ${p.pick.best.text}` } : suggestStrategy(s, mode.label, work.label)
    const rec = {
      id: s.id, startedAt: s.startedAt, turns: s.turns, live: s.live, classifier: tag,
      mode, work, strategy, eligible: mode.label === 'non-interactive',
      jevError: jev?.error ?? null, jevMs: jev?.ms ?? null, features: f,
      analysedAt: new Date().toISOString(),
    }
    cache.sessions[s.id] = rec
    out[i] = { ...rec, cost: s.cost, intent: s.intent }
    onEach?.(out[i], false)
  }
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => { while (next < inProject.length) await one(next++) })
  await Promise.all(workers)
  saveCache(cache)
  return { records: out, jevDown }
}
