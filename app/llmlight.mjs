#!/usr/bin/env node
/**
 * LLM Light profiles from the command line.
 *
 *   node llmlight.mjs list
 *   node llmlight.mjs show <profile> [--target=local|sandbox|mock] [--project=<dir>]
 *   node llmlight.mjs render <profile> --out=<dir> [--target=…] [--project=<dir>]
 *   node llmlight.mjs apply <profile> --project=<dir> [--target=local] [--start]
 *   node llmlight.mjs revert --project=<dir>
 *   node llmlight.mjs audit --project=<dir>
 *
 * apply lays the rendered files in <project>/.opthub/llmlight/, and points Claude Code in that
 * project at the proxy through <project>/.claude/settings.local.json (env only; the previous
 * file is kept as settings.local.json.llmlight-backup). --start also launches LiteLLM on :4000,
 * which needs `litellm` on PATH and, for target local, ANTHROPIC_API_KEY in the environment.
 * revert restores the backup. Nothing outside the project directory is touched.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { STATE } from './lib/state.mjs'
import { loadProfiles, profileById, renderFiles, classesFor, readAudit, SANDBOX_MODELS as MODELS } from './lib/llmlight.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const [cmd, id] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const opt = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d }
const flag = (k) => process.argv.includes(`--${k}`)
const triage = () => { try { return JSON.parse(fs.readFileSync(path.join(STATE, 'results', 'triage.json'), 'utf8')) } catch { return null } }
const need = (p) => { if (!p) { console.error(`no such profile "${id}". Try: node llmlight.mjs list`); process.exit(2) } return p }
const projectDir = () => { const p = opt('project'); if (!p) { console.error('--project=<dir> is required'); process.exit(2) } return path.resolve(p.replace(/^~/, process.env.HOME)) }

function build(profile) {
  const project = opt('project') ? projectDir() : null
  const classes = project ? classesFor(project, triage()) : {}
  return renderFiles(ROOT, profile, { target: opt('target', 'local'), MODELS, classes,
    auditPath: project ? path.join(project, '.opthub', 'llmlight', 'audit.jsonl') : null })
}

if (cmd === 'list' || !cmd) {
  const P = loadProfiles(ROOT)
  for (const p of P.profiles) console.log(`${p.id.padEnd(20)} ${p.title.padEnd(26)} ${p.for}`)
} else if (cmd === 'show') {
  const r = build(need(profileById(ROOT, id)))
  console.log(`${r.profile} · target ${r.target}\n`); for (const l of r.summary) console.log('  ' + l)
  console.log('\nClaude Code env:'); for (const [k, v] of Object.entries(r.env)) console.log(`  ${k}=${v}`)
  if (r.flags) console.log(`Claude Code flags: ${r.flags}`)
  console.log('\n' + r.litellmYaml)
} else if (cmd === 'render') {
  const out = opt('out'); if (!out) { console.error('--out=<dir> is required'); process.exit(2) }
  const r = build(need(profileById(ROOT, id)))
  fs.mkdirSync(out, { recursive: true })
  for (const [n, c] of Object.entries(r.files)) fs.writeFileSync(path.join(out, n), c)
  fs.writeFileSync(path.join(out, 'claude-env.json'), JSON.stringify(r.env, null, 2))
  console.log(`wrote ${Object.keys(r.files).length + 1} files to ${out}`)
} else if (cmd === 'apply') {
  const profile = need(profileById(ROOT, id)), project = projectDir(), r = build(profile)
  const dir = path.join(project, '.opthub', 'llmlight')
  fs.mkdirSync(dir, { recursive: true })
  for (const [n, c] of Object.entries(r.files)) fs.writeFileSync(path.join(dir, n), c)
  const sfile = path.join(project, '.claude', 'settings.local.json')
  fs.mkdirSync(path.dirname(sfile), { recursive: true })
  let cur = {}; if (fs.existsSync(sfile)) {
    cur = JSON.parse(fs.readFileSync(sfile, 'utf8'))
    if (!fs.existsSync(sfile + '.llmlight-backup')) fs.copyFileSync(sfile, sfile + '.llmlight-backup')
  } else fs.writeFileSync(sfile + '.llmlight-backup', '__none__')
  const next = { ...cur, env: { ...(cur.env ?? {}), ...r.env, OPTHUB_LLMLIGHT_PROFILE: profile.id } }
  fs.writeFileSync(sfile, JSON.stringify(next, null, 2) + '\n')
  console.log(`applied "${profile.id}" (target ${r.target}) to ${project}`)
  for (const l of r.summary) console.log('  ' + l)
  console.log(`\n  files:   ${dir}\n  claude:  ${sfile} (env only; backup kept)`)
  if (r.flags) console.log(`  flags:   run claude with ${r.flags}`)
  const run = `cd ${dir} && litellm --config litellm.yaml --port 4000`
  if (flag('start')) {
    const child = spawn('sh', ['-c', `${run} > ${path.join(dir, 'proxy.log')} 2>&1`], { detached: true, stdio: 'ignore' })
    child.unref(); console.log(`  proxy:   started (pid ${child.pid}), log ${path.join(dir, 'proxy.log')}`)
  } else console.log(`  proxy:   start it with\n           ${run}`)
  console.log('\n  New Claude Code sessions in this project go through the profile. Undo: node llmlight.mjs revert --project=' + project)
} else if (cmd === 'revert') {
  const project = projectDir(), sfile = path.join(project, '.claude', 'settings.local.json'), bak = sfile + '.llmlight-backup'
  if (!fs.existsSync(bak)) { console.log('nothing to revert: no backup'); process.exit(0) }
  const b = fs.readFileSync(bak, 'utf8')
  if (b === '__none__') fs.rmSync(sfile, { force: true }); else fs.writeFileSync(sfile, b)
  fs.rmSync(bak)
  console.log(`reverted ${sfile}. The rendered files in .opthub/llmlight/ are left for reference; stop the proxy if it runs.`)
} else if (cmd === 'audit') {
  const f = path.join(projectDir(), '.opthub', 'llmlight', 'audit.jsonl')
  const a = readAudit(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '')
  console.log(JSON.stringify(a, null, 2))
} else {
  console.log('usage: node llmlight.mjs list | show <profile> | render <profile> --out=<dir> | apply <profile> --project=<dir> [--start] | revert --project=<dir> | audit --project=<dir>')
}
