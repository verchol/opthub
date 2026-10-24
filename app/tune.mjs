/**
 * tune.mjs — search for a better harness configuration, and have Claude reason
 * about why one won.
 *
 * The rig compares two arms a human wrote. This closes that loop: run several
 * configurations of the *same* task, grade them the same way, then ask Claude to
 * read the results and propose the next set. Each round is a generation.
 *
 *   generation 1   baseline + N-1 candidates the reasoner proposes cold
 *   judge          why did this one win — signal or variance?
 *   generation 2   candidates informed by what generation 1 showed
 *   …
 *
 * Two things keep this honest rather than a slot machine:
 *
 *   * The reasoner may only move knobs in SEARCH_SPACE. Claude Code rejects a
 *     flag it does not have, and a candidate that fails to boot teaches nothing,
 *     so invention is not allowed — the space is passed in the prompt and the
 *     result is schema-checked against it.
 *   * n = 1 per candidate by default. Agent runs vary widely; the judge is told
 *     the sample size and asked to say when a gap is inside the noise rather
 *     than to declare a winner regardless.
 */
import Anthropic from '@anthropic-ai/sdk'
import { STATE } from './lib/state.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { runBundle } from './sandbox.mjs'
import { startTrace, ensureProject, usagePayload, enabled as tracingOn, projectUrl } from './langsmith.mjs'

const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', c: '\x1b[36m', m: '\x1b[35m',
            d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }

const REASONER_MODEL = process.env.TUNE_REASONER_MODEL ?? 'claude-opus-5'

/**
 * What the reasoner is allowed to change. Every entry is a real Claude Code
 * lever — `claude --help` is the source of truth, not the model's memory.
 */
export const SEARCH_SPACE = {
  model: {
    kind: 'enum', values: ['opus', 'sonnet', 'fable'],
    note: 'the session model. sonnet is ~2.5x cheaper per token than opus and often enough for a well-specified task.',
  },
  effort: {
    kind: 'enum', values: ['low', 'medium', 'high', 'xhigh', 'max'],
    flag: '--effort',
    note: 'thinking depth and overall token spend. xhigh is the Claude Code default; medium is the single cheapest lever.',
  },
  autocompact: {
    kind: 'enum', values: ['auto', '100000', '200000', '400000', '800000'],
    flag: '--autocompact',
    note: 'when the context window is compacted. A task that never approaches the window is unaffected by this.',
  },
  excludeDynamicSystemPrompt: {
    kind: 'bool', flag: '--exclude-dynamic-system-prompt-sections',
    note: 'moves per-machine sections out of the system prompt, improving prompt-cache reuse across runs.',
  },
  strictMcpConfig: {
    kind: 'bool', flag: '--strict-mcp-config',
    note: 'ignores user/project MCP config. In a clean sandbox this mostly removes startup work.',
  },
  settingSources: {
    kind: 'enum', values: ['', 'project', 'user,project'],
    flag: '--setting-sources',
    note: 'which settings files load. Empty means none.',
  },
  tools: {
    kind: 'string', flag: '--tools',
    note: 'space-separated built-in tool names to allow, e.g. "Bash Read Write Edit". Narrowing the set shrinks the tool schemas in the system prompt. "default" keeps all.',
  },
  agents: {
    kind: 'json', flag: '--agents',
    note: 'JSON object defining subagents, e.g. {"reviewer":{"description":"Reviews code","prompt":"…","model":"sonnet"}}. Downgrading a subagent to sonnet is a common cost lever.',
  },
  appendSystemPrompt: {
    kind: 'string', flag: '--append-system-prompt',
    note: 'text appended to the system prompt. Stable across turns, so it caches well.',
  },
  promptSuffix: {
    kind: 'string',
    note: 'strategy text appended to PROMPT.md itself — a plan-first checklist, a batching rule, a context-discipline rule. Not a flag; it changes the task prompt.',
  },
}

export const flagsFor = (cfg) => {
  const out = []
  for (const [key, spec] of Object.entries(SEARCH_SPACE)) {
    if (!spec.flag) continue
    const v = cfg[key]
    if (v == null || v === '' || v === false) continue
    if (spec.kind === 'bool') { out.push(spec.flag); continue }
    if (spec.kind === 'json') { out.push(`${spec.flag} ${JSON.stringify(JSON.stringify(v))}`); continue }
    out.push(`${spec.flag} ${/\s/.test(String(v)) ? JSON.stringify(String(v)) : v}`)
  }
  return out
}

/** The baseline every generation is measured against: stock everything. */
const BASELINE = { id: 'baseline', model: process.env.BENCH_MODEL ?? 'opus', rationale: 'stock defaults — the thing to beat' }

const toRunnable = (cfg) => ({
  id: cfg.id, model: cfg.model ?? 'opus', flags: flagsFor(cfg),
  promptSuffix: cfg.promptSuffix ?? null, env: cfg.env ?? {},
})

// ---------------------------------------------------------------- scoring

/**
 * A candidate is better if it is more correct; cost breaks ties.
 * Correctness that cannot be measured is not silently treated as zero — an
 * ungradeable run reports `null` and the reasoner is told to weigh cost and
 * the artifact instead.
 */
export function score(rec) {
  const total = rec.grade?.total ?? 0
  const passRate = total ? rec.grade.passed / total : null
  return {
    id: rec.id,
    passed: rec.grade?.passed ?? null, total: total || null, passRate,
    cost: rec.cost, turns: rec.turns, wallSec: rec.wallSec,
    tokens: rec.usage ? (rec.usage.input_tokens ?? 0) + (rec.usage.cache_read_input_tokens ?? 0)
                      + (rec.usage.cache_creation_input_tokens ?? 0) + (rec.usage.output_tokens ?? 0) : null,
    fatal: rec.fatal ?? null,
    error: rec.result?.is_error ? (rec.result.result ?? 'agent reported an error') : null,
  }
}

export function rank(scores) {
  return [...scores].sort((a, b) => {
    if (a.fatal && !b.fatal) return 1
    if (b.fatal && !a.fatal) return -1
    const ap = a.passRate ?? -1, bp = b.passRate ?? -1
    if (ap !== bp) return bp - ap
    return (a.cost ?? Infinity) - (b.cost ?? Infinity)
  })
}

// ---------------------------------------------------------------- reasoner

const PROPOSE_TOOL = {
  name: 'propose_generation',
  description: 'Record the analysis of the generation just run and the candidates to try next.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['reading', 'confidence', 'candidates'],
    properties: {
      reading: {
        type: 'string',
        description: 'What the results actually show, including where a difference is inside the noise for this sample size. Name the mechanism you think produced the difference, not just the ranking.',
      },
      confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
      stop: {
        type: 'boolean',
        description: 'True when further search is not worth the spend — the space is exhausted, or every remaining difference is noise.',
      },
      candidates: {
        type: 'array',
        minItems: 1, maxItems: 4,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'rationale'],
          properties: {
            id: { type: 'string', description: 'short kebab-case name, unique in this run' },
            rationale: { type: 'string', description: 'the one thing this candidate tests, and what result would confirm or kill it' },
            model: { type: 'string', enum: ['opus', 'sonnet', 'fable'] },
            effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
            autocompact: { type: 'string', enum: ['auto', '100000', '200000', '400000', '800000'] },
            excludeDynamicSystemPrompt: { type: 'boolean' },
            strictMcpConfig: { type: 'boolean' },
            settingSources: { type: 'string', enum: ['', 'project', 'user,project'] },
            tools: { type: 'string' },
            appendSystemPrompt: { type: 'string' },
            promptSuffix: { type: 'string' },
          },
        },
      },
    },
  },
}

