// The local tier's setup: `opt models bench` (what this machine serves within budget) and
// `opt install` (what is missing). No network: a fake Ollama in-process. Run: node test/local-cloud.test.mjs
import { bench } from '../lib/bench.mjs'
import { plan, OLLAMA_PIN, PROFILES } from '../lib/install.mjs'
import { caps } from '../lib/ult/capacity.mjs'
import { auditFiles, scoreModels, withMachine } from '../lib/model-scores.mjs'
import { decide } from '../lib/ult/policy.mjs'
import { loadConfig } from '../lib/ult/config.mjs'
import { extractFeatures } from '../lib/ult/features.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

let pass = 0, fail = 0
const ok = (name, cond, got) => { if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}${got !== undefined ? `  — got ${JSON.stringify(got)}` : ''}`) } }

console.log('opt models bench — a fake Ollama whose first token takes tokens/50 ms per request in flight')
{
  let inFlight = 0
  const fakeFetch = async (url, init = {}) => {
    if (url.endsWith('/api/version')) return { ok: true, json: async () => ({ version: '0.40.10' }) }
    if (url.endsWith('/api/ps')) return { ok: true, json: async () => ({ models: [{ name: 'w', size: 2e9, size_vram: 2e9 }] }) }
    const body = JSON.parse(init.body)
    const tokens = Math.round(body.prompt.length / 4)
    inFlight++
    const wait = (tokens / 50) * inFlight
    const lines = [
      { response: 'O', done: false },
      { response: '', done: true, prompt_eval_count: tokens, prompt_eval_duration: wait * 1e6, eval_count: 8, eval_duration: 8e7 },
    ]
    return { ok: true, body: (async function* () {
      await new Promise((r) => setTimeout(r, wait))
      inFlight--
      for (const l of lines) yield Buffer.from(JSON.stringify(l) + '\n')
    })() }
  }
  const steps = []
  const p = await bench({ baseUrl: 'http://x', model: 'w', sizes: [1000, 4000, 16000], concurrency: 2, repeats: 3, numCtx: 65536, budgetMs: 100,
                          fetchImpl: fakeFetch, onStep: (r) => steps.push(r) })
  ok('every size at every concurrency, three repeats each', steps.length === 6 && steps.every((r) => r.repeats === 3), steps.length)
  ok('the largest prompt alone within budget: 4K (80 ms), not 16K (320 ms)', p.recommended.maxPromptTokens === 4000, p.recommended)
  ok('in flight is judged at that size: 2 at 4K takes 160 ms, so 1', p.recommended.maxInFlight === 1, p.recommended)
  ok('profile records the machine, Ollama and the date', p.schema === 'opthub.capacity/1' && p.ollama === '0.40.10' && p.machine.memoryBytes > 0 && /^\d{4}-/.test(p.date))
  ok('prefill rate from Ollama\'s own counters', steps[0].prefillTps > 0)
  const none = await bench({ baseUrl: 'http://x', model: 'w', sizes: [16000], concurrency: 1, repeats: 3, budgetMs: 100, fetchImpl: fakeFetch })
  ok('nothing within budget: the profile says local should take nothing', none.recommended.maxPromptTokens === 0 && /nothing should go local/.test(none.recommended.note), none.recommended)
  ok('the router takes its caps from the profile', caps({ numCtx: 65536, maxInFlight: 4 }, p).numCtx === 4000 && caps({ maxInFlight: 4 }, p).maxInFlight === 1)
  const tight = await bench({ baseUrl: 'http://x', model: 'w', sizes: [1000, 32000, 70000], concurrency: 1, repeats: 3, numCtx: 33000, budgetMs: 1e9, fetchImpl: fakeFetch })
  ok('sizes above num_ctx are not sent', tight.results.map((r) => r.tokens).join() === '1000,32000', tight.results.map((r) => r.tokens))
}

console.log('opt install — the plan from a survey')
{
  const good = { version: OLLAMA_PIN, server: OLLAMA_PIN, models: ['tev1:latest', ...PROFILES.full.slice(1).map(([, m]) => m)], bench: true,
                 settings: { OLLAMA_CONTEXT_LENGTH: '131072', OLLAMA_NUM_PARALLEL: '1', OLLAMA_KV_CACHE_TYPE: 'q8_0', OLLAMA_FLASH_ATTENTION: '1' } }
  const all = plan(good, { worker: 'qwen2.5-coder:1.5b', platform: 'darwin' })
  ok('everything in place: every step ok', all.every((s) => s.ok), all.filter((s) => !s.ok).map((s) => s.id))
  const old = plan({ ...good, version: '0.12.0' }, { worker: 'qwen2.5-coder:1.5b', platform: 'darwin' })
  ok('too old for the Anthropic API: blocking, and Ollama is never upgraded for you', !old.find((s) => s.id === 'ollama').ok && old.find((s) => s.id === 'ollama').auto === null)
  const pin = plan({ ...good, version: '0.35.1' }, { worker: 'qwen2.5-coder:1.5b', platform: 'darwin' })
  ok('older than the pin but new enough: advisory only', pin.find((s) => s.id === 'ollama').ok && pin.find((s) => s.id === 'ollama-pin').advisory)
  const bare = plan({ ...good, settings: {}, models: [], bench: false }, { worker: 'w', maxInFlight: 2, platform: 'darwin' })
  const auto = bare.filter((s) => !s.ok && s.auto).map((s) => s.auto.flat().join(' '))
  ok('full (default): four settings with launchctl and five models', auto.length === 9 && auto.includes('launchctl setenv OLLAMA_NUM_PARALLEL 2') && auto.includes('ollama pull qwen3-coder:30b'), auto)
  const lean = plan({ ...good, settings: {}, models: [], bench: false }, { worker: 'w', profile: 'lean', platform: 'darwin' })
  const leanPulls = lean.filter((s) => !s.ok && s.auto && s.auto[0] === 'ollama').map((s) => s.auto[1][1])
  ok('lean: tev1, the side model and qwen3:8b only', leanPulls.join() === 'tev1,qwen2.5-coder:1.5b,qwen3:8b', leanPulls)
  ok('a short context is not enough', !plan({ ...good, settings: { ...good.settings, OLLAMA_CONTEXT_LENGTH: '8192' } }, { worker: 'qwen2.5-coder:1.5b' }).find((s) => s.id === 'OLLAMA_CONTEXT_LENGTH').ok)
  const linux = plan({ ...good, settings: {} }, { worker: 'qwen2.5-coder:1.5b', platform: 'linux' })
  ok('off macOS, settings are printed, not applied', linux.filter((s) => s.id.startsWith('OLLAMA_')).every((s) => s.auto === null))
}

console.log('routing record — scores from router audits, and the record steering the next decision')
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scores-'))
  const now = Date.now(), ts = new Date(now - 3600e3).toISOString(), old = new Date(now - 9 * 86400e3).toISOString()
  const L = (m, extra) => ({ kind: 'request', ts, mode: 'route', proposed: { decision: 'local', target: `local:${m}` }, ...extra })
  const lines = [
    // qwen3:8b: 12 answered quickly, 1 abandoned slow: good
    ...Array.from({ length: 12 }, () => L('qwen3:8b', { decision: 'local', target: 'local:qwen3:8b', status: 200, ttft_ms: 900, latency_ms: 2000, usage: { output_tokens: 50 }, counterfactual_usd: 0.02 })),
    L('qwen3:8b', { decision: 'fallback', target: 'claude-opus-5-5', actual_model: 'claude-opus-5-5', status: 200, fallback_from: { target: 'local:qwen3:8b' }, capacity: { reason: 'slow' }, cost_usd: 0.03 }),
    // tiny: 4 answered, 8 slow: too slow
    ...Array.from({ length: 4 }, () => L('tiny', { decision: 'local', target: 'local:tiny', status: 200, ttft_ms: 7000 })),
    ...Array.from({ length: 8 }, () => L('tiny', { decision: 'fallback', status: 200, fallback_from: { target: 'local:tiny' }, capacity: { reason: 'slow' }, actual_model: 'claude-opus-5-5' })),
    // huge: refused for memory, never answered
    ...Array.from({ length: 3 }, () => L('huge', { decision: 'keep', status: 200, capacity: { reason: 'no-fit' }, actual_model: 'claude-opus-5-5' })),
    // older than the window: ignored
    L('qwen3:8b', { ts: old, decision: 'fallback', status: 200, fallback_from: { target: 'local:qwen3:8b' }, capacity: { reason: 'malformed' } }),
  ]
  const dir = path.join(home, 'results', 'ult-test-1'); fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'audit.jsonl'), lines.map((x) => JSON.stringify(x)).join('\n') + '\n')
  const S = scoreModels(auditFiles(home), { now })
  const by = Object.fromEntries(S.models.map((m) => [m.where + ':' + m.id, m]))
  ok('a fast model that answers is good', by['local:qwen3:8b'].verdict === 'good' && by['local:qwen3:8b'].answered === 12 && by['local:qwen3:8b'].failed.slow === 1, by['local:qwen3:8b'])
  ok('a model abandoned for slowness is too slow', by['local:tiny'].verdict === 'too slow' && by['local:tiny'].demote, by['local:tiny'].verdict)
  ok('a model refused for memory and never answering does not fit', by['local:huge'].verdict === 'does not fit', by['local:huge'].verdict)
  ok('the frontier model is credited with the requests it caught', by['remote:claude-opus-5-5'].caughtFallbacks === 9, by['remote:claude-opus-5-5'])
  ok('audits older than 7 days are not counted', !by['local:qwen3:8b'].failed.malformed)
  const { config } = loadConfig({ flags: { routing: 'local' } })
  config.local.model = 'tiny'; config.local.firstTokenMs = 5000
  withMachine(config, home)
  ok('the launcher writes the demoted models into the router config (fit is re-checked, not remembered)', config.local.demoted.map((m) => m.id).join() === 'tiny', config.local.demoted)
  const f = extractFeatures({ model: 'claude-haiku-4-5', max_tokens: 100, messages: [{ role: 'user', content: 'Write a title for this' }] })
  const d = decide({ cls: 'background/utility', confidence: 0.9, features: f, config, threadTarget: null })
  ok('a demoted local model gets no work: the request stays on the frontier', d.decision === 'keep' && /too slow on this machine/.test(d.reason), d.reason)
  config.local.model = 'qwen3:8b'
  ok('a good one still does', decide({ cls: 'background/utility', confidence: 0.9, features: f, config, threadTarget: null }).decision === 'local')
}

console.log('the hub sees sandbox sessions')
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sbx-'))
  const proj = path.join(home, 'results', 'ult-demo-20261024', 'home', '.claude', 'projects', '-work')
  fs.mkdirSync(proj, { recursive: true })
  const sid = '0a0a0a0a-1111-2222-3333-444444444444'
  const rec = (o) => JSON.stringify({ sessionId: sid, timestamp: '2026-10-24T10:00:00Z', cwd: '/work', entrypoint: 'cli', ...o })
  fs.writeFileSync(path.join(proj, `${sid}.jsonl`), [
    rec({ type: 'user', message: { role: 'user', content: 'explain what a mutex is' } }),
    rec({ type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'a lock' }], usage: { input_tokens: 10, output_tokens: 5 } } }),
  ].join('\n') + '\n')
  // a child process: STATE is fixed when state.mjs first loads, and this file loaded it already
  const env = { ...process.env, OPT_HOME: home }; delete env.OPT_PROJECTS_DIR
  const code = `import('${path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'lib', 'sessions-index.mjs')}').then((m) => {
    const s = m.buildIndex({ limit: 5000 }).sessions.find((x) => x.id === '${sid}')
    console.log(JSON.stringify({ where: s?.where, run: s?.run, found: !!m.findTranscript('${sid.slice(0, 8)}') })) })`
  const r = JSON.parse(spawnSync(process.execPath, ['-e', code], { env, encoding: 'utf8' }).stdout.trim().split('\n').at(-1))
  ok('a session that ran in a sandbox is in the index, marked with its run', r.where === 'sandbox' && r.run === 'ult-demo-20261024', r)
  ok('and its detail opens', r.found)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
