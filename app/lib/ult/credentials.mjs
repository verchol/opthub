/**
 * The Claude subscription credential for sandboxed sessions.
 *
 * A container cannot use the Mac's own Claude Code login, so the subscription travels as the
 * long-lived token `claude setup-token` issues — billed to the plan, not to API credits.
 * `opt claude optimize login` stores it here: the macOS Keychain, or a 0600 file elsewhere.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const KEYCHAIN_SERVICE = 'opthub-claude-subscription'
const SERVICES = { oauth: KEYCHAIN_SERVICE, 'api-key': 'opthub-anthropic-api-key' }
const fileFor = (kind) => path.join(os.homedir(), '.opthub', 'credentials', kind === 'api-key' ? 'anthropic-api-key' : 'claude-subscription')
const mac = process.platform === 'darwin'

export function storedTokenLocation(kind = 'oauth') {
  return mac ? `macOS Keychain · ${SERVICES[kind]}` : fileFor(kind)
}

export function readStoredToken(kind = 'oauth') {
  if (mac) {
    const r = spawnSync('security', ['find-generic-password', '-s', SERVICES[kind], '-a', os.userInfo().username, '-w'], { encoding: 'utf8' })
    return r.status === 0 ? r.stdout.trim() || null : null
  }
  try { return fs.readFileSync(fileFor(kind), 'utf8').trim() || null } catch { return null }
}

export function storeToken(token, kind = 'oauth') {
  if (mac) {
    // -U updates an existing item. The value goes to `security`, a child of this process only;
    // it is never written to disk in the clear.
    const label = kind === 'api-key' ? 'opthub — Anthropic API key for sandboxed sessions' : 'opthub — Claude subscription token for sandboxed sessions'
    const r = spawnSync('security', ['add-generic-password', '-U', '-s', SERVICES[kind], '-a', os.userInfo().username, '-l', label, '-w', token], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`could not save to the Keychain: ${r.stderr.trim()}`)
    return
  }
  fs.mkdirSync(path.dirname(fileFor(kind)), { recursive: true, mode: 0o700 })
  fs.writeFileSync(fileFor(kind), token + '\n', { mode: 0o600 })
}

export function deleteStoredToken(kind = 'oauth') {
  if (mac) return spawnSync('security', ['delete-generic-password', '-s', SERVICES[kind], '-a', os.userInfo().username]).status === 0
  try { fs.rmSync(fileFor(kind)); return true } catch { return false }
}

/** sk-ant-oat… is a subscription token, sk-ant-api… an API key; anything else is treated as a subscription token. */
export function credentialKind(value) {
  return /^sk-ant-api/.test(value) ? 'api-key' : 'oauth'
}

export function credentialFromValue(value, source) {
  const kind = credentialKind(value)
  return { kind, value, env: kind === 'api-key' ? 'ANTHROPIC_API_KEY' : 'CLAUDE_CODE_OAUTH_TOKEN', source }
}

/** AUTH_MODE / ULT_AUTH_MODE: subscription (default) or api-key. */
export const authMode = (env = process.env) => (env.ULT_AUTH_MODE ?? env.AUTH_MODE ?? 'subscription') === 'api-key' ? 'api-key' : 'subscription'

const usable = (v) => v && !String(v).startsWith('op://') ? v : null

/**
 * What the launcher hands the router. Subscription is the default and never falls back to
 * an API key; an API key is used only when AUTH_MODE=api-key says so.
 * @returns {{kind:'oauth'|'api-key', value:string, env:string, source:string}|null}
 */
export function launcherCredential(env = process.env, { secretReport = null, readStored = readStoredToken } = {}) {
  if (authMode(env) === 'api-key') {
    const storedKey = readStored('api-key')
    if (storedKey) return { kind: 'api-key', value: storedKey, env: 'ANTHROPIC_API_KEY', source: storedTokenLocation('api-key') }
    const key = usable(env.ANTHROPIC_API_KEY)
    return key ? { kind: 'api-key', value: key, env: 'ANTHROPIC_API_KEY', source: secretReport?.ANTHROPIC_API_KEY?.source ?? 'environment' } : null
  }
  const stored = readStored('oauth')
  if (stored) return { kind: 'oauth', value: stored, env: 'CLAUDE_CODE_OAUTH_TOKEN', source: storedTokenLocation() }
  const tok = usable(env.CLAUDE_CODE_OAUTH_TOKEN)
  return tok ? { kind: 'oauth', value: tok, env: 'CLAUDE_CODE_OAUTH_TOKEN', source: secretReport?.CLAUDE_CODE_OAUTH_TOKEN?.source === '1Password' ? '1Password' : 'your shell or the repo .env' } : null
}
