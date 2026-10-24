/**
 * Session tags — what this session *is*, beyond the single `kind` classifier.
 *
 * Every tag is derived from a measured signal in the transcript and carries the
 * number that produced it, so a tag can be argued with. Nothing here is
 * inferred from the prompt text except `kind` itself, which the index already
 * guesses from wording and is labelled as a guess.
 *
 * Groups drive colour, and are ordered by how much they tell you:
 *   work   what the session was doing
 *   festive whether it is that time of year
 *   shape  how big and how long it ran
 *   cost   where the money went
 *   tools  how it went about it
 *   flag   things worth knowing before you act on it
 */
const TOOLS = {
  edit: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
  read: ['Read', 'Grep', 'Glob', 'LS'],
  shell: ['Bash', 'BashOutput', 'KillShell'],
  web: ['WebFetch', 'WebSearch'],
  agent: ['Task', 'Agent'],
  plan: ['TodoWrite', 'ExitPlanMode', 'EnterPlanMode'],
}
const share = (counts, names) => {
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  if (!total) return 0
  return names.reduce((a, n) => a + (counts[n] ?? 0), 0) / total
}

export function tagsFor(s) {
  const t = []
  const add = (tag, group, why) => t.push({ tag, group, why })
  const c = s.toolCounts ?? {}
  const names = Object.keys(c)
  const pct = (v) => (v * 100).toFixed(0) + '%'

  // ---- work -------------------------------------------------------------
  add(s.kind, 'work', 'guessed from the opening request and the tools used — the one tag here that is not measured')
  if (s.hasArtifact) add('shipped', 'work', `wrote ${s.artifacts.length} file(s): ${s.artifacts.slice(0, 4).map((a) => a.name).join(', ')}`)
  else add('no-artifact', 'work', 'no file was written — the value, if any, was in the conversation')
  if (share(c, TOOLS.plan) > 0.05) add('planned', 'work', 'used a todo list or plan mode rather than going straight at it')

  // ---- shape ------------------------------------------------------------
  if (s.turns <= 3) add('one-shot', 'shape', `${s.turns} assistant turn(s)`)
  else if (s.turns >= 200) add('marathon', 'shape', `${s.turns} assistant turns`)
  else if (s.turns >= 50) add('long-run', 'shape', `${s.turns} assistant turns`)
  if (s.durationMin >= 24 * 60) add('resumed', 'shape', `spans ${(s.durationMin / 60).toFixed(0)}h — first to last record, not active time, so it was picked back up`)
  if (s.live) add('live', 'shape', 'a record was written in the last five minutes')
  if (s.ctxMedian >= 250000) add('mega-context', 'shape', `median request carried ${Math.round(s.ctxMedian / 1000)}k tokens — the band where context dominates the bill`)
  else if (s.ctxMedian >= 120000) add('long-context', 'shape', `median request carried ${Math.round(s.ctxMedian / 1000)}k tokens`)
  if (s.compactions > 0) add('compacted', 'shape', `context was cut back ${s.compactions} time(s) mid-session`)

  // ---- cost -------------------------------------------------------------
  if (s.cost >= 100) add('top-spend', 'cost', `$${s.cost.toFixed(2)} API-list equivalent`)
  else if (s.cost >= 10) add('costly', 'cost', `$${s.cost.toFixed(2)} API-list equivalent`)
  else if (s.cost < 1) add('cheap', 'cost', `$${s.cost.toFixed(2)} — below the cost of measuring it`)
  if (s.cacheHit >= 0.95) add('cache-saturated', 'cost', `${pct(s.cacheHit)} of input served from cache — nothing left for a cache to win`)
  else if (s.inTokens > 50000 && s.cacheHit < 0.6) add('cache-cold', 'cost', `only ${pct(s.cacheHit)} of input came from cache — the prefix is being rewritten`)
  if (s.outTokens && s.thinkingTokens / s.outTokens >= 0.25)
    add('heavy-thinking', 'cost', `${pct(s.thinkingTokens / s.outTokens)} of output was thinking — billed, never read`)
  if (s.modelTier === 'opus') add('opus', 'cost', 'the most expensive tier, 5× Sonnet on both input and output')

  // ---- tools ------------------------------------------------------------
  if (share(c, TOOLS.edit) >= 0.25) add('write-heavy', 'tools', `${pct(share(c, TOOLS.edit))} of tool calls edited files`)
  if (share(c, TOOLS.read) >= 0.5) add('search-heavy', 'tools', `${pct(share(c, TOOLS.read))} of tool calls were reads or searches`)
  if (share(c, TOOLS.shell) >= 0.3) add('shell-heavy', 'tools', `${pct(share(c, TOOLS.shell))} of tool calls were shell commands`)
  if (names.some((n) => TOOLS.web.includes(n))) add('web', 'tools', 'fetched or searched the web')
  if (names.some((n) => TOOLS.agent.includes(n))) add('subagents', 'tools', 'delegated to subagents, whose cost lands in this session')
  if (names.some((n) => n.startsWith('mcp__'))) add('mcp', 'tools', `used MCP servers: ${[...new Set(names.filter((n) => n.startsWith('mcp__')).map((n) => n.split('__')[1]))].join(', ')}`)
  if (!s.toolCalls) add('no-tools', 'tools', 'pure conversation — nothing was run or read')

  // ---- festive ----------------------------------------------------------
  if (s.shanaTova?.hit) add('shana-tova', 'festive',
    `asked for a New Year card (confidence ${s.shanaTova.confidence}). This agent writes files, not images \u2014 `
    + `$${s.shanaTova.perCard.toFixed(2)} per attempt.`)

  // ---- flags ------------------------------------------------------------
  if (s.secrets) add('secrets-in-transcript', 'flag', 'a credential-shaped string appears in this transcript')
  if (s.turns >= 40 && !s.hasArtifact) add('long-and-empty', 'flag', `${s.turns} turns and no file written — worth knowing what it was for`)

  return t
}
