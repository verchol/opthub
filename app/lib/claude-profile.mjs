/**
 * The Claude Code profile `opt claude -p` runs with, per project, and how it moves.
 *
 * A profile is one rung on a ladder. Each rung is everything the previous one does, plus one lever:
 *
 *   guarded      the router in route mode (side calls to a cheaper or local model), lean working
 *                rules in the system prompt, the project's skills attached
 *   balanced     + --effort medium
 *   aggressive   + --effort low, subagents on Haiku
 *
 * Continuous: every compared run (opt claude -p --compare) is an outcome for the rung it ran on.
 * Two kept comparisons in a row move the project one rung up; a dropped one (dearer, or failing a
 * check the baseline passes) moves it one rung down at once. A run with nothing to compare against
 * moves nothing. The history is kept, so `opt claude profile` can show why the project is where it is.
 *
 *   $OPT_HOME/claude-profile/<project-key>.json
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stateDir } from './state.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const SKILLS_DIR = path.join(ROOT, 'template', 'claude', 'skills')

export const LEAN_RULES = 'Work from the files already in the workspace. Do not restate the task, do not echo file contents back, and do not summarise your plan before acting. Batch independent tool calls in one message. Read only the lines you need. Run the tests once after the change; stop when they pass. Final answer: two sentences at most.'

export const LEVELS = [
  { id: 'guarded', adds: "router routes side calls; lean rules; the project's skills attached", flags: [], env: {} },
  { id: 'balanced', adds: '--effort medium', flags: ['--effort', 'medium'], env: {} },
  { id: 'aggressive', adds: '--effort low; subagents on Haiku', flags: ['--effort', 'low'], env: { CLAUDE_CODE_SUBAGENT_MODEL: 'claude-haiku-4-5' } },
]
export const DEFAULT_LEVEL = 'balanced'
const UP_AFTER = 2

const file = (key) => path.join(stateDir('claude-profile'), `${key}.json`)

export function loadProfile(key) {
  try { return JSON.parse(fs.readFileSync(file(key), 'utf8')) } catch { return { key, level: DEFAULT_LEVEL, streak: 0, history: [] } }
}
export function saveProfile(p) { fs.writeFileSync(file(p.key), JSON.stringify(p, null, 2)) }
export function resetProfile(key) { fs.rmSync(file(key), { force: true }) }

/**
 * Skills the run attaches: the project's .opthub/skills, and any --skill (a directory, or the name of
 * one of opt's own in template/claude/skills, such as opt-lean). opt's own are not attached by default:
 * measured on the fix-invoice example, invoking opt-lean cost a round trip and saved nothing the lean
 * rules in the system prompt do not already give.
 */
export function skillDirs(projectDir, extra = []) {
  const out = []
  const add = (dir) => { try { for (const d of fs.readdirSync(dir)) if (fs.existsSync(path.join(dir, d, 'SKILL.md'))) out.push(path.join(dir, d)) } catch {} }
  add(path.join(projectDir, '.opthub', 'skills'))
  for (const e of extra) {
    if (fs.existsSync(path.join(SKILLS_DIR, e, 'SKILL.md'))) out.push(path.join(SKILLS_DIR, e))
    else if (fs.existsSync(path.join(e, 'SKILL.md'))) out.push(path.resolve(e))
    else add(e)
  }
  // one skill per name; the later one (--skill) wins
  return [...new Map(out.map((d) => [path.basename(d), d])).values()]
}

/** What a rung means for one run: claude flags, environment, the appended rules. Rungs are cumulative. */
export function planFor(levelId) {
  const i = Math.max(0, LEVELS.findIndex((l) => l.id === levelId))
  const flags = [], env = {}
  for (const l of LEVELS.slice(0, i + 1)) {
    for (let j = 0; j < l.flags.length; j += 2) {
      const at = flags.indexOf(l.flags[j])
      if (at >= 0) flags.splice(at, 2)   // a later rung replaces the same flag (effort medium → low)
      flags.push(l.flags[j], l.flags[j + 1])
    }
    Object.assign(env, l.env)
  }
  return { level: LEVELS[i].id, flags, env, rules: LEAN_RULES, router: 'route' }
}

/**
 * Record one outcome and move the rung. `verdict` is keep | drop | inconclusive | null (no baseline).
 * Returns { from, to, why }.
 */
export function recordOutcome(p, { level, verdict, run, cost, baseCost, check }) {
  p.history = [...(p.history ?? []), { at: new Date().toISOString(), run, level, verdict, cost, base_cost: baseCost, check }].slice(-50)
  const from = p.level, i = LEVELS.findIndex((l) => l.id === level)
  let to = from, why = 'no comparison, so no move'
  if (verdict === 'drop') {
    to = LEVELS[Math.max(0, i - 1)].id; p.streak = 0
    why = i > 0 ? `${level} did worse than plain claude -p: back to ${to}` : 'already on the most careful rung'
  } else if (verdict === 'keep') {
    p.streak = (level === from ? p.streak ?? 0 : 0) + 1
    if (p.streak >= UP_AFTER && i < LEVELS.length - 1) { to = LEVELS[i + 1].id; p.streak = 0; why = `${UP_AFTER} kept comparisons on ${level}: up to ${to}` }
    else why = i === LEVELS.length - 1 ? 'kept, on the top rung' : `kept (${p.streak}/${UP_AFTER} toward ${LEVELS[i + 1].id})`
  } else if (verdict === 'inconclusive') why = 'inconclusive, so no move'
  p.level = to
  return { from, to, why }
}
