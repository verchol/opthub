/** Filter controls and the chart card shared by Session, Percentiles and Classes. */
import type { ReactNode } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import type { Insights } from '@/lib/api'

/* Radix Select reserves the empty string, and "" means "no filter" throughout the hub */
const NONE = '__none'

/** a compact select over [value, label] pairs; '' is a valid value */
export function Pick({ value, options, onChange, className }: {
  value: string; options: [string, string][]; onChange: (v: string) => void; className?: string
}) {
  return (
    <Select value={value === '' ? NONE : value} onValueChange={(v) => onChange(v === NONE ? '' : v)}>
      <SelectTrigger size="sm" className={cn('bg-card font-mono text-xs', className)}><SelectValue /></SelectTrigger>
      <SelectContent>
        {options.map(([v, l]) => <SelectItem key={v} value={v === '' ? NONE : v} className="font-mono text-xs">{l}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}

/** the attribute ranking as options, size attributes marked */
export const attrOptions = (ins: Insights, prefix: string): [string, string][] =>
  ins.ranking.map((r) => [r.key, prefix + r.label + (r.group === 'size' ? ' (size)' : '')])

export function Filters({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mb-3 flex flex-wrap items-center gap-2', className)}>{children}</div>
}

/** a titled card with a one-line explanation over its body */
export function ChartCard({ title, note, children, className }: { title: ReactNode; note: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Card className={cn('gap-3 py-5', className)}>
      <CardHeader className="px-5">
        <CardTitle className="font-heading text-base font-bold">{title}</CardTitle>
        <CardDescription className="text-[13px]">{note}</CardDescription>
      </CardHeader>
      <CardContent className="px-5">{children}</CardContent>
    </Card>
  )
}
