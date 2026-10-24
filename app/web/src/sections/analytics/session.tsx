/**
 * Analytics → Session. Always about one named session. The old view charted every session
 * at once with no way to tell which line was yours, and approximated per-turn cost by
 * spreading the total evenly — a shape that was drawn, not measured. This reads the real
 * per-turn series from /api/session.
 */
import { ChevronLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Empty, MidHead, Stats, SubLine } from '@/components/hub'
import { BarsChart, LineChart, MixChart, RankChart } from '@/components/charts'
import { tok } from '@/lib/format'
import { useHub } from '@/store'
import { AsubBar } from './index'
import { ChartCard } from './controls'

export function SessionAnalyticsView() {
  const data = useHub((h) => h.data), sid = useHub((h) => h.sel.sessions), sd = useHub((h) => h.sdetail)
  const s = data?.sessions.find((x) => x.id === sid)
  if (!s || !data) return (
    <>
      <MidHead title="Analytics" />
      <Empty title="No session chosen">Analytics is always about one session. Open one in Sessions and press analytics.</Empty>
    </>
  )
  const head = (
    <>
      <Button variant="outline" size="sm" className="mb-3.5 font-mono text-xs text-muted-foreground" onClick={() => useHub.getState().go('sessions')}>
        <ChevronLeft /> back to sessions
      </Button>
      <MidHead title="Analytics" crumb={'session ' + s.id.slice(0, 8)} />
      <AsubBar />
      <SubLine>{s.intent.slice(0, 150)}</SubLine>
    </>
  )
  if (!sd || sd.id !== s.id) return <>{head}<Empty title="reading the transcript…" /></>
  const S = sd.series || []
  if (!S.length) return <>{head}<Empty title="This session billed no requests, so there is nothing to chart." /></>
  return (
    <>
      {head}
      <Stats items={[
        ['turns charted', S.length], ['peak context', tok(s.ctxPeak)],
        ['cache reuse', (s.cacheHit * 100).toFixed(1) + '%'], ['cost', '$' + s.cost.toFixed(2)],
        ['thinking', tok(s.thinkingTokens)],
      ]} />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))] gap-4">
        <ChartCard title="Context carried, per request"
          note="Every request re-sends the conversation. This is what the model was handed each turn — the line that decides the bill. Turns that billed no context are left out; drawing them as zero invents cliffs that never happened.">
          <LineChart series={S.filter((d) => d.ctx > 0)} get={(d) => d.ctx} fmt={(v) => tok(v)} color="var(--primary)" />
        </ChartCard>
        <ChartCard title="Cost, cumulative" note="Where the money actually accrued. A steep stretch is worth more attention than a long flat one.">
          <LineChart series={S} get={(d) => d.costCum} fmt={(v) => '$' + v.toFixed(v < 1 ? 3 : 1)} color="var(--warn)" />
        </ChartCard>
        <ChartCard title="What the input was made of" note="Cache reads bill at a tenth of fresh input and writes at 1.25×, so the mix matters more than the total.">
          <MixChart session={s} />
        </ChartCard>
        <ChartCard title="Output, per turn" note="Thinking is billed as output. The dark part of each bar is the part you never read.">
          <BarsChart series={S} />
        </ChartCard>
      </div>
      <ChartCard className="mt-4" title="Where this session sits" note="Every session on this machine by cost; this one marked.">
        <RankChart session={s} sessions={data.sessions} />
      </ChartCard>
    </>
  )
}
