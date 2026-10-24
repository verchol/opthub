/** The Optimization Hub. Rail on the left, list in the middle, the selected item on the right. */
import { useEffect, useLayoutEffect, useRef } from 'react'
import { ChevronsLeft, ChevronsRight, PanelRightOpen, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Empty, Mark } from '@/components/hub'

/** set by `opt hub demo`: the hub is serving a generated company, and says so on every page */
const SYNTHETIC = (window as unknown as { HUB_SYNTHETIC?: string }).HUB_SYNTHETIC ?? null
/** `opt hub demo --banner`: also say on every page that the data is generated */
const BANNER = !!(window as unknown as { HUB_BANNER?: boolean }).HUB_BANNER
/** the sidebar switch: your hub → the demo (started if needed); the demo → the hub it was opened from */
const DEMO_COMPANY = 'Tallyfox'
function switchHref() {
  if (!SYNTHETIC) return '/api/switch/demo'
  let home = new URLSearchParams(location.search).get('home')
  try {
    if (home && /^\d+$/.test(home)) localStorage.setItem('hub.home', home)
    else home = localStorage.getItem('hub.home')
  } catch { /* no storage: the server's default port */ }
  return '/api/switch/home' + (home ? `?port=${home}` : '')
}
import { cn } from '@/lib/utils'
import { DEMO, isLivePhase, SECTIONS, SUBTABS, useHub, type Theme } from '@/store'
import { SessionsDetail, SessionsView } from '@/sections/sessions'
import { OptimizeDetail, OptimizeView } from '@/sections/optimize'
import { TriageDetail, TriageView } from '@/sections/triage'
import { GraphView } from '@/sections/triage/graph'
import { AnalyticsView } from '@/sections/analytics'
import { OverviewView } from '@/sections/overview'

