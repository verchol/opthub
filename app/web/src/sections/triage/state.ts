/** Triage's own UI state: how the list is sorted, grouped and filtered, and which detail tab is open. */
import { create } from 'zustand'

/** a list filter: one class value (optionally two), or the sessions where a method is unlocked */
export type TriFilter = { g: string; v: string; g2?: string; v2?: string; m?: undefined } | { m: string } | null

interface TriageState {
  sortKey: string
  sortDir: number
  mode: 'list' | 'group'
  group: string
  group2: string
  filter: TriFilter
  detTab: 'judgment' | 'details'
  /** show the cost if batching loses the prompt cache */
  risk: boolean
  set: (p: Partial<Omit<TriageState, 'set' | 'sort' | 'setRisk'>>) => void
  /** click a header to sort by it, click it again to flip */
  sort: (k: string) => void
  setRisk: (on: boolean) => void
}

const risk0 = (() => { try { return localStorage.getItem('tri-risk') === 'on' } catch { return false } })()

export const useTriage = create<TriageState>()((set) => ({
  sortKey: 'gap',
  sortDir: -1,
  mode: 'list',
  group: 'kind',
  group2: '',
  filter: null,
  detTab: 'judgment',
  risk: risk0,
  set: (p) => set(p),
  sort: (k) => set((s) => ({ sortDir: s.sortKey === k ? -s.sortDir : 1, sortKey: k })),
  setRisk: (on) => {
    try { localStorage.setItem('tri-risk', on ? 'on' : 'off') } catch { /* private window */ }
    set({ risk: on })
  },
}))
