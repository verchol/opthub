/** Optimize → Catalog: config/optimizations.json, every lever and the Kong plugin that owns it. */
import { TableCell } from '@/components/ui/table'
import { Blk, Empty, Head, Pill, SubLine } from '@/components/hub'
import { useHub } from '@/store'
import { DetailTitle, Eyebrow, IntentCell, ListTable, MonoCell, Pre, SelRow } from './shared'

export function CatalogView() {
  const h = useHub()
  return (
    <>
      <SubLine>config/optimizations.json · v{h.cat.version || '?'} · every lever, and the Kong plugin that owns it</SubLine>
      <ListTable head={<><Head>Id</Head><Head>Family</Head><Head>What it changes</Head><Head>Status</Head><Head>Kong plugin</Head></>}>
        {h.cat.experiments.map((e) => (
          <SelRow key={e.id} on={h.sel.catalog === e.id} onClick={() => h.select({ catalog: e.id })}>
            <MonoCell>{e.id}</MonoCell>
            <TableCell><Pill>{e.family}</Pill></TableCell>
            <IntentCell>{String(e.summary ?? '').slice(0, 130)}</IntentCell>
            <TableCell>
              {e.control ? <Pill tone="flat">control</Pill> : e.runnable ? <Pill tone="improved">runnable</Pill> : <Pill tone="degraded">needs gateway</Pill>}
            </TableCell>
            <MonoCell>{e.kong ? e.kong.plugin : <span className="text-muted-foreground">—</span>}</MonoCell>
          </SelRow>
        ))}
      </ListTable>
    </>
  )
}

export function CatalogDetail() {
  const h = useHub()
  const e = h.cat.experiments.find((x) => x.id === h.sel.catalog)
  if (!e) return <Empty title="Pick a lever">What it changes, what it risks, and the gate it has to pass.</Empty>
  const arm = e.arm
    ? Object.entries(e.arm).map(([k, v]) => k + ': ' + (typeof v === 'string' && v.length > 60 ? v.slice(0, 60) + '…' : JSON.stringify(v))).join('\n')
    : null
  return (
    <>
      <Eyebrow>{e.family}{e.approximation ? ' · approximation' : ''}</Eyebrow>
      <DetailTitle>{e.title}</DetailTitle>
      <div className="mb-3.5 text-[13.5px] leading-normal break-words text-muted-foreground">{e.summary}</div>
      {e.hypothesis && <Blk k="hypothesis" tone="ac">{e.hypothesis}</Blk>}
      {e.risk && <Blk k="risk" tone="warn">{e.risk}</Blk>}
      {e.gate && <Blk k="gate">{e.gate}</Blk>}
      {arm && <Blk k="arm"><Pre>{arm}</Pre></Blk>}
      {e.kong ? (
        <Blk k={'kong · ' + e.kong.plugin}>
          <Pre>{Object.entries(e.kong.params || {}).map(([k, v]) => k + ': ' + (typeof v === 'object' ? JSON.stringify(v) : v)).join('\n')}</Pre>
          {e.kong.note && <div className="mt-2 text-xs text-muted-foreground">{e.kong.note}</div>}
        </Blk>
      ) : e.kongNote ? <Blk k="no gateway equivalent">{e.kongNote}</Blk> : null}
      {!e.runnable && !e.control && (
        <Blk k="not runnable here" tone="bad">
          Needs {String(e.requires || 'a gateway in the request path')}. Build it with <code className="font-mono text-[11px] text-primary">sandbox/e2b/kong/build.sh</code>.
        </Blk>
      )}
      {e.runnable && (
        <Blk k="to run it" tone="ac">
          <span className="text-[12.5px]">Open <b>Optimization → Sessions</b>, pick a session, choose <b>{e.title}</b> and press run. It executes against its own baseline arm on that session’s files.</span>
        </Blk>
      )}
    </>
  )
}
