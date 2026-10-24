/** One experiment: its arms, the blind verdict and the spider chart. */
import { Button } from '@/components/ui/button'
import { Blk, Empty, Kv, Pill } from '@/components/hub'
import type { Arm, Run, Session } from '@/lib/api'
import { ago, usd } from '@/lib/format'
import { expsOf, expTitle, isLivePhase, useHub } from '@/store'
import { DetailTitle, Eyebrow, Mut } from './shared'

/* the spider: each arm on cost, speed, accuracy and turns, scaled so the outside edge is the
   best value any arm reached. Arms are compared with each other, never with the original session. */
export function Spider({ run: r }: { run: Run }) {
  const A = (r.arms || []).filter((a) => !a.isError)
  if (!A.length) return null
  const low = (f: (a: Arm) => number | null | undefined) => {
    const v = A.map(f).filter((x): x is number => x != null && x > 0)
    const m = v.length ? Math.min(...v) : null
    return (a: Arm) => { const x = f(a); return m && x != null && x > 0 ? m / x : null }
  }
  const AX: [string, string, (a: Arm) => number | null][] = [
    ['cost', 'Cost', low((a) => a.cost)], ['latency', 'Speed', low((a) => a.secs)],
    ['accuracy', 'Accuracy', (a) => (a.score != null && r.scoreMax ? a.score / r.scoreMax : null)], ['turns', 'Fewer turns', low((a) => a.turns)],
  ]
  const W = 360, H = 270, cx = 180, cy = 135, R = 92, n = AX.length
  const pt = (i: number, v: number) => { const t = -Math.PI / 2 + i * 2 * Math.PI / n; return [cx + Math.cos(t) * R * v, cy + Math.sin(t) * R * v] }
  const pts = (f: (i: number) => number) => AX.map((_, i) => pt(i, f(i)).map((x) => x.toFixed(1)).join(',')).join(' ')
  const goal = r.goal || 'cost'
  const COL = ['var(--primary)', 'var(--warn)', 'var(--violet)'], opt = A.filter((a) => a.role !== 'baseline')
  const colOf = (a: Arm) => (a.role === 'baseline' ? 'var(--muted-foreground)' : COL[opt.indexOf(a) % COL.length])
  return (
    <>
      <svg className="mx-auto mt-1.5 block w-full max-w-[360px] font-mono" viewBox={`0 0 ${W} ${H}`}>
        {[0.25, 0.5, 0.75, 1].map((f) => <polygon key={f} points={pts(() => f)} fill="none" stroke="var(--border)" />)}
        {AX.map(([k, l], i) => {
          const [x, y] = pt(i, 1), [lx, ly] = pt(i, 1.2), on = k === goal
          return (
            <g key={k}>
              <line x1={cx} y1={cy} x2={x.toFixed(1)} y2={y.toFixed(1)} stroke="var(--border)" />
              <text x={lx.toFixed(1)} y={(ly + 4).toFixed(1)} textAnchor={Math.abs(lx - cx) < 2 ? 'middle' : lx < cx ? 'end' : 'start'}
                fontSize={on ? 12 : 10.5} fontWeight={on ? 700 : 400} fill={on ? 'var(--foreground)' : 'var(--muted-foreground)'}>{l}{on ? ' ★' : ''}</text>
            </g>
          )
        })}
        {A.map((a, j) => {
          const c = colOf(a)
          return <polygon key={j} points={pts((i) => AX[i][2](a) || 0)} fill={c} fillOpacity={0.14} stroke={c} strokeWidth={2}
            strokeDasharray={a.role === 'baseline' ? '4 3' : undefined} />
        })}
      </svg>
      <div className="mt-0.5 mb-2 text-center">
        {A.map((a, j) => (
          <span key={j} className="mr-3 inline-flex items-center gap-1.5 text-[11.5px]">
            <span className="inline-block h-[3px] w-3" style={{ background: colOf(a) }} />{a.label}
          </span>
        ))}
      </div>
    </>
  )
}

