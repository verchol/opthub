/** Optimize → Models: every model the gateway can use. Anthropic (priced), the local Ollama (live), the Hugging Face cache (listed). */
import { useEffect } from 'react'
import { create } from 'zustand'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { TableCell } from '@/components/ui/table'
import { Blk, Empty, Head, Kv, Pill, SubLine } from '@/components/hub'
import { getJSON, type CatalogModel, type ModelsPayload } from '@/lib/api'
import { useHub } from '@/store'
import { DetailTitle, Eyebrow, ListTable, MonoCell, Pre, SelRow } from './shared'

const useModels = create<{ data: ModelsPayload | null; loading: boolean; load: (fresh?: boolean) => Promise<void> }>()((set) => ({
  data: null, loading: false,
  load: async (fresh = false) => {
    set({ loading: true })
    try { set({ data: await getJSON<ModelsPayload>('/api/models' + (fresh ? '?fresh=1' : '')) }) } catch { /* keep the last */ }
    set({ loading: false })
  },
}))

const size = (b?: number | null) => (b == null ? '' : b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : Math.round(b / 1e6) + ' MB')
const price = (m: CatalogModel) => (m.where === 'remote' ? `$${m.priceIn} / $${m.priceOut}` : 'free')

export function ModelsView() {
  const { data, loading, load } = useModels()
  const sel = useHub((h) => h.sel.model), select = useHub((h) => h.select)
  useEffect(() => { void useModels.getState().load() }, [])
  if (!data) return <Empty title="asking Ollama and reading the catalog…" />
  const local = data.providers.filter((p) => p.kind === 'local').reduce((n, p) => n + p.models.length, 0)
  return (
    <>
      <SubLine className="flex items-center gap-2">
        {data.providers.map((p) => `${p.label} ${p.models.length}`).join(' · ')} · {local} local, free per token
        <Button variant="ghost" size="icon-xs" title="ask Ollama again" onClick={() => void load(true)} disabled={loading}><RefreshCw className={loading ? 'animate-spin' : ''} /></Button>
      </SubLine>
      {data.providers.map((p) => (
        <div key={p.id} className="mb-5">
          <div className="mb-1.5 flex flex-wrap items-baseline gap-2">
            <span className="font-heading text-[15px] font-bold">{p.label}</span>
            <Pill tone={p.status === 'ready' ? 'improved' : p.status === 'down' ? 'bad' : 'flat'}>{p.status}</Pill>
            <span className="font-mono text-[11px] text-muted-foreground">{p.note}</span>
          </div>
          {!p.models.length ? <div className="font-mono text-xs text-muted-foreground">none</div> : (
            <ListTable head={<><Head>Model</Head><Head>Size</Head><Head>Context</Head><Head>Price in / out per M</Head><Head>Good for</Head></>}>
              {p.models.map((m) => (
                <SelRow key={m.id} on={sel === m.id} onClick={() => select({ model: m.id })}>
                  <MonoCell>
                    {m.router && <span className="mr-1 text-primary" title="the gateway's local target">▸</span>}{m.id}
                    {m.loaded && <Pill tone="live" className="ml-1.5">loaded</Pill>}
                  </MonoCell>
                  <MonoCell>{[m.params, m.quant, size(m.sizeBytes)].filter(Boolean).join(' · ') || '—'}</MonoCell>
                  <MonoCell>{m.context ? Math.round(m.context / 1024) + 'k' : m.maxOutput ? `out ${Math.round(m.maxOutput / 1000)}k` : '—'}</MonoCell>
                  <MonoCell>{price(m)}</MonoCell>
                  <TableCell className="text-[12px] text-muted-foreground">{m.roles.join(' · ') || (p.id === 'huggingface' ? 'listed; serving comes later' : '—')}</TableCell>
                </SelRow>
              ))}
            </ListTable>
          )}
        </div>
      ))}
    </>
  )
}

export function ModelsDetail() {
  const data = useModels((s) => s.data), sel = useHub((h) => h.sel.model)
  const all = data?.providers.flatMap((p) => p.models) ?? []
  const m = all.find((x) => x.id === sel)
  if (!m) return <Empty title="Pick a model">What it can do, what it costs, and how to put it behind the gateway.</Empty>
  const routes = Object.entries(data?.router.routes ?? {})
  const usedBy = routes.filter(([, t]) => t === `remote:${m.id}` || (m.router && t === 'local')).map(([c]) => c)
  return (
    <>
      <Eyebrow>{m.provider} · {m.where}</Eyebrow>
      <DetailTitle>{m.id}</DetailTitle>
      <Kv rows={[
        ['price', m.where === 'remote' ? `$${m.priceIn} in · $${m.priceOut} out per M tokens` : 'free per token (your hardware)'],
        ...(m.params ? [['size', [m.params, m.quant, size(m.sizeBytes)].filter(Boolean).join(' · ')] as [string, string]] : []),
        ...(m.context ? [['context', `${m.context.toLocaleString('en')} tokens`] as [string, string]] : []),
        ...(m.capabilities?.length ? [['can', m.capabilities.join(', ')] as [string, string]] : []),
        ...(m.thinking ? [['thinking', m.thinking] as [string, string]] : []),
        ['gateway routes', usedBy.length ? usedBy.join(', ') : 'none today'],
      ]} />
      {m.roles.length > 0 && <Blk k="good for" tone="ac">{m.roles.join(' · ')}</Blk>}
      {m.provider === 'ollama' && (
        <Blk k="use it as the gateway's local target">
          <Pre>{`opt claude -p "…" --local-model ${m.id} --compare`}</Pre>
          <div className="text-[12px] text-muted-foreground">Side calls the gateway classifies as background/utility go to it; coding and review stay on Claude. The run's audit shows every request it moved.</div>
        </Blk>
      )}
      {m.provider === 'huggingface' && <Blk k="not served yet" tone="warn">It is in your Hugging Face cache. Serving it to the gateway (through Ollama or a local server) comes later.</Blk>}
      {m.provider === 'anthropic' && <Blk k="route a class to it"><Pre>{`opt claude optimize --route non-coding/*=remote:${m.id}`}</Pre></Blk>}
    </>
  )
}
