/** Number and date formatting, as the hub has always shown them. */

export const fmtM = (v: number) => (v >= 60 ? (v / 60).toFixed(1) + 'h' : Math.round(v) + 'm')

export const usd = (v: number | null | undefined) =>
  v == null ? '—' : '$' + Number(v).toFixed(Number(v) < 10 ? (Number(v) < 0.1 ? 4 : 2) : 0)

export const modelOf = (m: string | null | undefined) =>
  String(m ?? '').replace(/^.*?anthropic\./, '').replace(/-v1.*|:.*/, '').replace(/claude-/, '')

export const tok = (n: number | null | undefined) => {
  n = Number(n || 0)
  return n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1000 ? (n / 1000).toFixed(n >= 1e5 ? 0 : 1) + 'k' : String(n)
}

export const ago = (iso: string | null | undefined) => {
  if (!iso) return '—'
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  return s < 90 ? Math.round(s) + 's ago' : s < 5400 ? Math.round(s / 60) + 'm ago' : s < 172800 ? Math.round(s / 3600) + 'h ago' : Math.round(s / 86400) + 'd ago'
}

export const pct = (v: number | null | undefined) => (v == null ? '—' : Math.round(100 * v) + '%')

/** nearest-rank percentile on a sorted array */
export const pq = (v: number[], q: number) => (v.length ? v[Math.min(v.length - 1, Math.max(0, Math.ceil(q * v.length) - 1))] : 0)

export function stats(vals: number[]) {
  const v = [...vals].sort((a, b) => a - b)
  return { n: v.length, min: v[0] || 0, p50: pq(v, 0.5), p95: pq(v, 0.95), p99: pq(v, 0.99), max: v[v.length - 1] || 0, sum: v.reduce((a, b) => a + b, 0) }
}
export type Stats = ReturnType<typeof stats>

/** categorical palette shared by Classes and Similar, so a category keeps its colour */
export const PAL = ['#2A9D8F', '#E76F51', '#457B9D', '#E9B949', '#8E5EA2', '#F4A261', '#3FA34D', '#D1495B', '#00A6D6', '#B07AA1', '#7F8C3A', '#C46A2F']
export const PAL_REST = '#8B9C9E'
