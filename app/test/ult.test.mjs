// LLM Ultra Light — unit + integration checks, no network beyond 127.0.0.1.
// Run: node test/ult.test.mjs      (ULT_TEST_OLLAMA=1 also exercises a real local Ollama)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import { extractFeatures, sessionIdOf, humanText } from '../lib/ult/features.mjs'
import { rulesClassify, Classifier } from '../lib/ult/classifier.mjs'
import { ContextStore } from '../lib/ult/context-store.mjs'
import { decide, priceOf } from '../lib/ult/policy.mjs'
import { AuditLog, verifyAudit, readAudit, summarize } from '../lib/ult/audit.mjs'
import { loadConfig, merge, flagsToOverlay } from '../lib/ult/config.mjs'
import { createUlt } from '../lib/ult/server.mjs'
import { sanitizeForLocal, UsageTap, remoteHeaders, adaptForModel, adaptHeaders, forwardLocal, scopeForLocal, stripThinking, sseToMessage } from '../lib/ult/upstream.mjs'
import { LocalGate, caps as capsOf, fitCheck, estimateTokens } from '../lib/ult/capacity.mjs'
import { buildJevRequest } from '../lib/ult/jev.mjs'
import { render as renderStatus } from '../lib/ult/statusline.mjs'
import { execFile } from 'node:child_process'
const runStatus = (env) => new Promise((resolve, reject) => { const c = execFile(process.execPath, [fileURLToPath(new URL('../lib/ult/statusline.mjs', import.meta.url))], { env: { ...process.env, NO_COLOR: '1', ...env } }, (e, out) => e ? reject(e) : resolve(out)); c.stdin.end('{}') })

