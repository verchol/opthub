/**
 * langsmith.mjs — send every sandbox run to LangSmith so a run can be watched
 * and compared after the terminal has scrolled away.
 *
 * The rig already writes run.json and a report; what it could not do is show a
 * run *while it happens*, next to every other run, with the token and cost
 * accounting attached. That is what a tracing backend is for.
 *
 * Shape of a trace:
 *
 *   run <runId>                     chain — the whole experiment
 *     arm control                   chain — one sandbox
 *       install                     tool
 *       agent                       llm    — tokens and cost land here
 *       grade                       tool
 *     arm headroom
 *       ...
 *
 * Everything is best-effort. A tracing backend that can take a run down is
 * worse than no tracing at all, so every call swallows its own errors and the
 * harness never waits on one.
 */
import { randomUUID } from 'node:crypto'

const ENDPOINT = process.env.LANGSMITH_ENDPOINT ?? 'https://api.smith.langchain.com'
export const PROJECT = process.env.SANDBOX_LANGSMITH_PROJECT ?? 'sandboxes'

const KEY = () => process.env.LANGSMITH_API_KEY || process.env.LANGCHAIN_API_KEY || ''
export const enabled = () => !!KEY() && process.env.SANDBOX_TRACING !== '0'

/** LangSmith orders siblings by this string, so it needs microsecond precision. */
function stamp(d = new Date()) {
  // YYYYMMDDTHHMMSSffffffZ — no separators at all; a stray '.' reads as a
  // second path segment and LangSmith rejects the run.
  return d.toISOString().replace(/[-:.]/g, '').replace('Z', '') + '000Z'
}

let warned = false
async function call(method, path, body) {
  if (!enabled()) return null
  try {
    const res = await fetch(`${ENDPOINT}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-api-key': KEY() },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok && !warned) {
      warned = true
      console.error(`  langsmith: ${method} ${path} → ${res.status} ${(await res.text()).slice(0, 160)}`)
    }
    return res.ok ? res : null
  } catch (e) {
    if (!warned) { warned = true; console.error(`  langsmith: ${String(e?.message ?? e).slice(0, 120)}`) }
    return null
  }
}

/** Create the project up front so a fresh account gets a named home, not a default. */
export async function ensureProject(name = PROJECT) {
  if (!enabled()) return false
  const res = await call('POST', `/sessions?upsert=true`, {
    name,
    description: 'E2B sandbox runs from the harness experiment rig — one trace per run, one child per arm.',
  })
  return !!res
}

/**
 * One node in the trace. `child()` nests, `end()` closes.
 * A span that is never ended shows in LangSmith as still running, which for a
 * wedged sandbox is exactly the right picture.
 */
class Span {
  constructor({ name, runType = 'chain', inputs = {}, metadata = {}, tags = [], parent = null, project = PROJECT }) {
    this.id = randomUUID()
    this.name = name
    this.project = project
    this.start = new Date()
    this.traceId = parent ? parent.traceId : this.id
    this.dotted = (parent ? parent.dotted + '.' : '') + stamp(this.start) + this.id
    this.ended = false
    this.posted = call('POST', '/runs', {
      id: this.id,
      trace_id: this.traceId,
      dotted_order: this.dotted,
      parent_run_id: parent?.id ?? null,
      session_name: project,
      name, run_type: runType,
      start_time: this.start.toISOString(),
      inputs,
      tags,
      extra: { metadata },
    })
  }

  child(opts) { return new Span({ ...opts, parent: this, project: this.project }) }

  /** Fire-and-forget close. Pass `error` as a string to mark the span failed. */
  async end({ outputs = {}, error = null, metadata = null } = {}) {
    if (this.ended) return
    this.ended = true
    await this.posted            // a PATCH that overtakes its POST is dropped
    return call('PATCH', `/runs/${this.id}`, {
      end_time: new Date().toISOString(),
      outputs,
      error: error ?? undefined,
      ...(metadata ? { extra: { metadata } } : {}),
    })
  }
}

export function startTrace(name, opts = {}) { return new Span({ name, ...opts }) }

/**
 * Token accounting in the shape LangSmith understands, so its own cost and
 * token columns line up with what the harness reports.
 */
export function usagePayload(usage = {}, model = null) {
  const input = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
  return {
    input_tokens: input,
    output_tokens: usage.output_tokens ?? 0,
    total_tokens: input + (usage.output_tokens ?? 0),
    input_token_details: {
      cache_read: usage.cache_read_input_tokens ?? 0,
      cache_creation: usage.cache_creation_input_tokens ?? 0,
    },
    output_token_details: { reasoning: usage.output_tokens_details?.thinking_tokens ?? 0 },
    ...(model ? { ls_model_name: model } : {}),
  }
}

/** Direct link to a project, for printing after a run. */
export function projectUrl(name = PROJECT) {
  return `https://smith.langchain.com/o/-/projects/p/${encodeURIComponent(name)}`
}
