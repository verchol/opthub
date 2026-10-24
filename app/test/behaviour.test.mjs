// opt monitor + Analytics → Behaviour: the OTLP collector, both trace readers, the behaviour numbers,
// and the settings edit. Synthetic payloads shaped like Claude Code's; no network beyond 127.0.0.1.
// Run: node test/behaviour.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

let pass = 0, fail = 0
const ok = (name, cond, got) => { if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}${got !== undefined ? `  — got ${JSON.stringify(got)}` : ''}`) } }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'behaviour-test-'))
process.env.OPT_HOME = path.join(tmp, 'home')
process.env.OPT_CLAUDE_SETTINGS = path.join(tmp, 'settings.json')
process.env.OPT_OTLP_PORT = String(14000 + Math.floor(Math.random() * 1000))
const { flatten, startCollector, readOtel } = await import('../lib/otel.mjs')
const { turnsFromOtel, turnsFromLangsmith, behaviour, union, CACHE_TTL_MS } = await import('../lib/behaviour.mjs')
const { applyEnv, removeEnv, otelEnv } = await import('../lib/monitor.mjs')
const { priceFor } = await import('../lib/atlas.mjs')

// ---------------------------------------------------------------- OTLP fixtures
const T0 = Date.UTC(2026, 9, 19, 9, 0, 0)
const ns = (ms) => String(BigInt(ms) * 1000000n)
const kv = (o) => Object.entries(o).map(([key, v]) => ({ key, value: typeof v === 'number' ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }) : typeof v === 'boolean' ? { boolValue: v } : { stringValue: v } }))
const SID = 'aaaaaaaa-1111-4222-8333-944455556666'
const span = (id, parent, name, start, end, a = {}, err = false) => ({ traceId: 't' + id[0], spanId: id, parentSpanId: parent ?? '', name,
  startTimeUnixNano: ns(start), endTimeUnixNano: ns(end), attributes: kv({ 'session.id': SID, 'span.type': name, ...a }), status: err ? { code: 2 } : {} })
// turn 1: 0–60s, a warm model call, a Bash call that waited 20s on a permission prompt
// turn 2: starts 10 minutes after turn 1 ends (past the cache's life), its first call re-writes the cache
const traces = { resourceSpans: [{ resource: { attributes: kv({ 'service.name': 'claude-code' }) }, scopeSpans: [{ spans: [
  span('i1', null, 'claude_code.interaction', T0, T0 + 60e3, { 'interaction.duration_ms': 60000 }),
  span('l1', 'i1', 'claude_code.llm_request', T0 + 1e3, T0 + 11e3, { model: 'claude-opus-5-5', input_tokens: 100, output_tokens: 500, cache_read_tokens: 50000, cache_creation_tokens: 1000, ttft_ms: 900, request_id: 'r1', attempt: 1 }),
  span('b1', 'i1', 'claude_code.tool', T0 + 12e3, T0 + 50e3, { tool_name: 'Bash', bash_command_class: 'vcs' }),
  span('w1', 'b1', 'claude_code.tool.blocked_on_user', T0 + 12e3, T0 + 32e3, { duration_ms: 20000, decision: 'accept', source: 'user_temporary' }),
  span('e1', 'b1', 'claude_code.tool.execution', T0 + 32e3, T0 + 50e3, { success: false, error: 'ShellError' }),
  span('i2', null, 'claude_code.interaction', T0 + 660e3, T0 + 700e3),
  span('l2', 'i2', 'claude_code.llm_request', T0 + 661e3, T0 + 690e3, { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 300, cache_read_tokens: 2000, cache_creation_tokens: 52000, ttft_ms: 1500, request_id: 'r2', attempt: 2 }),
  span('s2', 'i2', 'claude_code.llm_request', T0 + 662e3, T0 + 670e3, { model: 'claude-haiku-4-5', agent_id: 'sub1', input_tokens: 10, output_tokens: 10 }),
] }] }] }
const logs = { resourceLogs: [{ resource: { attributes: kv({ 'service.name': 'claude-code' }) }, scopeLogs: [{ logRecords: [
  { timeUnixNano: ns(T0 + 11e3), body: { stringValue: 'claude_code.api_request' }, attributes: kv({ 'event.name': 'api_request', 'session.id': SID, request_id: 'r1', cost_usd: 0.25, duration_ms: 10000 }) },
  { timeUnixNano: ns(T0 + 32e3), body: { stringValue: 'claude_code.tool_decision' }, attributes: kv({ 'event.name': 'tool_decision', 'session.id': SID, decision: 'accept', source: 'user_temporary', tool_name: 'Bash' }) },
  { timeUnixNano: ns(T0 + 665e3), body: { stringValue: 'claude_code.api_error' }, attributes: kv({ 'event.name': 'api_error', 'session.id': SID, status_code: '529', attempt: 1 }) },
  { timeUnixNano: ns(T0 + 699e3), body: { stringValue: 'claude_code.compaction' }, attributes: kv({ 'event.name': 'compaction', 'session.id': SID }) },
] }] }] }
const metrics = { resourceMetrics: [{ resource: { attributes: kv({ 'service.name': 'claude-code' }) }, scopeMetrics: [{ metrics: [
  { name: 'claude_code.active_time.total', unit: 's', sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints: [
    { timeUnixNano: ns(T0 + 60e3), asDouble: 42.5, attributes: kv({ 'session.id': SID, type: 'cli' }) },
    { timeUnixNano: ns(T0 + 60e3), asDouble: 8, attributes: kv({ 'session.id': SID, type: 'user' }) }] } },
  { name: 'claude_code.lines_of_code.count', sum: { dataPoints: [{ timeUnixNano: ns(T0 + 60e3), asInt: '12', attributes: kv({ 'session.id': SID, type: 'added' }) }] } },
] }] }] }

console.log('\notel.mjs')
const fs1 = flatten('traces', traces)
ok('spans flatten with ms times, parents and attributes', fs1.length === 8 && fs1[0].t === T0 && fs1[2].parent === 'i1' && fs1[1].a.cache_read_tokens === 50000 && fs1[4].a.success === false)
ok('a span with status code 2 is an error', fs1.find((s) => s.id === 'e1') && fs1.find((s) => s.id === 'b1').err === false)
const fl = flatten('logs', logs)
ok('events are named claude_code.<event.name>', fl.map((r) => r.name).join() === 'claude_code.api_request,claude_code.tool_decision,claude_code.api_error,claude_code.compaction', fl.map((r) => r.name))
const fm = flatten('metrics', metrics)
ok('metric points: doubles and int64 strings', fm.length === 3 && fm[0].v === 42.5 && fm[2].v === 12)

const col = await startCollector()
ok('collector listens on 127.0.0.1', !col.error && col.url.startsWith('http://127.0.0.1:'), col)
const post = (p, body, gz) => fetch(col.url + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(gz ? { 'content-encoding': 'gzip' } : {}) },
  body: gz ? zlib.gzipSync(JSON.stringify(body)) : JSON.stringify(body) })
ok('POST /v1/traces → 200', (await post('/v1/traces', traces)).status === 200)
ok('POST /v1/logs gzip → 200', (await post('/v1/logs', logs, true)).status === 200)
ok('POST /v1/metrics → 200', (await post('/v1/metrics', metrics)).status === 200)
ok('protobuf is refused with 415', (await fetch(col.url + '/v1/logs', { method: 'POST', headers: { 'content-type': 'application/x-protobuf' }, body: 'x' })).status === 415)
ok('bad JSON is a 400, not a crash', (await fetch(col.url + '/v1/logs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status === 400)
const h = await (await fetch(col.url + '/health')).json()
ok('/health counts what arrived', h.ok && h.received === 15, h)
col.server.close()
const stored = readOtel({ sinceMs: T0 - 1 })
ok('records land in a day file and read back', stored.length === 15 && fs.existsSync(path.join(process.env.OPT_HOME, 'otel', '2026-10-19.ndjson')), stored.length)

console.log('\nbehaviour.mjs')
ok('union counts overlapping intervals once', union([[0, 10], [5, 15], [20, 30], [null, 4]]) === 25)
const ot = turnsFromOtel(stored)
ok('OTEL: two turns for the session', ot.length === 2 && ot.every((x) => x.sid === SID && x.src === 'otel'))
const [t1, t2] = ot.sort((a, b) => a.start - b.start)
ok('OTEL: permission wait from tool.blocked_on_user', t1.tools[0].wait === 20000 && t1.tools[0].decision === 'accept')
ok('OTEL: a failed tool.execution marks the call failed', t1.tools[0].ok === false)
ok('OTEL: subagent model calls are counted apart', t2.llm.length === 1 && t2.subLlm === 1)
ok('OTEL: cost from api_request when there is one', Math.abs(t1.cost - 0.25) < 1e-9, t1.cost)
ok('OTEL: retries and time to first token', t2.retries === 1 && t1.ttft[0] === 900)

const b = behaviour(ot, { otel: stored, now: T0 + 800e3 })
const s = b.sessions[0]
ok('gap is end of turn 1 to start of turn 2', b.sessions.length === 1 && s.turns === 2 && s.idle === 600e3, s.idle)
ok('turn 2 is cold: re-wrote the cache after an idle past the TTL', s.cold === 1 && s.coldAfterIdle === 1 && 600e3 > CACHE_TTL_MS)
ok('cold cost is priced: writes at 1.25x against reads at 0.1x input', s.coldCost > 0 && Math.abs(s.coldCost - 52000 * 1.15 * priceFor('claude-opus-5-5').in / 1e6) < 1e-9, s.coldCost)
ok('busy, idle share and tool errors', s.busy === 100e3 && Math.abs(s.idleShare - 600 / 700) < 1e-9 && s.toolErrors === 1)
ok('permission wait counted', s.waitMs === 20000 && s.waits === 1)
ok('gap histogram puts the gap in 5–15m, marked cold', b.gapHist.find((g) => g.label === '5–15m').n === 1 && b.gapHist.find((g) => g.label === '5–15m').cold === 1)
ok('tool table: Bash p50 and its wait', b.tools[0].name === 'Bash' && b.tools[0].p50 === 38e3 && b.tools[0].wait === 20000)
ok('OTEL summary: active time, lines, decisions, 529s, compactions', b.otel.activeTime.cli === 42.5 && b.otel.activeTime.user === 8 && b.otel.lines.added === 12
  && b.otel.decisionSources.user_temporary === 1 && b.otel.apiErrors['529'] === 1 && b.otel.compactions === 1, b.otel)
const away = behaviour(turnsFromOtel(stored).map((x, i) => (i ? { ...x, start: x.start + 3600e3, end: x.end + 3600e3 } : x)), { now: T0 + 9e6 })
ok('a gap over 30 minutes is a break, not idle', away.sessions[0].idle === 0 && away.sessions[0].away > 0 && away.sessions[0].breaks === 1)

// LangSmith: a root turn, a main-thread model call and tool call, a subagent below an Agent tool
const R = 'root-1', AG = 'agent-1'
const iso = (ms) => new Date(ms).toISOString()
const usage = (inp, cr, cw, out) => ({ usage_metadata: { input_tokens: inp, output_tokens: out, input_token_details: { cache_read: cr, cache_creation: cw } }, ls_model_name: 'claude-opus-5-5' })
const runs = [
  { id: R, name: 'Claude Code Turn', run_type: 'chain', is_root: true, start_time: iso(T0), end_time: iso(T0 + 60e3), status: 'success', thread_id: SID, parent_run_ids: [], metadata: { cwd: '/x/proj-a', thread_id: SID } },
  { id: 'l', name: 'Claude', run_type: 'llm', is_root: false, start_time: iso(T0 + 1e3), end_time: iso(T0 + 9e3), status: 'success', parent_run_ids: [R], metadata: usage(51100, 50000, 1000, 500) },
  { id: 'q', name: 'AskUserQuestion', run_type: 'tool', is_root: false, start_time: iso(T0 + 10e3), end_time: iso(T0 + 40e3), status: 'success', parent_run_ids: [R], metadata: {} },
  { id: AG, name: 'Agent', run_type: 'tool', is_root: false, start_time: iso(T0 + 41e3), end_time: iso(T0 + 59e3), status: 'success', parent_run_ids: [R], metadata: {} },
  { id: 'sl', name: 'Claude', run_type: 'llm', is_root: false, start_time: iso(T0 + 42e3), end_time: iso(T0 + 50e3), status: 'success', parent_run_ids: [R, AG, 'sub-turn'], metadata: usage(1000, 0, 1000, 100) },
  { id: 'R2', name: 'Claude Code Turn', run_type: 'chain', is_root: true, start_time: iso(T0 + 70e3), end_time: iso(T0 + 75e3), status: 'error', error: 'User interrupt', thread_id: SID, parent_run_ids: [], metadata: { cwd: '/x/proj-a' } },
]
const lt = turnsFromLangsmith(runs)
ok('LangSmith: root turns, project from cwd', lt.length === 2 && lt[0].project === 'proj-a')
ok('LangSmith: input_tokens net of cache reads and writes', lt[0].llm[0].in === 100 && lt[0].llm[0].cr === 50000)
ok('LangSmith: subagent calls priced into the turn, kept off the main thread', lt[0].llm.length === 1 && lt[0].subLlm === 1 && lt[0].subagents === 1 && lt[0].cost > 0)
ok('LangSmith: "User interrupt" is an interrupt', lt[1].status === 'interrupt')
const lb = behaviour(lt, { now: T0 + 1e6 }).sessions[0]
ok('LangSmith: AskUserQuestion time counts as waiting on the person', lb.waitMs === 30e3 && lb.interrupts === 1)

console.log('\nmonitor.mjs')
fs.writeFileSync(process.env.OPT_CLAUDE_SETTINGS, JSON.stringify({ env: { CC_LANGSMITH_PROJECT: 'mine', KEEP: '1' }, theme: 'dark' }))
const ch = applyEnv({ ...otelEnv({ endpoint: 'http://127.0.0.1:1' }), CC_LANGSMITH_PROJECT: 'other' })
const after = JSON.parse(fs.readFileSync(process.env.OPT_CLAUDE_SETTINGS, 'utf8'))
ok('on: OTEL env written, the rest of the settings kept', ch.length === 9 && after.env.CLAUDE_CODE_ENABLE_TELEMETRY === '1' && after.env.OTEL_EXPORTER_OTLP_PROTOCOL === 'http/json' && after.theme === 'dark' && after.env.KEEP === '1')
ok('on: no content gates', !Object.keys(after.env).some((k) => k.startsWith('OTEL_LOG_')))
ok('on: a backup is kept', fs.readdirSync(tmp).some((f) => f.startsWith('settings.json.opt-backup-')))
ok('on twice changes nothing', applyEnv(otelEnv({ endpoint: 'http://127.0.0.1:1' })) === null)
const off = removeEnv()
const back = JSON.parse(fs.readFileSync(process.env.OPT_CLAUDE_SETTINGS, 'utf8'))
ok('off: removes what on added and restores what it changed', off.removed.length === 8 && off.restored[0] === 'CC_LANGSMITH_PROJECT'
  && JSON.stringify(back.env) === JSON.stringify({ CC_LANGSMITH_PROJECT: 'mine', KEEP: '1' }), back.env)

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
