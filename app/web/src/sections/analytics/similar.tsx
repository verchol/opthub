/**
 * Analytics → Similar: sessions as a graph, an edge where two did the same kind of work.
 * The neighbours come from lib/insights.mjs (similarity()); this draws them with React Flow.
 * The layout is our own force pass, run to rest before drawing, because the clusters have to
 * read as categories: repulsion, springs weighted by similarity, and a pull towards each
 * category's anchor. React Flow owns pan, zoom, drag, the minimap and the controls.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Background, BackgroundVariant, Controls, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider,
  applyNodeChanges, useReactFlow,
  type Edge, type Node, type NodeChange, type NodeProps,
} from '@xyflow/react'
import { Crosshair, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Bar, ChartIcon } from '@/components/hub'
import type { Attrs, Insights, Session } from '@/lib/api'
import { PAL, PAL_REST, usd } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useHub } from '@/store'
import { attrLabel, DATES, insRows, useAnalytics, valuesOf, type InsF } from './state'

/* ------------------------------------------------------------------ model */

interface SimNode { id: string; s: Session; a: Attrs; cat: string; col: string; r: number; x: number; y: number; vx: number; vy: number }
interface SimEdge { a: string; b: string; sim: number }
interface SimGraph {
  nodes: SimNode[]; edges: SimEdge[]; byId: Record<string, SimNode>
  cats: string[]; col: Record<string, string>; count: Record<string, number>; anch: Record<string, [number, number]>
  degree: Record<string, number>
}

/** where each session sat last time, so a refresh or a filter change does not reshuffle the picture */
let POS: Record<string, [number, number]> = {}
const W = 1000, H = 640

function layout(g: SimGraph) {
  const N = g.nodes, anch = g.anch
  for (const n of N) {
    const p = POS[n.id]
    if (p) { n.x = p[0]; n.y = p[1] } else { const a = anch[n.cat]; n.x = a[0] + (Math.random() - 0.5) * 80; n.y = a[1] + (Math.random() - 0.5) * 80 }
    n.vx = 0; n.vy = 0
  }
  // settled positions need only a nudge for the newcomers
  const iters = N.every((n) => POS[n.id]) ? 60 : 300
  for (let it = 0; it < iters; it++) {
    const alpha = 1 - it / iters
    for (let i = 0; i < N.length; i++) for (let j = i + 1; j < N.length; j++) {
      const a = N[i], b = N[j]
      let dx = b.x - a.x, dy = b.y - a.y
      const d2 = dx * dx + dy * dy + 0.01
      if (d2 > 40000) continue
      const d = Math.sqrt(d2), min = a.r + b.r + 4, f = (d < min ? (min - d) * 0.5 : 0) + 900 / d2
      dx /= d; dy /= d; a.vx -= dx * f; a.vy -= dy * f; b.vx += dx * f; b.vy += dy * f
    }
    for (const e of g.edges) {
      const a = g.byId[e.a], b = g.byId[e.b], dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 1
      const f = (d - (40 + 90 * (1 - e.sim))) * 0.02 * e.sim
      a.vx += dx / d * f; a.vy += dy / d * f; b.vx -= dx / d * f; b.vy -= dy / d * f
    }
    for (const n of N) {
      const a = anch[n.cat]
      n.vx += (a[0] - n.x) * 0.006; n.vy += (a[1] - n.y) * 0.006
      n.x += n.vx * alpha * 0.6; n.y += n.vy * alpha * 0.6; n.vx *= 0.6; n.vy *= 0.6
    }
  }
  for (const n of N) POS[n.id] = [n.x, n.y]
}

