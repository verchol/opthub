/**
 * export.mjs — turn a session into something a sandbox can run.
 *
 * A session in `opt session` is a record of something that already happened.
 * Exporting it produces a bundle that can happen again, somewhere clean:
 *
 *   exports/<ref>/
 *     manifest.json     what this session was, and how faithful the export is
 *     PROMPT.md         what the agent is asked to do
 *     SPEC.md           the task spec, for an arm that had one
 *     workspace/        files the session produced
 *     run.sh            the exact claude invocation
 *
 * How faithful the bundle is depends on what kind of session it was, and the
 * manifest says so rather than letting the caller assume:
 *
 *   e2b arm   `replay` — the inputs are all still on disk (task spec, prompt,
 *             flags, scenario setup), so a re-run is the same experiment.
 *   local     `restart` — a transcript proves what the user typed and what the
 *             session wrote through Write/Edit. It cannot prove what the session
 *             read, or what Bash wrote. The prompt survives; the machine does not.
 */
import fs from 'node:fs'
import { STATE } from './lib/state.mjs'
import path from 'node:path'
import { collectSessions, findSession } from './sessions.mjs'

const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', c: '\x1b[36m', m: '\x1b[35m',
            d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }

const readIf = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } }

/**
 * Rebuild an arm's inputs from the task and scenario it came from.
 * The results directory keeps outputs, not inputs — but the inputs are
 * deterministic given the task name, the scenario file and the flags, all of
 * which the run recorded.
 */
function armInputs(ROOT, session) {
  const taskDir = path.join(ROOT, 'tasks', session.task)
  const spec = readIf(path.join(taskDir, 'SPEC.md'))
  const taskCfg = (() => { try { return JSON.parse(readIf(path.join(taskDir, 'task.json'))) } catch { return {} } })()
  const base = (readIf(path.join(ROOT, 'lib', 'BASE_PROMPT.md')) ?? '')
    .replace(/\{\{FILE\}\}/g, taskCfg.file ?? 'solution.py')

  let strategy = null
  if (!session.isControl) {
    const raw = readIf(path.join(ROOT, 'scenarios', `${session.scenario}.md`))
    if (raw) {
      const parts = raw.split('---')
      strategy = parts.length > 2 ? parts.slice(2).join('---').trim() : raw.trim()
    }
  }
  const prompt = strategy
    ? `${base}\n\n---\n\n# Optimization strategy — ${session.scenario}\n\n${strategy}\n`
    : base

  // The levers list records the flags the arm actually ran with.
  const flagLever = (session.levers ?? []).find((l) => l.startsWith('flags:'))
  const flags = flagLever && !/none beyond/.test(flagLever)
    ? flagLever.replace(/^flags:\s*/, '').trim()
    : ''

  return { spec, prompt, taskCfg, flags, strategy }
}

/** A local session's inputs are its prompts and whatever it wrote. */
function localInputs(session) {
  const prompts = session.prompts?.length
    ? session.prompts
    : [{ at: session.startedMs, text: session.intent }]
  const head = prompts[0]?.text ?? session.intent ?? ''
  const rest = prompts.slice(1)

  const prompt = [
    `# ${head}`,
    '',
    rest.length
      ? ['The session this was exported from continued with these turns. They are',
         'here as context, not as a script — do the whole job, in order.',
         '',
         ...rest.map((p, i) => `${i + 2}. ${p.text}`)].join('\n')
      : '',
  ].filter(Boolean).join('\n')

  const files = []
  for (const a of session.artifacts ?? []) {
    const data = a.path ? readIf(a.path) : null
    if (data !== null) files.push({ name: a.name, data })
  }
  const claudeMd = session.cwd ? readIf(path.join(session.cwd, 'CLAUDE.md')) : null
  return { prompt, files, claudeMd, promptCount: prompts.length }
}

/**
 * Write the bundle. Returns its path and the manifest, so a caller can boot a
 * sandbox from it without re-reading anything.
 */
