/**
 * The models catalog: every model opt can put behind the router, by provider.
 *
 *   anthropic     the remote models the router knows a price and a request shape for (config/ult.default.json)
 *   ollama        what the local Ollama has pulled, read live: GET /api/tags, /api/ps, POST /api/show
 *   huggingface   models in the local Hugging Face cache, listed only — serving them is not wired yet
 *
 * A local model is free per token; what it costs is quality and speed, which the router measures
 * per request (opt claude -p, audit). Nothing here downloads or loads a model.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const OLLAMA_URL = (process.env.OLLAMA_HOST ? (/^https?:/.test(process.env.OLLAMA_HOST) ? process.env.OLLAMA_HOST : `http://${process.env.OLLAMA_HOST}`) : 'http://127.0.0.1:11434').replace(/\/+$/, '')

function ultDefaults() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'ult.default.json'), 'utf8')) } catch { return {} }
}

const LABEL = (id) => id.replace(/^claude-/, 'Claude ').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-(\d+)$/, ' $1').replace(/\b[a-z]/g, (c) => c.toUpperCase())

/** Remote models: priced and shaped by the router's own config. */
export function anthropicModels(ult = ultDefaults()) {
  const prices = ult.prices ?? {}, shapes = ult.models ?? {}
  const routedTo = new Set(Object.values(ult.policy?.routes ?? {}).filter((t) => t.startsWith('remote:')).map((t) => t.slice(7)))
  return Object.entries(prices).filter(([id]) => id.startsWith('claude-')).map(([id, [inp, out]]) => ({
    id, label: LABEL(id), provider: 'anthropic', where: 'remote', priceIn: inp, priceOut: out,
    maxOutput: shapes[id]?.maxOutput ?? null, thinking: shapes[id]?.thinking ?? null,
    roles: routedTo.has(id) ? ['router target (non-coding)'] : [],
  }))
}

async function get(url, init = {}, ms = 2500) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) })
  if (!r.ok) throw new Error(`${url} → ${r.status}`)
  return r.json()
}

/** What a local model is good for in the router, from what Ollama says it can do. */
export function rolesFor(m) {
  const caps = m.capabilities ?? [], billions = m.paramsB ?? 0, roles = []
  if (caps.includes('embedding') || /embed/i.test(m.family ?? m.id)) return ['embeddings only']
  if (billions && billions <= 4) roles.push('background / utility calls')
  if (/coder|code/i.test(m.id)) roles.push('coding (small edits)')
  if (caps.includes('tools')) roles.push('can take tool calls')
  if (billions >= 30) roles.push('heavy: slow on a laptop')
  return roles
}
const paramsB = (s) => { const m = /([\d.]+)\s*([BM])/i.exec(String(s ?? '')); return m ? Number(m[1]) / (m[2].toUpperCase() === 'M' ? 1000 : 1) : null }

/** The local Ollama, read live. `up: false` with the reason when it is not running. */
export async function ollamaModels({ url = OLLAMA_URL, routerModel = ultDefaults().local?.model } = {}) {
  let tags, ps = { models: [] }, version = null
  try {
    ;[tags, ps, version] = await Promise.all([get(`${url}/api/tags`), get(`${url}/api/ps`).catch(() => ({ models: [] })), get(`${url}/api/version`).then((v) => v.version).catch(() => null)])
  } catch (e) {
    return { up: false, url, error: /fetch failed|ECONNREFUSED|timeout/i.test(String(e?.message ?? e)) ? 'Ollama is not running' : String(e?.message ?? e), models: [] }
  }
  const loaded = new Map((ps.models ?? []).map((m) => [m.name, m]))
  const models = await Promise.all((tags.models ?? []).map(async (m) => {
    // /api/show adds the context length and the capabilities; a model it cannot describe is still listed
    let show = null
    try { show = await get(`${url}/api/show`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: m.name }) }, 4000) } catch {}
    const info = show?.model_info ?? {}
    const ctxKey = Object.keys(info).find((k) => k.endsWith('.context_length'))
    const d = m.details ?? {}
    const row = {
      id: m.name, label: m.name, provider: 'ollama', where: 'local', priceIn: 0, priceOut: 0,
      family: d.family ?? null, params: d.parameter_size ?? null, paramsB: paramsB(d.parameter_size), quant: d.quantization_level ?? null,
      format: d.format ?? null, sizeBytes: m.size ?? null, modifiedAt: m.modified_at ?? null,
      context: ctxKey ? info[ctxKey] : null, capabilities: show?.capabilities ?? [],
      loaded: loaded.has(m.name), vramBytes: loaded.get(m.name)?.size_vram ?? null,
      router: m.name === routerModel,
    }
    row.roles = rolesFor(row)
    return row
  }))
  models.sort((a, b) => (b.router - a.router) || (a.paramsB ?? 0) - (b.paramsB ?? 0))
  return { up: true, url, version, models }
}

