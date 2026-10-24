/**
 * `opt models bench [model]` — measure what this machine's Ollama can serve (layer 3 of
 * docs/local-inference-capacity.md). Free: local inference only.
 *
 * Sends synthetic prompts at the sizes Claude Code sends (1K to 32K tokens, capped at num_ctx) at
 * concurrency 1..N, three repeats each, a fresh nonce per request so Ollama cannot reuse a cached
 * prefix. Records time to first token, prefill and decode tokens/second (Ollama's own counters), and
 * the memory the model holds. The profile it writes ($OPT_HOME/bench/<model>.json) is what the
 * router's capacity guards read: the largest prompt whose first token arrives within the budget, and
 * the most requests in flight that still do.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { benchFile } from './ult/capacity.mjs'

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null }

function prompt(tokens, nonce) {
  const line = 'Row {i}: the quick brown fox jumps over the lazy dog near the river bank.\n'
  const rows = Math.max(1, Math.floor((tokens * 4) / line.length))
  return `Bench ${nonce}. Reply with OK.\n` + Array.from({ length: rows }, (_, i) => line.replace('{i}', String(i))).join('')
}

/** One streamed /api/generate call: time to first token and Ollama's own counters. */
async function one({ baseUrl, model, tokens, numCtx, nonce, fetchImpl }) {
  const t0 = Date.now()
  const r = await fetchImpl(`${baseUrl}/api/generate`, {
    method: 'POST', signal: AbortSignal.timeout(600000),
    body: JSON.stringify({ model, prompt: prompt(tokens, nonce), stream: true, keep_alive: '30m',
                           options: { num_ctx: numCtx, num_predict: 32, temperature: 0 } }),
  })
  if (!r.ok) throw new Error(`/api/generate ${r.status}`)
  let ttft = null, buf = '', last = null
  for await (const chunk of r.body) {
    buf += Buffer.from(chunk).toString('utf8')
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      if (!line.trim()) continue
      const d = JSON.parse(line)
      if (ttft === null && (d.response || d.done)) ttft = Date.now() - t0
      if (d.done) last = d
    }
  }
  if (buf.trim()) { const d = JSON.parse(buf); if (d.done) last = d; if (ttft === null) ttft = Date.now() - t0 }
  const rate = (n, ns) => (n && ns ? n / (ns / 1e9) : null)
  return { ttftMs: ttft, promptTokens: last?.prompt_eval_count ?? null,
           prefillTps: rate(last?.prompt_eval_count, last?.prompt_eval_duration), decodeTps: rate(last?.eval_count, last?.eval_duration) }
}

/**
 * @returns {Promise<object>} the capacity profile (schema opthub.capacity/1)
 */
export async function bench({ baseUrl, model, sizes = [1000, 4000, 16000, 32000], concurrency = 2, repeats = 3,
                              numCtx = 65536, budgetMs = 5000, fetchImpl = fetch, onStep = () => {} }) {
  baseUrl = baseUrl.replace(/\/$/, '')
  const version = await fetchImpl(`${baseUrl}/api/version`).then((r) => r.json()).then((j) => j.version).catch(() => null)
  const usable = sizes.filter((s) => s <= numCtx - 256)
  const results = []
  let n = 0
  for (const tokens of usable) {
    for (let c = 1; c <= concurrency; c++) {
      const runs = []
      for (let rep = 0; rep < repeats; rep++) {
        runs.push(...await Promise.all(Array.from({ length: c }, () => one({ baseUrl, model, tokens, numCtx, nonce: `${Date.now()}-${n++}`, fetchImpl }))))
      }
      const row = { tokens, concurrency: c, repeats, ttftMs: median(runs.map((x) => x.ttftMs)), ttftMaxMs: Math.max(...runs.map((x) => x.ttftMs)),
                    promptTokens: median(runs.map((x) => x.promptTokens)), prefillTps: median(runs.map((x) => x.prefillTps)),
                    decodeTps: median(runs.map((x) => x.decodeTps)) }
      results.push(row)
      onStep(row)
    }
  }
  const ps = await fetchImpl(`${baseUrl}/api/ps`).then((r) => r.json()).catch(() => ({ models: [] }))
  const loaded = (ps.models ?? []).find((m) => m.name === model || m.model === model)
  const fits = (r) => r.ttftMs != null && r.ttftMs <= budgetMs
  // Largest prompt alone within budget; then the most in flight at which every prompt up to it still is.
  const single = results.filter((r) => r.concurrency === 1 && fits(r)).map((r) => r.tokens)
  const maxTok = single.length ? Math.max(...single) : 0
  const parallel = [...new Set(results.map((r) => r.concurrency))]
    .filter((c) => results.filter((r) => r.concurrency === c && r.tokens <= maxTok).every(fits) && maxTok > 0)
  return {
    schema: 'opthub.capacity/1', model, date: new Date().toISOString().slice(0, 10), ollama: version,
    machine: { platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model ?? null, memoryBytes: os.totalmem() },
    numCtx, budgetMs, repeats, results,
    memory: loaded ? { bytes: loaded.size ?? null, vramBytes: loaded.size_vram ?? null } : null,
    recommended: {
      maxPromptTokens: maxTok,
      maxInFlight: parallel.length ? Math.max(...parallel) : 0,
      note: single.length ? null : `no tested prompt got its first token within ${budgetMs} ms: nothing should go local on this machine`,
    },
  }
}

export function saveProfile(stateDir, profile) {
  const f = benchFile(stateDir, profile.model)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, JSON.stringify(profile, null, 1))
  return f
}
