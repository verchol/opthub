/**
 * Analytics. Percentiles, Classes and Similar are about every session; Behaviour is how
 * Claude Code sessions run turn by turn (LangSmith + OTEL); Session is the per-session view
 * opened from the Sessions tab.
 */
import { MidHead } from '@/components/hub'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useHub, type Asub } from '@/store'
import { PercentilesView } from './percentiles'
import { ClassesView } from './classes'
import { SessionAnalyticsView } from './session'
import { SimilarView } from './similar'
import { BehaviourView } from './behaviour'

export function AsubBar() {
  const asub = useHub((h) => h.asub), sid = useHub((h) => h.sel.sessions), data = useHub((h) => h.data)
  const s = sid ? data?.sessions.find((x) => x.id === sid) : undefined
  const tabs: [Asub, string][] = [['pct', 'Percentiles'], ['grp', 'Classes'], ['sim', 'Similar'], ['beh', 'Behaviour']]
  if (s) tabs.push(['session', 'Session ' + s.id.slice(0, 6)])
  const pick = (k: Asub) => {
    if (k === 'session' && s) return useHub.getState().openAnalytics(s.id)
    useHub.setState({ asub: k })
  }
  return (
    <Tabs value={asub} onValueChange={(v) => pick(v as Asub)} className="mt-1.5 mb-4">
      <TabsList>
        {tabs.map(([k, l]) => <TabsTrigger key={k} value={k} className="font-mono text-xs">{l}</TabsTrigger>)}
      </TabsList>
    </Tabs>
  )
}

export function AnalyticsView() {
  const asub = useHub((h) => h.asub), ins = useHub((h) => h.ins), sid = useHub((h) => h.sel.sessions), data = useHub((h) => h.data)
  if (asub === 'session' && data?.sessions.some((x) => x.id === sid)) return <SessionAnalyticsView />
  return (
    <>
      <MidHead title="Analytics" crumb={ins ? Object.keys(ins.attrs).length + ' sessions classified' : 'classifying…'} />
      <AsubBar />
      {/* Behaviour reads traces, not the classifier, so it never waits on classification */}
      {asub === 'beh' ? <BehaviourView /> : !ins ? <div className="py-8 text-center font-mono text-xs text-muted-foreground">classifying sessions…</div>
        : asub === 'grp' ? <ClassesView /> : asub === 'sim' ? <SimilarView /> : <PercentilesView />}
    </>
  )
}
