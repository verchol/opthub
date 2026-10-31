#!/usr/bin/env node
/**
 * bulk-read gate — a Claude Code PreToolUse hook (matcher "Read|Bash").
 *
 * Blocks a whole-file read of a large text file and tells the model to ask the cheap worker
 * instead (bulk-read.mjs), so the file never enters the expensive model's context, where it
 * would be written to the cache and re-read on every later request. The pattern is Spotify's
 * `shunt` (docs/optimization-agent.md, "Skill in depth: bulk-read delegation").
 *
 * What passes, on purpose:
 *   - targeted reads (offset or limit set) — the agent already knows the region it wants
 *   - files at or under the threshold, binaries, images, PDFs, notebooks
 *   - a file this session already edited — an edit needs the real text
 *   - a file the worker failed on, and a second whole read of the same file in one session
 *     (BULK_READ_MAX_BLOCKS, default 1): the gate redirects once, it never traps the agent
 *   - shell reads that are not a plain `cat|less|more|nl|bat <file>` (pipes, redirects, head, tail)
 *
 * Exit 2 blocks the call and hands stderr to the model; exit 0 lets it run. Any error in this
 * script exits 0: a broken gate must never block work. Every decision except "small file" is
 * appended to BULK_READ_LOG, so a run can report fire rate, overrides and leaks.
 *
 * Env: BULK_READ_THRESHOLD (lines, default 350) · BULK_READ_MAX_BLOCKS (default 1) ·
 *      BULK_READ_LOG (default ~/.opthub/bulk-read.jsonl) · BULK_READ_STATE (default
 *      ~/.opthub/bulk-read-state.json) · BULK_READ_CMD (how the model should call the worker)
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOME = os.homedir()
const SKIP_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|ipynb|zip|gz|tgz|tar|jar|class|so|dylib|dll|exe|bin|wasm|woff2?|ttf|otf|mp[34]|mov|avi|sqlite|db)$/i
const SHELL_READ = /^\s*(cat|less|more|nl|bat)\s+(.+)$/
const SHELL_META = /[|;&<>`$()]/
const MAX_BYTES = 64 * 1024 * 1024

export const settings = () => ({
  threshold: Number(process.env.BULK_READ_THRESHOLD) || 350,
  maxBlocks: Number(process.env.BULK_READ_MAX_BLOCKS ?? 1),
  log: process.env.BULK_READ_LOG || path.join(HOME, '.opthub', 'bulk-read.jsonl'),
  state: process.env.BULK_READ_STATE || path.join(HOME, '.opthub', 'bulk-read-state.json'),
  cmd: process.env.BULK_READ_CMD || `node ${JSON.stringify(path.join(HERE, 'bulk-read.mjs'))}`,
})

/** Lines in a text file, or null when it is not one we should judge (missing, binary, huge). */
export function countLines(file) {
  let st
  try { st = fs.statSync(file) } catch { return null }
  if (!st.isFile() || SKIP_EXT.test(file) || st.size > MAX_BYTES) return null
  const buf = fs.readFileSync(file)
  if (buf.subarray(0, 8000).includes(0)) return null              // binary
  let n = 0
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++
  return buf.length && buf[buf.length - 1] !== 10 ? n + 1 : n
}

/** Did this session already edit the file? Reads the session transcript the hook is given. */
export function editedInSession(transcript, file) {
  if (!transcript) return false
  let text
  try { text = fs.readFileSync(transcript, 'utf8') } catch { return false }
  for (const line of text.split('\n')) {
    if (!line.includes('tool_use') || !line.includes(path.basename(file))) continue
    let r; try { r = JSON.parse(line) } catch { continue }
    for (const b of r?.message?.content ?? []) {
      if (b?.type !== 'tool_use' || !['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(b.name)) continue
      const p = b.input?.file_path ?? b.input?.notebook_path
      if (p && path.resolve(p) === path.resolve(file)) return true
    }
  }
  return false
}

/** The files a plain shell read names, resolved against the hook's cwd; [] when it is not one. */
export function shellReadTargets(command, cwd) {
  const m = SHELL_READ.exec(String(command ?? ''))
  if (!m || SHELL_META.test(m[2])) return []
  return m[2].split(/\s+/).filter((a) => a && !a.startsWith('-')).map((a) => path.resolve(cwd || '.', a.replace(/^['"]|['"]$/g, '')))
}

function readState(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return { sessions: {}, failed: [] } } }
function writeState(file, s) { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(s)) } catch {} }
function log(file, rec) { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify({ kind: 'gate', ts: new Date().toISOString(), ...rec }) + '\n') } catch {} }

/** The decision for one hook input: { action: 'allow' | 'block', reason, message? }. Pure apart from reading files. */
export function decide(input, cfg = settings(), state = readState(cfg.state)) {
  const tool = input?.tool_name
  const ti = input?.tool_input ?? {}
  let files = []
  if (tool === 'Read') {
    if (ti.offset != null || ti.limit != null) return { action: 'allow', reason: 'targeted' }
    files = ti.file_path ? [path.resolve(input.cwd || '.', ti.file_path)] : []
  } else if (tool === 'Bash') {
    files = shellReadTargets(ti.command, input.cwd)
  }
  if (!files.length) return { action: 'allow', reason: 'not a whole-file read' }
  const sid = input.session_id ?? 'unknown'
  const blocked = state.sessions?.[sid]?.blocked ?? {}
  const big = []
  for (const f of files) {
    const lines = countLines(f)
    if (lines == null || lines <= cfg.threshold) continue
    if ((state.failed ?? []).includes(f)) return { action: 'allow', reason: 'worker failed on this file', file: f, lines }
    if (editedInSession(input.transcript_path, f)) return { action: 'allow', reason: 'edited in this session', file: f, lines }
    if ((blocked[f] ?? 0) >= cfg.maxBlocks) return { action: 'allow', reason: 'override: read again after a block', file: f, lines }
    big.push({ file: f, lines })
  }
  if (!big.length) return { action: 'allow', reason: 'small' }
  const names = big.map((b) => `${b.file} (${b.lines} lines)`).join(', ')
  const paths = big.map((b) => JSON.stringify(b.file)).join(' ')
  return {
    action: 'block', reason: 'large whole-file read', files: big,
    message: `opthub bulk-read: ${names} is over ${cfg.threshold} lines. Do not load it whole into this context.\n`
      + `Ask about it instead; a smaller model reads it and answers with line numbers:\n`
      + `  ${cfg.cmd} --question "<what you need from it>" ${paths}\n`
      + `If you need exact text to edit, read just that range (Read with offset and limit) or grep for it first.`,
  }
}

async function main() {
  const cfg = settings()
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  const input = JSON.parse(raw || '{}')
  const state = readState(cfg.state)
  const d = decide(input, cfg, state)
  if (d.reason !== 'small' && d.reason !== 'not a whole-file read' && d.reason !== 'targeted')
    log(cfg.log, { session: input.session_id, tool: input.tool_name, action: d.action, reason: d.reason,
                   files: d.files ?? (d.file ? [{ file: d.file, lines: d.lines }] : []) })
  if (d.action !== 'block') return 0
  const sid = input.session_id ?? 'unknown'
  state.sessions ??= {}
  const s = (state.sessions[sid] ??= { blocked: {} })
  for (const b of d.files) s.blocked[b.file] = (s.blocked[b.file] ?? 0) + 1
  writeState(cfg.state, state)
  process.stderr.write(d.message + '\n')
  return 2
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), () => process.exit(0))
}
