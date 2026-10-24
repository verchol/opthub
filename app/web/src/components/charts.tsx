/**
 * Hand-drawn SVG charts for one session's per-turn series (/api/session), and where it
 * sits among every session. The per-turn numbers are measured, never spread evenly.
 */
import type { ReactNode } from 'react'
import type { SeriesPoint, Session } from '@/lib/api'
import { tok } from '@/lib/format'

const MONO = 'var(--font-mono)'

function Axes({ W, H, padL, padB, padT, padR, maxY, fmt }: { W: number; H: number; padL: number; padB: number; padT: number; padR: number; maxY: number; fmt: (v: number) => string }) {
  return (
    <>
      {[0, 0.25, 0.5, 0.75, 1].map((f) => {
        const v = maxY * f, y = H - padB - f * (H - padT - padB)
        return (
          <g key={f}>
            <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="var(--border)" />
            <text x={padL - 6} y={y + 3} textAnchor="end" fontSize={10} fill="var(--muted-foreground)" fontFamily={MONO}>{fmt(v)}</text>
          </g>
        )
      })}
    </>
  )
}

/** a swatch-and-label legend under a chart */
export function Legend({ items }: { items: { color: string; label: ReactNode; opacity?: number }[] }) {
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-4 font-mono text-[11px] text-muted-foreground">
      {items.map((it, i) => (
        <span key={i} className="flex items-center gap-1.5">
          <i className="inline-block size-[11px] shrink-0" style={{ background: it.color, opacity: it.opacity }} />{it.label}
        </span>
      ))}
    </div>
  )
}

/** one value per turn, as a line over a faint area */
export function LineChart({ series, get, fmt, color }: { series: SeriesPoint[]; get: (d: SeriesPoint) => number; fmt: (v: number) => string; color: string }) {
  const W = 640, H = 220, padL = 58, padB = 26, padT = 10, padR = 10
  const S = series, n = S.length
  if (!n) return null
  const maxY = Math.max(...S.map(get), 1e-9)
  const xf = (i: number) => padL + (n < 2 ? 0 : (i / (n - 1)) * (W - padL - padR)), yf = (v: number) => H - padB - (v / maxY) * (H - padT - padB)
  const pts = S.map((d, i) => xf(i).toFixed(1) + ',' + yf(get(d)).toFixed(1))
  const area = 'M' + xf(0).toFixed(1) + ',' + (H - padB) + ' L' + pts.join(' L') + ' L' + xf(n - 1).toFixed(1) + ',' + (H - padB) + ' Z'
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block w-full">
      <Axes W={W} H={H} padL={padL} padB={padB} padT={padT} padR={padR} maxY={maxY} fmt={fmt} />
      <path d={area} fill={color} opacity={0.12} />
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth={1.5} />
      <text x={W / 2} y={H - 4} textAnchor="middle" fontSize={10} fill="var(--muted-foreground)" fontFamily={MONO}>turn 1 → {n}</text>
    </svg>
  )
}

/** what the input was made of, priced, not just counted: cache reads bill 0.1x and writes 1.25x */
export function MixChart({ session: s }: { session: Session }) {
  const W = 640
  const r = s.modelTier === 'opus' ? { i: 15, o: 75 } : s.modelTier === 'haiku' ? { i: 1, o: 5 } : { i: 3, o: 15 }
  const parts = ([
    ['fresh input', s.freshInTokens * r.i / 1e6, 'var(--primary)'],
    ['cache writes', s.cacheWriteTokens * 1.25 * r.i / 1e6, 'var(--warn)'],
    ['cache reads', s.cacheReadTokens * 0.1 * r.i / 1e6, 'var(--muted-foreground)'],
    ['output', (s.outTokens - s.thinkingTokens) * r.o / 1e6, 'var(--violet)'],
    ['thinking', s.thinkingTokens * r.o / 1e6, 'var(--bad)'],
  ] as [string, number, string][]).filter((x) => x[1] > 0)
  const tot = parts.reduce((a, x) => a + x[1], 0) || 1
  let x = 0
  const bars = parts.map(([k, v, c]) => {
    const w = (v / tot) * W, el = <rect key={k} x={x.toFixed(1)} y={0} width={Math.max(0, w - 1).toFixed(1)} height={34} fill={c} opacity={0.8} />
    x += w
    return el
  })
  return (
    <>
      <svg viewBox={`0 0 ${W} 34`} className="block h-[34px] w-full" preserveAspectRatio="none">{bars}</svg>
      <Legend items={parts.map(([k, v, c]) => ({ color: c, label: `${k} $${v.toFixed(2)} · ${((v / tot) * 100).toFixed(0)}%` }))} />
    </>
  )
}

