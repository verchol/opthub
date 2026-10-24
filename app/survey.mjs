#!/usr/bin/env node
/**
 * Survey real Claude Code sessions on this machine for replay suitability.
 * Costs nothing: reads local transcripts only.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const PROJ = path.join(os.homedir(), '.claude', 'projects')
// API list prices, USD per 1M tokens. Cache reads bill at 0.1x input, writes 1.25x.
const PRICE = {
  opus:   { in: 15, out: 75 }, sonnet: { in: 3, out: 15 },
  haiku:  { in: 1, out: 5 },   fable:  { in: 3, out: 15 }, other: { in: 3, out: 15 },
}
const tier = (m = '') => /opus/i.test(m) ? 'opus' : /sonnet/i.test(m) ? 'sonnet'
  : /haiku/i.test(m) ? 'haiku' : /fable/i.test(m) ? 'fable' : 'other'

const SECRET = /sk-ant-(api03|oat01)-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|e2b_[a-f0-9]{32}|gho_[A-Za-z0-9]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY/

function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name)
    if (f.isDirectory()) walk(p, out)
    else if (f.name.endsWith('.jsonl')) out.push(p)
  }
  return out
}

const rows = []
for (const file of (fs.existsSync(PROJ) ? walk(PROJ) : [])) {
  let cost = 0, turns = 0, tools = 0, out = 0, inTok = 0, model = '', intent = '', secrets = false
  let firstTs = null, lastTs = null, cwd = ''
  const toolNames = new Set()
  let raw = ''
  try { raw = fs.readFileSync(file, 'utf8') } catch { continue }
  if (SECRET.test(raw)) secrets = true
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let ev; try { ev = JSON.parse(line) } catch { continue }
    if (ev.cwd && !cwd) cwd = ev.cwd
    const ts = ev.timestamp ? Date.parse(ev.timestamp) : null
    if (ts) { firstTs ??= ts; lastTs = ts }
    if (ev.type === 'user' && !intent) {
      const c = ev.message?.content
      const t = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((b) => b.type === 'text')?.text ?? '') : ''
      if (t && !t.startsWith('<')) intent = t.replace(/\s+/g, ' ').trim().slice(0, 110)
    }
    if (ev.type === 'assistant') {
      turns++
      const m = ev.message?.model; if (m) model = m
      const u = ev.message?.usage
      if (u) {
        const p = PRICE[tier(m)]
        const i = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) * 1.25 + (u.cache_read_input_tokens ?? 0) * 0.1
        cost += (i * p.in + (u.output_tokens ?? 0) * p.out) / 1e6
        out += u.output_tokens ?? 0
        inTok += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      }
      for (const b of ev.message?.content ?? []) if (b.type === 'tool_use') { tools++; toolNames.add(b.name) }
    }
  }
  if (!turns) continue
  rows.push({ file, id: path.basename(file, '.jsonl'), cost, turns, tools, out, inTok, model, intent,
    cwd, mins: firstTs && lastTs ? (lastTs - firstTs) / 60000 : 0, secrets,
    tools: [...toolNames], toolCount: tools,
    // a session that only edited files inside one directory is far easier to replay faithfully
    net: [...toolNames].some((t) => /WebSearch|WebFetch|Chrome|mcp__/.test(t)) })
}

rows.sort((a, b) => b.cost - a.cost)
const maxCost = Number(process.argv.find((a) => a.startsWith('--max-cost='))?.split('=')[1] ?? 50)
const minTurns = Number(process.argv.find((a) => a.startsWith('--min-turns='))?.split('=')[1] ?? 6)

const total = rows.reduce((a, r) => a + r.cost, 0)
console.log(`\n  ${rows.length} sessions with usage · $${total.toFixed(2)} total at API list prices\n`)

const ok = rows.filter((r) => r.cost <= maxCost && r.cost >= 0.05 && r.turns >= minTurns && !r.secrets && !r.net)
console.log(`  replay candidates: cost ≤ $${maxCost}, ≥ ${minTurns} turns, no secrets in transcript, no web/MCP tools\n`)
console.log(`  ${'REF'.padEnd(10)}${'COST'.padStart(8)}${'TURNS'.padStart(7)}${'TOOLS'.padStart(7)}${'MIN'.padStart(6)}  INTENT`)
for (const r of ok.slice(0, 18))
  console.log(`  ${r.id.slice(0, 8).padEnd(10)}${('$' + r.cost.toFixed(2)).padStart(8)}${String(r.turns).padStart(7)}${String(r.toolCount).padStart(7)}${String(Math.round(r.mins)).padStart(6)}  ${r.intent.slice(0, 62)}`)

const excl = rows.length - ok.length
console.log(`\n  ${excl} excluded: ${rows.filter((r) => r.secrets).length} contain secrets, ` +
            `${rows.filter((r) => r.net).length} use web/MCP tools, ` +
            `${rows.filter((r) => r.cost > maxCost).length} over $${maxCost}, ` +
            `${rows.filter((r) => r.turns < minTurns).length} too short\n`)
fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'results', 'session-survey.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), maxCost, minTurns, candidates: ok.slice(0, 40) }, null, 2))
