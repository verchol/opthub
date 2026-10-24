/**
 * Secret resolution. A .env value may be a literal, or a 1Password secret
 * reference (`op://vault/item/field`) which is read through the `op` CLI at
 * run time — so the secret itself never lands on disk.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { ENV_FILE } from './lib/state.mjs'

export function parseEnvFile(file) {
  const out = {}
  if (!fs.existsSync(file)) return out
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (/^\s*#/.test(line)) continue
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  }
  return out
}

export const isOpRef = (v) => typeof v === 'string' && v.startsWith('op://')

// `op read` blocks on a Touch ID prompt. Unanswered — nobody at the keyboard, a
// locked vault, an expired session — it blocks forever, and since secrets are
// resolved at module load that wedges every command in the CLI with no output at
// all. A bounded wait turns that into the readable error below.
const OP_TIMEOUT_MS = Number(process.env.OP_TIMEOUT_MS ?? 20000)

export function opAvailable() {
  try { execFileSync('op', ['--version'], { stdio: 'pipe', timeout: 5000 }); return true } catch { return false }
}

/** Read one 1Password secret reference. Throws with a readable message. */
export function opRead(ref) {
  try {
    return execFileSync('op', ['read', '--no-newline', ref],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: OP_TIMEOUT_MS, killSignal: 'SIGKILL' }).toString()
  } catch (e) {
    if (e?.code === 'ETIMEDOUT' || e?.signal === 'SIGKILL')
      throw new Error(`1Password did not answer within ${Math.round(OP_TIMEOUT_MS / 1000)}s reading ${ref}\n` +
        `       Its Touch ID prompt is waiting, or the vault is locked.\n` +
        `       Unlock once with:  op read ${ref} > /dev/null\n` +
        `       For unattended runs: export OP_SERVICE_ACCOUNT_TOKEN=...  (or OP_TIMEOUT_MS to wait longer)`)
    const err = String(e?.stderr ?? e?.message ?? '').trim().split('\n').pop() || 'unknown error'
    if (/authorization|authenticat|not signed in|session expired|timeout/i.test(err))
      throw new Error(`1Password needs your approval to read ${ref}\n` +
        `       It raised a Touch ID / unlock prompt that was not answered in time.\n` +
        `       Approve it, or pre-authorise once with:  op read ${ref} > /dev/null\n` +
        `       For unattended runs, use a service account: export OP_SERVICE_ACCOUNT_TOKEN=...`)
    throw new Error(`1Password could not read ${ref}: ${err}`)
  }
}

/** Find plausible items when nothing is configured. Returns [{title, vault, ref}]. */
export function opFindAnthropic() {
  try {
    const items = JSON.parse(execFileSync('op', ['item', 'list', '--format', 'json'],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: OP_TIMEOUT_MS, killSignal: 'SIGKILL' }).toString())
    return items.filter((i) => /anthropic|claude/i.test(i.title ?? ''))
      .map((i) => ({ title: i.title, vault: i.vault?.name, ref: `op://${i.vault?.name}/${i.title}/token` }))
  } catch { return [] }
}

/**
 * Clean a pasted API key. Vault fields collect stray characters and duplicate
 * pastes; both are silent 401s later, so name them loudly rather than guess.
 */
export function sanitizeKey(raw) {
  const notes = []
  let v = String(raw ?? '').replace(/\s+/g, '')
  if (!v) return { key: '', notes: ['empty'] }

  const start = v.indexOf('sk-ant-')
  if (start < 0) return { key: v, notes: ['does not contain sk-ant-'] }
  if (start > 0) { notes.push(`dropped ${start} stray character(s) before the key`); v = v.slice(start) }

  const second = v.indexOf('sk-ant-', 1)
  if (second > 0) {
    const a = v.slice(0, second), b = v.slice(second)
    if (a === b) { notes.push('the key was stored twice; using one copy'); v = a }
    else { notes.push('two different keys are concatenated in this field; using the first'); v = a }
  }
  return { key: v, notes }
}

/** Live check. Returns { ok, status, message }. */
export async function verifyKey(key) {
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }),
    })
    if (r.ok) return { ok: true, status: r.status }
    const t = await r.text()
    let msg = t.slice(0, 160)
    try { msg = JSON.parse(t).error?.message ?? msg } catch {}
    return { ok: false, status: r.status, message: msg }
  } catch (e) { return { ok: false, status: 0, message: String(e?.message ?? e) } }
}

/**
 * Resolve every secret, applying op:// references. Mutates process.env.
 * Returns { [KEY]: { source, ref?, notes[] } } describing where each came from.
 */
export function resolveSecrets(keys = ['ANTHROPIC_API_KEY', 'E2B_API_KEY']) {
  const file = parseEnvFile(ENV_FILE)
  const report = {}
  for (const k of keys) {
    let notes = []
    let raw = process.env[k]
    let source = raw ? 'environment' : null

    // An op:// reference in .env is deliberate configuration; an inherited shell
    // variable is usually a leftover. Explicit configuration wins.
    if (isOpRef(file[k])) {
      if (raw) notes.push('ignoring the ANTHROPIC_API_KEY inherited from your shell — .env names a 1Password item')
      raw = file[k]; source = '.env'
    } else if (!raw && file[k]) {
      raw = file[k]; source = '.env'
    } else if (raw && file[k] && file[k] !== raw) {
      notes.push('your shell environment overrides the value in .env')
    }
    if (!raw) { report[k] = { source: null, notes }; continue }
    if (isOpRef(raw)) {
      const ref = raw
      if (!opAvailable()) { report[k] = { source: '1Password', ref, notes: ['`op` CLI not installed'], error: true }; continue }
      try { raw = opRead(ref); source = '1Password' } catch (e) {
        report[k] = { source: '1Password', ref, notes: [e.message], error: true }; continue
      }
      report[k] = { source: '1Password', ref, notes }
    } else {
      report[k] = { source, notes }
    }
    if (k === 'ANTHROPIC_API_KEY') {
      const s = sanitizeKey(raw)
      raw = s.key
      report[k].notes = [...(report[k].notes ?? []), ...s.notes]
      // `op read` can exit 0 with empty output when its auth prompt times out.
      // Passing that on shows up later as a bogus "API key is invalid".
      if (!raw || !/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(raw)) {
        report[k] = { ...report[k], error: true, length: raw.length,
          notes: [...(report[k].notes ?? []),
            raw ? `resolved to something that is not an API key (${raw.length} chars)`
                : 'resolved to an EMPTY value — 1Password most likely timed out waiting for approval'] }
        continue
      }
    } else {
      raw = String(raw).trim()
    }
    process.env[k] = raw
    report[k].length = raw.length
  }
  return report
}