function build(sessions: Session[], ins: Insights, color: string, min: number, proj: string, f: InsF): SimGraph {
  const rows = insRows(sessions, ins, f).filter((r) => !proj || r.a.project === proj)
  const ids = new Set(rows.map((r) => r.s.id)), seen = new Set<string>(), edges: SimEdge[] = []
  for (const r of rows) for (const nb of ins.neighbours[r.s.id] || []) {
    if (!ids.has(nb.id) || nb.sim < min) continue
    const k = r.s.id < nb.id ? r.s.id + nb.id : nb.id + r.s.id
    if (seen.has(k)) continue
    seen.add(k); edges.push({ a: r.s.id, b: nb.id, sim: nb.sim })
  }
  const count: Record<string, number> = {}
  for (const r of rows) count[r.a[color]] = (count[r.a[color]] || 0) + 1
  const cats = Object.keys(count).sort((x, y) => count[y] - count[x])
  const col: Record<string, string> = {}
  cats.forEach((c, i) => { col[c] = i < PAL.length ? PAL[i] : PAL_REST })
  const anch: Record<string, [number, number]> = {}
  cats.forEach((c, i) => { const t = 2 * Math.PI * i / Math.max(cats.length, 1); anch[c] = [W / 2 + Math.cos(t) * W * 0.3, H / 2 + Math.sin(t) * H * 0.3] })
  const nodes: SimNode[] = rows.map((r) => ({
    id: r.s.id, s: r.s, a: r.a, cat: r.a[color], col: col[r.a[color]], r: Math.min(22, 4 + Math.sqrt(r.s.cost) * 1.6), x: 0, y: 0, vx: 0, vy: 0,
  }))
  const degree: Record<string, number> = {}
  for (const e of edges) { degree[e.a] = (degree[e.a] || 0) + 1; degree[e.b] = (degree[e.b] || 0) + 1 }
  const g: SimGraph = { nodes, edges, byId: Object.fromEntries(nodes.map((n) => [n.id, n])), cats, col, count, anch, degree }
  layout(g)
  return g
}

/* ------------------------------------------------------------------ nodes */

type SessionData = { n: SimNode; label: string | null; dim: boolean; hl: boolean; colorBy: string; close: number }
type SessionNode = Node<SessionData, 'session'>
type ClusterNode = Node<{ text: string }, 'cluster'>
type AnyNode = SessionNode | ClusterNode

/* one invisible handle at the centre: edges run dot centre to dot centre */
const centre = { left: '50%', top: '50%', transform: 'translate(-50%,-50%)', width: 1, height: 1, minWidth: 0, minHeight: 0, border: 0, background: 'transparent', opacity: 0 }

