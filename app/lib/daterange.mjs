/**
 * Date specs for filtering sessions by when they were *created*.
 *
 * Creation is a different question from last activity, and the difference is
 * not academic here: a resumed session can be four days old and still writing.
 * Filtering on `startedAt` answers "what did I begin this week"; filtering on
 * `endedAt` answers "what has touched disk lately". Both are useful; this file
 * is the first one.
 *
 * Accepted, in one grammar shared by the CLI and the hub:
 *
 *   all | any            no filter
 *   today | yesterday    that calendar day, local time
 *   7d  48h  90m  2w     relative window ending now
 *   2026-09-01           that whole calendar day
 *   2026-09-01..09-05    inclusive range, either end optional
 *   ..2026-09-05         everything up to and including that day
 */
const DAY = 86400e3
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime() }
const isoDay = (str) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str.trim())
  if (!m) return null
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
  return Number.isFinite(t) ? t : null
}

/** → {from, to} in ms, either side null for open-ended. `undefined` if unparseable. */
export function parseDateSpec(spec, now = Date.now()) {
  if (spec == null) return { from: null, to: null }
  const raw = String(spec).trim().toLowerCase()
  if (!raw || raw === 'all' || raw === 'any') return { from: null, to: null }
  if (raw === 'today') return { from: startOfDay(now), to: startOfDay(now) + DAY - 1 }
  if (raw === 'yesterday') return { from: startOfDay(now) - DAY, to: startOfDay(now) - 1 }

  if (raw.includes('..')) {
    const [a, b] = raw.split('..')
    const from = a ? isoDay(a) : null, to = b ? isoDay(b) : null
    if ((a && from == null) || (b && to == null)) return undefined
    return { from, to: to == null ? null : to + DAY - 1 }
  }
  const day = isoDay(raw)
  if (day != null) return { from: day, to: day + DAY - 1 }

  const rel = /^(\d+(?:\.\d+)?)\s*([mhdw])?$/.exec(raw)
  if (!rel) return undefined
  const mult = { m: 60e3, h: 3600e3, d: DAY, w: 7 * DAY }[rel[2] ?? 'h']
  return { from: now - Number(rel[1]) * mult, to: null }
}

/** Sessions created inside the range. An undated session is never inside one. */
export function withinCreated(sessions, { from, to } = {}, field = 'startedAt') {
  if (from == null && to == null) return sessions
  return sessions.filter((s) => {
    const t = s[field] ? Date.parse(s[field]) : NaN
    if (!Number.isFinite(t)) return false
    return (from == null || t >= from) && (to == null || t <= to)
  })
}

// local, not toISOString(): the ranges are built from local midnight, so
// formatting them in UTC made "today" straddle two dates east of Greenwich
const d = (ms) => {
  const x = new Date(ms)
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
}

export function describeRange({ from, to } = {}, now = Date.now()) {
  if (from == null && to == null) return 'any date'
  if (from != null && to != null) {
    if (d(from) === d(to)) return d(from) === d(now) ? 'today' : d(from)
    return `${d(from)} → ${d(to)}`
  }
  if (to == null) {
    const mins = (now - from) / 60e3, h = mins / 60
    if (mins < 180) return `last ${Math.round(mins)}m`
    if (h > 48) return `last ${Math.round(h / 24)}d`
    return `last ${Math.round(h)}h`
  }
  return `up to ${d(to)}`
}
