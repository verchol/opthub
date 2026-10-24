/** Optimize → Experiments: every run on disk, plus any launched here and not yet written. */
import { useEffect } from 'react'
import { Empty, Head, Pill, SubLine } from '@/components/hub'
import { TableCell } from '@/components/ui/table'
import { ago, usd } from '@/lib/format'
import { expTitle, runRows, useHub } from '@/store'
import { ExperimentDetail } from './experiment'
import { IntentCell, ListTable, MonoCell, NumCell, SelRow } from './shared'

export function RunsView() {
  const h = useHub()
  const rows = runRows(h)
  // a pending row becomes the real one as soon as optimize.mjs writes its dir
  const real = h.pendingRun ? rows.find((r) => r.session === h.pendingRun && !r.pending) : undefined
  const pend = h.pendingRun && !real ? rows.find((r) => r.session === h.pendingRun) : undefined
  useEffect(() => {
    if (real) useHub.setState((s) => ({ sel: { ...s.sel, run: real.run }, pendingRun: null }))
    else if (pend && h.sel.run !== pend.run) h.select({ run: pend.run }, { open: false })
  }, [real?.run, pend?.run]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <SubLine>{rows.length} experiment(s) · each one replays one real session: a baseline arm and the strategy, judged blind</SubLine>
      {rows.length ? (
        <ListTable head={<>
          <Head>Session</Head><Head>Strategy</Head><Head>Goal</Head><Head>Intent</Head>
          <Head className="text-right">Arms</Head><Head className="text-right">Cost</Head><Head>Verdict</Head><Head>Started</Head>
        </>}>
          {rows.map((r) => (
            <SelRow key={r.run} on={h.sel.run === r.run} onClick={() => h.select({ run: r.run })}>
              <MonoCell>{r.sessionShort}</MonoCell>
              <TableCell><Pill tone={r.kind === 'experiment' ? 'code' : undefined}>{expTitle(h.cat, r)}</Pill></TableCell>
              <TableCell><Pill>{r.goal || 'cost'}</Pill></TableCell>
              <IntentCell>{String(r.intent ?? '').slice(0, 110)}</IntentCell>
              <NumCell>{(r.arms || []).length}</NumCell>
              <NumCell>{usd(r.totalCost)}</NumCell>
              <TableCell><Pill tone={r.headline?.tone}>{(r.headline?.text ?? '').slice(0, 44)}</Pill></TableCell>
              <MonoCell>{ago(r.startedAt)}</MonoCell>
            </SelRow>
          ))}
        </ListTable>
      ) : (
        <Empty title={<>No experiments yet. Open <b>Optimize → Sessions</b>, pick one, choose a goal and a strategy, and press Run.</>} />
      )}
    </>
  )
}

export function RunsDetail() {
  const h = useHub()
  return <ExperimentDetail run={runRows(h).find((x) => x.run === h.sel.run)} />
}
