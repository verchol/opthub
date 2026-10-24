/**
 * LLM Light profiles (config/llmlight-profiles.json): one bundle of classifier, routing, cache,
 * budget and audit, rendered for a laptop or a sandbox, optionally with a project's Triage
 * classes baked in. Applied with llmlight.mjs; tried against a real session as an experiment.
 */
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { TableCell } from '@/components/ui/table'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Empty, Head, Kv, Pill } from '@/components/hub'
import { post, q } from '@/lib/api'
import { DEMO, useHub } from '@/store'
import { DetailTitle, ListTable, Mut, NumCell, Pre, Sec, SelRow, triDate, triDir, triTot } from './shared'

/* a Select item cannot carry an empty value */
const NONE = '__none'

function useProfDirs() {
  const tri = useHub((h) => h.tri)
  const W: Record<string, number> = {}
  for (const s of tri?.sessions || []) { const d = triDir(s); W[d] = (W[d] || 0) + s.cost }
  return Object.entries(W).sort((a, b) => b[1] - a[1])
}

export function ProfilesView() {
  const h = useHub()
  const dirs = useProfDirs()
  useEffect(() => { if (!h.prof && !h.profLoading) h.loadProf() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const P = h.prof
  const profR = (id: string) => (P?.rendered || []).find((r) => r.id === id)
  const ctl = (
    <div className="mb-2.5 flex flex-wrap items-center gap-2 text-[12.5px]">
      <ToggleGroup type="single" variant="outline" size="sm" value={h.profTarget} onValueChange={(v) => v && h.loadProf({ target: v })}>
        <ToggleGroupItem value="local" className="font-mono text-[11px] data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">laptop</ToggleGroupItem>
        <ToggleGroupItem value="sandbox" className="font-mono text-[11px] data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">sandbox</ToggleGroupItem>
      </ToggleGroup>
      <Select value={h.profProject || NONE} onValueChange={(v) => h.loadProf({ project: v === NONE ? '' : v })}>
        <SelectTrigger size="sm" className="max-w-full font-mono text-[11px]"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE} className="font-mono text-[11px]">no project — rules only</SelectItem>
          {dirs.map(([d, c]) => <SelectItem key={d} value={d} className="font-mono text-[11px]">{d.replace(/^~\/workspace\//, '')} · {triTot(c)}</SelectItem>)}
        </SelectContent>
      </Select>
      {P?.classes?._sessions ? <Mut>Triage classes from {P.classes._sessions} sessions baked in</Mut> : null}
    </div>
  )
  if (!P) return <>{ctl}<Empty title="loading…" /></>
  return (
    <>
      {ctl}
      <ListTable head={<><Head>profile</Head><Head>main loop</Head><Head className="text-right">rules</Head><Head>classifier</Head><Head className="text-right">budget</Head><Head>audit</Head></>}>
        {(P.profiles || []).map((p) => {
          const r = profR(p.id) || {}, b = p.budget || {}, rt = p.routing || {}
          const tierLbl = (t: string) => (r.tiers && r.tiers[t]) || t
          return (
            <SelRow key={p.id} on={h.sel.profile === p.id} onClick={() => h.select({ profile: p.id })}>
              <TableCell className="whitespace-normal"><b>{p.title}</b><Mut>{p.id} · {p.for}</Mut></TableCell>
              <TableCell>{tierLbl(rt.default || 'frontier')}</TableCell>
              <NumCell>{(rt.rules || []).length}{rt.neverDowngrade?.length ? ' · guard' : ''}</NumCell>
              <TableCell><Pill>{(p.classifier || {}).source || 'rules'}</Pill></TableCell>
              <NumCell>{b.perRunUsd ? '$' + b.perRunUsd + '/run' : b.perDayUsd ? '$' + b.perDayUsd + '/day' : '—'}{b.maxTurns ? ' · ' + b.maxTurns + ' turns' : ''}</NumCell>
              <TableCell><Pill>{(p.audit || {}).log || 'off'}</Pill></TableCell>
            </SelRow>
          )
        })}
      </ListTable>
      <div className="my-3 max-w-[80ch] text-xs leading-normal text-muted-foreground">
        A profile routes each request to a tier inside LiteLLM (assets/llmlight_router.py): the decision is local and costs no model call. Profiles that read Triage use the project’s classes as Jev answered them, baked in when applied. Every decision and result is audited as numbers and names, never text.
      </div>
    </>
  )
}

export function ProfilesDetail() {
  const h = useHub()
  const P = h.prof
  const p = P && (P.profiles || []).find((x) => x.id === h.sel.profile)
  const cands = (h.tri?.sessions || []).filter((s) => s.session && (!h.profProject || triDir(s) === h.profProject))
    .sort((a, b) => b.cost - a.cost).slice(0, 15)
  const [tryOn, setTryOn] = useState('')
  const target = cands.some((s) => s.session === tryOn) ? tryOn : cands[0]?.session ?? ''
  if (!p) return <Empty title="Pick a profile">Its rules, the exact LiteLLM config and Claude Code settings it renders to, how to apply it, and a sandbox test against a real session.</Empty>
  const r = (P!.rendered || []).find((x) => x.id === p.id) || {}
  const apply = 'node llmlight.mjs apply ' + p.id + ' --project=' + (h.profProject || '<dir>') + ' --target=' + h.profTarget + ' --start'
  const profTry = () => {
    if (!target) return
    h.toRuns(target, 'experiment', 'profile-' + p.id)
    post('/api/experiment?' + q({ session: target, experiment: 'profile-' + p.id })).catch(() => {})
  }
  const cls = p.classifier || {}
  return (
    <>
      <DetailTitle>{p.title}</DetailTitle>
      <Mut>{p.summary}</Mut>
      <Sec>What it does · {h.profTarget === 'local' ? 'laptop, Anthropic API' : 'sandbox, Bedrock'}</Sec>
      <ul className="mb-1.5 list-disc pl-4.5 text-xs leading-normal">{(r.summary || []).map((l: string, i: number) => <li key={i} className="break-words">{l}</li>)}</ul>
      <Sec>Classifier</Sec>
      <Kv rows={[['source', cls.source], ['when Jev said unclear', cls.unclear], ...(cls.model ? [['model', cls.model] as [string, string]] : [])]} />
      <Sec>Apply to a project</Sec>
      <Pre tall>{apply}</Pre>
      <Mut>Writes .opthub/llmlight/ and the env in .claude/settings.local.json of that project, starts LiteLLM on :4000. Undo with <code className="font-mono text-[10.5px] text-primary">node llmlight.mjs revert --project=…</code>. Target local bills the Anthropic API key, not a subscription.</Mut>
      <Sec>Test it first · sandbox, blind-judged against baseline</Sec>
      {DEMO ? (
        <Button variant="outline" size="sm" disabled className="border-primary font-mono text-xs text-primary" title="read-only deploy">try in sandbox</Button>
      ) : cands.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Select value={target} onValueChange={setTryOn}>
            <SelectTrigger size="sm" className="max-w-full font-mono text-[11px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {cands.map((s) => <SelectItem key={s.session} value={s.session} className="font-mono text-[11px]">{s.project} · {triDate(s, h.data?.sessions)} · {triTot(s.cost)}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" className="border-primary font-mono text-xs text-primary" onClick={profTry}>try in sandbox</Button>
        </div>
      ) : <Mut>no Triage session to try it on</Mut>}
      <Sec>Claude Code env</Sec>
      <Kv rows={[...Object.entries(r.env || {}).map(([k, v]) => [k, String(v)] as [string, string]), ...(r.flags ? [['flags', r.flags] as [string, string]] : [])]} />
      <Sec>litellm.yaml</Sec>
      <Pre tall>{r.yaml || r.error || ''}</Pre>
      <Sec>llmlight_profile.json (what the hook reads)</Sec>
      <Pre tall>{JSON.stringify(r.hook || {}, null, 2)}</Pre>
    </>
  )
}
