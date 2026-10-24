/**
 * config/optimizations.json — the catalog of levers, and the one place that
 * knows how a catalog entry becomes an arm the sandbox can run.
 *
 * The catalog is deliberately wider than what this harness can execute: levers
 * that need a gateway in the request path (semantic cache, token rate limiting,
 * response scoring) are listed with the Kong plugin and parameters that would
 * enable them, marked runnable:false. That keeps the parameter surface in one
 * file instead of splitting "what we tried" from "what exists".
 */
import fs from 'node:fs'
import path from 'node:path'
import { describeLitellm, describeClaude } from './arm-config.mjs'
import { loadProfiles } from './llmlight.mjs'

let cached = null

export function loadCatalog(ROOT, { fresh = false } = {}) {
  if (cached && !fresh) return cached
  const file = path.join(ROOT, 'config', 'optimizations.json')
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'))
    c.experiments = (c.experiments ?? []).map((e) => ({ runnable: true, control: false, ...e }))
    // every LLM Light profile is also an experiment: the whole profile as one arm, against baseline
    for (const p of loadProfiles(ROOT).profiles ?? []) c.experiments.push({
      id: `profile-${p.id}`, title: `LLM Light · ${p.title}`, family: 'llmlight', runnable: true, control: false,
      tag: `profile ${p.id}`, summary: p.summary, arm: { model: 'baseline', compaction: false, llmlight: p.id }, kong: null,
      hypothesis: `The ${p.id} profile (${p.for}) holds the judge score at lower cost than the session's own model alone.`,
      risk: 'Routing a turn to a weaker tier can cost more turns than it saves, and can fail the task.',
      gate: 'judge score must not drop more than 1 point out of 10 against baseline' })
    cached = c
    return c
  } catch (e) {
    return { version: '0', about: {}, experiments: [], error: `config/optimizations.json unreadable: ${e.message}` }
  }
}

/** Everything a caller needs to show the catalog without running anything. */
export function catalogPayload(ROOT) {
  const c = loadCatalog(ROOT, { fresh: true })
  return {
    version: c.version, updated: c.updated, error: c.error ?? null,
    experiments: c.experiments.map((e) => ({
      id: e.id, title: e.title, family: e.family, summary: e.summary,
      runnable: e.runnable !== false && !e.control, control: !!e.control,
      approximation: !!e.approximation, requires: e.requires ?? null,
      hypothesis: e.hypothesis, risk: e.risk, gate: e.gate,
      arm: e.arm ?? null, kong: e.kong ?? null, kongNote: e.kongNote ?? null,
    })),
  }
}

/**
 * A catalog entry plus the session it runs against becomes a grid cell.
 * `model: "baseline"` means "whatever tier this session actually used", which
 * is the only way a single-lever experiment stays single-lever.
 */
export function resolveArm(entry, session, baselineModel) {
  const arm = entry?.arm ?? {}
  const model = !arm.model || arm.model === 'baseline' ? baselineModel(session) : arm.model
  return {
    label: entry?.title ?? entry?.id ?? 'arm',
    // the column header in the report, and the key the judge scores against
    armId: entry?.control ? 'control' : (entry?.id ?? 'optimized'),
    experimentId: entry?.id ?? null,
    role: entry?.control ? 'baseline' : 'optimized',
    model,
    compaction: !!arm.compaction,
    ...(arm.effort ? { effort: arm.effort } : {}),
    ...(arm.flags ? { flags: arm.flags } : {}),
    ...(arm.budgetUsd ? { budgetUsd: arm.budgetUsd } : {}),
    ...(arm.appendPrompt ? { appendPrompt: arm.appendPrompt } : {}),
    ...(arm.litellm ? { litellm: arm.litellm } : {}),
    ...(arm.claude ? { claude: arm.claude } : {}),
    ...(arm.llmlight ? { llmlight: arm.llmlight } : {}),
  }
}

/**
 * What an arm actually changed, read off its parameters rather than its label.
 *
 * The label is prose — a model wrote it, and on the roman.py grid it confidently
 * called an arm "Frontier no compaction" when the baseline already had
 * compaction off, so the arm varied nothing at all. A run like that measures
 * run-to-run variance and reports it as a lever unless something checks the
 * parameters instead of the prose.
 */
const PARAMS = [
  { key: 'model', label: 'model', of: (c) => c.model },
  { key: 'compaction', label: 'compaction', of: (c) => !!c.compaction,
    say: (v) => (v ? 'compaction on' : 'compaction off') },
  { key: 'effort', label: 'effort', of: (c) => c.effort ?? 'default',
    say: (v) => `effort ${v}` },
  { key: 'budgetUsd', label: 'budget', of: (c) => c.budgetUsd ?? null,
    say: (v) => `budget $${v}` },
  { key: 'flags', label: 'flags', of: (c) => c.flags ?? null },
  { key: 'appendPrompt', label: 'prompt', of: (c) => (c.appendPrompt ? 'appended' : null),
    say: () => 'prompt directive' },
  // the proxy and the client: routing, cache and budget in LiteLLM; env, settings and flags in Claude Code
  { key: 'litellm', label: 'proxy', of: (c) => describeLitellm(c.litellm), say: (v) => `proxy: ${v ?? 'default'}` },
  { key: 'claude', label: 'client', of: (c) => describeClaude(c.claude), say: (v) => `claude code: ${v ?? 'default'}` },
  { key: 'llmlight', label: 'profile', of: (c) => c.llmlight ?? null, say: (v) => `LLM Light profile ${v ?? 'none'}` },
]

/** [{key, label, from, to, say}] — empty when the arm is a copy of the baseline. */
export function armDiff(cell, base) {
  if (!base || cell === base) return []
  const out = []
  for (const p of PARAMS) {
    const a = p.of(base), b = p.of(cell)
    if (a === b) continue
    out.push({ key: p.key, label: p.label, from: a, to: b, say: p.say ? p.say(b) : `${p.label} ${b}` })
  }
  return out
}

/**
 * The short name that identifies an arm on a chart axis: "cheap", "compaction".
 *
 * `priceOf` maps a model id to a rough $/1M figure so a model swap can say which
 * direction it went — "model" alone tells a reader nothing about why the arm
 * exists, and the direction is the whole point of the experiment.
 */
export function armTag(cell, base, entry, priceOf) {
  if (!base || cell === base) return null
  if (entry?.tag) return entry.tag
  const d = armDiff(cell, base)
  if (!d.length) return 'no change'
  const say = (x) => {
    if (x.key !== 'model') return x.label
    const a = priceOf?.(x.from), b = priceOf?.(x.to)
    if (!(a > 0) || !(b > 0)) return 'model'
    return b <= a / 4 ? 'cheap' : b < a ? 'cheaper' : b >= a * 4 ? 'stronger' : 'costlier'
  }
  return d.map(say).join(' + ')
}
