/**
 * The claims audit for an `opt claude -p --compare` run: every claim the run makes, checked
 * against the raw evidence it left — never against the summary it printed.
 *
 *   evidence                         where
 *   the task each side was given     <arm>/task.md (sha256)
 *   what Claude Code did and used    <arm>/events.jsonl (stream-json: init, every message's usage)
 *   what the router decided          <arm>/router/audit.jsonl (hash-chained)
 *   the key the agent held           <arm>/agent-key.sha256 (hashed inside the container)
 *   the hidden check                 <arm>/check/check_code
 *   the task trail                   $OPT_HOME/audit/tasks.jsonl (hash-chained)
 *
 * Both sides are priced the same way: each API message's usage at list rates from the router's
 * table (config/ult.default.json), so a saving cannot come from two different price lists.
 *
 * A claim is `verified` (the evidence shows it), `failed` (the evidence contradicts it),
 * `not proven` (the evidence needed is missing), or a `note` (measured, but not a claim).
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { priceUsage } from './ult/server.mjs'
import { verifyAudit, readAudit, summarize } from './ult/audit.mjs'
import { AUDIT_FILE } from './task-audit.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
const read = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return null } }
const median = (xs) => { const v = xs.filter((x) => x != null).sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null }
export const priceTable = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'ult.default.json'), 'utf8'))

/**
 * One arm's stream-json, read back: the init event, every distinct API message with its usage
 * (stream-json repeats a message once per content block), the skills Claude Code invoked, the result.
 */
export function readEvents(file, cfg = priceTable()) {
  const out = { init: null, result: null, messages: new Map(), skillCalls: [], toolCalls: 0, priced: 0, unpriced: [] }
  for (const line of (read(file) ?? '').split('\n')) {
    if (!line.trim()) continue
    let e; try { e = JSON.parse(line) } catch { continue }
    if (e.type === 'system' && e.subtype === 'init') out.init = e
    if (e.type === 'result') out.result = e
    if (e.type === 'assistant' && e.message?.id) {
      out.messages.set(e.message.id, { model: e.message.model, usage: e.message.usage })
      for (const b of e.message.content ?? []) if (b.type === 'tool_use') { out.toolCalls++; if (b.name === 'Skill') out.skillCalls.push(b.input?.skill ?? b.input?.name ?? '?') }
    }
  }
  for (const [, m] of out.messages) {
    const c = m.model?.startsWith('local') || m.model?.includes(':') ? 0 : priceUsage(m.usage, m.model, cfg)
    if (c == null) out.unpriced.push(m.model); else out.priced += c
  }
  return out
}

/**
 * One run's cost from Claude Code's own final totals (result.modelUsage), at list rates. The per-message
 * usage in stream-json is a snapshot from the first streamed chunk (output tokens far too low), so it is
 * never used for money. Cache writes are split 1h / 5m in the proportion result.usage reports.
 */
export function priceResult(result, cfg = priceTable()) {
  const mu = result?.modelUsage
  if (!mu || !Object.keys(mu).length) return null
  const cc = result.usage?.cache_creation ?? {}
  const w1 = cc.ephemeral_1h_input_tokens ?? 0, w5 = cc.ephemeral_5m_input_tokens ?? 0
  const share1h = w1 + w5 ? w1 / (w1 + w5) : 0
  let total = 0
  for (const [model, m] of Object.entries(mu)) {
    const cw = m.cacheCreationInputTokens ?? 0
    const c = priceUsage({ input_tokens: m.inputTokens ?? 0, output_tokens: m.outputTokens ?? 0, cache_read_input_tokens: m.cacheReadInputTokens ?? 0,
      cache_creation: { ephemeral_1h_input_tokens: cw * share1h, ephemeral_5m_input_tokens: cw * (1 - share1h) } }, model, cfg)
    if (c == null) return null
    total += c
  }
  return total
}

