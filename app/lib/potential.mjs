/**
 * Optimization potential for one session — an estimate, not a measurement.
 *
 * Two kinds of number appear here and they are labelled differently everywhere
 * they surface:
 *
 *   priced   — this session's own token counts re-priced at another model's
 *              published rate. Arithmetic on numbers we have. It is still not a
 *              prediction: a cheaper model usually needs more tokens to finish,
 *              so the priced figure is a ceiling nobody reaches.
 *   guess    — a range with a stated basis and no measurement behind it. Present
 *              so the tab suggests something on sessions where the priced levers
 *              do not apply. Treat as a prompt to run the experiment, nothing more.
 *
 * Every method here names a catalog id, so "run the experiment that would
 * settle this" is one click away.
 */

// $/1M tokens, API list. Cache reads bill 0.1x input, writes 1.25x.
const RATE = {
  opus45:   { in: 15, out: 75, label: 'Opus' },
  sonnet46: { in: 3,  out: 15, label: 'Sonnet' },
  qwen480:  { in: 0.22, out: 1.80, label: 'Qwen3-Coder-480B' },
}
// Two sandbox arms of a typical session. The ROI gate below is measured against this.
const EXPERIMENT_COST = Number(process.env.OPT_EXPERIMENT_COST_USD ?? 1.0)
const TIER_RATE = { opus: RATE.opus45, sonnet: RATE.sonnet46, haiku: { in: 1, out: 5 }, fable: RATE.sonnet46, other: RATE.sonnet46 }

/** This session's exact token counts, priced at some rate. */
function priceAt(s, r) {
  return ((s.freshInTokens + s.cacheWriteTokens * 1.25 + s.cacheReadTokens * 0.1) * r.in
        + s.outTokens * r.out) / 1e6
}

export function potential(s) {
  const methods = []
  const cost = s.cost || 0
  const own = TIER_RATE[s.modelTier] ?? TIER_RATE.other
  const pctOf = (usd) => (cost > 0 ? (usd / cost) * 100 : 0)

  // ---- priced: move the same tokens to a cheaper model ---------------------
  if (cost > 0.05 && (s.modelTier === 'opus' || s.modelTier === 'fable')) {
    const save = cost - priceAt(s, RATE.sonnet46)
    if (save > 0) methods.push({
      id: 'route-cheaper-frontier', title: 'Route to Sonnet', kind: 'priced',
      lo: pctOf(save) * 0.6, hi: pctOf(save),
      why: `These exact tokens cost $${priceAt(s, RATE.sonnet46).toFixed(2)} at Sonnet's rate instead of $${cost.toFixed(2)}. The low end assumes the weaker model needs ~40% more tokens to finish; nothing here measures whether it finishes at all.`,
    })
  }
  if (cost > 0.05 && s.kind === 'code' && s.modelTier !== 'haiku') {
    const save = cost - priceAt(s, RATE.qwen480)
    if (save > 0) methods.push({
      id: 'route-open-weights', title: 'Route to open weights', kind: 'priced',
      lo: pctOf(save) * 0.5, hi: pctOf(save),
      why: `Qwen3-Coder-480B on Bedrock prices these tokens at $${priceAt(s, RATE.qwen480).toFixed(2)}. Open weights are weakest exactly where this is riskiest — tool-calling and long-context adherence — so the low end halves the paper win.`,
    })
  }

  // ---- priced: thinking is output, and output is the expensive half --------
  const thinkShare = s.outTokens ? s.thinkingTokens / s.outTokens : 0
  if (s.thinkingTokens > 2000 && thinkShare > 0.12) {
    const thinkCost = (s.thinkingTokens * own.out) / 1e6
    methods.push({
      id: 'effort-medium', title: 'Lower the reasoning effort', kind: 'priced',
      lo: pctOf(thinkCost) * 0.3, hi: pctOf(thinkCost) * 0.6,
      why: `${(thinkShare * 100).toFixed(0)}% of output was thinking ($${thinkCost.toFixed(2)} of it). Medium effort cuts some fraction of that and nothing else — the smallest-risk lever here, and the smallest prize.`,
    })
  }

  // ---- guess: the context is the bill -------------------------------------
  if (s.ctxMedian >= 250000) {
    methods.push({
      id: 'context-compaction', title: 'Compact the context window', kind: 'guess',
      lo: 10, hi: 30,
      why: `Median request carried ${(s.ctxMedian / 1000).toFixed(0)}k tokens. Sessions with a median context at or above 250k are where the spend concentrates, and no priced lever touches session length. The range is a guess with no measurement behind it.`,
    })
  } else if (s.ctxMedian >= 120000) {
    methods.push({
      id: 'context-compaction', title: 'Compact the context window', kind: 'guess',
      lo: 4, hi: 15,
      why: `Median request carried ${(s.ctxMedian / 1000).toFixed(0)}k tokens — long, but below the band where context dominates. Compaction costs one summarisation, which on a session this size can be most of the win.`,
    })
  }

  // ---- guess / detector: what the cache is already doing -------------------
  if (s.cacheHit >= 0.9) {
    methods.push({
      id: 'semantic-cache', title: 'Caching — already saturated', kind: 'detector', lo: 0, hi: 0,
      why: `Prompt-cache hit rate is ${(s.cacheHit * 100).toFixed(1)}%. There is nothing left for a cache to catch. Anything sold as a caching win on this session is measuring something else.`,
    })
  } else if (s.inTokens > 50000) {
    methods.push({
      id: 'terse-context', title: 'Trim the prefix', kind: 'guess', lo: 3, hi: 12,
      why: `Only ${(s.cacheHit * 100).toFixed(1)}% of input was served from cache, so the prefix is being rewritten. Something ahead of the cache breakpoint is changing between turns — worth finding before trimming anything.`,
    })
  }

  const scoring = methods.filter((m) => m.kind !== 'detector')
  // Levers overlap — routing and effort both bill against output — so the
  // headline is the best single lever, not the sum of them.
  const lo = scoring.length ? Math.max(...scoring.map((m) => m.lo)) : 0
  const hi = scoring.length ? Math.max(...scoring.map((m) => m.hi)) : 0
  const mid = (lo + hi) / 2
  const usdLo = (cost * lo) / 100, usdHi = (cost * hi) / 100

  // Routing applies to nearly every session, so a percentage alone rates
  // everything "high" and discriminates nothing. What actually decides whether
  // a session is worth touching is whether the win clears the cost of finding
  // out: two sandbox arms, on this grid, run about $EXPERIMENT_COST.
  const band = usdHi < EXPERIMENT_COST ? 'below-gate'
    : mid >= 40 ? 'high' : mid >= 15 ? 'medium' : mid > 0 ? 'low' : 'none'

  return {
    band, lo, hi, usdLo, usdHi,
    experimentCost: EXPERIMENT_COST,
    gateNote: band === 'below-gate'
      ? `The whole session cost $${cost.toFixed(2)}, so the best case saves $${usdHi.toFixed(2)} — less than the ~$${EXPERIMENT_COST.toFixed(2)} of sandbox time it takes to measure. Not worth an experiment.`
      : null,
    methods: methods.sort((a, b) => b.hi - a.hi),
    basis: 'Best single lever, not the sum — routing and effort bill against the same output tokens. Priced figures re-price this session’s own tokens; guesses carry a stated basis and no measurement. Run the experiment to replace either with a number.',
  }
}
