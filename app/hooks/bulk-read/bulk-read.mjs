#!/usr/bin/env node
/**
 * bulk-read — answer a question about large files with a cheap model, so the files never enter
 * the calling agent's context. The gate (gate.mjs) sends the agent here instead of a whole read.
 *
 *   node bulk-read.mjs --question "<what you need>" <file> [<file> …]
 *
 * The worker sees the files with line numbers and must cite them, so the agent can follow up
 * with a targeted read (Spotify's worker summaries lacked reliable line numbers; this fixes the
 * input side of that, not the model's accuracy).
 *
 * Two ways to reach the worker model (BULK_READ_VIA):
 *   api     POST $ANTHROPIC_BASE_URL/v1/messages with ANTHROPIC_API_KEY (x-api-key) or
 *           ANTHROPIC_AUTH_TOKEN (Bearer). The E2B arm uses this against its LiteLLM proxy,
 *           where BULK_READ_MODEL is a route alias. Priced with BULK_READ_PRICE_IN/_OUT ($/MTok).
 *   claude  `claude -p --model <worker>`: whatever credential and proxy Claude Code itself uses.
 *           The local Docker sandbox uses this: its egress goes through a proxy that Node's fetch
 *           does not read, and it may run on a subscription token. Priced by Claude Code.
 * Default: claude.
 *
 * Every call appends usage and cost to BULK_READ_LOG. The runners add that to the arm's cost:
 * this spend happens outside Claude Code's own accounting, and leaving it out would make the arm
 * look cheaper than it is. On failure the files are recorded in BULK_READ_STATE so the gate lets
 * the next whole read through, and the agent is told to read in ranges.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HOME = os.homedir()
export const cfg = () => ({
  model: process.env.BULK_READ_MODEL || 'claude-haiku-4-5',
  via: process.env.BULK_READ_VIA || 'claude',
  timeoutMs: Number(process.env.BULK_READ_TIMEOUT_MS) || 30000,
  maxChars: Number(process.env.BULK_READ_MAX_CHARS) || 400000,
  maxTokens: Number(process.env.BULK_READ_MAX_TOKENS) || 1500,
  priceIn: process.env.BULK_READ_PRICE_IN != null ? Number(process.env.BULK_READ_PRICE_IN) : null,
  priceOut: process.env.BULK_READ_PRICE_OUT != null ? Number(process.env.BULK_READ_PRICE_OUT) : null,
  log: process.env.BULK_READ_LOG || path.join(HOME, '.opthub', 'bulk-read.jsonl'),
  state: process.env.BULK_READ_STATE || path.join(HOME, '.opthub', 'bulk-read-state.json'),
  base: (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, ''),
})

export const SYSTEM = 'You answer questions about source files for a coding agent that cannot read them itself. '
  + 'Use only the files given. Reply in short bullets. Start every bullet with the path:line or the symbol name it rests on. '
  + 'Quote at most a few lines at a time. If the files do not answer the question, say exactly that. Do not speculate.'

export function parseArgs(argv) {
  const out = { question: null, files: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--question' || a === '-q') out.question = argv[++i]
    else if (a.startsWith('--question=')) out.question = a.slice(11)
    else if (a === '--help' || a === '-h') out.help = true
    else out.files.push(a)
  }
  return out
}

/** The worker's prompt: every file with line numbers, capped at maxChars in total. */
export function buildPrompt(question, files, maxChars) {
  let body = '', lines = 0, truncated = false
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8')
    const ls = text.split('\n')
    if (ls.length && ls[ls.length - 1] === '') ls.pop()
    lines += ls.length
    const numbered = `=== ${f} (${ls.length} lines) ===\n` + ls.map((l, i) => `${i + 1}\t${l}`).join('\n') + '\n\n'
    if (body.length + numbered.length > maxChars) {
      body += numbered.slice(0, Math.max(0, maxChars - body.length))
      body += `\n[truncated at ${maxChars} characters; ask about a narrower part]\n`
      truncated = true
      break
    }
    body += numbered
  }
  return { prompt: `${body}Question: ${question}`, lines, chars: body.length, truncated }
}