/** output per turn, the thinking part drawn over it */
export function BarsChart({ series }: { series: SeriesPoint[] }) {
  const W = 640, H = 180, padL = 58, padB = 26, padT = 10, padR = 10
  const S = series, n = S.length
  if (!n) return null
  const maxY = Math.max(...S.map((d) => d.out), 1), bw = Math.max(1, (W - padL - padR) / n - 0.5)
  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full">
        <Axes W={W} H={H} padL={padL} padB={padB} padT={padT} padR={padR} maxY={maxY} fmt={tok} />
        {S.map((d, i) => {
          const x = padL + (i / n) * (W - padL - padR)
          const h = (d.out / maxY) * (H - padT - padB), th = (d.think / maxY) * (H - padT - padB)
          return (
            <g key={i}>
              <rect x={x.toFixed(1)} y={(H - padB - h).toFixed(1)} width={bw.toFixed(1)} height={h.toFixed(1)} fill="var(--primary)" opacity={0.55} />
              {th > 0 && <rect x={x.toFixed(1)} y={(H - padB - th).toFixed(1)} width={bw.toFixed(1)} height={th.toFixed(1)} fill="var(--warn)" opacity={0.9} />}
            </g>
          )
        })}
      </svg>
      <Legend items={[{ color: 'var(--primary)', opacity: 0.55, label: 'output' }, { color: 'var(--warn)', label: 'thinking' }]} />
    </>
  )
}

/** every session by cost, the top 18, with this one marked (and appended if it is not among them) */
export function RankChart({ session: s, sessions }: { session: Session; sessions: Session[] }) {
  const all = [...sessions].sort((a, b) => b.cost - a.cost)
  const here = all.findIndex((x) => x.id === s.id)
  const top = all.slice(0, 18)
  const rows = top.some((x) => x.id === s.id) ? top : [...top.slice(0, 17), s]
  /* Three fixed columns — intent, bar, price — so no label's position depends on how
     wide its own text turns out to be. The bar can never reach PRICE, and PRICE stops
     well short of the viewBox edge: a label placed right after the bar left the single
     longest bar (the priciest session on the machine) as the one row with no number. */
  const W = 1000, BAR = 300, PRICE = 880, max = Math.max(...rows.map((x) => x.cost), 0.01)
  return (
    <>
      <svg viewBox={`0 0 ${W} ${rows.length * 26 + 4}`} className="block w-full">
        {rows.map((x, i) => {
          const w = (x.cost / max) * (PRICE - BAR - 80), me = x.id === s.id
          const txt = { fontSize: 11, fill: me ? 'var(--foreground)' : 'var(--muted-foreground)', fontFamily: MONO, fontWeight: me ? 700 : undefined }
          return (
            <g key={x.id} transform={`translate(0,${i * 26})`}>
              <rect x={BAR} y={4} width={Math.max(1, w).toFixed(0)} height={18} fill={me ? 'var(--primary)' : 'var(--muted-foreground)'} opacity={me ? 0.95 : 0.35} />
              {/* a caret in the gutter, so the marked row is found by shape and not by hue */}
              {me && <text x={0} y={17} fontSize={11} fill="var(--primary)" fontFamily={MONO} fontWeight={700}>▸</text>}
              <text x={12} y={17} {...txt}>{x.intent.slice(0, 40)}</text>
              <text x={PRICE} y={17} textAnchor="end" {...txt}>${x.cost.toFixed(2)}</text>
            </g>
          )
        })}
      </svg>
      <div className="mt-2.5 font-mono text-[11px] text-muted-foreground">rank {here + 1} of {all.length} by cost</div>
    </>
  )
}