let pass = 0, fail = 0
const ok = (name, cond, got) => { if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}${got !== undefined ? `  — got ${JSON.stringify(got)}` : ''}`) } }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ult-test-'))
const SID = '0f3c2a1e-1111-4222-8333-944455556666'

const req = (prompt, { history = [], tools = 3, model = 'claude-opus-5-5', lastToolResult = false, maxTokens = 32000, system = 'You are Claude Code.' } = {}) => ({
  model, max_tokens: maxTokens, stream: false, system,
  metadata: { user_id: `user_abc_account_def_session_${SID}` },
  tools: Array.from({ length: tools }, (_, i) => ({ name: `T${i}`, input_schema: { type: 'object' } })),
  messages: [...history, lastToolResult
    ? { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] }
    : { role: 'user', content: [{ type: 'text', text: `<system-reminder>ignore me</system-reminder>${prompt}` }] }],
})
const editHistory = [
  { role: 'user', content: 'add idempotency keys' },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Edit', input: {} }, { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'git diff main' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
]

console.log('features')
{
  const f = extractFeatures(req('explain the retry logic', { history: editHistory }))
  ok('session id parsed from metadata.user_id', f.session === SID, f.session)
  ok('session id parsed from JSON user_id', sessionIdOf({ metadata: { user_id: JSON.stringify({ device_id: 'd', session_id: SID }) } }) === SID)
  ok('system reminders stripped from the prompt', f.promptText === 'explain the retry logic', f.promptText)
  ok('recent edits and git diff seen', f.recent.edits === 1 && f.recent.gitDiff === true, f.recent)
  ok('human turn detected', f.humanTurn && !f.toolLoop)
  ok('tool loop detected', extractFeatures(req('', { history: editHistory, lastToolResult: true })).toolLoop)
  ok('humanText strips command wrappers', humanText('<command-name>/x</command-name> hi') === 'hi')
}

console.log('rules — the five demo beats')
{
  const cls = (p, o) => rulesClassify(extractFeatures(req(p, o))).cls
  ok('beat 1 idempotency keys → coding/edit', cls('add idempotency keys to POST /v1/payments') === 'coding/edit', cls('add idempotency keys to POST /v1/payments'))
  ok('beat 2 flaky test → coding/debug', cls('the checkout e2e test has failed 3 of the last 20 CI runs, find it') === 'coding/debug')
  ok('beat 3 explain → non-coding/explain', cls('explain how the payments retry logic works today, in plain english') === 'non-coding/explain')
  ok('beat 4 review → review/security (session view)', cls("go over the diff before I open the PR — anything in there that'd bite us?", { history: editHistory }) === 'review/security', cls("go over the diff before I open the PR — anything in there that'd bite us?", { history: editHistory }))
  ok('beat 5 PR description → non-coding/pr-description', cls('write the PR description') === 'non-coding/pr-description')
  ok('title side call → background/utility', cls('Summarize this conversation in 5 words', { tools: 0, model: 'claude-haiku-4-5', maxTokens: 512 }) === 'background/utility')
  ok('no signal → unclear', cls('hmm') === 'unclear')
}

console.log('classifier memory')
{
  const file = path.join(tmp, 'ctx.json')
  const store = new ContextStore({ file, writeDelayMs: 0 })
  const c = new Classifier({ config: { rules: true, jev: { enabled: false } }, store })
  const a = await c.classify(extractFeatures(req('write the PR description')))
  ok('human turn starts a turn', a.turn && a.cls === 'non-coding/pr-description')
  const b = await c.classify(extractFeatures(req('', { lastToolResult: true })))
  ok('tool loop keeps the turn class (sticky)', b.source === 'sticky' && b.cls === 'non-coding/pr-description', b)
  const g = await c.classify(extractFeatures(req('Summarize in 5 words', { tools: 0, model: 'claude-haiku-4-5', maxTokens: 256 })))
  ok('side call does not reset the turn', g.cls === 'background/utility' && store.currentTurn(SID).cls === 'non-coding/pr-description')
  const d = await c.classify(extractFeatures(req('go ahead')))
  ok('"go ahead" continues the previous class', d.source === 'sticky' && d.cls === 'non-coding/pr-description', d)
  store.flush()
  const again = new ContextStore({ file })
  ok('context persists across restarts', again.currentTurn(SID)?.cls === 'non-coding/pr-description' && again.data.sessions[SID].turn === 2, again.data.sessions[SID])
  // Jev asked only when rules are unsure; answer validated; features only.
  let sent = null
  const fakeFetch = async (_u, o) => { sent = JSON.parse(o.body); return { ok: true, json: async () => ({ answers: { task_class: { type: 'choice', choice: 'coding/edit', confidence: 0.8, probabilities: Object.fromEntries(['coding/edit', 'coding/debug', 'review/security', 'review/general', 'non-coding/explain', 'non-coding/summarize', 'non-coding/pr-description', 'background/utility', 'unclear'].map(k => [k, k === 'coding/edit' ? 1 : 0])) } } }) } }
  const cj = new Classifier({ config: { rules: true, jev: { enabled: true, endpoint: 'x', model: 'jev', timeoutMs: 100, minRuleConfidence: 0.6 } }, store: new ContextStore(), jevKey: 'k', fetchImpl: fakeFetch })
  const j = await cj.classify(extractFeatures(req('hmm, the thing we discussed')))
  ok('Jev decides when rules are unsure', j.source === 'jev' && j.cls === 'coding/edit', j)
  ok('Jev payload has no prompt text', sent && !JSON.stringify(sent).includes('the thing we discussed') && !('promptText' in sent.state.request))
  const bad = new Classifier({ config: { rules: true, jev: { enabled: true, endpoint: 'x', model: 'jev', timeoutMs: 100 } }, store: new ContextStore(), jevKey: 'k', fetchImpl: async () => ({ ok: true, json: async () => ({ answers: { task_class: { type: 'choice', choice: 'made-up' } } }) }) })
  const bj = await bad.classify(extractFeatures(req('hmm')))
  ok('invalid Jev answer → abstain', bj.source !== 'jev' && bj.jev.outcome === 'invalid', bj.jev)
}

console.log('policy')
{
  const { config } = loadConfig({ flags: { mode: 'route' } })
  const f = (p, o) => extractFeatures(req(p, o))
  const d1 = decide({ cls: 'review/security', confidence: 0.9, features: f('x'), config })
  ok('never_downgrade keeps', d1.decision === 'keep' && /never_downgrade/.test(d1.reason))
  const big = f('explain the retry logic', { history: Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(8000) })) })
  const d2 = decide({ cls: 'non-coding/explain', confidence: 0.8, features: big, config })
  ok('long main-thread route to haiku refused by the cache-aware economics check', d2.decision === 'keep' && d2.estRouteUsd > d2.estKeepUsd, d2)
  const small = f('explain what a mutex is', { tools: 0 })
  const d3 = decide({ cls: 'non-coding/explain', confidence: 0.8, features: small, config })
  ok('new small thread routes to haiku', d3.decision === 'route' && d3.target === 'claude-haiku-4-5', d3)
  const d4 = decide({ cls: 'background/utility', confidence: 0.9, features: f('title', { tools: 0 }), config })
  ok('background → local model', d4.decision === 'local' && d4.target.startsWith('local:'), d4)
  const d5 = decide({ cls: 'background/utility', confidence: 0.9, features: f('title', { tools: 2 }), config })
  ok('local refused when the request offers tools', d5.decision === 'keep')
  const d6 = decide({ cls: 'non-coding/explain', confidence: 0.4, features: small, config })
  ok('low confidence keeps', d6.decision === 'keep')
  const pinned = decide({ cls: 'non-coding/explain', confidence: 0.9, features: small, config: merge(config, { policy: { pin: 'frontier' } }) })
  ok('--pin frontier keeps everything', pinned.decision === 'keep')
  const sticky = decide({ cls: 'coding/edit', confidence: 0.9, features: f('x'), config, threadTarget: 'claude-haiku-4-5' })
  ok('a pinned thread stays on its target', sticky.decision === 'route' && sticky.target === 'claude-haiku-4-5')
  ok('dated model ids price as their base', JSON.stringify(priceOf('claude-haiku-4-5-20251001', config.prices)) === '[1,5]')
  ok('--route overrides one route only', (() => { const o = loadConfig({ flags: { routes: ['non-coding/*=keep'] } }).config.policy.routes; return o['non-coding/*'] === 'keep' && o['background/utility'] === 'local' })())
  let threw = false; try { loadConfig({ flags: { mode: 'yolo' } }) } catch { threw = true }
  ok('invalid mode rejected', threw)
  ok('flags overlay', flagsToOverlay({ localModel: 'm', noLocal: false }).local.model === 'm')
}

console.log('audit chain')
{
  const file = path.join(tmp, 'audit.jsonl')
  const a = new AuditLog(file)
  a.append({ kind: 'request', class: 'coding/edit', decision: 'keep' })
  a.append({ kind: 'request', class: 'background/utility', decision: 'local', acted: true })
  const a2 = new AuditLog(file)   // resume after restart
  a2.append({ kind: 'request', class: 'coding/debug', decision: 'keep' })
  ok('chain verifies across a restart', verifyAudit(file).ok && verifyAudit(file).entries === 3, verifyAudit(file))
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  lines[1] = lines[1].replace('"local"', '"keep"')
  fs.writeFileSync(path.join(tmp, 'tampered.jsonl'), lines.join('\n'))
  const v = verifyAudit(path.join(tmp, 'tampered.jsonl'))
  ok('editing a line breaks the chain at that line', !v.ok && v.brokenAt === 2, v)
  const del = fs.readFileSync(file, 'utf8').split('\n').filter((_, i) => i !== 0).join('\n')
  fs.writeFileSync(path.join(tmp, 'deleted.jsonl'), del)
  ok('deleting a line breaks the chain', !verifyAudit(path.join(tmp, 'deleted.jsonl')).ok)
}

console.log('upstream helpers')
{
  const s = sanitizeForLocal({ model: 'x', thinking: { type: 'enabled' }, system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }], messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: '.' }, { type: 'text', text: 'hi' }] }] }, 'qwen')
  ok('local body sanitized', s.model === 'qwen' && !s.thinking && !s.system[0].cache_control && s.messages[0].content.length === 1)
  const { config: dc } = loadConfig({})
  const ad = adaptForModel({ model: 'claude-opus-5-5', max_tokens: 128000, thinking: { type: 'adaptive' }, output_config: { effort: 'high' }, messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: '.' }, { type: 'text', text: 'x' }] }] }, 'claude-haiku-4-5', dc.models)
  ok('route to Haiku: adaptive thinking off, max_tokens clamped, effort dropped', ad.model === 'claude-haiku-4-5' && !ad.thinking && ad.max_tokens === 64000 && !ad.output_config && ad.messages[0].content.length === 1, ad)
  const same = adaptForModel({ model: 'claude-opus-5-5', max_tokens: 128000, thinking: { type: 'adaptive' } }, 'claude-sonnet-5-5', dc.models)
  ok('route to Sonnet 5.5 keeps adaptive thinking', same.thinking?.type === 'adaptive' && same.max_tokens === 128000)
  const cm = adaptForModel({ model: 'x', thinking: { type: 'adaptive' }, context_management: { edits: [{ type: 'clear_thinking_20251015' }] }, messages: [] }, 'claude-haiku-4-5', dc.models)
  ok('clear_thinking edit dropped when thinking is off', !cm.context_management)
  const pt = adaptForModel({ model: 'x', messages: [{ role: 'user', content: 'hi', output_config: { effort: 'low' } }] }, 'claude-haiku-4-5', dc.models)
  ok('per-message output_config dropped for Haiku', !('output_config' in pt.messages[0]))
  const sm = adaptForModel({ model: 'x', system: 'base', messages: [{ role: 'user', content: 'a' }, { role: 'system', content: 'note' }, { role: 'user', content: 'b' }] }, 'claude-haiku-4-5', dc.models)
  ok('mid-conversation system messages folded into system', sm.messages.every(m => m.role !== 'system') && sm.system.map(x => x.text).join('|') === 'base|note', sm)
  const hh = adaptHeaders({ 'anthropic-beta': 'claude-code-20250219,effort-2025-11-24,per-turn-control-2026-07-01,context-management-2025-06-27' }, 'claude-haiku-4-5', dc.models)
  ok('unsupported betas dropped for Haiku', hh['anthropic-beta'] === 'claude-code-20250219,context-management-2025-06-27', hh)
  const tap = new UsageTap()
  tap.push('event: message_start\ndata: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":10,"cache_read_input_tokens":90}}}\n\nevent: message_delta\ndata: {"type":"message_de')
  tap.push('lta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n')
  ok('SSE usage read across chunk boundaries', tap.usage.input_tokens === 10 && tap.usage.cache_read_input_tokens === 90 && tap.usage.output_tokens === 7, tap.usage)
  const h = remoteHeaders({ 'x-api-key': 'dummy', 'anthropic-beta': 'a' }, { kind: 'oauth', value: 'tok' })
  ok('ULT swaps the dummy key for its OAuth credential', h.authorization === 'Bearer tok' && !h['x-api-key'] && h['anthropic-beta'].includes('oauth-2025-04-20'))
  const { ultCredential } = await import('../lib/ult/upstream.mjs')
  ok('subscription token is the default, even when an API key exists', ultCredential({ ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't' }).kind === 'oauth')
  ok('no silent fallback to an API key', ultCredential({ ANTHROPIC_API_KEY: 'k' }) === null)
  ok('AUTH_MODE=api-key uses the key', ultCredential({ ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't', AUTH_MODE: 'api-key' }).kind === 'api-key')
  ok('an unresolved op:// reference is never used', ultCredential({ CLAUDE_CODE_OAUTH_TOKEN: 'op://vault/item/t' }) === null)
  const { launcherCredential } = await import('../lib/ult/credentials.mjs')
  const lc = launcherCredential({ CLAUDE_CODE_OAUTH_TOKEN: 'from-env', ANTHROPIC_API_KEY: 'k' }, { readStored: () => 'from-keychain' })
  ok('launcher: stored login token wins over .env, API key ignored', lc.kind === 'oauth' && lc.value === 'from-keychain', lc)
  ok('launcher: API key only with AUTH_MODE=api-key', launcherCredential({ ANTHROPIC_API_KEY: 'k', AUTH_MODE: 'api-key' }, { readStored: () => 'x' }).kind === 'api-key')
  const { cleanToken, parseArgs } = await import('../optimize-live.mjs')
  const { credentialKind } = await import('../lib/ult/credentials.mjs')
  ok('credential kind detected from the value', credentialKind('sk-ant-oat01-x') === 'oauth' && credentialKind('sk-ant-api03-x') === 'api-key')
  ok('--auth alone means ask at a prompt', parseArgs(['--auth', '--mode', 'route']).flags.auth === 'prompt' && parseArgs(['--auth']).flags.auth === 'prompt')
  ok('--auth <value>, --auth=env:NAME and --save parse', parseArgs(['--auth', 'sk-ant-oat01-x', '--save']).flags.auth === 'sk-ant-oat01-x' && parseArgs(['--auth=env:TOK']).flags.auth === 'env:TOK' && parseArgs(['--auth', '--save']).flags.save)
  ok('pasted token: wrapped lines and bracketed-paste markers removed', cleanToken('\x1b[200~sk-ant-oat01-abc\r\ndef\n  ghi\x1b[201~\r') === 'sk-ant-oat01-abcdefghi')
  const { verifyCredential } = await import('../lib/ult/upstream.mjs')
  let vsent = null
  const vOk = await verifyCredential({ kind: 'oauth', value: 't' }, 'http://x', async (_u, o) => { vsent = { h: o.headers, b: JSON.parse(o.body) }; return { ok: false, status: 400, json: async () => ({ error: { message: 'This credential is only authorized for use with Claude Code and cannot be used for other API requests.' } }) } })
  ok('subscription check identifies as Claude Code', vsent.b.system?.[0]?.text?.startsWith('You are Claude Code') && vsent.h.authorization === 'Bearer t' && vsent.h['anthropic-beta'].includes('oauth-2025-04-20'))
  ok('"Claude Code only" answer counts as a valid token', vOk.ok && vOk.restricted)
  const vBad = await verifyCredential({ kind: 'oauth', value: 't' }, 'http://x', async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'OAuth access token is invalid.' } }) }))
  ok('401 invalid token is rejected', !vBad.ok && vBad.status === 401)
  const jr = buildJevRequest({ flags: { mentions_bug: true }, promptSha256: 'abc', session: 's', thread: 't' }, 'jev')
  ok('Jev request drops hashes and ids', !JSON.stringify(jr).includes('abc') && jr.questions.task_class.type === 'choice')
}

// What a small Ollama model reports: weights 1 GB, 28 layers, 2 KV heads of 128, 32k native context.
const fakeOllamaApi = (url, r, { pulled = ['qwen-test'] } = {}) => {
  r.writeHead(200, { 'content-type': 'application/json' })
  if (url === '/api/tags') return r.end(JSON.stringify({ models: pulled.map((name) => ({ name, model: name, size: 1e9 })) }))
  if (url === '/api/ps') return r.end(JSON.stringify({ models: [] }))
  r.end(JSON.stringify({ model_info: { 'general.architecture': 'qwen2', 'qwen2.block_count': 28, 'qwen2.attention.head_count_kv': 2,
    'qwen2.attention.head_count': 12, 'qwen2.attention.key_length': 128, 'qwen2.embedding_length': 1536, 'qwen2.context_length': 32768 } }))
}

console.log('integration — fake upstreams')
{
  const seen = []
  const mkUpstream = (name, behave) => http.createServer((q, r) => {
    let b = ''; q.on('data', d => b += d); q.on('end', () => {
      if (q.url.startsWith('/api/')) return fakeOllamaApi(q.url, r)     // the fit check, not traffic
      const body = b ? JSON.parse(b) : {}
      seen.push({ name, path: q.url, model: body.model, auth: q.headers['x-api-key'] ?? q.headers.authorization ?? null, cacheCtl: b.includes('cache_control') })
      behave(body, r)
    })
  })
  const usage = { input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 }
  const remote = mkUpstream('remote', (body, r) => {
    if (seen.at(-1).auth === 'Bearer expired') { r.writeHead(401, { 'content-type': 'application/json' }); return r.end('{"type":"error","error":{"type":"authentication_error","message":"invalid"}}') }
    if (body.stream) {
      r.writeHead(200, { 'content-type': 'text/event-stream' })
      r.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { model: body.model, usage: { input_tokens: 12, cache_read_input_tokens: 1000 } } })}\n\n`)
      r.write(`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n`)
      r.end(`event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n`)
    } else { r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify({ type: 'message', model: body.model, content: [{ type: 'text', text: 'hi' }], usage })) }
  })
  let localDown = false
  const local = mkUpstream('local', (body, r) => {
    if (localDown) { r.writeHead(404, { 'content-type': 'application/json' }); return r.end('{"type":"error","error":{"type":"not_found_error","message":"model not found"}}') }
    r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify({ type: 'message', model: body.model, content: [{ type: 'text', text: 'local' }], usage: { input_tokens: 40, output_tokens: 6 } }))
  })
  await new Promise(r => remote.listen(0, '127.0.0.1', r)); await new Promise(r => local.listen(0, '127.0.0.1', r))
  const base = (s) => `http://127.0.0.1:${s.address().port}`

  const start = async (mode, extra = {}, env = { CLAUDE_CODE_OAUTH_TOKEN: 'real-token' }) => {
    const { config } = loadConfig({ flags: { mode, port: 1 } })
    const cfg = merge(config, { remote: { baseUrl: base(remote) }, local: { baseUrl: base(local), model: 'qwen-test' }, ...extra })
    const runDir = path.join(tmp, `run-${mode}-${Date.now()}`)
    const u = createUlt({ config: cfg, runDir, contextFile: path.join(runDir, 'ctx.json'), env })
    const a = await u.listen(0, '127.0.0.1')
    return { u, url: `http://127.0.0.1:${a.port}`, runDir }
  }
  const post = (url, body, headers = {}) => fetch(`${url}/v1/messages?beta=true`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'sk-dummy', 'anthropic-version': '2023-06-01', ...headers }, body: JSON.stringify(body) })

  // route mode
  const R = await start('route')
  let r = await post(R.url, req('Summarize this session in 5 words', { tools: 0, model: 'claude-haiku-4-5', maxTokens: 256 }))
  let j = await r.json()
  ok('background call answered by the local model', r.status === 200 && j.content[0].text === 'local' && seen.at(-1).name === 'local' && seen.at(-1).model === 'qwen-test', seen.at(-1))
  ok('local request carries no cache_control and no credential', !seen.at(-1).cacheCtl && seen.at(-1).auth === null)
  r = await post(R.url, { ...req('add idempotency keys'), stream: true })
  const text = await r.text()
  ok('streaming passed through', r.status === 200 && text.includes('hello') && text.includes('message_delta'))
  ok('remote gets the subscription token, not the dummy key', seen.at(-1).name === 'remote' && seen.at(-1).auth === 'Bearer real-token', seen.at(-1))
  ok('coding/edit kept on the requested model', seen.at(-1).model === 'claude-opus-5-5')
  r = await post(R.url, req('explain what a mutex is', { tools: 0 }))
  await r.json()
  ok('small explain thread routed to haiku', seen.at(-1).model === 'claude-haiku-4-5', seen.at(-1))
  localDown = true
  r = await post(R.url, req('Summarize this session in 3 words', { tools: 0, model: 'claude-haiku-4-5', maxTokens: 128, system: 'other' }))
  j = await r.json()
  ok('local failure falls back to the requested model', r.status === 200 && seen.at(-1).name === 'remote' && seen.at(-1).model === 'claude-haiku-4-5', seen.at(-1))
  localDown = false
  const cnt = await fetch(`${R.url}/v1/messages/count_tokens`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"m","messages":[]}' })
  ok('count_tokens passed through', cnt.status === 200 && seen.at(-1).path.startsWith('/v1/messages/count_tokens'))
  const st = await (await fetch(`${R.url}/ult/status`)).json()
  const line = await runStatus({ ANTHROPIC_BASE_URL: R.url })
  ok('status line shows route mode and the last decision', /opthub ROUTE/.test(line) && /4 req/.test(line) && /fallback/.test(line), line)
  const down = await runStatus({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' })
  ok('status line says when the router is unreachable', /router unreachable/.test(down), down)
  const sh = renderStatus({ mode: 'shadow', requests: 3, wouldAct: 2, last: { class: 'non-coding/explain', acted: false, proposed: { decision: 'route', target: 'claude-haiku-4-5' } } }).replace(/\x1b\[[0-9;]*m/g, '')
  ok('status line in shadow mode says what it would do', sh.includes('SHADOW') && sh.includes('would route haiku-4-5') && sh.includes('would act on 2'), sh)
  ok('/ult/status counts requests', st.requests === 4 && st.byDecision.local === 1 && st.byDecision.fallback === 1, st)
  await R.u.close()
  const entries = readAudit(path.join(R.runDir, 'audit.jsonl'))
  const v = verifyAudit(path.join(R.runDir, 'audit.jsonl'))
  ok('audit chain verifies', v.ok && v.entries === 5, v)
  ok('audit has no prompt text by default', !fs.readFileSync(path.join(R.runDir, 'audit.jsonl'), 'utf8').includes('idempotency'))
  const stream = entries.find(e => e.class === 'coding/edit')
  ok('audit records stream usage and cost', stream.usage.output_tokens === 5 && stream.cost_usd > 0, stream.usage)
  const loc = entries.find(e => e.decision === 'local')
  ok('local decision priced at $0 with a counterfactual', loc.cost_usd === 0 && loc.counterfactual_usd > 0, loc)
  ok('fallback recorded with its cause', entries.find(e => e.decision === 'fallback')?.fallback_from?.status === 404)
  ok('summary totals', summarize(entries).requests === 4)

  // shadow mode: same requests, nothing changes
  const S = await start('shadow')
  const before = seen.length
  await (await post(S.url, req('Summarize this session in 5 words', { tools: 0, model: 'claude-haiku-4-5', maxTokens: 256 }))).json()
  ok('shadow mode forwards unchanged', seen.length === before + 1 && seen.at(-1).name === 'remote' && seen.at(-1).model === 'claude-haiku-4-5', seen.at(-1))
  await S.u.close()
  const se = readAudit(path.join(S.runDir, 'audit.jsonl'))[0]
  ok('shadow audit records what route mode would do', se.decision === 'keep' && se.proposed.decision === 'local' && se.acted === false, se.proposed)

  // a rejected credential is relayed, not retried
  const X = await start('route', {}, { CLAUDE_CODE_OAUTH_TOKEN: 'expired' })
  const n0 = seen.length
  const xr = await post(X.url, req('explain what a mutex is', { tools: 0 }))
  await X.u.close()
  const xe = readAudit(path.join(X.runDir, 'audit.jsonl'))[0]
  ok('401 relayed to the client without a fallback retry', xr.status === 401 && seen.length === n0 + 1 && xe.decision === 'route' && xe.error === 'http-401', { status: xr.status, calls: seen.length - n0, decision: xe.decision })

  // audit-prompts opt-in
  const P = await start('shadow', { audit: { prompts: true } })
  await (await post(P.url, req('add a retry test'))).json()
  await P.u.close()
  ok('--audit-prompts stores the prompt', readAudit(path.join(P.runDir, 'audit.jsonl'))[0].prompt_text === 'add a retry test')

  remote.close(); local.close()
}

console.log('local capacity — fake Ollama: slow, malformed, busy, small context, not pulled, failing')
{
  // One fake Ollama whose behaviour each test sets. The remote answers everything else.
  let mode = 'ok', calls = 0
  const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
  const local = http.createServer((q, r) => {
    let b = ''; q.on('data', (d) => b += d); q.on('end', () => {
      if (q.url.startsWith('/api/')) return fakeOllamaApi(q.url, r, { pulled: mode === 'not-pulled' ? ['other'] : ['qwen-test'] })
      calls++
      const streamed = JSON.parse(b || '{}').stream
      const send = () => {
        if (mode === 'down') { r.writeHead(500, { 'content-type': 'application/json' }); return r.end('{"type":"error","error":{"message":"boom"}}') }
        if (!streamed) {
          r.writeHead(200, { 'content-type': 'application/json' })
          return r.end(JSON.stringify({ type: 'message', model: 'qwen-test', usage: { input_tokens: 40, output_tokens: 3 },
            content: mode === 'malformed' ? [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } }] : [{ type: 'text', text: 'local' }] }))
        }
        r.writeHead(200, { 'content-type': 'text/event-stream' })
        const tool = mode === 'malformed'
        r.end(sse([{ type: 'message_start', message: { model: 'qwen-test', usage: { input_tokens: 40 } } },
          tool ? { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'Bash', input: {} } }
               : { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          tool ? { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command": "ls"' } }
               : { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'local' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }]))
      }
      mode === 'slow' ? setTimeout(send, 400) : mode === 'hold' ? setTimeout(send, 150) : send()
    })
  })
  const remote = http.createServer((q, r) => { q.resume(); q.on('end', () => { r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify({ type: 'message', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'remote' }], usage: { input_tokens: 10, output_tokens: 2 } })) }) })
  await new Promise((r) => local.listen(0, '127.0.0.1', r)); await new Promise((r) => remote.listen(0, '127.0.0.1', r))
  const at = (s) => `http://127.0.0.1:${s.address().port}`
  const start = async (over = {}) => {
    const { config } = loadConfig({ flags: { mode: 'route', port: 1 } })
    const cfg = merge(config, merge({ remote: { baseUrl: at(remote) }, local: { baseUrl: at(local), model: 'qwen-test', firstTokenMs: 200, breaker: { failures: 2, cooldownMs: 60000 } } }, over))
    const runDir = path.join(tmp, `cap-${Date.now()}-${Math.random()}`)
    const u = createUlt({ config: cfg, runDir, env: { CLAUDE_CODE_OAUTH_TOKEN: 't' } })
    const a = await u.listen(0, '127.0.0.1')
    return { u, url: `http://127.0.0.1:${a.port}`, runDir }
  }
  const sideCall = (U, prompt = 'Summarize this session in 5 words', extra = {}) =>
    fetch(`${U.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ ...req(prompt, { tools: 0, model: 'claude-haiku-4-5', maxTokens: 128 }), ...extra }) })
  const last = (U) => readAudit(path.join(U.runDir, 'audit.jsonl')).at(-1)

  let U = await start()
  let r = await sideCall(U); let j = await r.json()
  ok('a side call that fits runs locally', j.content[0].text === 'local' && last(U).decision === 'local' && last(U).capacity === null, last(U).capacity)
  mode = 'slow'
  r = await sideCall(U); j = await r.json()
  ok('no first token within the budget: answered remotely, reason slow', j.content[0].text === 'remote' && last(U).decision === 'fallback' && last(U).capacity?.reason === 'slow', last(U).capacity)
  mode = 'malformed'
  r = await sideCall(U); j = await r.json()
  ok('a tool call that was not offered never reaches the client', j.content[0].text === 'remote' && last(U).capacity?.reason === 'malformed', last(U).capacity)
  await U.u.close()
  U = await start()
  mode = 'malformed'
  r = await sideCall(U, 'Summarize this session in 5 words', { stream: true }); const t = await r.text()
  ok('streamed: an unfinished tool-call JSON is caught before the client sees a byte', t.includes('remote') && !t.includes('input_json_delta') && last(U).capacity?.reason === 'malformed', last(U).capacity)
  mode = 'slow'
  await (await sideCall(U)).json()
  mode = 'ok'; const before = calls
  r = await sideCall(U); j = await r.json()
  ok('two failures in a row open the breaker: local not even tried', j.content[0].text === 'remote' && calls === before && last(U).capacity?.reason === 'breaker', last(U).capacity)
  const st = await (await fetch(`${U.url}/ult/status`)).json()
  ok('/ult/status counts refusals by reason', st.capacity.refused.slow === 1 && st.capacity.refused.malformed === 1 && st.capacity.refused.breaker === 1, st.capacity)
  await U.u.close()

  U = await start({ local: { numCtx: 50 } })
  r = await sideCall(U, 'Summarize this session in 5 words, please, carefully and with all the context you have'); await r.json()
  ok('a prompt longer than num_ctx goes remote, reason context', last(U).decision === 'keep' && last(U).capacity?.reason === 'context', last(U).capacity)
  await U.u.close()

  mode = 'hold'
  U = await start({ local: { maxInFlight: 1 } })
  const [a1, a2] = await Promise.all([sideCall(U), (async () => { await new Promise((z) => setTimeout(z, 30)); return sideCall(U, 'Summarize this session in 4 words') })()])
  await a1.json(); await a2.json()
  const both = readAudit(path.join(U.runDir, 'audit.jsonl'))
  ok('every slot taken: the next request goes remote at once, reason busy', both.some((e) => e.capacity?.reason === 'busy') && both.some((e) => e.decision === 'local'), both.map((e) => e.capacity?.reason ?? e.decision))
  await U.u.close()

  mode = 'not-pulled'
  U = await start()
  await (await sideCall(U)).json()
  ok('a model that is not pulled never gets traffic, reason no-fit', last(U).capacity?.reason === 'no-fit' && /not pulled/.test(last(U).capacity.why), last(U).capacity)
  await U.u.close()

  mode = 'ok'
  U = await start()
  const S = await (async () => { const { config } = loadConfig({ flags: { mode: 'shadow', port: 1 } }); return config })()
  await U.u.close()
  const sh = createUlt({ config: merge(S, { remote: { baseUrl: at(remote) }, local: { baseUrl: at(local), model: 'qwen-test', numCtx: 50 } }), runDir: path.join(tmp, 'cap-shadow'), env: { CLAUDE_CODE_OAUTH_TOKEN: 't' } })
  const sa = await sh.listen(0, '127.0.0.1')
  await (await fetch(`http://127.0.0.1:${sa.port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req('Summarize this session in 5 words, please, carefully and with all the context you have', { tools: 0, model: 'claude-haiku-4-5', maxTokens: 128 })) })).json()
  await sh.close()
  const se = readAudit(path.join(tmp, 'cap-shadow', 'audit.jsonl')).at(-1)
  ok('shadow mode logs whether local would have been admitted', se.decision === 'keep' && se.proposed.decision === 'local' && se.capacity?.reason === 'context', se.capacity)

  local.close(); remote.close()

  // the arithmetic, without servers
  const fit = await fitCheck({ baseUrl: 'http://x', model: 'qwen-test', numCtx: 65536, totalMem: 8 * 2 ** 30,
    fetchImpl: async (u) => ({ ok: true, json: async () => { const out = {}; let body; fakeOllamaApi(new URL(u).pathname, { writeHead() {}, end: (t) => { body = t } }); return JSON.parse(body) } }) })
  // KV: 2 x 28 layers x 2 heads x 128 dims x 32768 tokens (native cap) x 1 byte (q8_0) = 469,762,048; plus 1e9 weights
  ok('fit: weights + KV at the native context cap, against 75% of memory', fit.ok && fit.numCtx === 32768 && fit.needBytes === 1e9 + 469762048, fit)
  const tiny = await fitCheck({ baseUrl: 'http://x', model: 'qwen-test', numCtx: 65536, totalMem: 1.5 * 2 ** 30,
    fetchImpl: async (u) => ({ ok: true, json: async () => { let body; fakeOllamaApi(new URL(u).pathname, { writeHead() {}, end: (t) => { body = t } }); return JSON.parse(body) } }) })
  ok('fit: a machine too small says how much is needed', !tiny.ok && /GiB/.test(tiny.why), tiny)
  const g = new LocalGate({ caps: capsOf({ numCtx: 1000, maxInFlight: 2 }, { date: '2026-10-24', recommended: { maxInFlight: 1, maxPromptTokens: 500 } }) })
  ok('a bench profile overrides the configured caps', g.c.maxInFlight === 1 && g.c.numCtx === 500 && /bench/.test(g.c.source), g.c)
  ok('tokens estimated at 4 characters', estimateTokens({ messages: [{ role: 'user', content: 'x'.repeat(400) }] }) > 100)
}