/** Re-derive one arm from its directory. */
export function armEvidence(runDir, arm, cfg = priceTable()) {
  const dir = path.join(runDir, arm.label)
  const ev = readEvents(path.join(dir, 'events.jsonl'), cfg)
  const routerFile = path.join(dir, 'router', 'audit.jsonl')
  let router = null
  if (fs.existsSync(routerFile)) {
    const v = verifyAudit(routerFile)
    const entries = readAudit(routerFile)
    const s = summarize(entries)
    const req = entries.filter((e) => e.kind === 'request')
    // what moving requests off the asked-for model saved, per the gateway's own before/after pricing
    const saved = req.filter((e) => e.acted && e.cost_usd != null && e.counterfactual_usd != null).reduce((t, e) => t + (e.counterfactual_usd - e.cost_usd), 0)
    router = { verify: v, requests: s.requests, byDecision: s.byDecision, acted: s.acted, costUsd: s.costUsd, counterfactualUsd: s.counterfactualUsd, errors: s.errors, fallbacks: s.fallbacks, saved,
      moved: req.filter((e) => e.acted && e.decision !== 'keep').map((e) => `${e.class} → ${e.target}`), unpriced: req.filter((e) => e.cost_usd == null).length }
  }
  const code = read(path.join(dir, 'check', 'check_code'))
  return {
    label: arm.label, side: arm.side, taskSha: read(path.join(dir, 'task.md')) != null ? sha(read(path.join(dir, 'task.md'))) : null,
    keySha: read(path.join(dir, 'agent-key.sha256'))?.trim().split(/\s+/)[0] ?? null,
    events: ev, router, check: code == null ? null : Number(code.trim()) === 0 ? 'pass' : 'fail',
    isError: ev.result ? !!ev.result.is_error : true, durationMs: ev.result?.duration_ms ?? null,
    claudeCost: ev.result?.total_cost_usd ?? null,
    // both sides priced the same way: Claude Code's final token totals at list rates; the optimized
    // side less what the gateway saved by answering some requests with a cheaper model
    resultCost: priceResult(ev.result, cfg),
    cost: (() => { const c = priceResult(ev.result, cfg); return c == null ? null : c - (arm.side === 'optimized' && router ? router.saved : 0) })(),
  }
}

const pct = (a, b) => (b ? ((a - b) / b) * 100 : null)
const fmt = (v) => (v == null ? '—' : `$${v.toFixed(4)}`)

