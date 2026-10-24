/** Optimize: Sessions (goal → strategy → run) · Experiments · Catalog · Models · Profiles. */
import { Empty, MidHead } from '@/components/hub'
import { SessionsView } from '@/sections/sessions'
import { SUBTABS, useHub } from '@/store'
import { CatalogDetail, CatalogView } from './catalog'
import { ModelsDetail, ModelsView } from './models'
import { ProfilesDetail, ProfilesView } from './profiles'
import { RunsDetail, RunsView } from './runs'
import { OptimizeSessionDetail } from './strategies'

export function OptimizeView() {
  const subtab = useHub((h) => h.subtab)
  if (subtab === 'sessions') return <SessionsView inOpt />
  const label = SUBTABS.find(([x]) => x === subtab)?.[1] ?? ''
  return (
    <>
      <MidHead title="Optimize" crumb={label} />
      {subtab === 'catalog' ? <CatalogView /> : subtab === 'models' ? <ModelsView /> : subtab === 'runs' ? <RunsView /> : <ProfilesView />}
    </>
  )
}

export function OptimizeDetail() {
  const h = useHub()
  if (h.subtab === 'catalog') return <CatalogDetail />
  if (h.subtab === 'models') return <ModelsDetail />
  if (h.subtab === 'runs') return <RunsDetail />
  if (h.subtab === 'profiles') return <ProfilesDetail />
  // withRun: this tab spends, so the detail is goal → strategy → run
  const s = h.data?.sessions.find((x) => x.id === h.sel.sessions)
  if (!s) return <Empty title="Pick a session">Choose a goal, pick a strategy from what the analysis found, and run it. The result comes back as an experiment on this session.</Empty>
  return <OptimizeSessionDetail s={s} />
}
