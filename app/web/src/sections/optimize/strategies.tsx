/**
 * goal → strategies → run. The strategies come from what is already known about the
 * session (its own tokens, priced by lib/goals.mjs) with Jev's per-method score beside them.
 */
import { useEffect } from 'react'
import { create } from 'zustand'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Kv, Pill } from '@/components/hub'
import { getJSON, q, type Session } from '@/lib/api'
import { modelOf, tok, usd } from '@/lib/format'
import { cn } from '@/lib/utils'
import { DEMO, GOALS, runState, useHub, type Goal } from '@/store'
import { ExpList } from './experiment'
import { DetailTitle, Eyebrow, Mut, Sec, triUsd } from './shared'

/** one candidate from /api/strategies */
export interface Strategy {
  id: string; title: string; levers: string[]; runnable: boolean; ok: boolean; why: string | null
  risk: string; rank: number | null; jevAgainst: boolean
  best: { text: string; x: number | null; label?: string }; worst: string; caughtBy: string
  jev: { score: number | null; unlocked?: boolean; saving: number; pct: number } | null
}
interface StratPayload { goal: string; session: string; pick: string | null; considered: Strategy[] }
interface StratState { key: string; loading?: boolean; error?: boolean; data?: StratPayload }

/* the strategies for one session|goal, fetched once each */
const useStrat = create<{ s: StratState | null }>()(() => ({ s: null }))

function loadStrat(id: string, goal: Goal) {
  const key = id + '|' + goal
  const cur = useStrat.getState().s
  if (cur && cur.key === key) return
  useStrat.setState({ s: { key, loading: true } })
  getJSON<StratPayload>('/api/strategies?' + q({ session: id, goal })).then((d) => {
    if (useStrat.getState().s?.key !== key) return
    useStrat.setState({ s: { key, data: d } })
    const pick = (d.considered || []).find((c) => c.id === d.pick && c.runnable)
    useHub.getState().select({ lever: pick ? pick.id : '__auto' }, { open: false })
  }).catch(() => { if (useStrat.getState().s?.key === key) useStrat.setState({ s: { key, error: true } }) })
}

const riskTone = (r: string) => (r === 'low' ? 'improved' : r === 'high' ? 'degraded' : 'warn')

function StratCard({ on, disabled, onClick, children }: { on: boolean; disabled?: boolean; onClick?: () => void; children: React.ReactNode }) {
  return (
    <div onClick={disabled ? undefined : onClick}
      className={cn('mb-1.5 flex gap-2 rounded-md border bg-card px-2.5 py-2',
        disabled ? 'cursor-default opacity-50' : 'cursor-pointer hover:border-primary/60',
        on && 'border-primary shadow-[inset_3px_0_0_var(--primary)]')}>
      <div className="flex-1">{children}</div>
    </div>
  )
}

export function OptimizeSessionDetail({ s }: { s: Session }) {
  const h = useHub()
  const strat = useStrat((x) => x.s)
  const key = s.id + '|' + h.goal
  useEffect(() => { loadStrat(s.id, h.goal) }, [s.id, h.goal])
  const S = strat && strat.key === key ? strat : null
  const busy = runState(h, s.id).live
  const lever = h.sel.lever

  let list: React.ReactNode
  if (!S || S.loading) list = <Mut>reading the analysis…</Mut>
  else if (S.error || !S.data) list = <Mut>no strategies for this session</Mut>
  else {
    const d = S.data
    const C = d.considered.slice().sort((a, b) => (Number(b.runnable) - Number(a.runnable)) || ((a.rank || 99) - (b.rank || 99)))
    list = (
      <>
        {C.map((c) => {
          const j = c.jev
          return (
            <StratCard key={c.id} on={lever === c.id} disabled={!c.runnable} onClick={() => h.select({ lever: c.id }, { open: false })}>
              <div className="text-[13px] font-bold">
                {c.id === d.pick ? '★ ' : ''}{c.title} <Pill tone={riskTone(c.risk)}>{c.risk} risk</Pill>
              </div>
              <div className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
                {c.runnable ? (
                  <>
                    <b>best case:</b> {c.best.text}{c.best.label && <span className="text-muted-foreground"> ({c.best.label})</span>}
                    <br /><b>can go wrong:</b> {c.worst} — caught by {c.caughtBy}
                    {j && (
                      <>
                        <br /><b>Jev:</b>{' '}
                        {c.jevAgainst ? <span className="text-bad">says it does not apply</span> : j.score == null ? 'no answer' : Math.round(100 * j.score) + '% relevant'}
                        {j.unlocked ? ' · unlocked' : ''} · priced {triUsd(j.saving)} ({j.pct}%)
                      </>
                    )}
                  </>
                ) : (c.why || 'stacks two levers — run each one first')}
              </div>
            </StratCard>
          )
        })}
        <StratCard on={lever === '__auto'} onClick={() => h.select({ lever: '__auto' }, { open: false })}>
          <div className="text-[13px] font-bold">Auto</div>
          <div className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">let a model propose a small grid with a control arm, when no single lever stands out</div>
        </StratCard>
      </>
    )
  }

  return (
    <>
      <Eyebrow>optimize · session {s.id.slice(0, 8)}</Eyebrow>
      <DetailTitle>{s.intent.slice(0, 150)}</DetailTitle>
      <Kv rows={[['model', modelOf(s.model)], ['cost', usd(s.cost)], ['turns', s.turns], ['context', 'median ' + tok(s.ctxMedian)]]} />
      <Sec>1 · goal</Sec>
      <ToggleGroup type="single" variant="outline" size="sm" value={h.goal} onValueChange={(v) => v && h.set({ goal: v as Goal })} className="mt-1.5 mb-1 w-full">
        {GOALS.map(([g, l]) => <ToggleGroupItem key={g} value={g} className="flex-1 font-mono text-[11.5px] data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">{l}</ToggleGroupItem>)}
      </ToggleGroup>
      <Mut>{GOALS.find((x) => x[0] === h.goal)?.[2] ?? ''}</Mut>
      <Sec>2 · strategy · ★ recommended for {h.goal}</Sec>
      {list}
      <Sec>3 · run</Sec>
      <div className="my-4 flex items-center gap-1.5">
        {DEMO
          ? <Button variant="outline" size="sm" disabled className="border-primary font-mono text-xs text-primary" title="read-only deploy — this would boot cloud sandboxes and spend">Run</Button>
          : (
            <>
              <Button variant="outline" size="sm" className="border-primary font-mono text-xs text-primary" disabled={busy || !S || !!S.loading}
                onClick={() => h.runExp(s.id)}>{busy ? 'running…' : 'Run'}</Button>
              {busy && <Button variant="outline" size="sm" className="border-warn font-mono text-xs text-warn" onClick={() => h.stopRun(s.id)}>stop</Button>}
            </>
          )}
      </div>
      <Mut>Replays this session’s task twice in a sandbox — the baseline and the strategy — and a blind judge scores both (≤ $3). The result appears as an experiment under this session, with a spider chart against the baseline.</Mut>
      <div className="mt-3"><ExpList s={s} /></div>
    </>
  )
}