console.log('small tasks — --routing local')
{
  const { config } = loadConfig({ flags: { routing: 'local', port: 1 } })
  ok('--routing local: route mode, local on, tev1 on local Ollama', config.mode === 'route' && config.local.enabled && config.classifier.jev.model === 'tev1' && /11434\/v1\/systemone/.test(config.classifier.jev.endpoint))
  ok('--routing local: explain, summarize, PR text are small; coding and review stay on the frontier',
     config.policy.routes['non-coding/explain'] === 'scoped:qwen3:8b' && config.policy.routes['coding/*'] === 'keep' && config.policy.routes['review/*'] === 'keep')
  ok('--routing local keeps a --route override', loadConfig({ flags: { routing: 'local', routes: ['non-coding/summarize=keep'] } }).config.policy.routes['non-coding/explain'] === 'scoped:qwen3:8b')
  const f = extractFeatures(req('explain what a mutex is'))
  const d = decide({ cls: 'non-coding/explain', confidence: 0.8, features: f, config, threadTarget: null })
  ok('a short explain question is a small task, even with Claude Code\'s tools offered', d.decision === 'local' && d.scoped && d.target === 'local:qwen3:8b', d)
  const long = decide({ cls: 'non-coding/explain', confidence: 0.8, features: extractFeatures(req('explain ' + 'this part '.repeat(300))), config, threadTarget: null })
  ok('a long prompt is not small', long.decision === 'keep' && /2000/.test(long.reason), long.reason)
  const loop = decide({ cls: 'non-coding/explain', confidence: 0.8, features: extractFeatures(req('explain', { history: editHistory, lastToolResult: true })), config, threadTarget: null })
  ok('a tool-loop request is not a person\'s turn: not small', loop.decision === 'keep', loop.reason)
  const sc = scopeForLocal({ max_tokens: 32000, stream: true, system: [{ type: 'text', text: 'You are Claude Code. '.repeat(2000) }], tools: [{ name: 'Bash' }],
    messages: [...editHistory, { role: 'user', content: [{ type: 'text', text: '<system-reminder>secret</system-reminder>explain the retry logic' }] }] }, 'qwen3:8b')
  ok('scoped: no tools, no Claude Code system prompt, output capped', !sc.tools && !JSON.stringify(sc.system).includes('Claude Code') && sc.max_tokens === 1024 && sc.stream === true)
  ok('scoped: starts with the person, ends with the request, reminders stripped', sc.messages[0].role === 'user' && sc.messages.at(-1).content.endsWith('explain the retry logic') && !JSON.stringify(sc).includes('secret'))
  ok('scoped: tool calls reduced to a line', JSON.stringify(sc.messages).includes('[ran Edit]'))
  ok('scoped: alternating roles', sc.messages.every((m, i) => i === 0 || m.role !== sc.messages[i - 1].role))
  const big = scopeForLocal({ messages: Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(2000) })) }, 'm', { budgetTokens: 1000 })
  ok('scoped: cut from the end to its token budget', estimateTokens(big) < 1300, estimateTokens(big))
  const json = stripThinking(JSON.stringify({ content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'ok' }] }), false)
  ok('thinking blocks removed from a local JSON answer', !json.includes('thinking') && json.includes('"ok"'))
  const ev = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}`
  const sse = [ev({ type: 'message_start', message: {} }), ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hm' } }), ev({ type: 'content_block_stop', index: 0 }),
    ev({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }), ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'ok' } }),
    ev({ type: 'content_block_stop', index: 1 }), ev({ type: 'message_stop' })].join('\n\n') + '\n\n'
  const out = stripThinking(sse, true)
  const msg = sseToMessage(stripThinking(sse, true))
  ok('a stream reassembled for a client that did not ask for one', msg.type === 'message' && msg.content.length === 1 && msg.content[0].text === 'ok', msg)
  ok('small tasks are sent with thinking off', sc.thinking?.type === 'disabled')
  ok('thinking blocks removed from a local stream, text re-indexed to 0', !out.includes('thinking') && out.includes('"index":0') && !out.includes('"index":1') && out.includes('text_delta'))

  // end to end: a small task answered by the fake Ollama, scoped; a coding turn on the remote
  const seen = []
  const ollama = http.createServer((q, r) => { let b = ''; q.on('data', (x) => b += x); q.on('end', () => {
    if (q.url.startsWith('/api/')) return fakeOllamaApi(q.url, r, { pulled: ['qwen3:8b', 'qwen2.5-coder:1.5b'] })
    if (q.url.startsWith('/v1/systemone')) { r.writeHead(503); return r.end() }
    const body = JSON.parse(b); seen.push({ to: 'ollama', model: body.model, tools: body.tools, system: body.system })
    r.writeHead(200, { 'content-type': 'application/json' })
    r.end(JSON.stringify({ type: 'message', model: body.model, content: [{ type: 'thinking', thinking: 'let me see' }, { type: 'text', text: 'A mutex is a lock.' }], usage: { input_tokens: 90, output_tokens: 8 } }))
  }) })
  const remote = http.createServer((q, r) => { let b = ''; q.on('data', (x) => b += x); q.on('end', () => { seen.push({ to: 'remote', model: JSON.parse(b).model })
    r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify({ type: 'message', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 10, output_tokens: 2 } })) }) })
  await new Promise((z) => ollama.listen(0, '127.0.0.1', z)); await new Promise((z) => remote.listen(0, '127.0.0.1', z))
  const cfg = merge(config, { remote: { baseUrl: `http://127.0.0.1:${remote.address().port}` }, local: { baseUrl: `http://127.0.0.1:${ollama.address().port}` },
                              classifier: { jev: { endpoint: `http://127.0.0.1:${ollama.address().port}/v1/systemone` } } })
  const u = createUlt({ config: cfg, runDir: path.join(tmp, 'small'), env: { CLAUDE_CODE_OAUTH_TOKEN: 't' } })
  const a = await u.listen(0, '127.0.0.1')
  const send = (body) => fetch(`http://127.0.0.1:${a.port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json())
  const j1 = await send(req('explain what a mutex is'))
  ok('small task answered by the local model, without tools or the 20K prefix', j1.content.length === 1 && j1.content[0].text === 'A mutex is a lock.' && seen.at(-1).to === 'ollama' && seen.at(-1).model === 'qwen3:8b' && !seen.at(-1).tools, seen.at(-1))
  await send(req('add idempotency keys to the webhook handler'))
  ok('a coding turn goes to the frontier model', seen.at(-1).to === 'remote' && seen.at(-1).model === 'claude-opus-5-5', seen.at(-1))
  await u.close(); ollama.close(); remote.close()
  const e = readAudit(path.join(tmp, 'small', 'audit.jsonl'))[0]
  ok('the audit says scoped, how big the scoped request was, and that it ran locally', e.scoped === true && e.scoped_tokens > 0 && e.scoped_tokens < 1000 && e.decision === 'local', { scoped: e.scoped, tokens: e.scoped_tokens })
}

if (process.env.ULT_TEST_OLLAMA === '1') {
  console.log('integration — real Ollama')
  const model = process.env.ULT_TEST_OLLAMA_MODEL ?? 'qwen2.5-coder:1.5b'
  const { config } = loadConfig({ flags: { mode: 'route', localModel: model } })
  const runDir = path.join(tmp, 'run-ollama')
  const u = createUlt({ config, runDir, env: {} })
  const a = await u.listen(0, '127.0.0.1')
  const r = await fetch(`http://127.0.0.1:${a.port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body: JSON.stringify(req('Reply with the single word: pong', { tools: 0, model: 'claude-haiku-4-5', maxTokens: 20 })) })
  const j = await r.json()
  await u.close()
  const e = readAudit(path.join(runDir, 'audit.jsonl'))[0]
  ok(`Ollama ${model} answered through ULT`, r.status === 200 && Array.isArray(j.content) && e.decision === 'local', { status: r.status, decision: e.decision, text: j.content?.[0]?.text })
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
