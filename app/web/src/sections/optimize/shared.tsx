/** Pieces the Optimize sub-tabs share: section labels, muted notes, preformatted blocks, selectable table rows. */
import type { ReactNode } from 'react'
import { Table, TableBody, TableCell, TableHeader, TableRow } from '@/components/ui/table'
import type { Session, TriageSession } from '@/lib/api'
import { cn } from '@/lib/utils'

/** a numbered step or sub-heading in the detail pane */
export function Sec({ children }: { children: ReactNode }) {
  return <div className="mt-3.5 mb-1.5 font-mono text-[10.5px] tracking-wider text-muted-foreground uppercase">{children}</div>
}

export function Mut({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('text-[11.5px] leading-relaxed text-muted-foreground', className)}>{children}</div>
}

export function Pre({ children, tall }: { children: ReactNode; tall?: boolean }) {
  return (
    <pre className={cn('mb-1.5 overflow-auto rounded-md border bg-background px-2.5 py-2 font-mono text-[11px] leading-snug break-words whitespace-pre-wrap', tall ? 'max-h-[340px]' : 'max-h-[260px]')}>
      {children}
    </pre>
  )
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="eyebrow">{children}</div>
}

export function DetailTitle({ children }: { children: ReactNode }) {
  return <h3 className="mt-1.5 mb-2.5 font-heading text-[17px] font-extrabold tracking-tight break-words">{children}</h3>
}

/** the middle pane's table: a card, rows that select */
export function ListTable({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <Table className="min-w-[760px] text-[13px]">
        <TableHeader><TableRow className="hover:bg-transparent">{head}</TableRow></TableHeader>
        <TableBody>{children}</TableBody>
      </Table>
    </div>
  )
}

export function SelRow({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <TableRow onClick={onClick} data-state={on ? 'selected' : undefined}
      className={cn('cursor-pointer hover:bg-accent', on && 'bg-primary/10 shadow-[inset_2px_0_0_var(--primary)] data-[state=selected]:bg-primary/10')}>
      {children}
    </TableRow>
  )
}

export const MonoCell = ({ children, className }: { children: ReactNode; className?: string }) =>
  <TableCell className={cn('font-mono text-[11px]', className)}>{children}</TableCell>
export const IntentCell = ({ children }: { children: ReactNode }) =>
  <TableCell className="w-[29%] min-w-[24ch] text-[12.5px] break-words whitespace-normal">{children}</TableCell>
export const NumCell = ({ children }: { children: ReactNode }) => <TableCell className="num">{children}</TableCell>

/* Triage helpers Profiles needs: the working dir from the ledger key (ISO start|cwd), money totals, the start date */
export const triDir = (s: TriageSession) => String(s.key || '').split('|').slice(1).join('|') || s.project
export const triTot = (v: number) => '$' + Math.max(0, v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const triUsd = (v: number) => (v < 0 ? '−$' : '$') + Math.abs(v).toFixed(2)
export function triDate(s: TriageSession, sessions: Session[] | undefined) {
  const h = s.session ? sessions?.find((x) => x.id === s.session) : undefined
  const d = new Date((h && h.startedAt) || String(s.key || '').split('|')[0] + 'Z')
  return isNaN(d.getTime()) ? '—'
    : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}
