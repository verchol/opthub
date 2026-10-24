/** Analytics → Percentiles: which category is cheapest, at the median and in the tail. */
import { Fragment } from 'react'
import { Crosshair } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHeader, TableRow } from '@/components/ui/table'
import { ChartIcon, Head, MiniButton, SortHead, Stats } from '@/components/hub'
import { stats, usd, type Stats as St } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useHub } from '@/store'
import { attrLabel, DATES, fmtMetric, insRows, METRICS, metricFn, simFocus, useAnalytics, valuesOf, type InsF, type InsRow } from './state'
import { attrOptions, Filters, Pick } from './controls'

/** the filters Percentiles is read through */
export function InsFilters() {
  const ins = useHub((h) => h.ins)!, f = useAnalytics((a) => a.insF), setF = useAnalytics((a) => a.setInsF)
  return (
    <Filters>
      <Pick value={f.dim} options={attrOptions(ins, 'by ')} onChange={(v) => { setF({ dim: v }); useAnalytics.getState().set({ insOpen: null }) }} />
      <Pick value={f.metric} options={METRICS.map((m) => [m[0], m[1]])} onChange={(v) => setF({ metric: v })} />
      <Pick value={f.date} options={DATES} onChange={(v) => setF({ date: v })} />
      <Pick value={f.tier} options={[['', 'all models'], ...valuesOf(ins, 'tier').map((v): [string, string] => [v, v])]} onChange={(v) => setF({ tier: v })} />
      <Pick value={f.driver} options={[['', 'human + script'], ...valuesOf(ins, 'driver').map((v): [string, string] => [v, v])]} onChange={(v) => setF({ driver: v })} />
      <Pick value={String(f.minN)} options={[['1', 'any n'], ['3', 'n ≥ 3'], ['5', 'n ≥ 5'], ['10', 'n ≥ 10']]} onChange={(v) => setF({ minN: +v })} />
      <Input placeholder="filter intent / project…" value={f.q} onChange={(e) => setF({ q: e.target.value })} className="h-7 w-56 bg-card font-mono text-xs" />
    </Filters>
  )
}

/** min–p99 on a log scale shared by every row, so bars compare across categories */
function Range({ st, X, W }: { st: St; X: (v: number) => number; W: number }) {
  return (
    <svg className="block" width={W} height={16}>
      <line x1={6} x2={W - 6} y1={8} y2={8} stroke="var(--border)" />
      <line x1={X(st.min)} x2={X(st.p99)} y1={8} y2={8} stroke="var(--muted-foreground)" strokeWidth={1} />
      <line x1={X(st.p50)} x2={X(st.p95)} y1={8} y2={8} stroke="var(--warn)" strokeWidth={4} />
      <line x1={X(st.p99)} x2={X(st.p99)} y1={2} y2={14} stroke="var(--bad)" strokeWidth={2} />
      <circle cx={X(st.p50)} cy={8} r={4.5} fill="var(--primary)" />
    </svg>
  )
}

function Badge({ children }: { children: string }) {
  return <span className="ml-1.5 border border-primary px-1.5 py-px text-[9.5px] tracking-wide text-primary uppercase">{children}</span>
}

/** one session in an opened group: its value, its intent, and the way to analytics or its neighbours */
export function SessLine({ value, r }: { value: string; r: InsRow }) {
  return (
    <div className="flex items-center gap-2.5 py-0.5">
      <span className="min-w-16 text-right">{value}</span>
      <span className="flex-1 truncate text-muted-foreground">{r.s.intent}</span>
      <MiniButton title="analytics" onClick={() => useHub.getState().openAnalytics(r.s.id)}><ChartIcon /></MiniButton>
      <MiniButton title="similar sessions" onClick={() => simFocus(r.s.id)}><Crosshair /></MiniButton>
    </div>
  )
}
export const SessHead = ({ children }: { children: string }) =>
  <div className="mt-1.5 text-[10px] tracking-wider text-muted-foreground uppercase">{children}</div>

