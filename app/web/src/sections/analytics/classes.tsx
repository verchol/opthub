/** Analytics → Classes: continuous classification, grouped by what matters most. */
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { PAL, stats, usd } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useHub } from '@/store'
import { attrLabel, DATES, insRows, topWork, useAnalytics, type InsRow } from './state'
import { attrOptions, ChartCard, Filters, Pick } from './controls'
import { SessLine } from './percentiles'

export function ClassesView() {
  const data = useHub((h) => h.data), ins = useHub((h) => h.ins)!
  const insF = useAnalytics((a) => a.insF), setInsF = useAnalytics((a) => a.setInsF)
  const g = useAnalytics((a) => a.grpF), setG = useAnalytics((a) => a.setGrpF)
  const rows = insRows(data?.sessions, ins, insF), total = rows.reduce((a, r) => a + r.s.cost, 0) || 1
  const maxS = Math.max(...ins.ranking.map((r) => r.score), 1e-6)
  const by: Record<string, InsRow[]> = {}
  for (const r of rows) { const k = r.a[g.k1] + (g.k2 ? ' · ' + r.a[g.k2] : ''); (by[k] = by[k] || []).push(r) }
  const groups = Object.entries(by).map(([k, list]) => ({ k, list, st: stats(list.map((r) => r.s.cost)) })).sort((a, b) => b.st.sum - a.st.sum)
  // what else characterises a group: the value of each other work attribute that is most over-represented in it
  const others = ins.ranking.filter((r) => r.group !== 'size' && r.key !== g.k1 && r.key !== g.k2).slice(0, 6).map((r) => r.key)
  const base: Record<string, Record<string, number>> = {}
  for (const k of others) { base[k] = {}; for (const r of rows) base[k][r.a[k]] = (base[k][r.a[k]] || 0) + 1 / rows.length }
  const traits = (list: InsRow[]) => others.map((k) => {
    const c: Record<string, number> = {}
    for (const r of list) c[r.a[k]] = (c[r.a[k]] || 0) + 1 / list.length
    const [v, share] = Object.entries(c).sort((a, b) => b[1] - a[1])[0]
    return { k, v, share, lift: share / (base[k][v] || 1) }
  }).filter((t) => t.share >= 0.5 && t.v !== 'unlabelled').sort((a, b) => b.lift - a.lift).slice(0, 4)
  const open = groups.find((x) => x.k === g.open)
  const changed = (ins.changed || []).length

  return (
    <>
      <div className="mb-3.5 flex items-center gap-2 font-mono text-[11.5px] text-muted-foreground">
        <span className="size-2 animate-hub-pulse rounded-full bg-primary" />
        classifying continuously · {Object.keys(ins.attrs).length} sessions · last pass {new Date(ins.classifiedAt).toLocaleTimeString()}
        {changed ? <> · <b className="text-foreground">{changed} new or reclassified</b></> : ' · no change since the last pass'}
      </div>

      <ChartCard className="mb-4" title="Which classifications matter"
        note="How much of the spread in cost each attribute explains (ω² on log cost, corrected for the number of groups). Size attributes explain cost by construction, so they are shown but never chosen for you. Click one to group by it.">
        {ins.ranking.map((r) => {
          const size = r.group === 'size'
          return (
            <Tooltip key={r.key}>
              <TooltipTrigger asChild>
                <div onClick={() => setG({ k1: r.key, open: null })}
                  className={cn('grid cursor-pointer grid-cols-[110px_1fr_auto] items-center gap-2.5 rounded-sm px-1 py-0.5 font-mono text-[11.5px] hover:bg-rail',
                    size && 'text-muted-foreground', g.k1 === r.key && 'outline outline-primary')}>
                  <span>{r.label}</span>
                  <span className="relative h-2.5 bg-border">
                    <i className={cn('absolute inset-y-0 left-0', size ? 'bg-muted-foreground opacity-50' : 'bg-primary')} style={{ width: (100 * r.score / maxS).toFixed(1) + '%' }} />
                  </span>
                  <span className="min-w-[70px]">{(r.score * 100).toFixed(1)}% · {r.groups}g</span>
                </div>
              </TooltipTrigger>
              <TooltipContent side="left" className="max-w-xs">{r.why}</TooltipContent>
            </Tooltip>
          )
        })}
      </ChartCard>

      <Filters>
        <Pick value={g.k1} options={attrOptions(ins, 'group by ')} onChange={(v) => setG({ k1: v, open: null })} />
        <Pick value={g.k2} options={[['', 'then by — nothing'], ...ins.ranking.filter((r) => r.key !== g.k1).map((r): [string, string] => [r.key, 'then by ' + r.label])]}
          onChange={(v) => setG({ k2: v, open: null })} />
        <Button variant="outline" size="sm" className="font-mono text-xs" onClick={() => setG({ k1: topWork(ins, 0), k2: topWork(ins, 1), open: null })}>auto: top two</Button>
        <Pick value={insF.date} options={DATES} onChange={(v) => setInsF({ date: v })} />
      </Filters>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3">
        {groups.map((x, i) => {
          const col = PAL[i % PAL.length], ex = x.list.slice().sort((a, b) => b.s.cost - a.s.cost)[0]
          return (
            <div key={x.k} onClick={() => setG({ open: g.open === x.k ? null : x.k })}
              className={cn('cursor-pointer rounded-lg border border-t-[3px] bg-card p-3.5 hover:border-primary', g.open === x.k && 'outline-2 outline-primary')}
              style={{ borderTopColor: col }}>
              <h4 className="mb-0.5 font-heading text-[15px] font-bold break-words">{x.k}</h4>
              <div className="font-mono text-[11px] text-muted-foreground">{x.st.n} sessions · {usd(x.st.sum)} · {(100 * x.st.sum / total).toFixed(1)}% of spend</div>
              <div className="my-2 h-[5px] bg-border"><i className="block h-full" style={{ width: Math.max(1, 100 * x.st.sum / total).toFixed(1) + '%', background: col }} /></div>
              <div className="font-mono text-[11px] text-muted-foreground">p50 {usd(x.st.p50)} · p95 {usd(x.st.p95)}</div>
              <div className="mt-2 flex flex-wrap gap-1">
                {traits(x.list).map((t) => (
                  <span key={t.k} title={`${Math.round(t.share * 100)}% of this group, ${t.lift.toFixed(1)}× the fleet`}
                    className="rounded-sm border px-1.5 py-px font-mono text-[10px] text-muted-foreground">
                    {attrLabel(ins, t.k)} <b className="font-medium text-foreground">{t.v}</b>
                  </span>
                ))}
              </div>
              {ex && <div className="mt-2 line-clamp-2 text-xs text-muted-foreground">“{ex.s.intent}”</div>}
            </div>
          )
        })}
      </div>

      {open && (
        <ChartCard className="mt-3.5" title={open.k} note={`${open.st.n} sessions, most expensive first.`}>
          <div className="font-mono text-[11.5px]">
            {open.list.slice().sort((a, b) => b.s.cost - a.s.cost).map((r) => <SessLine key={r.s.id} value={usd(r.s.cost)} r={r} />)}
          </div>
        </ChartCard>
      )}
    </>
  )
}