async function viaApi(c, prompt) {
  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }
  if (process.env.ANTHROPIC_API_KEY) headers['x-api-key'] = process.env.ANTHROPIC_API_KEY
  else if (process.env.ANTHROPIC_AUTH_TOKEN) headers.authorization = `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN}`
  else throw new Error('api mode needs ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN')
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), c.timeoutMs)
  try {
    const res = await fetch(`${c.base}/v1/messages`, { method: 'POST', headers, signal: ac.signal,
      body: JSON.stringify({ model: c.model, max_tokens: c.maxTokens, temperature: 0.2, system: SYSTEM,
                             messages: [{ role: 'user', content: prompt }] }) })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${j?.error?.message ?? 'no body'}`)
    const text = (j.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()
    const u = j.usage ?? {}
    const inTok = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    const outTok = u.output_tokens ?? 0
    const cost = c.priceIn != null && c.priceOut != null ? (inTok * c.priceIn + outTok * c.priceOut) / 1e6 : null
    return { text, inTok, outTok, cost }
  } finally { clearTimeout(timer) }
}

/** argv for the claude-mode worker: one turn, no tools, nothing persisted. */
export const claudeArgs = (model) => ['-p', '--model', model, '--output-format', 'json', '--max-turns', '1',
  '--no-session-persistence', '--disallowed-tools', 'Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'Task', 'NotebookEdit', 'TodoWrite']

function viaClaude(c, prompt) {
  const r = spawnSync(process.env.BULK_READ_CLAUDE || 'claude', claudeArgs(c.model),
    { input: `${SYSTEM}\n\n${prompt}`, encoding: 'utf8', timeout: c.timeoutMs, maxBuffer: 16 * 1024 * 1024 })
  if (r.error) throw new Error(r.error.code === 'ETIMEDOUT' ? `timed out after ${c.timeoutMs} ms` : r.error.message)
  let j; try { j = JSON.parse(r.stdout) } catch { throw new Error(`claude exited ${r.status}: ${(r.stderr || r.stdout || '').trim().slice(0, 200)}`) }
  if (j.is_error) throw new Error(String(j.result ?? 'worker error').slice(0, 200))
  const u = j.usage ?? {}
  const inTok = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
  return { text: String(j.result ?? '').trim(), inTok, outTok: u.output_tokens ?? 0, cost: j.total_cost_usd ?? null }
}

function append(file, rec) { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(rec) + '\n') } catch {} }
function markFailed(stateFile, files) {
  let s; try { s = JSON.parse(fs.readFileSync(stateFile, 'utf8')) } catch { s = { sessions: {}, failed: [] } }
  s.failed = [...new Set([...(s.failed ?? []), ...files])]
  try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(s)) } catch {}
}

export async function run(argv, c = cfg()) {
  const a = parseArgs(argv)
  if (a.help || !a.question || !a.files.length) {
    return { code: 2, out: 'usage: bulk-read --question "<what you need>" <file> [<file> ...]' }
  }
  const files = a.files.map((f) => path.resolve(f))
  const missing = files.filter((f) => !fs.existsSync(f))
  if (missing.length) return { code: 2, out: `bulk-read: no such file: ${missing.join(', ')}` }
  const t0 = Date.now()
  const p = buildPrompt(a.question, files, c.maxChars)
  const rec = { kind: 'worker', ts: new Date().toISOString(), via: c.via, model: c.model, files: files.length,
                lines: p.lines, chars: p.chars, truncated: p.truncated }
  try {
    const r = c.via === 'api' ? await viaApi(c, p.prompt) : viaClaude(c, p.prompt)
    append(c.log, { ...rec, ok: true, input_tokens: r.inTok, output_tokens: r.outTok, cost_usd: r.cost, ms: Date.now() - t0 })
    const foot = `\n(bulk-read: ${files.length} file(s), ${p.lines} lines, answered by ${c.model}${p.truncated ? '; input truncated' : ''}. `
      + 'For exact text, read the cited range with offset and limit.)'
    return { code: 0, out: (r.text || '(the worker returned no text)') + foot }
  } catch (e) {
    append(c.log, { ...rec, ok: false, error: String(e?.message ?? e).slice(0, 200), ms: Date.now() - t0 })
    markFailed(c.state, files)
    return { code: 1, out: `bulk-read failed: ${e?.message ?? e}\nRead the file in ranges instead (Read with offset and limit), or grep for what you need. A whole read of it is now allowed.` }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then((r) => { (r.code === 0 ? process.stdout : process.stderr).write(r.out + '\n'); process.exit(r.code) })
}