export function exportSession(ROOT, session, { outDir = null, task = null } = {}) {
  const dir = outDir ?? path.join(STATE, 'exports', session.ref.replace(/[^\w.·-]/g, '_'))
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, 'workspace'), { recursive: true })

  const manifest = {
    exportedAt: new Date().toISOString(),
    fidelity: session.kind === 'e2b' ? 'replay' : 'restart',
    fidelityNote: session.kind === 'e2b'
      ? 'every input is still on disk — task spec, prompt, flags, scenario setup'
      : 'the prompts and the files this session wrote through Write/Edit; what it read, and anything Bash wrote, is not recoverable from a transcript',
    session: {
      ref: session.ref, kind: session.kind, runId: session.runId, arm: session.arm,
      where: session.where, task: session.task, scenario: session.scenario,
      intent: session.intent, model: session.model, state: session.state,
      startedAt: session.startedAt, cwd: session.cwd ?? null,
    },
    measured: {
      turns: session.turns, wallSec: session.wallSec, cost: session.cost,
      tokens: session.tokens, grade: session.grade, linesOfCode: session.linesOfCode,
    },
    tools: [...(session.toolCounts instanceof Map ? session.toolCounts.entries()
              : Object.entries(session.toolCounts ?? {}))].map(([name, n]) => ({ name, n })),
    levers: session.levers ?? [],
  }

  let flags = `--model ${session.model?.includes('sonnet') ? 'sonnet' : 'opus'}`
  let promptText = ''

  // A local session seeded from one of the rig's tasks keeps the task's spec and
  // its hidden suite, so the replay can be graded rather than merely admired.
  if (task) {
    const taskDir = path.join(ROOT, 'tasks', task)
    const spec = readIf(path.join(taskDir, 'SPEC.md'))
    const taskCfg = (() => { try { return JSON.parse(readIf(path.join(taskDir, 'task.json'))) } catch { return {} } })()
    const base = (readIf(path.join(ROOT, 'lib', 'BASE_PROMPT.md')) ?? '')
      .replace(/\{\{FILE\}\}/g, taskCfg.file ?? 'solution.py')
    promptText = base
    if (spec) fs.writeFileSync(path.join(dir, 'SPEC.md'), spec)
    manifest.task = { name: task, file: taskCfg.file ?? null, module: taskCfg.module ?? null,
                      kind: taskCfg.kind ?? 'code', title: taskCfg.title ?? task }
    manifest.gradeable = !!spec && taskCfg.kind !== 'document'
    manifest.fidelity = 'task-replay'
    manifest.fidelityNote = 'the same task spec the origin session was given, so both sides can be graded by the same hidden suite'
  } else if (session.kind === 'e2b') {
    const { spec, prompt, taskCfg, flags: armFlags, strategy } = armInputs(ROOT, session)
    promptText = prompt
    if (spec) fs.writeFileSync(path.join(dir, 'SPEC.md'), spec)
    if (armFlags) flags += ' ' + armFlags
    manifest.task = { name: session.task, file: taskCfg.file ?? null, module: taskCfg.module ?? null,
                      kind: taskCfg.kind ?? 'code', title: taskCfg.title ?? session.taskTitle }
    manifest.strategy = strategy ? { words: strategy.split(/\s+/).filter(Boolean).length } : null
    manifest.gradeable = !!spec && taskCfg.kind !== 'document'
  } else {
    const { prompt, files, claudeMd, promptCount } = localInputs(session)
    promptText = prompt
    for (const f of files) fs.writeFileSync(path.join(dir, 'workspace', f.name), f.data)
    if (claudeMd) fs.writeFileSync(path.join(dir, 'workspace', 'CLAUDE.md'), claudeMd)
    manifest.promptTurns = promptCount
    manifest.carried = { files: files.map((f) => f.name), claudeMd: !!claudeMd }
    manifest.gradeable = false
  }

  fs.writeFileSync(path.join(dir, 'PROMPT.md'), promptText)
  manifest.promptWords = promptText.split(/\s+/).filter(Boolean).length
  manifest.flags = flags

  fs.writeFileSync(path.join(dir, 'run.sh'),
    ['#!/usr/bin/env sh',
     '# What the sandbox runs. Regenerate by re-exporting; editing this alone',
     '# leaves manifest.json describing something that no longer happens.',
     'set -e',
     'cd "$(dirname "$0")/workspace"',
     `cat ../PROMPT.md | claude -p --output-format stream-json --verbose \\`,
     `  --dangerously-skip-permissions --no-session-persistence ${flags}`,
     ''].join('\n'))
  fs.chmodSync(path.join(dir, 'run.sh'), 0o755)
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return { dir, manifest }
}

/** Everything the bundle needs written into a sandbox, as e2b file entries. */
export function bundleFiles(dir, WORK = '/home/user/work') {
  const out = []
  const prompt = readIf(path.join(dir, 'PROMPT.md'))
  if (prompt != null) out.push({ path: `${WORK}/PROMPT.md`, data: prompt })
  const spec = readIf(path.join(dir, 'SPEC.md'))
  if (spec != null) out.push({ path: `${WORK}/SPEC.md`, data: spec })
  const ws = path.join(dir, 'workspace')
  if (fs.existsSync(ws)) {
    for (const f of fs.readdirSync(ws)) {
      const data = readIf(path.join(ws, f))
      if (data != null) out.push({ path: `${WORK}/${f}`, data })
    }
  }
  return out
}

export function renderExport({ dir, manifest }, ROOT) {
  const rel = path.relative(ROOT, dir)
  const L = ['']
  L.push(`  ${C.b}${manifest.session.ref}${C.x} ${C.d}exported${C.x}  ${C.c}${rel}${C.x}`)
  L.push('')
  L.push(`  ${C.d}fidelity${C.x}     ${manifest.fidelity === 'replay' ? C.g : C.y}${manifest.fidelity}${C.x}  ${C.d}${manifest.fidelityNote}${C.x}`)
  L.push(`  ${C.d}prompt${C.x}       ${manifest.promptWords} words${manifest.promptTurns ? `, ${manifest.promptTurns} turns carried` : ''}`)
  if (manifest.task) L.push(`  ${C.d}task${C.x}         ${manifest.task.name} — ${manifest.task.title ?? ''}`)
  if (manifest.carried?.files?.length)
    L.push(`  ${C.d}workspace${C.x}    ${manifest.carried.files.join(', ')}${manifest.carried.claudeMd ? ' + CLAUDE.md' : ''}`)
  L.push(`  ${C.d}flags${C.x}        ${manifest.flags}`)
  L.push(`  ${C.d}gradeable${C.x}    ${manifest.gradeable ? `${C.g}yes${C.x} ${C.d}— the task's hidden suite still applies${C.x}` : `${C.d}no — nothing to grade against${C.x}`}`)
  L.push('')
  L.push(`  ${C.d}opt session export ${manifest.session.ref} --run    boot a sandbox from it${C.x}`)
  L.push(`  ${C.d}opt tune ${rel}${' '.repeat(Math.max(1, 24 - rel.length))}search for a better configuration${C.x}`)
  L.push('')
  return L.join('\n')
}

/** Resolve a session by ref across the full history, window be damned. */
export function resolveSession(ROOT, ref) {
  const all = collectSessions(ROOT, { sinceMs: null })
  return findSession(all, ref)
}