export function reasonerPrompt({ manifest, generations, budget, candidatesPerGen, repeats }) {
  const space = Object.entries(SEARCH_SPACE)
    .map(([k, v]) => `- ${k} (${v.kind}${v.values ? `: ${v.values.join(' | ')}` : ''}) — ${v.note}`)
    .join('\n')

  const history = generations.map((g, i) => {
    const rows = rank(g.scores).map((s) => {
      const cfg = g.configs.find((c) => c.id === s.id) ?? {}
      const knobs = Object.entries(cfg)
        .filter(([k]) => k in SEARCH_SPACE)
        .map(([k, v]) => `${k}=${typeof v === 'string' && v.length > 60 ? v.slice(0, 60) + '…' : JSON.stringify(v)}`)
        .join(' ') || 'stock'
      return `  ${s.id.padEnd(18)} ${s.total ? `${s.passed}/${s.total}` : 'ungraded'.padEnd(7)}  ` +
             `$${s.cost?.toFixed(4) ?? '—'}  ${s.turns ?? '—'} turns  ${s.wallSec ?? '—'}s  ${s.tokens ?? '—'} tok` +
             `${s.fatal ? `  FATAL: ${s.fatal.slice(0, 120)}` : ''}${s.error ? `  ERROR: ${s.error.slice(0, 120)}` : ''}\n` +
             `    ${knobs}${cfg.rationale ? `\n    intent: ${cfg.rationale}` : ''}`
    }).join('\n')
    return `## Generation ${i + 1}\n${rows}${g.reading ? `\n\n  your reading last time: ${g.reading}` : ''}`
  }).join('\n\n')

  return `You are tuning the harness around a coding agent, not the model inside it.

The same task runs in a fresh E2B sandbox under each configuration. The model is
whatever the candidate selects; everything else — prompt, flags, tool surface,
compaction — is what you are searching over.

# The task
${manifest.task ? `${manifest.task.title ?? manifest.task.name} — implements \`${manifest.task.file}\`, graded by a hidden test suite the agent never sees.`
                : manifest.session.intent}