export function PercentilesView() {
  const data = useHub((h) => h.data), ins = useHub((h) => h.ins)
  const f = useAnalytics((a) => a.insF), setF = useAnalytics((a) => a.setInsF)
  const insOpen = useAnalytics((a) => a.insOpen), setA = useAnalytics((a) => a.set)
  const fn = metricFn(f), rows = insRows(data?.sessions, ins, f), by: Record<string, InsRow[]> = {}
  const fm = (v: number) => fmtMetric(f, v)
  for (const r of rows) (by[r.a[f.dim]] = by[r.a[f.dim]] || []).push(r)
  const groups = Object.entries(by).map(([k, list]) => ({ k, list, st: stats(list.map((r) => fn(r.s))) })).filter((g) => g.st.n >= f.minN)
  const key = f.sort, d = f.dir
  groups.sort((a, b) => key === 'k' ? a.k.localeCompare(b.k) * d : (a.st[key as keyof St] - b.st[key as keyof St]) * d)
  const all = stats(rows.map((r) => fn(r.s)))
  const solid = groups.filter((g) => g.st.n >= 3)
  const pool = solid.length ? solid : groups
  const cheapest = pool.slice().sort((a, b) => a.st.p50 - b.st.p50)[0]
  const tailBest = pool.slice().sort((a, b) => a.st.p95 - b.st.p95)[0]
  // one log scale shared by every row, so bars compare across categories
  const pos = groups.flatMap((g) => [g.st.min, g.st.p99]).filter((v) => v > 0)
  const lo = Math.log10(Math.min(...pos, 1e9) || 1e-3), hi = Math.log10(Math.max(...pos, 1e-9) || 1)
  const W = 220, X = (v: number) => v > 0 ? 6 + (W - 12) * (Math.log10(v) - lo) / Math.max(hi - lo, 1e-6) : 6
  const sort = (k: string) => setF(f.sort === k ? { dir: -f.dir } : { sort: k, dir: 1 } as Partial<InsF>)
  const sh = (k: string, l: string, num?: boolean) =>
    <SortHead label={l} k={k} sortKey={f.sort} dir={f.dir} onSort={sort} className={cn(num && 'text-right [&>span]:justify-end')} />

  return (
    <>
      <InsFilters />
      <Stats items={[
        ['sessions', rows.length], ['p50 · all', fm(all.p50)], ['p95 · all', fm(all.p95)], ['p99 · all', fm(all.p99)],
        ['cheapest ' + attrLabel(ins, f.dim), cheapest ? cheapest.k : '—'], ['tamest tail (p95)', tailBest ? tailBest.k : '—'],
      ]} />
      <div className="overflow-hidden rounded-lg border bg-card">
        <Table className="font-mono text-xs">
          <TableHeader>
            <TableRow>
              {sh('k', attrLabel(ins, f.dim))}{sh('n', 'n', true)}{sh('p50', 'p50', true)}{sh('p95', 'p95', true)}{sh('p99', 'p99', true)}
              {sh('sum', f.metric === 'cost' ? 'total' : '', true)}
              <Head>min · <span className="text-primary">●</span> p50 · <span className="text-warn">▬</span> p95 · <span className="text-bad">|</span> p99 (log)</Head>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!groups.length && <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">no category has enough sessions under these filters</TableCell></TableRow>}
            {groups.map((g) => {
              const open = insOpen === g.k
              const sorted = open ? g.list.slice().sort((a, b) => fn(a.s) - fn(b.s)) : []
              return (
                <Fragment key={g.k}>
                  <TableRow onClick={() => setA({ insOpen: open ? null : g.k })}
                    className={cn('cursor-pointer', g.st.n < 3 && 'text-muted-foreground', open && 'bg-rail')}>
                    <TableCell className="max-w-[260px] truncate" title={g.k}>
                      {open ? '▾ ' : '▸ '}{g.k}
                      {g === cheapest && <Badge>cheapest p50</Badge>}
                      {g === tailBest && g !== cheapest && <Badge>tamest tail</Badge>}
                    </TableCell>
                    <TableCell className="num">{g.st.n}</TableCell>
                    <TableCell className="num">{fm(g.st.p50)}</TableCell>
                    <TableCell className="num">{fm(g.st.p95)}</TableCell>
                    <TableCell className="num">{fm(g.st.p99)}</TableCell>
                    <TableCell className="num">{f.metric === 'cost' ? usd(g.st.sum) : ''}</TableCell>
                    <TableCell><Range st={g.st} X={X} W={W} /></TableCell>
                  </TableRow>
                  {open && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={7} className="pt-1.5 pr-2.5 pb-3 pl-6 text-[11.5px] whitespace-normal">
                        <SessHead>cheapest</SessHead>
                        {sorted.slice(0, 5).map((r) => <SessLine key={r.s.id} value={fm(fn(r.s))} r={r} />)}
                        {sorted.length > 5 && <>
                          <SessHead>the tail (p95 and up)</SessHead>
                          {sorted.slice(-Math.min(3, sorted.length - 5)).reverse().map((r) => <SessLine key={r.s.id} value={fm(fn(r.s))} r={r} />)}
                        </>}
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              )
            })}
          </TableBody>
        </Table>
      </div>
      <p className="mt-2 font-mono text-[11px] text-muted-foreground">
        Cost is <b>priced</b>: transcript tokens at list rates. Percentiles are nearest-rank: under 20 sessions p95 and p99 are the top values, not a tail, and greyed rows have n &lt; 3. Click a row for its cheapest sessions and its tail.
      </p>
    </>
  )
}
