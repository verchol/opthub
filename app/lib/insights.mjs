/**
 * Fleet insights for the Analytics tab: every session classified on a fixed set
 * of attributes, the attributes ranked by how much of the cost spread they
 * explain, and a similarity graph between sessions.
 *
 * Every attribute is derived from the session record (lib/sessions-index.mjs)
 * or its Jev triage labels. `purpose` is the one read from wording, so it is a
 * guess in the same way `kind` is; the rest are measured. Recomputed whenever
 * the session set changes (the cache key is every id + endedAt), which is what
 * makes the classification continuous: a new or growing session is classified
 * on the next poll.
 */

// What the session was for, from the opening request. First match wins, so
// the order goes from specific to general.
const PURPOSE = [
  ['review', /\breview|audit|critique|security[- ]review/],
  ['fix', /\bfix|bug|debug|error|fail|broken|crash|trace|why (is|does|did)/],
  ['test', /\btests?\b|coverage|spec file|pytest|jest/],
  ['refactor', /refactor|clean ?up|simplif|rename|restructure/],
  ['feature', /implement|add |build |create |new feature|support for|wire /],
  ['docs', /readme|document|docs?\b|write[- ]?up|memo|report|blog|spec\b/],
  ['design', /design|diagram|architect|mock|ui\b|page|slide|deck/],
  ['ops', /deploy|install|setup|set up|config|docker|ci\b|release|commit|push|merge/],
  ['data', /analy[sz]|csv|metric|cost|price|percentile|chart|dashboard/],
  ['research', /research|compare|survey|find out|look up|what is|how (do|does|to)/],
  ['explore', /summar|explain|read|check|list|show|where|which|what/],
]
const EXT = {
  code: /\.(m?[jt]sx?|py|go|rs|java|rb|sh|c|cc|cpp|h|swift|kt|sql)$/i,
  docs: /\.(md|mdx|txt|rst|docx?|pdf)$/i,
  web: /\.(html?|css|svg)$/i,
  data: /\.(json|jsonl|csv|ya?ml|toml|xml|tsv)$/i,
  config: /(^\.|rc$|\.env|Dockerfile|Makefile|\.conf$|\.ini$)/i,
}
const TOOLSTYLE = {
  editor: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
  reader: ['Read', 'Grep', 'Glob', 'LS'],
  shell: ['Bash', 'BashOutput', 'KillShell'],
  web: ['WebFetch', 'WebSearch'],
  agentic: ['Task', 'Agent'],
}
const STOP = new Set(('the a an and or of to in on for with from this that these those is are was be it its as at by '
  + 'we you i me my our your can could would should will just also into about make please lets let use using then '
  + 'there here what when where which who how why all any some more most other such only own same than too very '
  + 'have has had do does did not no yes so if but out up new now one two get got see run add file files').split(' '))

export const ATTRS = [
  ['purpose', 'purpose', 'what the opening request asked for (from wording — a guess)'],
  ['kind', 'kind', 'the Sessions tab’s kind'],
  ['artifact', 'artifact', 'type of the files the session wrote'],
  ['project', 'project', 'working directory, last two path parts'],
  ['tools', 'tool style', 'which tool family dominated'],
  ['tier', 'model', 'model tier the session ran on'],
  ['driver', 'driver', 'a person at a terminal, or a script'],
  ['scale', 'scale', 'assistant turns', 'size'],
  ['context', 'context', 'median context carried per request', 'size'],
  ['urgency', 'urgency', 'Jev triage class'],
  ['capability', 'capability', 'Jev triage class'],
  ['deferral', 'deferral', 'Jev triage class'],
]

const band = (v, edges, names) => names[edges.findIndex((e) => v < e)] ?? names[names.length - 1]
function artifactType(arts = []) {
  if (!arts.length) return 'none'
  const n = {}
  for (const a of arts) {
    const t = Object.keys(EXT).find((k) => EXT[k].test(a.name)) ?? 'other'
    n[t] = (n[t] ?? 0) + 1
  }
  return Object.entries(n).sort((a, b) => b[1] - a[1])[0][0]
}
function toolStyle(counts = {}) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  if (!total) return 'chat'
  const share = Object.entries(TOOLSTYLE).map(([k, names]) => [k, names.reduce((a, x) => a + (counts[x] ?? 0), 0) / total])
  share.sort((a, b) => b[1] - a[1])
  return share[0][1] >= 0.2 ? share[0][0] : 'mixed'
}
export const words = (t) => (String(t).toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []).filter((w) => !STOP.has(w))

/** One session's attributes. Missing Jev labels read 'unlabelled', never a guess. */
export function classifySession(s, tri) {
  const i = String(s.intent ?? '').toLowerCase()
  const L = tri?.labels ?? {}
  return {
    purpose: (PURPOSE.find(([, re]) => re.test(i)) ?? ['other'])[0],
    kind: s.kind ?? 'other',
    artifact: artifactType(s.artifacts),
    project: String(s.cwd ?? '?').split('/').filter(Boolean).slice(-2).join('/') || '?',
    tools: toolStyle(s.toolCounts),
    tier: s.modelTier ?? 'other',
    driver: s.entry === 'cli' ? 'human' : s.entry === 'unknown' ? 'unknown' : 'script',
    scale: band(s.turns ?? 0, [4, 20, 50, 200], ['one-shot', 'short', 'medium', 'long', 'marathon']),
    context: band(s.ctxMedian ?? 0, [50e3, 120e3, 250e3], ['<50k', '50–120k', '120–250k', '250k+']),
    urgency: L.urgency ?? 'unlabelled',
    capability: L.capability ?? 'unlabelled',
    deferral: L.deferral ?? 'unlabelled',
  }
}