/** Every claim of the run, checked. Returns { claims, summary } and writes claims.json + claims.md. */
export function auditClaims(runDir, { write = true, dummyKey = null, trailFile = AUDIT_FILE } = {}) {
  const run = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'))
  const cfg = priceTable()
  const arms = run.arms.map((a) => armEvidence(runDir, a, cfg))
  const opt = arms.filter((a) => a.side === 'optimized'), base = arms.filter((a) => a.side === 'baseline')
  const claims = []
  const add = (id, claim, status, evidence, detail = '') => claims.push({ id, claim, status, evidence, detail })

  // 1 · same input
  const taskShas = new Set(arms.map((a) => a.taskSha))
  add('same-input', 'Both sides were given the same task and the same source tree.',
    taskShas.size === 1 && !taskShas.has(null) ? 'verified' : 'failed',
    [`task.md sha256 ${[...taskShas].map((s) => s?.slice(0, 12)).join(' / ')} across ${arms.length} runs`, `source tree sha256 ${run.tree_sha256?.slice(0, 12)} (one read-only mount for every run)`])

  // 2 · same model: Claude Code's own init event, not the flag that was asked for
  const models = arms.map((a) => a.events.init?.model ?? null)
  if (base.length) add('same-model', 'Both sides ran the same main model.', models.includes(null) ? 'not proven' : new Set(models).size === 1 ? 'verified' : 'failed',
    arms.map((a, i) => `${a.label}: ${models[i] ?? 'no init event'} (Claude Code's init event)`),
    new Set(models).size > 1 ? 'the comparison measures two models, not optimize mode' : '')

  // 2b · same client: what Claude Code loaded (tools, version) must not differ except by the profile
  if (base.length) {
    const tools = (a) => new Set(a.events.init?.tools ?? [])
    const bt = tools(base[0]), ot = tools(opt[0])
    const onlyBase = [...bt].filter((t) => !ot.has(t)), onlyOpt = [...ot].filter((t) => !bt.has(t))
    const versions = new Set(arms.map((a) => a.events.init?.claude_code_version))
    add('same-client', 'Claude Code loaded the same tools and version on both sides.', onlyBase.length || onlyOpt.length || versions.size > 1 ? 'failed' : 'verified',
      [`tools: ${bt.size} plain, ${ot.size} optimized${onlyBase.length ? ` · only plain: ${onlyBase.join(', ')}` : ''}${onlyOpt.length ? ` · only optimized: ${onlyOpt.join(', ')}` : ''}`,
       `Claude Code ${[...versions].join(' / ')}`],
      onlyBase.includes('ToolSearch') ? 'behind the gateway Claude Code turned tool search off, so every tool schema is sent with every request: a cost of the gateway path, not of the profile' : '')
  }

  // 3 · finished
  const failed = arms.filter((a) => a.isError)
  add('finished', 'Every run finished without an error.', failed.length ? 'failed' : 'verified',
    arms.map((a) => `${a.label}: ${a.isError ? 'error / no result' : `result after ${a.events.result.num_turns} turns`}`))

  if (base.length) {
    // 3 · cost
    const oc = median(opt.map((a) => a.cost)), bc = median(base.map((a) => a.cost))
    const p = pct(oc, bc)
    const reported = run.verdict?.pct
    const agrees = p != null && reported != null && Math.abs(p - reported) < 1
    const status = p == null ? 'not proven' : p < 0 ? (reported == null || agrees ? 'verified' : 'failed') : 'failed'
    add('cheaper', `The optimized side cost less than plain claude -p${reported != null ? ` (reported ${Math.abs(reported).toFixed(0)}% ${reported < 0 ? 'cheaper' : 'dearer'})` : ''}.`, status,
      [`both sides priced the same way: Claude Code's final token totals (result.modelUsage) at list rates`,
       `baseline ${fmt(bc)} · optimized ${fmt(oc)}${opt.some((a) => a.router?.saved) ? ` (after ${fmt(median(opt.map((a) => a.router?.saved ?? 0)))} the gateway saved by moving requests)` : ''} · medians of ${base.length} and ${opt.length}`,
       `meter cross-check, optimized side: Claude Code's totals ${fmt(median(opt.map((a) => a.resultCost)))} vs the gateway's own per-request sum ${fmt(median(opt.map((a) => a.router?.costUsd)))}`,
       `recomputed from the files: ${p == null ? '—' : `${Math.abs(p).toFixed(1)}% ${p < 0 ? 'cheaper' : 'dearer'}`}${reported != null ? `; the run reported ${Math.abs(reported).toFixed(1)}% ${reported < 0 ? 'cheaper' : 'dearer'}` : ''}`,
       `Claude Code's own estimate (its price list): baseline ${fmt(median(base.map((a) => a.claudeCost)))}, optimized ${fmt(median(opt.map((a) => a.claudeCost)))}`],
      p != null && p >= 0 ? 'the optimized side was not cheaper' : '')

    // 4 · quality
    if (run.check) {
      const passes = (rs) => rs.filter((a) => a.check === 'pass').length
      const ok = passes(opt) === opt.length && passes(opt) / opt.length >= passes(base) / base.length
      add('same-result', `The optimized side's result passes the same hidden check as the baseline (${run.check.name}).`, ok ? 'verified' : 'failed',
        [`check ${run.check.name} sha256 ${run.check.sha256.slice(0, 12)}, run in its own sandbox against each finished workspace`,
         `baseline ${passes(base)}/${base.length} pass · optimized ${passes(opt)}/${opt.length} pass`])
    } else add('same-result', 'The optimized side did the job as well as the baseline.', 'not proven', ['no --check was given, so nothing tested the result'])

    // 5 · warm start: a comparison between a cold and a warm prompt cache measures the cache
    const firstRead = (a) => { const m = [...a.events.messages.values()][0]; return m?.usage?.cache_read_input_tokens ?? 0 }
    const firstWrite = (a) => { const u = [...a.events.messages.values()][0]?.usage ?? {}; return (u.cache_creation_input_tokens ?? 0) || ((u.cache_creation?.ephemeral_1h_input_tokens ?? 0) + (u.cache_creation?.ephemeral_5m_input_tokens ?? 0)) }
    const cold = arms.filter((a) => firstRead(a) === 0)
    // the other way to be lucky: the task itself already cached by an earlier run of the same input
    const precached = arms.filter((a) => firstRead(a) > 0 && firstWrite(a) === 0)
    add('warm', 'Every measured run started the same way: system prompt and tools warm, the task itself not cached.', cold.length || precached.length ? 'failed' : 'verified',
      [...arms.map((a) => `${a.label}: first request read ${firstRead(a).toLocaleString('en')} cached tokens, wrote ${firstWrite(a).toLocaleString('en')}`),
       run.warmup ? `warm-up: one turn a side beforehand (plain ${fmt(run.warmup.cost_usd.baseline)}, optimized ${fmt(run.warmup.cost_usd.optimized)}), not in the comparison` : 'no warm-up (--no-warm)'],
      cold.length ? `${cold.map((a) => a.label).join(', ')} started cold: the cost gap may be the cache, not optimize mode`
        : precached.length ? `${precached.map((a) => a.label).join(', ')} found the whole task already cached from an earlier run: a discount the other side did not get` : '')

    // 6 · time (measured, not claimed)
    const ot = median(opt.map((a) => a.durationMs)), bt = median(base.map((a) => a.durationMs)), tp = pct(ot, bt)
    add('time', 'Wall time of each side.', 'note', [`baseline ${bt == null ? '—' : Math.round(bt / 1000) + 's'} · optimized ${ot == null ? '—' : Math.round(ot / 1000) + 's'}${tp == null ? '' : ` (${Math.abs(tp).toFixed(0)}% ${tp < 0 ? 'faster' : 'slower'})`}`],
      'the optimized side also waits for the router and, on local routes, for Ollama')
  }

  // 6 · every request through the router
  for (const a of opt) {
    if (!a.router) { add(`router-${a.label}`, `${a.label}: every model request went through the router.`, 'not proven', ['no router audit for this run']); continue }
    const msgs = a.events.messages.size
    add(`router-${a.label}`, `${a.label}: every model request went through the router, and its log is intact.`,
      a.router.verify.ok && a.router.requests >= msgs ? 'verified' : 'failed',
      [`router audit: ${a.router.requests} requests, hash chain ${a.router.verify.ok ? `intact (${a.router.verify.entries} entries)` : `BROKEN at line ${a.router.verify.brokenAt}: ${a.router.verify.reason}`}`,
       `Claude Code received ${msgs} messages; the router must have seen at least as many requests`,
       `decisions: ${Object.entries(a.router.byDecision).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}${a.router.moved.length ? ` · moved: ${[...new Set(a.router.moved)].join('; ')}` : ' · nothing was moved off the requested model'}`])
  }

  // 7 · credential isolation
  const want = run.placeholder_sha256 ?? (dummyKey ? sha(dummyKey) : null)
  if (want && opt.length) {
    const ok = opt.every((a) => a.keySha === want)
    add('credential', 'The optimized agent never held your real credential; only the router did.', ok ? 'verified' : opt.some((a) => !a.keySha) ? 'not proven' : 'failed',
      opt.map((a) => `${a.label}: sha256 of the key inside the container ${a.keySha?.slice(0, 12) ?? 'missing'} ${a.keySha === want ? '= the placeholder' : '≠ the placeholder'}`))
  }

  // 8 · the profile was applied
  const prof = run.profile
  if (prof && opt.length) {
    const loaded = opt.map((a) => a.events.init?.skills ?? [])
    const want = prof.skills ?? []
    const allLoaded = loaded.every((l) => want.every((s) => l.includes(s)))
    const invoked = [...new Set(opt.flatMap((a) => a.events.skillCalls))]
    add('profile', `The optimized side ran on the ${prof.level} profile: ${prof.flags.join(' ') || 'no extra flags'}, lean rules, skills ${want.join(', ') || 'none'}.`,
      allLoaded ? 'verified' : 'failed',
      [`skills loaded (Claude Code's init event): ${want.map((s) => `${s} ${loaded.every((l) => l.includes(s)) ? '✓' : '✗'}`).join(', ') || '—'}`,
       `skills invoked: ${invoked.join(', ') || 'none (attached, not used on this task)'}`,
       `flags and rules: recorded in run.json and the task trail (rules sha256 ${prof.rules_sha256?.slice(0, 12)})`])
  }

  // 9 · the audit trail
  const chain = (() => { try { return verifyAudit(trailFile) } catch (e) { return { ok: false, entries: 0, reason: 'no task trail' } } })()
  const trail = (read(trailFile) ?? '').split('\n').filter((l) => l.includes(run.task_id ?? '\u0000'))
  const taskText = read(path.join(runDir, run.arms[0].label, 'task.md')) ?? ''
  const probe = taskText.trim().slice(0, 48)
  const leaked = probe.length >= 16 && [trailFile, ...opt.map((a) => path.join(runDir, a.label, 'router', 'audit.jsonl'))].some((f) => (read(f) ?? '').includes(probe))
  add('trail', 'The run is in the hash-chained task trail, and no log holds the task text.', chain.ok && trail.length >= 2 && !leaked ? 'verified' : 'failed',
    [`tasks.jsonl: chain ${chain.ok ? `intact (${chain.entries} entries)` : `BROKEN at line ${chain.brokenAt}: ${chain.reason}`}, ${trail.length} entries for ${run.task_id}`,
     `task text ${leaked ? 'FOUND' : 'not found'} in tasks.jsonl or the router audit`])

  // 10 · sample size
  const n = Math.min(opt.length, base.length || opt.length)
  add('sample', `n = ${n} per side.`, 'note', [n < 3 ? 'under 3 runs a side, a difference is a direction, not a finding: --repeats 3' : `${n} runs a side, compared by median`])

  const summary = { verified: claims.filter((c) => c.status === 'verified').length, failed: claims.filter((c) => c.status === 'failed').length,
    notProven: claims.filter((c) => c.status === 'not proven').length, notes: claims.filter((c) => c.status === 'note').length }
  if (write) {
    fs.writeFileSync(path.join(runDir, 'claims.json'), JSON.stringify({ run: run.run, audited: new Date().toISOString(), summary, claims }, null, 2))
    fs.writeFileSync(path.join(runDir, 'claims.md'), renderMarkdown(run, claims, summary))
  }
  return { claims, summary, arms }
}

