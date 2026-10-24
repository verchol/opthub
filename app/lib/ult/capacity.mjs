/**
 * Capacity guards for the local tier (docs/local-inference-capacity.md, layers 1-2; release plan
 * "Local cloud"). A request goes to Ollama only if the model fits in memory, the prompt fits the
 * context Ollama runs with, a slot is free, and recent local calls have not been failing. Anything
 * else goes to the Anthropic model at once, with the reason in the audit log:
 *
 *   no-fit    weights + KV cache at num_ctx exceed the memory the GPU can use, or the model is not pulled
 *   unreachable Ollama did not answer the fit check (re-checked after 30 s, never cached as a verdict)
 *   context   the prompt is longer than the context the local model runs with
 *   busy      every slot (OLLAMA_NUM_PARALLEL) is taken; Ollama would queue it, silently
 *   breaker   the last N local calls failed or were slow; local is off for a cooldown
 *   slow      no first token within the budget (decided while forwarding, see upstream.forwardLocal)
 *   malformed a tool call the client could not use (decided while forwarding)
 *
 * The caps come from config.local, or from the machine's own `opt models bench` profile when one
 * exists for the model: measured beats assumed.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const GPU_SHARE = 0.75          // unified memory the GPU may use on Apple silicon; a guess on other machines
const KV_BYTES = { f16: 2, q8_0: 1, q4_0: 0.5 }

/** Tokens in a request, estimated at 4 characters each (Ollama does not count for us before the call). */
export function estimateTokens(body) {
  const text = JSON.stringify([body?.system ?? '', body?.messages ?? [], body?.tools ?? []])
  return Math.ceil(text.length / 4)
}

export function benchFile(stateDir, model) {
  return path.join(stateDir, 'bench', `${String(model).replace(/[^\w.-]+/g, '_')}.json`)
}

/** The machine's measured capacity for a model, written by `opt models bench`. */
export function loadProfile(stateDir, model) {
  try { return JSON.parse(fs.readFileSync(benchFile(stateDir, model), 'utf8')) } catch { return null }
}

/** The caps in force: config, overridden by a bench profile's measured values. */
export function caps(local, profile) {
  const rec = profile?.recommended ?? local.bench ?? {}
  return {
    numCtx: Math.min(local.numCtx ?? 65536, rec.maxPromptTokens ?? Infinity),
    maxInFlight: rec.maxInFlight ?? local.maxInFlight ?? 1,
    firstTokenMs: local.firstTokenMs ?? 5000,
    failures: local.breaker?.failures ?? 3,
    cooldownMs: local.breaker?.cooldownMs ?? 300000,
    source: profile ? `bench ${profile.date}` : 'config',
  }
}

/**
 * Layer 1: will the model fit? Weights from /api/tags, layer shape from /api/show, other loaded
 * models from /api/ps. An estimate: the label in the audit log says so.
 */
export async function fitCheck({ baseUrl, model, numCtx, kvType = 'q8_0', totalMem = os.totalmem(), fetchImpl = fetch }) {
  const get = async (p, init) => {
    const r = await fetchImpl(baseUrl.replace(/\/$/, '') + p, { ...init, signal: AbortSignal.timeout(10000) })
    if (!r.ok) throw new Error(`${p} ${r.status}`)
    return r.json()
  }
  try {
    const [tags, show, ps] = await Promise.all([get('/api/tags'), get('/api/show', { method: 'POST', body: JSON.stringify({ model }) }), get('/api/ps')])
    const tag = (tags.models ?? []).find((m) => m.name === model || m.model === model)
    if (!tag) return { ok: false, why: `${model} is not pulled` }
    const info = show.model_info ?? {}
    const arch = info['general.architecture']
    const n = (k) => Number(info[`${arch}.${k}`] ?? 0)
    const layers = n('block_count'), kvHeads = n('attention.head_count_kv') || n('attention.head_count')
    const headDim = n('attention.key_length') || (n('embedding_length') / (n('attention.head_count') || 1))
    const native = n('context_length') || Infinity
    const ctx = Math.min(numCtx, native)
    const kv = 2 * layers * kvHeads * headDim * ctx * (KV_BYTES[kvType] ?? 2)
    const others = (ps.models ?? []).filter((m) => m.name !== model).reduce((a, m) => a + (m.size ?? 0), 0)
    const need = (tag.size ?? 0) + kv, have = totalMem * GPU_SHARE - others
    return { ok: need <= have, needBytes: Math.round(need), haveBytes: Math.round(have), numCtx: ctx,
             why: need <= have ? null : `needs ${(need / 2 ** 30).toFixed(1)} GiB at ${ctx} tokens, ${(have / 2 ** 30).toFixed(1)} GiB available` }
  } catch (e) {
    return { ok: false, reason: 'unreachable', why: `Ollama did not answer at ${baseUrl}: ${e.message}` }
  }
}

