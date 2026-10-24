/**
 * Append-only, hash-chained decision log (opthub SPEC §9.2 format):
 *   hash = sha256(prev_hash + canonical JSON of the entry without its hash)
 * Editing, removing or reordering any line breaks `verifyAudit`.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { canonical } from './config.mjs'

export const GENESIS = '0'.repeat(64)
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')

export class AuditLog {
  constructor(file) {
    this.file = file
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.seq = 0
    this.prev = GENESIS
    if (fs.existsSync(file)) {        // resume the chain after a restart
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      if (lines.length) {
        const last = JSON.parse(lines.at(-1))
        this.seq = last.seq
        this.prev = last.hash
      }
    }
  }

  append(entry) {
    const e = { seq: ++this.seq, ts: new Date().toISOString(), ...entry, prev_hash: this.prev }
    e.hash = sha(this.prev + canonical(e))
    fs.appendFileSync(this.file, JSON.stringify(e) + '\n')
    this.prev = e.hash
    return e
  }
}

/** @returns {{ok:boolean, entries:number, brokenAt?:number, reason?:string}} */
export function verifyAudit(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  let prev = GENESIS
  for (let i = 0; i < lines.length; i++) {
    let e
    try { e = JSON.parse(lines[i]) } catch { return { ok: false, entries: lines.length, brokenAt: i + 1, reason: 'not JSON' } }
    const { hash, ...rest } = e
    if (rest.prev_hash !== prev) return { ok: false, entries: lines.length, brokenAt: i + 1, reason: 'prev_hash does not match the line before' }
    if (sha(prev + canonical(rest)) !== hash) return { ok: false, entries: lines.length, brokenAt: i + 1, reason: 'hash does not match content' }
    if (rest.seq !== i + 1) return { ok: false, entries: lines.length, brokenAt: i + 1, reason: 'sequence gap' }
    prev = hash
  }
  return { ok: true, entries: lines.length }
}

export function readAudit(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
}

/** Totals for the end-of-session summary and `opt claude optimize audit`. */
export function summarize(entries) {
  const s = { requests: 0, byClass: {}, byDecision: {}, acted: 0, costUsd: 0, counterfactualUsd: 0, errors: 0, fallbacks: 0, tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 } }
  for (const e of entries) {
    if (e.kind && e.kind !== 'request') continue
    s.requests++
    s.byClass[e.class] = (s.byClass[e.class] ?? 0) + 1
    s.byDecision[e.decision] = (s.byDecision[e.decision] ?? 0) + 1
    if (e.acted) s.acted++
    if (e.decision === 'fallback') s.fallbacks++
    if (e.status >= 400 || e.error) s.errors++
    s.costUsd += e.cost_usd ?? 0
    s.counterfactualUsd += e.counterfactual_usd ?? 0
    const u = e.usage ?? {}
    s.tokens.in += u.input_tokens ?? 0; s.tokens.out += u.output_tokens ?? 0
    s.tokens.cacheRead += u.cache_read_input_tokens ?? 0; s.tokens.cacheWrite += u.cache_creation_input_tokens ?? 0
  }
  return s
}