const SessionDot = memo(function SessionDot({ data, selected }: NodeProps<SessionNode>) {
  const { n, label, dim, hl } = data
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="relative" style={{ width: n.r * 2, height: n.r * 2 }}>
          <Handle type="target" position={Position.Top} style={centre} isConnectable={false} />
          <Handle type="source" position={Position.Top} style={centre} isConnectable={false} />
          <div
            className={cn('size-full rounded-full border-[1.5px] border-card transition-[opacity,box-shadow] duration-150',
              dim && 'opacity-[.12]', (hl || selected) && 'ring-2 ring-foreground ring-offset-1 ring-offset-card')}
            style={{ background: n.col }}
          />
          {label && (
            <span className={cn('pointer-events-none absolute top-1/2 -translate-y-1/2 font-mono text-[10px] whitespace-nowrap text-foreground', dim && 'opacity-[.12]')}
              style={{ left: n.r * 2 + 3, textShadow: '0 0 3px var(--card), 0 0 3px var(--card), 0 0 2px var(--card)' }}>
              {label}
            </span>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-[300px] font-mono text-[11px] leading-snug">
        <div className="font-semibold">{n.s.intent.slice(0, 140)}</div>
        <div>{usd(n.s.cost)} · {n.s.turns} turns · {n.a.project}</div>
        <div className="opacity-70">{data.colorBy}: {n.cat} · {data.close} close</div>
      </TooltipContent>
    </Tooltip>
  )
})

const ClusterLabel = memo(function ClusterLabel({ data }: NodeProps<ClusterNode>) {
  return <div className="pointer-events-none -translate-x-1/2 font-heading text-[13px] font-bold whitespace-nowrap text-muted-foreground opacity-55">{data.text}</div>
})

const nodeTypes = { session: SessionDot, cluster: ClusterLabel }

/* ------------------------------------------------------------------ view */

export function SimilarView() {
  return (
    <ReactFlowProvider>
      <Similar />
    </ReactFlowProvider>
  )
}

function Similar() {
  const data = useHub((h) => h.data), ins = useHub((h) => h.ins)!, theme = useHub((h) => h.theme)
  const date = useAnalytics((a) => a.insF.date), simF = useAnalytics((a) => a.simF), layoutGen = useAnalytics((a) => a.layoutGen)
  const { setSimF, setInsF } = useAnalytics.getState()
  const rf = useReactFlow<AnyNode>()
  const [minDraft, setMinDraft] = useState(simF.min)
  useEffect(() => setMinDraft(simF.min), [simF.min])

  /* rebuild only when what the graph is made of changes: the classification pass, the
     colouring, the threshold, the project and date filters, or a re-layout. Only the date
     filter applies here (Percentiles' tier, driver and text filters do not). */
  const sessions = data?.sessions
  const g = useMemo(() => {
    const f: InsF = { ...useAnalytics.getState().insF, date, tier: '', driver: '', q: '' }
    return build(sessions ?? [], ins, simF.color, simF.min, simF.proj, f)
  }, [ins, sessions, date, simF.color, simF.min, simF.proj, layoutGen])

  const colorBy = attrLabel(ins, simF.color)
  const baseNodes = useMemo<AnyNode[]>(() => {
    const labelled = new Set(simF.labels ? g.nodes.slice().sort((a, b) => b.s.cost - a.s.cost).slice(0, 14).map((n) => n.id) : [])
    const clusters: ClusterNode[] = g.cats.slice(0, PAL.length).filter((c) => g.count[c] >= 3).map((c) => ({
      id: 'cat:' + c, type: 'cluster', position: { x: g.anch[c][0], y: g.anch[c][1] - 60 },
      data: { text: c }, draggable: false, selectable: false, focusable: false, zIndex: -1,
    }))
    const dots: SessionNode[] = g.nodes.map((n) => ({
      id: n.id, type: 'session', position: { x: n.x - n.r, y: n.y - n.r },
      data: { n, label: labelled.has(n.id) ? n.s.intent.slice(0, 28) : null, dim: false, hl: false, colorBy, close: (ins.neighbours[n.id] || []).length },
      width: n.r * 2, height: n.r * 2,
    }))
    return [...clusters, ...dots]
  }, [g, simF.labels, colorBy, ins.neighbours])

  /* React Flow owns positions while dragging; a rebuild resets them from the layout */
  const [nodes, setNodes] = useState(baseNodes)
  useEffect(() => setNodes(baseNodes), [baseNodes])
  const onNodesChange = useCallback((ch: NodeChange<AnyNode>[]) => {
    setNodes((ns) => applyNodeChanges(ch, ns))
    for (const c of ch) if (c.type === 'position' && c.position) {
      const n = g.byId[c.id]
      if (n) { n.x = c.position.x + n.r; n.y = c.position.y + n.r; POS[n.id] = [n.x, n.y] }
    }
  }, [g])

  /* highlight, hide and focus without rebuilding the graph */
  const q = simF.q.toLowerCase()
  const focus = simF.focus && g.byId[simF.focus] ? simF.focus : null
  const near = useMemo(() => new Set(focus ? [focus, ...g.edges.filter((e) => e.a === focus || e.b === focus).map((e) => (e.a === focus ? e.b : e.a))] : []), [focus, g])
  const shownNodes = useMemo(() => nodes.map((nd): AnyNode => {
    if (nd.type !== 'session') return nd
    const n = nd.data.n
    const miss = !!q && !n.s.intent.toLowerCase().includes(q), off = !!focus && !near.has(n.id)
    return { ...nd, hidden: !!simF.hidden[n.cat], selected: n.id === focus, data: { ...nd.data, dim: miss || off, hl: !!q && !miss } }
  }), [nodes, q, focus, near, simF.hidden])
  const shownEdges = useMemo<Edge[]>(() => g.edges.map((e) => {
    const on = !!focus && (e.a === focus || e.b === focus)
    const dim = (!!focus && !on) || !!q
    return {
      id: e.a + '-' + e.b, source: e.a, target: e.b, type: 'straight', focusable: false, selectable: false,
      hidden: !!(simF.hidden[g.byId[e.a].cat] || simF.hidden[g.byId[e.b].cat]),
      zIndex: on ? 1 : 0,
      style: {
        stroke: on ? 'var(--primary)' : 'var(--muted-foreground)',
        strokeWidth: 0.5 + 3 * (e.sim - 0.3) + (on ? 0.5 : 0),
        strokeOpacity: dim ? 0.05 : on ? 0.9 : 0.15 + 0.6 * (e.sim - 0.3),
      },
    }
  }), [g, focus, q, simF.hidden])

  /* fit when the reader changes what is drawn — never on the live poll's rebuilds, which
     must keep their zoom and pan; fly to a session focused from outside the canvas (◎, the side list) */
  const fly = useRef(!!simF.focus)
  const fitKey = [simF.color, simF.min, simF.proj, date, layoutGen].join('|')
  useEffect(() => { if (!fly.current) requestAnimationFrame(() => rf.fitView({ padding: 0.08 })) }, [fitKey, rf])
  const focusOn = useCallback((id: string | null, flyTo = true) => { fly.current = flyTo && !!id; setSimF({ focus: id }) }, [setSimF])
  useEffect(() => {
    if (!fly.current || !focus) return
    fly.current = false
    const ids = [...near].map((id) => ({ id }))
    requestAnimationFrame(() => rf.fitView({ nodes: ids, padding: 0.35, duration: 450, maxZoom: 1.6 }))
  }, [focus, near, rf])

  const dark = theme === 'dark' || theme === 'black' || (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  const projs = valuesOf(ins, 'project').map((p) => [p, p + ' (' + Object.values(ins.attrs).filter((a) => a.project === p).length + ')'])

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select value={simF.color} onValueChange={(v) => setSimF({ color: v, hidden: {} })}>
          <SelectTrigger size="sm" className="font-mono text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>{ins.ranking.map((r) => <SelectItem key={r.key} value={r.key} className="font-mono text-xs">colour by {r.label}{r.group === 'size' ? ' (size)' : ''}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={simF.proj || '__all'} onValueChange={(v) => setSimF({ proj: v === '__all' ? '' : v })}>
          <SelectTrigger size="sm" className="max-w-56 font-mono text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all" className="font-mono text-xs">all projects</SelectItem>
            {projs.map(([v, l]) => <SelectItem key={v} value={v} className="font-mono text-xs">{l}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={date} onValueChange={(v) => setInsF({ date: v })}>
          <SelectTrigger size="sm" className="font-mono text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>{DATES.map(([v, l]) => <SelectItem key={v} value={v} className="font-mono text-xs">{l}</SelectItem>)}</SelectContent>
        </Select>
        <div className="flex items-center gap-2 font-mono text-[11.5px] text-muted-foreground">
          similarity ≥
          <Slider className="w-28" min={0.3} max={0.8} step={0.05} value={[minDraft]}
            onValueChange={([v]) => setMinDraft(v)} onValueCommit={([v]) => setSimF({ min: v })} />
          <span className="w-8 tabular-nums text-foreground">{Math.round(minDraft * 100)}%</span>
        </div>
        <Input className="h-7 w-44 font-mono text-xs" placeholder="highlight intent…" value={simF.q} onChange={(e) => setSimF({ q: e.target.value })} />
        <div className="flex items-center gap-1.5">
          <Switch id="simlabels" size="sm" checked={simF.labels} onCheckedChange={(v) => setSimF({ labels: v })} />
          <Label htmlFor="simlabels" className="font-mono text-[11.5px] font-normal text-muted-foreground">labels</Label>
        </div>
        <Button variant="outline" size="sm" className="font-mono text-xs" onClick={() => { POS = {}; useAnalytics.getState().set({ layoutGen: layoutGen + 1 }) }}>
          <RotateCcw /> re-layout
        </Button>
      </div>

      <div className="grid gap-3.5 min-[1100px]:grid-cols-[minmax(0,1fr)_320px]">
        <div>
          <div className="h-[640px] overflow-hidden rounded-lg border bg-card">
            <ReactFlow<AnyNode>
              nodes={shownNodes} edges={shownEdges} nodeTypes={nodeTypes} onNodesChange={onNodesChange}
              onNodeClick={(_, n) => { if (n.type === 'session') focusOn(simF.focus === n.id ? null : n.id, false) }}
              onPaneClick={() => { if (simF.focus) focusOn(null, false) }}
              colorMode={dark ? 'dark' : 'light'} minZoom={0.1} maxZoom={4}
              nodesConnectable={false} elementsSelectable={false} edgesFocusable={false}
              proOptions={{ hideAttribution: true }} fitView fitViewOptions={{ padding: 0.08 }}
              style={{ background: 'var(--card)' }}
            >
              <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--border)" />
              <Controls showInteractive={false} className="overflow-hidden rounded-md border shadow-sm" />
              <MiniMap<AnyNode> pannable zoomable className="overflow-hidden rounded-md border"
                style={{ background: 'var(--card)' }} maskColor="color-mix(in srgb, var(--background) 70%, transparent)"
                nodeColor={(n) => (n.type === 'session' ? n.data.n.col : 'transparent')} nodeStrokeWidth={0} />
            </ReactFlow>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1.5 font-mono text-[11px]">
            {g.cats.map((c) => (
              <button key={c} className={cn('inline-flex items-center gap-1.5 hover:text-foreground', simF.hidden[c] && 'opacity-35')}
                title={simF.hidden[c] ? 'show' : 'hide'} onClick={() => setSimF({ hidden: { ...simF.hidden, [c]: !simF.hidden[c] } })}>
                <i className="inline-block size-2.5 rounded-full" style={{ background: g.col[c] }} />{c} · {g.count[c]}
              </button>
            ))}
          </div>
          <p className="mt-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
            Each dot is a session, sized by cost and coloured by {colorBy}. An edge joins two sessions when they are among each other’s five nearest:
            half from shared purpose, artifact type, project, kind, tool style, model and scale; a third from the opening request’s words (TF-IDF);
            the rest from file types written. Drag the canvas to pan, scroll to zoom, drag a dot to move it, click a dot for its neighbours.
          </p>
        </div>
        <Card className="max-h-[640px] gap-0 overflow-auto py-3.5 text-[13px]">
          <CardContent className="px-3.5"><Side g={g} focus={focus} onFocus={focusOn} /></CardContent>
        </Card>
      </div>
    </>
  )
}

function Chip({ children }: { children: ReactNode }) {
  return <span className="rounded-sm border px-1.5 py-px font-mono text-[10px] text-muted-foreground">{children}</span>
}

function Side({ g, focus, onFocus }: { g: SimGraph; focus: string | null; onFocus: (id: string | null) => void }) {
  const ins = useHub((h) => h.ins)!, data = useHub((h) => h.data)
  const min = useAnalytics((a) => a.simF.min)
  if (!focus) {
    const iso = g.nodes.filter((n) => !g.degree[n.id]).length
    const top = g.nodes.map((n) => [n, g.degree[n.id] || 0] as const).sort((a, b) => b[1] - a[1]).slice(0, 8)
    return (
      <>
        <h4 className="mb-1 font-heading text-[15px] font-bold">Close sessions</h4>
        <p className="mb-2.5 font-mono text-xs text-muted-foreground">
          {g.nodes.length} sessions · {g.edges.length} links · {iso} with no close neighbour at ≥ {Math.round(min * 100)}%
        </p>
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">Click a dot, or ◎ on any session in Percentiles or Classes, to see the sessions most like it and why.</p>
        <div className="eyebrow mb-1">most connected</div>
        {top.map(([n, k]) => (
          <button key={n.id} className="flex w-full items-baseline gap-2.5 py-0.5 text-left font-mono text-[11.5px] hover:text-primary" onClick={() => onFocus(n.id)}>
            <span className="min-w-16 shrink-0 text-right">{k} links</span>
            <span className="truncate text-muted-foreground">{n.s.intent}</span>
          </button>
        ))}
      </>
    )
  }
  const n = g.byId[focus], nbs = ins.neighbours[focus] || []
  return (
    <>
      <h4 className="mb-1 font-heading text-[15px] leading-snug font-bold">{n.s.intent.slice(0, 120)}</h4>
      <div className="font-mono text-[11px] text-muted-foreground">{usd(n.s.cost)} · {n.s.turns} turns · {n.a.project}</div>
      <div className="my-2 flex flex-wrap gap-1">
        {['purpose', 'artifact', 'kind', 'tools', 'tier'].map((k) => <Chip key={k}>{attrLabel(ins, k)} <b className="font-medium text-foreground">{n.a[k]}</b></Chip>)}
      </div>
      <div className="mb-1.5 flex gap-1.5">
        <Button variant="outline" size="xs" className="font-mono" onClick={() => useHub.getState().openAnalytics(focus)}><ChartIcon /> analytics</Button>
        <Button variant="outline" size="xs" className="font-mono" onClick={() => onFocus(focus)}><Crosshair /> centre</Button>
        <Button variant="ghost" size="xs" className="font-mono" onClick={() => onFocus(null)}>clear</Button>
      </div>
      {nbs.length ? nbs.map((x) => {
        const m = data?.sessions.find((s) => s.id === x.id)
        if (!m) return null
        return (
          <div key={x.id} className="border-t py-2">
            <div className="flex items-center gap-2 font-mono text-[11px]">
              <Bar v={x.sim} className="w-14" />{Math.round(x.sim * 100)}% similar · {usd(m.cost)}
            </div>
            <button className="my-1 block text-left text-xs hover:text-primary" onClick={() => onFocus(x.id)}>{m.intent.slice(0, 140)}</button>
            <div className="flex flex-wrap gap-1">
              {x.why.shared.slice(0, 4).map((t) => <Chip key={t}>{t}</Chip>)}
              {x.why.words.map((w) => <Chip key={'w' + w}>“{w}”</Chip>)}
              {x.why.files.map((f) => <Chip key={'f' + f}>{f}</Chip>)}
            </div>
          </div>
        )
      }) : <p className="text-xs leading-relaxed text-muted-foreground">No session is at least 30% like this one.</p>}
    </>
  )
}