Fidelity of this bundle: ${manifest.fidelity} (${manifest.fidelityNote})
Gradeable: ${manifest.gradeable ? 'yes — pass rate is the primary signal' : 'NO — there is no test suite. Correctness cannot be measured here, so weigh cost, turns, and whether the run completed at all, and say plainly that quality is unmeasured.'}

# The search space
Only these knobs exist. A flag outside this list does not exist in Claude Code and
the run will fail, teaching nothing.

${space}

# What has been run
${history || '(nothing yet — this is the first generation)'}

# Sample size
${repeats} run per candidate. Agent runs vary substantially; on one run a
difference under roughly 15% in cost or turns is not distinguishable from noise,
and a 1-2 test difference in pass rate usually is not either. Say so when it
applies instead of ranking regardless.

# Your job
Propose up to ${candidatesPerGen} candidates for the next generation. Each should
test one thing you can name, so that its result is interpretable. Do not propose
a candidate whose knobs you cannot justify from what the runs have shown, and do
not re-run a configuration already measured unless you are explicitly testing
reproducibility — say so if you are.

Budget: about $${budget} per candidate. Set stop=true when more search is not
worth the spend.`
}

async function askReasoner(client, args, trace) {
  const prompt = reasonerPrompt(args)
  const span = trace?.child({
    name: 'reasoner', runType: 'llm',
    inputs: { prompt },
    metadata: { model: REASONER_MODEL, ls_model_name: REASONER_MODEL, ls_provider: 'anthropic' },
    tags: ['reasoner'],
  })
  try {
    const res = await client.messages.create({
      model: REASONER_MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      tools: [PROPOSE_TOOL],
      tool_choice: { type: 'tool', name: 'propose_generation' },
      messages: [{ role: 'user', content: prompt }],
    })
    const call = res.content.find((b) => b.type === 'tool_use')
    if (!call) throw new Error('the reasoner returned no proposal')
    await span?.end({
      outputs: { ...call.input, usage_metadata: usagePayload(
        { input_tokens: res.usage.input_tokens, cache_read_input_tokens: res.usage.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: res.usage.cache_creation_input_tokens ?? 0,
          output_tokens: res.usage.output_tokens }, REASONER_MODEL) },
    })
    return { ...call.input, usage: res.usage }
  } catch (e) {
    await span?.end({ error: String(e?.message ?? e).slice(0, 500) })
    throw e
  }
}

// ---------------------------------------------------------------- the loop

export async function tune({ ROOT, dir, generations = 2, candidatesPerGen = 3, repeats = 1,
                             budget = process.env.MAX_BUDGET_USD ?? '4', onLog = console.log } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  const client = new Anthropic()
  const tuneId = new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = path.join(STATE, 'tuning', tuneId)
  fs.mkdirSync(outDir, { recursive: true })

  await ensureProject()
  const trace = tracingOn() ? startTrace(`tune ${path.basename(dir)}`, {
    inputs: { bundle: path.basename(dir), intent: manifest.session.intent,
              generations, candidatesPerGen, repeats, budgetPerCandidate: budget },
    metadata: { tuneId, fidelity: manifest.fidelity, gradeable: manifest.gradeable,
                reasoner: REASONER_MODEL, searchSpace: Object.keys(SEARCH_SPACE) },
    tags: ['tune', `bundle:${path.basename(dir)}`],
  }) : null
  if (trace) onLog(`  ${C.d}tracing → ${projectUrl()}${C.x}`)

  const history = []
  let configs = [BASELINE]
  let stopped = null

  for (let gen = 1; gen <= generations; gen++) {
    // The reasoner proposes from generation 2 on; generation 1 is baseline plus
    // its cold proposals, so there is something to compare against from the start.
    if (gen === 1) {
      onLog(`\n  ${C.b}generation 1${C.x} ${C.d}· asking ${REASONER_MODEL} for an opening set${C.x}`)
      const opening = await askReasoner(client, { manifest, generations: [], budget, candidatesPerGen: candidatesPerGen - 1, repeats }, trace)
        .catch((e) => { onLog(`  ${C.y}reasoner unavailable (${e.message}) — running baseline alone${C.x}`); return null })
      if (opening) {
        configs = [BASELINE, ...opening.candidates.slice(0, candidatesPerGen - 1)]
        onLog(`  ${C.d}${opening.reading}${C.x}`)
      }
    } else {
      onLog(`\n  ${C.b}generation ${gen}${C.x} ${C.d}· reading ${history.length} generation(s) of results${C.x}`)
      const next = await askReasoner(client, { manifest, generations: history, budget, candidatesPerGen, repeats }, trace)
      history[history.length - 1].reading = next.reading
      onLog(`\n  ${C.c}reading${C.x} ${next.reading}`)
      onLog(`  ${C.d}confidence ${next.confidence}${C.x}`)
      if (next.stop) { stopped = next.reading; onLog(`  ${C.y}the reasoner stopped here${C.x}`); break }
      configs = next.candidates.slice(0, candidatesPerGen)
    }

    const genSpan = trace?.child({
      name: `generation ${gen}`,
      inputs: { candidates: configs.map((c) => ({ id: c.id, rationale: c.rationale })) },
      tags: ['generation', `gen:${gen}`],
    })

    onLog(`  ${C.d}running ${configs.length} candidate(s) in parallel${C.x}`)
    for (const c of configs) onLog(`    ${C.m}${c.id.padEnd(20)}${C.x}${C.d}${c.rationale ?? ''}${C.x}`)

    const recs = await Promise.all(configs.map((cfg) =>
      runBundle({ ROOT, dir, manifest, config: toRunnable(cfg), trace: genSpan, budgetUsd: budget })
        .catch((e) => ({ id: cfg.id, fatal: String(e?.message ?? e) }))))

    const scores = recs.map(score)
    for (const s of rank(scores)) {
      const verdict = s.fatal ? `${C.r}FATAL${C.x} ${s.fatal.slice(0, 60)}`
        : `${s.total ? `${s.passed}/${s.total}` : 'ungraded'}  $${s.cost?.toFixed(4) ?? '—'}  ${s.turns ?? '—'} turns  ${s.wallSec ?? '—'}s`
      onLog(`    ${C.d}→${C.x} ${s.id.padEnd(20)}${verdict}`)
    }
    await genSpan?.end({ outputs: { ranked: rank(scores) } })

    history.push({ gen, configs, scores, recs: recs.map((r) => ({ ...r, stream: undefined })) })
    fs.writeFileSync(path.join(outDir, 'tuning.json'), JSON.stringify(
      { tuneId, bundle: path.basename(dir), manifest, generations: history, stopped }, null, 2))
  }

  const all = history.flatMap((g) => g.scores)
  const best = rank(all)[0] ?? null
  const baseline = all.find((s) => s.id === 'baseline') ?? null
  await trace?.end({
    outputs: { best, baseline, generations: history.length, stopped },
  })
  fs.writeFileSync(path.join(outDir, 'tuning.json'), JSON.stringify(
    { tuneId, bundle: path.basename(dir), manifest, generations: history, best, baseline, stopped }, null, 2))
  return { outDir, history, best, baseline, stopped, traceUrl: trace ? projectUrl() : null }
}

export function renderTuning({ outDir, history, best, baseline, stopped, traceUrl }, ROOT) {
  const L = ['']
  if (!best) { L.push(`  ${C.y}nothing ran${C.x}`); L.push(''); return L.join('\n') }
  const delta = (a, b) => (a == null || b == null || !b) ? null : ((a - b) / b) * 100
  L.push(`  ${C.b}best${C.x}      ${best.id}  ${best.total ? `${best.passed}/${best.total}` : 'ungraded'}  $${best.cost?.toFixed(4) ?? '—'}  ${best.turns ?? '—'} turns`)
  if (baseline && baseline.id !== best.id) {
    const dc = delta(best.cost, baseline.cost)
    L.push(`  ${C.d}baseline${C.x}  ${baseline.id}  ${baseline.total ? `${baseline.passed}/${baseline.total}` : 'ungraded'}  $${baseline.cost?.toFixed(4) ?? '—'}  ${baseline.turns ?? '—'} turns`)
    if (dc != null) L.push(`  ${C.d}cost${C.x}      ${dc < 0 ? C.g : C.r}${dc > 0 ? '+' : ''}${dc.toFixed(1)}%${C.x} ${C.d}against baseline${C.x}`)
  } else if (baseline) {
    L.push(`  ${C.y}nothing beat the baseline${C.x}`)
  }
  L.push('')
  L.push(`  ${C.d}generations${C.x} ${history.length}${stopped ? ` ${C.d}(stopped early: ${stopped.slice(0, 90)})${C.x}` : ''}`)
  L.push(`  ${C.d}written to${C.x}  ${path.relative(ROOT, outDir)}/tuning.json`)
  if (traceUrl) L.push(`  ${C.d}trace${C.x}       ${traceUrl}`)
  L.push('')
  L.push(`  ${C.d}n=1 per candidate — a gap under ~15% is not distinguishable from run-to-run variance${C.x}`)
  L.push('')
  return L.join('\n')
}