/**
 * How much of the spread in log(cost) an attribute explains — eta², corrected
 * for the number of groups (omega²-style) so a key that puts every session in
 * its own group does not win by default. 0 means it tells you nothing about cost.
 */
function significance(rows, key) {
  const y = rows.map((r) => Math.log10(Math.max(r.cost, 1e-4)))
  const n = y.length; if (n < 3) return { score: 0, groups: 0 }
  const mean = y.reduce((a, b) => a + b, 0) / n
  const g = {}
  rows.forEach((r, j) => { (g[r.attrs[key]] ??= []).push(y[j]) })
  const k = Object.keys(g).length
  if (k < 2) return { score: 0, groups: k }
  let ssb = 0, ssw = 0
  for (const v of Object.values(g)) {
    const m = v.reduce((a, b) => a + b, 0) / v.length
    ssb += v.length * (m - mean) ** 2
    for (const x of v) ssw += (x - m) ** 2
  }
  const sst = ssb + ssw, msw = ssw / Math.max(n - k, 1)
  const omega = sst ? (ssb - (k - 1) * msw) / (sst + msw) : 0
  return { score: Math.max(0, +omega.toFixed(4)), eta: +(sst ? ssb / sst : 0).toFixed(4), groups: k }
}

// Similarity weights: what the session was for and what it produced count most.
const SIM_W = { purpose: 3, artifact: 2.5, project: 2, kind: 1.5, tools: 1, tier: 0.5, scale: 0.5 }
const SIM_WMAX = Object.values(SIM_W).reduce((a, b) => a + b, 0)

/** Pairwise similarity, kept as each session's nearest neighbours. */
function similarity(rows, { k = 5, min = 0.3 } = {}) {
  // intent words as TF-IDF, so a word every session uses ("opthub") counts for little
  const df = {}
  const docs = rows.map((r) => { const w = new Set(words(r.intent)); for (const x of w) df[x] = (df[x] ?? 0) + 1; return w })
  const N = rows.length
  const vec = docs.map((w) => {
    const v = {}; let norm = 0
    for (const x of w) { const idf = Math.log(1 + N / df[x]); v[x] = idf; norm += idf * idf }
    return { v, norm: Math.sqrt(norm) || 1 }
  })
  const exts = rows.map((r) => new Set((r.artifacts ?? []).map((a) => (a.name.match(/\.[a-z0-9]+$/i) ?? [a.name])[0].toLowerCase())))
  const nbrs = rows.map(() => [])
  for (let a = 0; a < N; a++) for (let b = a + 1; b < N; b++) {
    const A = rows[a].attrs, B = rows[b].attrs
    let attr = 0; const shared = []
    for (const [key, w] of Object.entries(SIM_W)) if (A[key] === B[key]) { attr += w; shared.push(key + ': ' + A[key]) }
    attr /= SIM_WMAX
    let dot = 0; const common = []
    for (const [x, wt] of Object.entries(vec[a].v)) if (vec[b].v[x]) { dot += wt * vec[b].v[x]; common.push([x, wt]) }
    const text = dot / (vec[a].norm * vec[b].norm)
    const ea = exts[a], eb = exts[b]
    const inter = [...ea].filter((x) => eb.has(x))
    const art = ea.size || eb.size ? inter.length / new Set([...ea, ...eb]).size : 0
    const sim = 0.5 * attr + 0.35 * text + 0.15 * art
    if (sim < min) continue
    const why = { shared, words: common.sort((p, q) => q[1] - p[1]).slice(0, 5).map((p) => p[0]), files: inter.slice(0, 5) }
    nbrs[a].push({ id: rows[b].id, sim, why }); nbrs[b].push({ id: rows[a].id, sim, why })
  }
  const out = {}
  rows.forEach((r, j) => { out[r.id] = nbrs[j].sort((p, q) => q.sim - p.sim).slice(0, k).map((x) => ({ ...x, sim: +x.sim.toFixed(3) })) })
  return out
}

let CACHE = { key: '', value: null }
export function insights(sessions, triage = {}) {
  const key = sessions.map((s) => s.id + s.endedAt).join('|') + '#' + Object.keys(triage).length
  if (CACHE.key === key) return CACHE.value
  const prev = CACHE.value?.attrs ?? {}
  const rows = sessions.map((s) => ({ id: s.id, cost: s.cost ?? 0, intent: s.intent, artifacts: s.artifacts, attrs: classifySession(s, triage[s.id]) }))
  // 'size' attributes explain cost by construction (more turns, more tokens), so they are ranked
  // but never the default grouping — the useful answer is which *kind of work* costs what
  const ranking = ATTRS.map(([k, label, why, group = 'work']) => ({ key: k, label, why, group, ...significance(rows, k) }))
    .sort((a, b) => b.score - a.score)
  // sessions whose class is new or changed since the last pass: what "continuous" moved this time
  const changed = rows.filter((r) => !prev[r.id] || JSON.stringify(prev[r.id]) !== JSON.stringify(r.attrs)).map((r) => r.id)
  const value = {
    classifiedAt: new Date().toISOString(),
    attrs: Object.fromEntries(rows.map((r) => [r.id, r.attrs])),
    ranking, changed: CACHE.value ? changed : [],
    neighbours: similarity(rows),
  }
  CACHE = { key, value }
  return value
}