const MARK = { verified: '✓ verified', failed: '✗ FAILED', 'not proven': '? not proven', note: '· note' }
export function renderMarkdown(run, claims, summary) {
  return [`# Claims audit · ${run.run}`, '',
    `${summary.verified} verified · ${summary.failed} failed · ${summary.notProven} not proven · ${summary.notes} notes`, '',
    ...claims.flatMap((c) => [`## ${MARK[c.status]} — ${c.claim}`, '', ...c.evidence.map((e) => `- ${e}`), ...(c.detail ? ['', `_${c.detail}_`] : []), '']),
    '---', 'Re-run this audit from the files alone: `opt claude audit ' + run.run + '`', ''].join('\n')
}

export function printClaims(claims, summary, out = console.error) {
  const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }
  const col = { verified: C.g, failed: C.r, 'not proven': C.y, note: C.d }
  out(`\n  ${C.b}claims audit${C.x}  ${C.g}${summary.verified} verified${C.x} · ${summary.failed ? C.r : ''}${summary.failed} failed${C.x} · ${summary.notProven} not proven · ${summary.notes} notes`)
  for (const c of claims) {
    out(`  ${col[c.status]}${MARK[c.status].padEnd(13)}${C.x} ${c.claim}`)
    for (const e of c.evidence) out(`  ${C.d}${' '.repeat(13)} ${e}${C.x}`)
  }
}