/** Models already in the Hugging Face cache. Listing only, no network. */
export function huggingfaceModels() {
  const hub = process.env.HF_HUB_CACHE || path.join(process.env.HF_HOME || path.join(os.homedir(), '.cache', 'huggingface'), 'hub')
  let dirs = []
  try { dirs = fs.readdirSync(hub).filter((d) => d.startsWith('models--')) } catch { return { up: false, dir: hub, error: 'no Hugging Face cache on this machine', models: [] } }
  const models = dirs.map((d) => {
    let size = 0
    try { for (const b of fs.readdirSync(path.join(hub, d, 'blobs'))) size += fs.statSync(path.join(hub, d, 'blobs', b)).size } catch {}
    const id = d.slice(8).replace('--', '/')
    return { id, label: id, provider: 'huggingface', where: 'local', priceIn: 0, priceOut: 0, sizeBytes: size, roles: [], serving: false }
  })
  return { up: true, dir: hub, models }
}

let CACHE = null
/** Every provider, cached 30 s (the hub polls; /api/show is one request per model). */
export async function modelsCatalog({ fresh = false } = {}) {
  if (!fresh && CACHE && Date.now() - CACHE.at < 30e3) return CACHE.payload
  const ult = ultDefaults()
  const ollama = await ollamaModels({ routerModel: ult.local?.model })
  const hf = huggingfaceModels()
  const payload = {
    at: Date.now(),
    router: { localModel: ult.local?.model ?? null, localEnabled: !!ult.local?.enabled, routes: ult.policy?.routes ?? {} },
    providers: [
      { id: 'anthropic', label: 'Anthropic', kind: 'remote', status: 'ready', note: 'priced and adapted by the router', models: anthropicModels(ult) },
      { id: 'ollama', label: 'Ollama', kind: 'local', status: ollama.up ? 'ready' : 'down', note: ollama.up ? `${ollama.url} · v${ollama.version ?? '?'}` : `${ollama.error} — ollama serve`, models: ollama.models },
      { id: 'huggingface', label: 'Hugging Face', kind: 'local', status: hf.up ? 'listed' : 'none', note: hf.up ? `${hf.dir} · listing only; serving comes later` : 'serving comes later', models: hf.models },
    ],
  }
  CACHE = { at: Date.now(), payload }
  return payload
}

const gb = (b) => (b == null ? '' : b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : Math.round(b / 1e6) + ' MB')

/** `opt models` */
export async function cmdModels(argv = []) {
  const C = { b: '\x1b[1m', d: '\x1b[2m', g: '\x1b[32m', y: '\x1b[33m', x: '\x1b[0m' }
  const cat = await modelsCatalog({ fresh: true })
  if (argv.includes('--json')) { console.log(JSON.stringify(cat, null, 2)); return 0 }
  for (const p of cat.providers) {
    console.log(`\n  ${C.b}${p.label}${C.x}  ${p.status === 'ready' ? C.g : C.y}${p.status}${C.x}  ${C.d}${p.note}${C.x}`)
    if (!p.models.length) { console.log(`    ${C.d}none${C.x}`); continue }
    for (const m of p.models) {
      const price = m.where === 'remote' ? `$${m.priceIn}/$${m.priceOut} per M` : 'free per token'
      const facts = [m.params, m.quant, gb(m.sizeBytes), m.context ? `${Math.round(m.context / 1024)}k ctx` : null, m.loaded ? 'loaded' : null].filter(Boolean).join(' · ')
      console.log(`    ${m.router ? C.g + '▸ ' : '  '}${m.id.padEnd(30)}${C.x}${price.padEnd(22)}${C.d}${facts}${m.roles?.length ? '  ' + m.roles.join(', ') : ''}${m.router ? '  (router local target)' : ''}${C.x}`)
    }
  }
  console.log(`\n  ${C.d}use one as the router's local target: opt claude -p "…" --local-model <tag>${C.x}\n`)
  return 0
}