export function ExperimentDetail({ run: r }: { run: Run | undefined }) {
  const h = useHub()
  if (!r) return <Empty title="Pick an experiment">Its goal, the spider chart against the baseline, and the verdict.</Empty>
  const busy = isLivePhase(r.phase)
  const A = r.arms || []
  const headline = r.headline ?? { text: r.phase, tone: 'flat' }
  const toSession = () => useHub.setState((s) => ({ sel: { ...s.sel, sessions: r.session, exp: null }, section: 'sessions' }))
  return (
    <>
      <Eyebrow>experiment · session {r.sessionShort} · {ago(r.startedAt)}</Eyebrow>
      <DetailTitle>{expTitle(h.cat, r)}</DetailTitle>
      <div className="my-4 flex flex-wrap items-center gap-1.5">
        <Pill tone="code">goal: {r.goal || 'cost'}</Pill> <Pill tone={headline.tone} className="h-auto max-w-full py-0.5 text-left break-words whitespace-normal">{headline.text}</Pill>
        {busy && <span className="font-mono text-[11px]"><span className="animate-hub-pulse text-primary">●</span> {r.phase}</span>}
      </div>
      {busy && !A.length
        ? <Blk k=""><span className="text-muted-foreground">running — the spider appears when the arms report.</span></Blk>
        : <Spider run={r} />}
      {A.length > 0 && (
        <Kv rows={[
          ['', A.map((a, i) => <span key={i}>{i > 0 && ' · '}<b>{a.label}</b></span>)],
          ['cost', A.map((a) => (a.isError ? 'error' : usd(a.cost))).join(' · ')],
          ['time', A.map((a) => (a.secs != null ? a.secs + 's' : '—')).join(' · ')],
          ['accuracy', A.map((a) => (a.score != null ? a.score + (r.scoreMax ? '/' + r.scoreMax : '') : 'not judged')).join(' · ')],
          ['turns', A.map((a) => a.turns).join(' · ')],
        ]} />
      )}
      {headline.detail && <div className="mb-3 rounded-md border border-l-2 px-3 py-2.5 text-[12.5px] leading-relaxed">{headline.detail}</div>}
      <Mut className="mt-1.5 mb-2.5 text-xs">
        Both arms replay the same task in the sandbox, so they are compared with each other; the outside edge of the spider is the best value either reached.
        {' '}The original session ({r.originalCost != null ? usd(r.originalCost) : '—'}) is context, not a baseline — a replay finishes in a few turns what the real session took many for.
        {' '}One run is one data point, not a finding: repeat it three times before trusting it.
      </Mut>
      <div className="my-4 flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
        {r.report && <><a className="text-primary hover:underline" href={'/' + r.report} target="_blank" rel="noreferrer">report ▸</a> · </>}
        <a className="text-primary hover:underline" href={'/optlog?session=' + encodeURIComponent(r.session)} target="_blank" rel="noreferrer">log ▸</a>
        {' · '}<a className="text-primary hover:underline" href="#" onClick={(e) => { e.preventDefault(); toSession() }}>session ▸</a>
        {busy && <Button variant="outline" size="xs" className="ml-1 border-warn font-mono text-warn" onClick={() => h.stopRun(r.session)}>stop</Button>}
      </div>
    </>
  )
}

/** the experiments run on one session, each a link to its detail under Sessions */
export function ExpList({ s }: { s: Session }) {
  const h = useHub()
  const ex = expsOf(h, s.id)
  if (!ex.length) return null
  const open = (run: string) => useHub.setState((st) => ({ sel: { ...st.sel, exp: run }, section: 'sessions', detailShut: false }))
  return (
    <Blk k="experiments on this session">
      {ex.map((r) => (
        <div key={r.run} className="my-1">
          <a href="#" className="text-primary hover:underline" onClick={(e) => { e.preventDefault(); open(r.run) }}>{expTitle(h.cat, r)}</a>
          {' '}<span className="text-[11.5px] text-muted-foreground">goal {r.goal || 'cost'} · {ago(r.startedAt)}</span>
          {' '}<Pill tone={r.headline?.tone}>{(r.headline?.text ?? '').slice(0, 40)}</Pill>
        </div>
      ))}
    </Blk>
  )
}
