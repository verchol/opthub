/**
 * Small pieces every section uses: the mark, headers, stat strips, key/value tables,
 * labelled blocks, pills, sortable headers and the empty state. Built on shadcn primitives.
 */
import type { ReactNode } from 'react'
import { BarChart3, ChevronDown, ChevronUp } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { TableHead } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/** "less for more": a short quiet fall (what the work costs), a taller rise in the accent (what you got) — see lib/icon.mjs */
export function Mark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label="Less for more: cost falling, value rising" className={className}>
      <path d="M7.2 5.2 v6.6" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" fill="none" />
      <path d="M3.2 10.8 L7.2 15.4 L11.2 10.8 Z" fill="currentColor" />
      <path d="M16.8 20.8 v-9.6" stroke="var(--primary)" strokeWidth="2.6" strokeLinecap="round" fill="none" />
      <path d="M12.4 11.6 L16.8 5.4 L21.2 11.6 Z" fill="var(--primary)" />
    </svg>
  )
}

export function MidHead({ title, crumb, children }: { title: string; crumb?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-1 flex flex-wrap items-center gap-3">
      <h2 className="font-heading text-xl font-extrabold tracking-tight">{title}</h2>
      {crumb != null && <Badge variant="outline" className="font-mono font-normal text-muted-foreground">{crumb}</Badge>}
      {children}
    </div>
  )
}

/** the one muted summary line under a header */
export function SubLine({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('mb-4 font-mono text-xs text-muted-foreground', className)}>{children}</p>
}

export function Stats({ items, className }: { items: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <div className={cn('mb-4 grid grid-cols-[repeat(auto-fit,minmax(110px,1fr))] overflow-hidden rounded-lg border bg-border gap-px', className)}>
      {items.map(([k, v], i) => (
        <div key={i} className="bg-card px-4 py-2.5">
          <div className="font-heading text-lg font-extrabold tracking-tight">{v}</div>
          <div className="eyebrow">{k}</div>
        </div>
      ))}
    </div>
  )
}

export function Kv({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <table className="mb-4 w-full font-mono text-[11.5px]">
      <tbody>
        {rows.map(([k, v], i) => (
          <tr key={i}>
            <td className="w-[9.5em] py-0.5 pr-2.5 align-top text-muted-foreground">{k}</td>
            <td className="py-0.5 break-words">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const BLK_TONE = { ac: 'border-l-primary', warn: 'border-l-warn', bad: 'border-l-bad', '': 'border-l-border' } as const
export type Tone = keyof typeof BLK_TONE

/** a labelled block in the detail pane, its left edge carrying the tone */
export function Blk({ k, children, tone = '', className }: { k: ReactNode; children: ReactNode; tone?: Tone; className?: string }) {
  return (
    <div className={cn('mb-3 rounded-md border border-l-2 px-3 py-2.5', BLK_TONE[tone], className)}>
      <div className="eyebrow mb-1.5">{k}</div>
      <div className="text-[13px] leading-relaxed">{children}</div>
    </div>
  )
}

const PILL: Record<string, string> = {
  code: 'text-primary border-primary/60', doc: 'text-violet border-violet/60',
  debug: 'text-warn border-warn/60', explore: 'text-warn border-warn/60', warn: 'text-warn border-warn/60',
  improved: 'text-primary border-primary/60', degraded: 'text-bad border-bad/60', bad: 'text-bad border-bad/60',
  live: 'text-primary border-primary/60', open: 'text-warn border-warn/60',
  flat: 'text-muted-foreground', idle: 'text-muted-foreground',
}
/** a small outlined tag; tone picks the colour (kind, verdict tone, status) */
export function Pill({ tone, children, title, className }: { tone?: string; children: ReactNode; title?: string; className?: string }) {
  return (
    <Badge variant="outline" title={title} className={cn('h-5 rounded-sm px-1.5 font-mono text-[10px] font-normal text-muted-foreground', tone && PILL[tone], className)}>
      {children}
    </Badge>
  )
}

export function Empty({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="py-8 text-center font-mono text-xs text-muted-foreground">
      {title}
      {children && <div className="mx-auto mt-1.5 max-w-[26em] leading-relaxed">{children}</div>}
    </div>
  )
}

/** a header cell that sorts: click to sort by it, click again to flip */
export function SortHead({ label, k, sortKey, dir, onSort, className }: {
  label: ReactNode; k: string; sortKey: string; dir: number; onSort: (k: string) => void; className?: string
}) {
  const on = sortKey === k
  return (
    <TableHead onClick={() => onSort(k)}
      className={cn('cursor-pointer font-mono text-[10px] uppercase tracking-wider text-muted-foreground select-none hover:text-foreground', on && 'text-foreground', className)}>
      <span className="inline-flex items-center gap-0.5">{label}{on && (dir > 0 ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />)}</span>
    </TableHead>
  )
}

/** a plain header cell in the same type as SortHead */
export function Head({ children, className }: { children?: ReactNode; className?: string }) {
  return <TableHead className={cn('font-mono text-[10px] uppercase tracking-wider text-muted-foreground', className)}>{children}</TableHead>
}

/** the small square icon button tables use for "analytics" and "similar" */
export function MiniButton({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline" size="icon-xs" aria-label={title} onClick={(e) => { e.stopPropagation(); onClick() }}>{children}</Button>
      </TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  )
}
export const ChartIcon = BarChart3

/** turn on/off strip, coloured: an 80px picture of which turns used tools */
export function Sparkline({ series }: { series: unknown[] | undefined }) {
  const w = 80, n = (series || []).length
  if (!n) return null
  const cell = Math.max(1, Math.min(4, Math.floor(w / n)))
  return (
    <svg className="inline-block align-middle" width={cell * n} height={16} viewBox={`0 0 ${cell * n} 16`}>
      {series!.map((t, i) => {
        const on = !!t
        return <rect key={i} x={i * cell} y={on ? 2 : 7} width={cell - 0.5} height={on ? 12 : 2} fill={on ? 'var(--primary)' : 'var(--border)'} />
      })}
    </svg>
  )
}

/** a thin share bar: 0–1 filled in the accent (or a given colour) */
export function Bar({ v, color, className }: { v: number; color?: string; className?: string }) {
  return (
    <span className={cn('relative inline-block h-1.5 w-16 overflow-hidden rounded-full bg-border align-middle', className)}>
      <i className="absolute inset-y-0 left-0" style={{ width: Math.round(100 * Math.max(0, Math.min(1, v || 0))) + '%', background: color ?? 'var(--primary)' }} />
    </span>
  )
}
