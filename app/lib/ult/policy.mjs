/**
 * class → keep | route | local, under the policy block of the ULT config.
 *
 * Two rules come from measurement, not taste (opthub docs/evidence-catalog.md):
 *  - Economics is cache-aware. Claude Code input is 94–99.9% cache reads, so moving a
 *    long main-thread request to another model re-buys its prefix uncached. A remote
 *    route must show an estimated saving.
 *  - Threads are sticky. Once a thread goes to a target it stays there, so its cache
 *    stays warm; flipping per turn pays a cache write every time.
 */

/** Model id → [input $/M, output $/M]. Unknown models price as the dearest known one. */
export function priceOf(model, prices) {
  if (!model) return null
  if (prices[model]) return prices[model]
  const base = model.replace(/-\d{8}$/, '').replace(/\[.*\]$/, '')
  if (prices[base]) return prices[base]
  const hit = Object.keys(prices).filter(k => base.startsWith(k)).sort((a, b) => b.length - a.length)[0]
  return hit ? prices[hit] : null
}

export function estimateUsd({ inputTokens, outputTokens, price, cachedShare, cache, freshWrite }) {
  if (!price) return null
  const [pin, pout] = price
  const cached = freshWrite ? 0 : inputTokens * cachedShare
  const fresh = inputTokens - cached
  const inputUsd = (cached * pin * cache.read + fresh * pin * (freshWrite ? cache.write5m : 1)) / 1e6
  return inputUsd + (outputTokens * pout) / 1e6
}

function routeFor(cls, routes) {
  if (routes[cls]) return routes[cls]
  const fam = cls.split('/')[0] + '/*'
  return routes[fam] ?? 'keep'
}

/**
 * @returns {{decision:'keep'|'route'|'local', target:string|null, reason:string,
 *            estKeepUsd:number|null, estRouteUsd:number|null, wouldAct:boolean}}
 * `target` is a concrete model id (remote) or `local:<model>`. `wouldAct` is what route
 * mode would do; in shadow mode the caller forwards unchanged regardless.
 */
export function decide({ cls, confidence, features: f, config: cfg, threadTarget }) {
  const p = cfg.policy
  const requested = f.requestedModel
  const keep = (reason, extra = {}) => ({ decision: 'keep', target: requested, reason, estKeepUsd: null, estRouteUsd: null, wouldAct: false, ...extra })

  if (p.pin === 'frontier') return keep('pinned: frontier')
  if (p.neverDowngrade?.includes(cls)) return keep(`never_downgrade (${p.version})`)

  if (p.stickyThreads && threadTarget && threadTarget !== requested) {
    const local = threadTarget.startsWith('local:')
    if (local && !cfg.local?.enabled) return keep('thread was local; local disabled')
    return { decision: local ? 'local' : 'route', target: threadTarget, reason: 'thread pinned to its earlier target', estKeepUsd: null, estRouteUsd: null, wouldAct: true }
  }

  const rule = routeFor(cls, p.routes)
  if (rule === 'keep') return keep(`route table: ${cls} → keep`)
  if ((confidence ?? 0) < (p.minConfidence ?? 0.6)) return keep(`confidence ${(confidence ?? 0).toFixed(2)} below ${p.minConfidence ?? 0.6}`)

  if (rule === 'local' || rule.startsWith('local:')) {
    if (!cfg.local?.enabled) return keep('local route, but local is disabled')
    if (f.toolsOffered > 0 && !p.localWithTools) return keep('local route skipped: request offers tools')
    const model = rule === 'local' ? cfg.local.model : rule.slice(6)
    return { decision: 'local', target: `local:${model}`, reason: `route table: ${cls} → local`, estKeepUsd: null, estRouteUsd: 0, wouldAct: true }
  }

  const target = rule.slice(7)   // remote:<model>
  if (target === requested) return keep('target equals requested model')
  const out = p.economics?.expectedOutputTokens ?? 800
  const cachedShare = p.economics?.assumeCachedPrefix === false ? 0 : (f.messages > 2 ? 0.95 : 0)
  const estKeepUsd = estimateUsd({ inputTokens: f.approxInputTokens, outputTokens: out, price: priceOf(requested, cfg.prices), cachedShare, cache: cfg.cache })
  const estRouteUsd = estimateUsd({ inputTokens: f.approxInputTokens, outputTokens: out, price: priceOf(target, cfg.prices), cachedShare: 0, cache: cfg.cache, freshWrite: true })
  const est = { estKeepUsd, estRouteUsd }
  if (p.economics?.requireSaving !== false && estKeepUsd != null && estRouteUsd != null && estRouteUsd >= estKeepUsd) {
    return keep(`route to ${target} costs more once the prefix is re-bought uncached`, est)
  }
  return { decision: 'route', target, reason: `route table: ${cls} → ${target}`, ...est, wouldAct: true }
}