/** Layer 2: admission control, one instance per router. */
export class LocalGate {
  constructor({ caps: c, now = Date.now }) {
    this.c = c; this.now = now
    this.inFlight = 0; this.failures = 0; this.openUntil = 0
    this.fitter = null              // model -> promise of fitCheck's result, set by the router
    this.fits = new Map()
    this.counts = {}
  }
  fitFor(model) {
    if (!this.fitter) return Promise.resolve({ ok: true })
    const hit = this.fits.get(model)
    if (hit && !(hit.unreachable && this.now() - hit.at > 30000)) return hit.p
    const entry = { at: this.now(), unreachable: false, p: null }
    entry.p = this.fitter(model).then((r) => { entry.unreachable = r.reason === 'unreachable'; return r })
    this.fits.set(model, entry)
    return entry.p
  }
  async admit(promptTokens, model) {
    const fit = await this.fitFor(model)
    if (!fit.ok) return { ok: false, reason: fit.reason ?? 'no-fit', why: fit.why }
    if (this.now() < this.openUntil) return { ok: false, reason: 'breaker', why: `local off until ${new Date(this.openUntil).toISOString()}` }
    const ctx = Math.min(this.c.numCtx, fit.numCtx ?? Infinity)
    if (promptTokens > ctx) return { ok: false, reason: 'context', why: `~${promptTokens} tokens > num_ctx ${ctx}` }
    if (this.inFlight >= this.c.maxInFlight) return { ok: false, reason: 'busy', why: `${this.inFlight} of ${this.c.maxInFlight} slots taken` }
    return { ok: true }
  }
  start() { this.inFlight++ }
  /** outcome: 'ok', or the reason the local call failed ('slow', 'malformed', 'failed'). */
  end(outcome) {
    this.inFlight = Math.max(0, this.inFlight - 1)
    if (outcome === 'ok') { this.failures = 0; return }
    if (++this.failures >= this.c.failures) { this.openUntil = this.now() + this.c.cooldownMs; this.failures = 0 }
  }
  count(reason) { this.counts[reason] = (this.counts[reason] ?? 0) + 1 }
}

/** Every local model the config can send work to: the side model and each local: or scoped: route. */
export function localModels(config) {
  const out = new Set(config.local?.enabled ? [config.local.model] : [])
  for (const t of Object.values(config.policy?.routes ?? {})) {
    if (t.startsWith('local:')) out.add(t.slice(6))
    if (t.startsWith('scoped:')) out.add(t.slice(7))
  }
  return [...out]
}

/** Load the model before the first real request pays for it, and keep it loaded. Best effort. */
export async function warmLocal({ baseUrl, model, keepAlive = '30m', fetchImpl = fetch }) {
  try {
    const r = await fetchImpl(baseUrl.replace(/\/$/, '') + '/api/generate', {
      method: 'POST', body: JSON.stringify({ model, prompt: '', keep_alive: keepAlive }), signal: AbortSignal.timeout(120000),
    })
    return { ok: r.ok, status: r.status }
  } catch (e) {
    return { ok: false, status: 0, error: e.message }
  }
}
