// The local tier's setup: `opt models bench` (what this machine serves within budget) and
// `opt install` (what is missing). No network: a fake Ollama in-process. Run: node test/local-cloud.test.mjs
import { bench } from '../lib/bench.mjs'
import { plan, OLLAMA_PIN } from '../lib/install.mjs'
import { caps } from '../lib/ult/capacity.mjs'

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
  const good = { version: OLLAMA_PIN, server: OLLAMA_PIN, models: ['tev1:latest', 'qwen2.5-coder:1.5b'], bench: true,
                 settings: { OLLAMA_CONTEXT_LENGTH: '131072', OLLAMA_NUM_PARALLEL: '1', OLLAMA_KV_CACHE_TYPE: 'q8_0', OLLAMA_FLASH_ATTENTION: '1' } }
  const all = plan(good, { worker: 'qwen2.5-coder:1.5b', platform: 'darwin' })
  ok('everything in place: every step ok', all.every((s) => s.ok), all.filter((s) => !s.ok).map((s) => s.id))
  const old = plan({ ...good, version: '0.12.0' }, { worker: 'qwen2.5-coder:1.5b', platform: 'darwin' })
  ok('too old for the Anthropic API: blocking, and Ollama is never upgraded for you', !old.find((s) => s.id === 'ollama').ok && old.find((s) => s.id === 'ollama').auto === null)
  const pin = plan({ ...good, version: '0.35.1' }, { worker: 'qwen2.5-coder:1.5b', platform: 'darwin' })
  ok('older than the pin but new enough: advisory only', pin.find((s) => s.id === 'ollama').ok && pin.find((s) => s.id === 'ollama-pin').advisory)
  const bare = plan({ ...good, settings: {}, models: [], bench: false }, { worker: 'w', maxInFlight: 2, platform: 'darwin' })
  const auto = bare.filter((s) => !s.ok && s.auto).map((s) => s.auto.flat().join(' '))
  ok('--yes would set the four settings with launchctl and pull both models', auto.length === 6 && auto.includes('launchctl setenv OLLAMA_NUM_PARALLEL 2') && auto.includes('ollama pull tev1'), auto)
  ok('a short context is not enough', !plan({ ...good, settings: { ...good.settings, OLLAMA_CONTEXT_LENGTH: '8192' } }, { worker: 'qwen2.5-coder:1.5b' }).find((s) => s.id === 'OLLAMA_CONTEXT_LENGTH').ok)
  const linux = plan({ ...good, settings: {} }, { worker: 'qwen2.5-coder:1.5b', platform: 'linux' })
  ok('off macOS, settings are printed, not applied', linux.filter((s) => s.id.startsWith('OLLAMA_')).every((s) => s.auto === null))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
