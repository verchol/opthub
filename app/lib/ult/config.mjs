/**
 * ULT configuration: shipped defaults, then user, project, --config file, then flags.
 * Later layers win; objects merge key by key, arrays and scalars replace.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { STATE, PACKAGE_ROOT } from '../state.mjs'

export const DEFAULT_CONFIG_PATH = path.join(PACKAGE_ROOT, 'config', 'ult.default.json')

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)

export function merge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over
  const out = { ...base }
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v
  return out
}

function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8')
  try { return JSON.parse(raw) } catch (e) { throw new Error(`${file}: invalid JSON (${e.message})`) }
}

/** Every layer that exists, in order, with where it came from. */
export function configLayers({ projectDir, configFile } = {}) {
  const layers = [{ source: DEFAULT_CONFIG_PATH, data: readJson(DEFAULT_CONFIG_PATH) }]
  const user = path.join(STATE, 'ult.json')
  if (fs.existsSync(user)) layers.push({ source: user, data: readJson(user) })
  if (projectDir) {
    const proj = path.join(projectDir, '.opthub', 'ult.json')
    if (fs.existsSync(proj)) layers.push({ source: proj, data: readJson(proj) })
  }
  if (configFile) layers.push({ source: configFile, data: readJson(configFile) })
  return layers
}

/** Flags → a config overlay. Unknown flags are the caller's business. */
export function flagsToOverlay(f = {}) {
  const o = {}
  const set = (p, v) => {
    if (v === undefined) return
    const keys = p.split('.'); let cur = o
    for (const k of keys.slice(0, -1)) cur = cur[k] ??= {}
    cur[keys.at(-1)] = v
  }
  set('mode', f.mode)
  set('listen.port', f.port)
  set('remote.defaultModel', f.model)
  if (f.localModel) { set('local.model', f.localModel); set('local.enabled', true) }
  if (f.noLocal) set('local.enabled', false)
  set('local.baseUrl', f.ollamaUrl)
  if (f.ollamaUrl) set('local.dockerBaseUrl', f.ollamaUrl)
  if (f.jev !== undefined) set('classifier.jev.enabled', f.jev)
  if (f.pin) set('policy.pin', f.pin)
  if (f.auditPrompts) set('audit.prompts', true)
  if (f.routes?.length) {
    const routes = {}
    for (const r of f.routes) {
      const i = r.indexOf('=')
      if (i < 1) throw new Error(`--route expects <class>=<target>, got "${r}"`)
      routes[r.slice(0, i)] = r.slice(i + 1)
    }
    set('policy.routes', routes)
  }
  return o
}

export function validate(cfg) {
  const errs = []
  if (!['shadow', 'route'].includes(cfg.mode)) errs.push(`mode must be shadow or route, got ${cfg.mode}`)
  if (cfg.policy?.pin && cfg.policy.pin !== 'frontier') errs.push(`policy.pin supports only "frontier"`)
  for (const [cls, target] of Object.entries(cfg.policy?.routes ?? {})) {
    if (!/^(keep|local|local:.+|remote:.+)$/.test(target)) errs.push(`route ${cls}: target must be keep, local, local:<model> or remote:<model>, got "${target}"`)
  }
  if (!Number.isInteger(cfg.listen?.port) || cfg.listen.port < 0 || cfg.listen.port > 65535) errs.push(`listen.port invalid: ${cfg.listen?.port}`)
  if (errs.length) throw new Error('ULT config:\n  ' + errs.join('\n  '))
  return cfg
}

export function loadConfig({ projectDir, configFile, flags } = {}) {
  const layers = configLayers({ projectDir, configFile })
  let cfg = {}
  for (const l of layers) cfg = merge(cfg, l.data)
  const overlay = flagsToOverlay(flags)
  cfg = merge(cfg, overlay)   // routes merge key by key, so --route replaces one route, not the table
  validate(cfg)
  return { config: cfg, sources: layers.map(l => l.source), hash: configHash(cfg) }
}

export function configHash(cfg) {
  return crypto.createHash('sha256').update(canonical(cfg)).digest('hex').slice(0, 16)
}

/** Stable JSON: keys sorted at every level, so equal configs hash equal. */
export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'
  if (isObj(v)) return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'
  return JSON.stringify(v ?? null)
}
