/**
 * Which sessions are still going, and how sure we are.
 *
 * Claude Code appends to a transcript and closes it again, so `lsof` on the
 * file tells you nothing — it is never held open. The signals that do work:
 *
 *   mtime   how long since the session last wrote anything
 *   cwd     a running `claude` process's working directory, matched against
 *           the session's own cwd
 *
 * Neither is conclusive on its own, so the status says which one it is
 * standing on:
 *
 *   live    wrote something in the last 90s — producing right now
 *   open    a claude process is running in this session's directory and this is
 *           the newest transcript there: on screen, waiting on the human
 *   idle    wrote recently, but nothing is running there any more
 *   closed  neither
 *
 * The honest limit: two sessions in one directory share a cwd, so `open` is
 * awarded to the newest transcript there. It can be wrong about which of two
 * sibling sessions is the one on screen; it is not wrong that one of them is.
 */
import { execFileSync } from 'node:child_process'
import { buildIndex } from './sessions-index.mjs'
import { withinCreated } from './daterange.mjs'
import os from 'node:os'

export const LIVE_MS = 90 * 1000
export const IDLE_MS = 30 * 60 * 1000

const sh = (cmd, args) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }) }
  catch { return '' }
}

/** Working directories of every running `claude`, resolved through lsof. */
export function runningClaudeCwds() {
  const pids = sh('pgrep', ['-x', 'claude']).split('\n').map((s) => s.trim()).filter(Boolean)
  const out = new Map()   // cwd -> [pid]
  for (const pid of pids) {
    const cwd = sh('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn']).split('\n')
      .find((l) => l.startsWith('n'))?.slice(1)
    if (!cwd) continue
    if (!out.has(cwd)) out.set(cwd, [])
    out.get(cwd).push(Number(pid))
  }
  return out
}

const abs = (cwd) => String(cwd ?? '').replace(/^~/, os.homedir())

/**
 * Sessions with a status, newest first. `onlyOpen` keeps just the ones a person
 * could still be sitting in front of.
 */
export function watchList({ limit = 500, onlyOpen = false, created = null } = {}) {
  const idx = buildIndex({ limit })
  const procs = runningClaudeCwds()
  const now = Date.now()

  // one cwd can hold several sessions; only its newest can claim "open"
  const newestByCwd = new Map()
  for (const s of idx.sessions) {
    const c = abs(s.cwd), t = s.endedAt ? Date.parse(s.endedAt) : 0
    if (!newestByCwd.has(c) || t > newestByCwd.get(c).t) newestByCwd.set(c, { id: s.id, t })
  }

  const rows = idx.sessions.map((s) => {
    const age = s.endedAt ? now - Date.parse(s.endedAt) : Infinity
    const c = abs(s.cwd)
    const pids = procs.get(c) ?? []
    const isNewestHere = newestByCwd.get(c)?.id === s.id
    const status = age < LIVE_MS ? 'live'
      : (pids.length && isNewestHere) ? 'open'
      : age < IDLE_MS ? 'idle'
      : 'closed'
    return { ...s, status, ageMs: age, pids: status === 'open' || status === 'live' ? pids : [] }
  })

  const ORDER = { live: 0, open: 1, idle: 2, closed: 3 }
  rows.sort((a, b) => (ORDER[a.status] - ORDER[b.status]) || a.ageMs - b.ageMs)

  // Filter first, then count: a header that tallies 154 sessions above a table
  // showing 3 is describing something the reader cannot see.
  const shown = withinCreated(
    onlyOpen ? rows.filter((r) => r.status === 'live' || r.status === 'open') : rows,
    created ?? {})
  const tally = (list) => list.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {})
  const counts = tally(shown)
  return {
    generatedAt: new Date().toISOString(),
    // buildIndex's own totals, carried through, plus what watching adds
    totals: { ...idx.totals, live: counts.live ?? 0, open: counts.open ?? 0, shown: shown.length },
    counts,
    countsAll: tally(rows),          // the whole store, for "3 of 154"
    processes: [...procs.entries()].map(([cwd, pids]) => ({ cwd, pids })),
    sessions: shown,
  }
}
