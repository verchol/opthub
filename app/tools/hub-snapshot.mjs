#!/usr/bin/env node
/**
 * Freeze the hub's API surface into static JSON, for a read-only deploy.
 *
 *   node tools/hub-snapshot.mjs [outDir]
 *
 * The deployed hub has no transcript store and no E2B credentials, so it cannot
 * answer /api/sessions by reading ~/.claude. This writes exactly what those
 * endpoints return today, and hub-demo.mjs serves the files back under the same
 * paths. The page never learns the difference.
 *
 * Absolute home paths are rewritten to `~` on the way out: `cwd` is in every
 * session row and there is no reason for a deploy to carry the operator's
 * directory layout.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { sessionDetail } from '../lib/sessions-index.mjs'
import { collectRuns, runsBySession } from '../lib/hub-runs.mjs'
import { catalogPayload } from '../lib/optimizations.mjs'
import { atlasPotential as potential } from '../lib/atlas.mjs'
import { tagsFor } from '../lib/tags.mjs'
import { shanaTova } from '../lib/shana-tova.mjs'
import { watchList } from '../lib/watch.mjs'
import { STATE } from '../lib/state.mjs'
import { overviewPayload } from '../lib/overview.mjs'
import { modelsCatalog } from '../lib/models.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.resolve(process.argv[2] ?? path.join(ROOT, 'deploy', 'snapshot'))
const HOME = os.homedir()

/** `/Users/someone/x` -> `~/x`, at any depth, in every string in the tree. */
const redact = (v) =>
  typeof v === 'string' ? v.split(HOME).join('~')
  : Array.isArray(v) ? v.map(redact)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x)]))
  : v

const write = (rel, obj) => {
  const abs = path.join(OUT, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, JSON.stringify(redact(obj)))
  return fs.statSync(abs).size
}

fs.rmSync(OUT, { recursive: true, force: true })

// --- the list, exactly as hub.mjs decorates it -----------------------------
const idx = watchList({ limit: 500 })
for (const s of idx.sessions) {
  const p = potential(s)
  s.potential = p; s.potPct = p.hi; s.shanaTova = shanaTova(s); s.tags = tagsFor(s)
  s.pids = []            // a frozen row cannot own a process on the deploy host
}
const bytes = { sessions: write('sessions.json', { ...idx, snapshotAt: new Date().toISOString() }) }

// --- one file per session, for the analytics view --------------------------
let detailBytes = 0, details = 0
for (const s of idx.sessions) {
  const d = sessionDetail(s.id)
  if (!d) continue
  d.potential = potential(d); d.shanaTova = shanaTova(d); d.tags = tagsFor(d)
  detailBytes += write(path.join('session', `${s.id}.json`), d)
  details++
}
bytes.details = detailBytes

// --- catalog, runs, and the per-session run map ----------------------------
bytes.catalog = write('catalog.json', catalogPayload(ROOT))
// the landing page and the models catalog, as they stood when the snapshot was taken
let triage = null
try { triage = JSON.parse(fs.readFileSync(path.join(STATE, 'results', 'triage.json'), 'utf8')) } catch {}
bytes.overview = write('overview.json', await overviewPayload({ sessions: idx.sessions, potentialOf: (s) => s.potential, triage }))
bytes.models = write('models.json', await modelsCatalog({ fresh: true }))
const runs = collectRuns(ROOT), bySession = runsBySession(ROOT)
bytes.runs = write('runs.json', { runs, bySession })
bytes.all = write('optimize-all.json', bySession)

// --- the reports those runs point at --------------------------------------
let reports = 0, reportBytes = 0
for (const r of runs) {
  const src = path.join(STATE, 'results', r.run, 'report.html')
  if (!fs.existsSync(src)) continue
  const dst = path.join(OUT, 'results', r.run, 'report.html')
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.writeFileSync(dst, fs.readFileSync(src, 'utf8').split(HOME).join('~'))
  reports++; reportBytes += fs.statSync(dst).size
}

const kb = (n) => (n / 1024).toFixed(0) + ' KB'
console.log(`snapshot -> ${OUT}`)
console.log(`  sessions.json   ${idx.sessions.length} sessions, ${kb(bytes.sessions)}`)
console.log(`  session/*.json  ${details} files, ${kb(bytes.details)}`)
console.log(`  catalog.json    ${kb(bytes.catalog)}  ·  runs.json ${runs.length} runs, ${kb(bytes.runs)}`)
console.log(`  results/        ${reports} report.html, ${kb(reportBytes)}`)
console.log('  home paths rewritten to ~')