/** Every `opt claude -p` run on this machine, newest first, with its verdict and its audit's counts. */
export function listClaudeRuns(root, limit = 20) {
  let dirs = []
  try { dirs = fs.readdirSync(root).filter((d) => d.startsWith('cp-') && fs.existsSync(path.join(root, d, 'run.json'))).sort().reverse().slice(0, limit) } catch { return [] }
  return dirs.map((d) => {
    const run = JSON.parse(fs.readFileSync(path.join(root, d, 'run.json'), 'utf8'))
    // re-audited from the files every time, so a run audited before a check existed is held to it now
    let claims = null; try { claims = auditClaims(path.join(root, d), { write: false }) } catch {}
    // costs re-derived by the audit (the current pricing method), not the numbers stored at run time
    const audited = claims?.arms ?? []
    const side = (s) => median((audited.length ? audited.filter((a) => a.side === s).map((a) => a.cost) : run.arms.filter((a) => a.side === s).map((a) => a.cost_usd)))
    const pass = (s) => { const rs = run.arms.filter((a) => a.side === s); return run.check ? `${rs.filter((a) => a.check === 'pass').length}/${rs.length}` : null }
    // a verdict recorded with an older pricing method, whose direction the re-priced costs reverse, is shown as stale
    const plainCost = run.compare ? side('baseline') : null, optCost = side('optimized')
    let verdict = run.verdict
    // only a verdict decided on cost can go stale with a pricing change; one decided by the check cannot
    if (verdict && plainCost && optCost != null && ['keep', 'drop'].includes(verdict.verdict) && !/check the baseline passes/.test(verdict.reason ?? '') && (optCost < plainCost) !== (verdict.verdict === 'keep')) {
      const p = ((optCost - plainCost) / plainCost) * 100
      verdict = { verdict: 'stale', reason: `recorded as ${verdict.verdict} with the old pricing; re-priced, optimized is ${Math.abs(p).toFixed(0)}% ${p < 0 ? 'cheaper' : 'dearer'}`, pct: p }
    }
    return {
      run: d, at: run.started, project: run.project, level: run.profile?.level, compare: run.compare, repeats: run.repeats,
      plainCost, optCost, verdict, check: run.check?.name ?? null,
      plainPass: pass('baseline'), optPass: pass('optimized'), move: run.profile_move ?? null,
      claims: claims?.summary ?? null, failed: (claims?.claims ?? []).filter((c) => c.status === 'failed').map((c) => ({ id: c.id, claim: c.claim, detail: c.detail || c.evidence.slice(-1)[0] })),
    }
  })
}