function useTheme() {
  const theme = useHub((h) => h.theme)
  useLayoutEffect(() => {
    const root = document.documentElement
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const t = theme === 'auto' ? (mq.matches ? 'dark' : 'light') : theme
      root.classList.toggle('dark', t === 'dark')
      root.classList.toggle('black', t === 'black')
      // the embedded session graph keys off data-theme
      if (theme === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', theme)
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])
}

function Rail() {
  const h = useHub()
  const live = Object.values(h.live).filter((x) => x && isLivePhase(x.phase)).length
  const counts: Record<string, string | number> = {
    sessions: h.data ? h.data.sessions.length : '',
    optimization: live ? h.runs.runs.length + ' ·' + live : h.runs.runs.length,
    analytics: h.ins ? Object.keys(h.ins.attrs).length : '',
    triage: h.tri?.sessions ? h.tri.sessions.length : '',
  }
  const subCounts: Record<string, string | number> = {
    catalog: h.cat.experiments.length, runs: h.runs.runs.length, profiles: h.prof ? (h.prof.profiles || []).length : '',
  }
  const item = (on: boolean, sub = false) => cn(
    'flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left font-mono text-xs text-muted-foreground transition-colors hover:text-foreground',
    sub && 'text-[11.5px]',
    on && (sub ? 'bg-sidebar-accent/60 text-foreground' : 'bg-sidebar-accent text-foreground shadow-xs ring-1 ring-border'),
  )
  return (
    <aside className="flex h-full min-h-0 flex-col overflow-auto border-r bg-sidebar">
      <div className="flex items-start gap-2 border-b px-4 pt-5 pb-4">
        <Mark className="mt-0.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h1 className="font-heading text-[13.5px] font-extrabold tracking-tight whitespace-nowrap">Optimization Hub</h1>
          <div className="mt-1 font-mono text-[10px] tracking-wide text-muted-foreground">
            {h.data ? `${h.data.totals.count} sessions · $${h.data.totals.cost}${DEMO ? ' · read-only snapshot' : ''}` : 'loading…'}
          </div>
          {SYNTHETIC && (BANNER
            ? <div className="mt-1.5 font-mono text-[10px] font-bold tracking-wide text-warn">{SYNTHETIC} · synthetic demo data</div>
            : <div className="mt-1.5 font-mono text-[10.5px] font-bold tracking-wide text-foreground">{SYNTHETIC}</div>)}
          {!DEMO && (
            <a href={switchHref()} className="mt-1.5 inline-block font-mono text-[10.5px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
               title={SYNTHETIC ? 'back to the hub with your own sessions' : `open the ${DEMO_COMPANY} demo: a fictional company, all data generated (starts it if needed)`}>
              {SYNTHETIC ? '← back to my data' : `switch to ${DEMO_COMPANY} demo →`}
            </a>
          )}
        </div>
        <Button variant="ghost" size="icon-xs" title="hide sidebar" onClick={() => h.setRail(true)}><ChevronsLeft /></Button>
      </div>
      <nav className="flex flex-col gap-0.5 p-2">
        {SECTIONS.map(([id, label]) => (
          <div key={id}>
            <button className={item(h.section === id)} onClick={() => h.go(id)}>
              {label}<span className="text-[10px] tabular-nums text-muted-foreground">{counts[id] || ''}</span>
            </button>
            {id === 'optimization' && h.section === 'optimization' && (
              <div className="mt-0.5 mb-1 ml-2.5 flex flex-col gap-0.5 border-l pl-1.5">
                {SUBTABS.map(([x, l]) => (
                  <button key={x} className={item(h.subtab === x, true)} onClick={() => h.go('optimization', x)}>
                    {l}<span className="text-[10px] tabular-nums text-muted-foreground">{subCounts[x] ?? ''}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {h.section === 'graph' && <button className={item(true)}>Graph<span className="text-[10px]">1</span></button>}
      </nav>
      <div className="mt-auto border-t p-2.5">
        <ToggleGroup type="single" variant="outline" size="sm" value={h.theme} onValueChange={(v) => v && h.setTheme(v as Theme)} className="w-full">
          {(['auto', 'light', 'dark', 'black'] as Theme[]).map((t) => (
            <ToggleGroupItem key={t} value={t} className="flex-1 font-mono text-[10px]">{t}</ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
    </aside>
  )
}

function Mid() {
  const section = useHub((h) => h.section), data = useHub((h) => h.data)
  if (!data) return <Empty title="loading…" />
  switch (section) {
    case 'overview': return <OverviewView />
    case 'optimization': return <OptimizeView />
    case 'triage': return <TriageView />
    case 'graph': return <GraphView />
    case 'analytics': return <AnalyticsView />
    default: return <SessionsView inOpt={false} />
  }
}

function Detail() {
  const section = useHub((h) => h.section), data = useHub((h) => h.data)
  if (!data) return null
  switch (section) {
    case 'optimization': return <OptimizeDetail />
    case 'triage': return <TriageDetail />
    case 'sessions': return <SessionsDetail />
    default: return null
  }
}

export default function App() {
  useTheme()
  const h = useHub()
  const midRef = useRef<HTMLElement>(null)
  useEffect(() => { useHub.getState().load() }, [])

  // the overview, analytics and the graph own the full width; elsewhere the pane is the reader's to close
  const fullWidth = h.section === 'overview' || h.section === 'analytics' || h.section === 'graph'
  const noDetail = fullWidth || h.detailShut
  /* the middle pane is the scroll container: reset it on a view change only, so watch
     mode's 2s refreshes never fight the reader's scroll */
  const view = h.section + '|' + h.subtab + '|' + (h.section === 'analytics' ? (h.sel.sessions || '') + h.asub : h.section === 'graph' ? h.graphSid : '')
  useEffect(() => { midRef.current?.scrollTo({ top: 0 }) }, [view])

  return (
    <TooltipProvider delayDuration={250}>
      <div className="grid h-screen overflow-hidden max-[900px]:h-auto max-[900px]:grid-cols-1! max-[900px]:overflow-auto"
        style={{ gridTemplateColumns: `${h.railShut ? '0px' : 'clamp(180px, 15vw, 212px)'} minmax(0,1fr) ${noDetail ? '0px' : 'clamp(330px, 28vw, 420px)'}` }}>
        <div className={cn('min-h-0 overflow-hidden', h.railShut && 'hidden')}><Rail /></div>
        {h.railShut && <div />}
        <main ref={midRef} className={cn('min-w-0 overflow-auto px-6 pt-5 pb-16', h.railShut && 'pl-14')}>
          <Mid />
        </main>
        {noDetail ? <div /> : (
          <aside className="relative min-w-0 overflow-auto border-l bg-card px-5 pt-5 pb-16 max-[900px]:border-t max-[900px]:border-l-0">
            <Button variant="ghost" size="icon-xs" className="absolute top-2.5 right-3 z-10" title="hide details" onClick={() => h.setDetail(false)}><X /></Button>
            <Detail />
          </aside>
        )}
      </div>
      {h.railShut && <Button variant="outline" size="icon-sm" className="fixed top-3 left-3 z-20" title="show sidebar" onClick={() => h.setRail(false)}><ChevronsRight /></Button>}
      {h.detailShut && !fullWidth && <Button variant="outline" size="icon-sm" className="fixed top-3 right-3 z-20" title="show details" onClick={() => h.setDetail(true)}><PanelRightOpen /></Button>}
      {SYNTHETIC && BANNER && (
        <div className="pointer-events-none fixed right-4 bottom-4 z-30 rounded-full border border-warn/60 bg-card/95 px-3 py-1 font-mono text-[10.5px] text-warn shadow-sm">
          Synthetic demo · {SYNTHETIC} is a fictional company; every session, experiment and audit here is generated
        </div>
      )}
      <Toaster position="bottom-right" />
    </TooltipProvider>
  )
}
