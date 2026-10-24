/**
 * One audit trail for every task `opt` runs: analyse, optimize, and whatever comes next.
 *
 *   $OPT_HOME/audit/tasks.jsonl     append-only, hash-chained (same format as lib/ult/audit.mjs)
 *
 * A task writes `start`, any number of progress events, and exactly one `end` or `error`.
 * Entries carry ids, labels, counts, hashes and money — never prompt text. Editing,
 * removing or reordering a line breaks `opt audit --verify`.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { STATE } from './state.mjs'
import { GENESIS, verifyAudit } from './ult/audit.mjs'
import { canonical } from './ult/config.mjs'

export const AUDIT_FILE = path.join(STATE, 'audit', 'tasks.jsonl')

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex')
export const newTaskId = (kind) => `${kind}-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`

/** Open a task. Returns a handle whose methods append to the shared chain. */
/** The last entry on disk, read from the tail so the log can grow without slowing appends. */
function lastEntry(file) {
  let fd
  try { fd = fs.openSync(file, 'r') } catch { return null }
  try {
    const size = fs.fstatSync(fd).size
    for (let span = 4096; ; span *= 4) {
      const start = Math.max(0, size - span)
      const buf = Buffer.alloc(size - start)
      fs.readSync(fd, buf, 0, buf.length, start)
      const lines = buf.toString('utf8').split('\n').filter(Boolean)
      if (lines.length > 1 || start === 0) return lines.length ? JSON.parse(lines.at(-1)) : null
    }
  } finally { fs.closeSync(fd) }
}

/**
 * Append one entry, chained to whatever is on disk *now*. Several tasks run at once (opt
 * optimize --eligible runs them in parallel), so no writer may keep its own idea of the tail.
 * Read-hash-append happens in one synchronous step, which serialises writers in this process.
 */
export function appendEntry(entry, file = AUDIT_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const last = lastEntry(file)
  const prev = last?.hash ?? GENESIS
  const e = { seq: (last?.seq ?? 0) + 1, ts: new Date().toISOString(), ...entry, prev_hash: prev }
  e.hash = sha256(prev + canonical(e))
  fs.appendFileSync(file, JSON.stringify(e) + '\n')
  return e
}

export function startTask(kind, fields = {}) {
  const task = newTaskId(kind)
  const t0 = Date.now()
  let closed = false
  const write = (event, data = {}) => appendEntry({ task, kind, event, ...data })
  write('start', fields)
  return {
    id: task,
    event: (name, data) => write(name, data),
    end: (data = {}) => { if (!closed) { closed = true; write('end', { ms: Date.now() - t0, ...data }) } },
    fail: (err, data = {}) => {
      if (closed) return
      closed = true
      write('error', { ms: Date.now() - t0, error: String(err?.message ?? err).slice(0, 300), ...data })
    },
  }
}

export function readTasks(file = AUDIT_FILE) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

/** Collapse the event stream into one row per task, newest first. */
export function summarizeTasks(entries) {
  const by = new Map()
  for (const e of entries) {
    const t = by.get(e.task) ?? { task: e.task, kind: e.kind, started: e.ts, state: 'running', events: 0 }
    t.events++
    if (e.event === 'start') Object.assign(t, { started: e.ts, start: e })
    // an `end` whose run reported an error is a failure, not a success with a footnote
    if (e.event === 'end') Object.assign(t, { state: e.is_error ? 'failed' : 'done', ended: e.ts, end: e })
    if (e.event === 'error') Object.assign(t, { state: 'failed', ended: e.ts, end: e })
    by.set(e.task, t)
  }
  return [...by.values()].sort((a, b) => String(b.started).localeCompare(String(a.started)))
}

export { verifyAudit }
