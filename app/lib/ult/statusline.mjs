#!/usr/bin/env node
/**
 * Claude Code status line for optimization mode — the visible sign that a session is
 * running behind LLM Ultra Light, and what it just decided.
 *
 *   ◆ opthub ROUTE · non-coding/explain → haiku-4-5 · 14 req · 3 rerouted · saved $0.19
 *   ◆ opthub SHADOW · coding/edit keep · 9 req · would act on 2
 *   ◆ opthub · router unreachable
 *
 * Claude Code runs it with session JSON on stdin (unused) and the session's environment,
 * so ANTHROPIC_BASE_URL already points at the router. ULT_STATUS_URL overrides it.
 */
const base = (process.env.ULT_STATUS_URL ?? process.env.ANTHROPIC_BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '')
const color = !process.env.NO_COLOR
const paint = (code, s) => color ? `\x1b[${code}m${s}\x1b[0m` : s
const tag = (mode) => paint(mode === 'route' ? '1;97;48;5;28' : '1;97;48;5;99', ` opthub ${mode.toUpperCase()} `)
const dim = (s) => paint('2', s)
const short = (m) => m == null ? '?' : String(m).startsWith('local:') ? `local ${m.slice(6)}` : String(m).replace(/^claude-/, '').replace(/-\d{8}$/, '')
const money = (n) => `$${(n ?? 0).toFixed((n ?? 0) < 1 ? 2 : 2)}`

export function render(s) {
  const parts = [tag(s.mode) + (s.pin ? paint('33', ` pinned ${s.pin}`) : '')]
  const l = s.last
  if (l) {
    let what
    if (l.fallback) what = `${l.class} ${paint('33', `→ fallback ${short(l.target)}`)}`
    else if (l.acted) what = `${l.class} ${paint('32', `→ ${short(l.target)}`)}`
    else if (s.mode === 'shadow' && l.proposed) what = `${l.class} ${dim(`keep · would ${l.proposed.decision} ${short(l.proposed.target)}`)}`
    else what = `${l.class} ${dim('keep')}`
    parts.push(what)
  } else parts.push(dim('waiting for the first request'))
  parts.push(dim(`${s.requests} req`))
  if (s.mode === 'route') {
    if (s.acted) parts.push(paint('32', `${s.acted} rerouted`))
    const saved = (s.counterfactualUsd ?? 0) - (s.costUsd ?? 0)
    if (saved > 0.005) parts.push(paint('32', `saved ${money(saved)}`))
  } else if (s.wouldAct) parts.push(dim(`would act on ${s.wouldAct}`))
  if (s.fallbacks) parts.push(paint('33', `${s.fallbacks} fallback`))
  return parts.join(dim(' · '))
}

async function main() {
  process.stdin.resume(); process.stdin.on('data', () => {}); process.stdin.on('error', () => {})
  try {
    const r = await fetch(`${base}/ult/status`, { signal: AbortSignal.timeout(1500) })
    if (!r.ok) throw new Error(String(r.status))
    process.stdout.write(render(await r.json()))
  } catch {
    process.stdout.write(`${paint('1;97;41', ' opthub ')} ${paint('31', 'router unreachable')} ${dim(base)}`)
  }
  process.exit(0)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
