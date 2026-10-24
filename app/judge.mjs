#!/usr/bin/env node
/**
 * Blind pairwise comparison of two documents produced by a run.
 *
 *   node judge.mjs [runId]
 *
 * The two documents are presented as X and Y in a RANDOMISED order, with no
 * indication of which arm produced which, so the judge cannot favour the
 * treatment. It scores both against a rubric and picks a winner; we map the
 * labels back afterwards. Results are written into run.json as `judgement`.
 */
import { execFile } from 'node:child_process'
import { STATE, ENV_FILE } from './lib/state.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveSecrets, parseEnvFile } from './secrets.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const RESULTS = path.join(STATE, 'results')

const RUBRIC = [
  ['coverage', 'Breadth of optimization levers. Does it map the whole space, or only a favourite few?'],
  ['specificity', 'Concrete techniques, settings and numbers rather than category names and generalities.'],
  ['accuracy_honesty', 'Does it separate levers that are free of accuracy risk from those that trade quality for cost, and state each risk honestly rather than selling everything as free?'],
  ['measurability', 'Does it say how each lever would be measured, so a claim could be checked?'],
  ['prioritisation', 'Is there a defensible sequence — what to do first and why — rather than an undifferentiated list?'],
  ['usability', 'Could an engineering lead act on this on Monday and defend the choice?'],
]

export function judgePrompt(a, b, cfg = {}) {
  const rubric = cfg.rubric ?? RUBRIC
  const brief = cfg.brief ?? `"Create an AI optimization strategy document that provides all potential optimization aspects and chance to see wins without compromise on accuracy." The reader is an engineering lead whose agent spend is growing and who must choose what to do first and defend that choice.`
  return `You are grading two independently written documents against the same brief.

THE BRIEF THE AUTHORS WERE GIVEN:
${brief}

Grade each document 1-10 on each criterion. Be a hard marker: 5 is competent,
8 is genuinely good, 10 is exceptional. Length is not quality — a long document
that repeats itself scores worse than a short one that is dense and specific.
Penalise confident claims with no stated basis. Penalise treating every lever as
free of accuracy risk, since that is the specific thing the brief asks about.

CRITERIA:
${rubric.map(([k, d]) => `- ${k}: ${d}`).join('\n')}

=========== DOCUMENT X ===========
${a}

=========== DOCUMENT Y ===========
${b}
=========== END ===========

Reply with ONLY this JSON, no prose:
{"X":{${rubric.map(([k]) => `"${k}":<1-10>`).join(',')}},
 "Y":{${rubric.map(([k]) => `"${k}":<1-10>`).join(',')}},
 "winner":"X"|"Y"|"tie",
 "margin":"clear"|"slight"|"none",
 "why":"<two sentences citing something specific from each document>",
 "X_strongest":"<one phrase>","X_weakest":"<one phrase>",
 "Y_strongest":"<one phrase>","Y_weakest":"<one phrase>"}`
}

function claude(prompt, model = 'opus') {
  const env = { ...process.env }
  delete env.CLAUDE_CODE_OAUTH_TOKEN
  return new Promise((res) => {
    const p = execFile('claude',
      ['-p', '--model', model, '--output-format', 'json', '--strict-mcp-config',
       '--no-session-persistence', '--max-budget-usd', '1.00'],
      { timeout: 300000, maxBuffer: 32 * 1024 * 1024, env },
      (err, stdout, stderr) => {
        if (err && !stdout) return res({ error: `${err.message.slice(0, 120)} ${String(stderr).slice(0, 200)}` })
        try {
          const j = JSON.parse(stdout)
          const m = /\{[\s\S]*\}/.exec(String(j.result ?? ''))
          res(m ? { verdict: JSON.parse(m[0]), cost: j.total_cost_usd } : { error: 'no JSON in reply', raw: String(j.result).slice(0, 300) })
        } catch (e) { res({ error: 'unparsable: ' + String(e.message).slice(0, 120) }) }
      })
    p.stdin.end(prompt)
  })
}

export async function judgeRun(runId) {
  const dir = path.join(RESULTS, runId)
  const run = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'))
  const docs = run.arms.map((a) => ({
    arm: a.arm,
    text: a.document ?? (fs.existsSync(path.join(dir, a.arm, 'STRATEGY.md'))
      ? fs.readFileSync(path.join(dir, a.arm, 'STRATEGY.md'), 'utf8') : ''),
  }))
  if (docs.some((d) => !d.text)) {
    return { error: `missing document for: ${docs.filter((d) => !d.text).map((d) => d.arm).join(', ')}` }
  }

  // randomise which arm is shown as X
  const flip = Math.random() < 0.5
  const [first, second] = flip ? [docs[1], docs[0]] : [docs[0], docs[1]]
  let cfg = {}
  try {
    const t = JSON.parse(fs.readFileSync(path.join(ROOT, 'tasks', run.task ?? '', 'task.json'), 'utf8'))
    if (t.judge) cfg = { brief: t.judge.brief, rubric: t.judge.rubric }
  } catch {}
  const res = await claude(judgePrompt(first.text, second.text, cfg))
  if (res.error) return { error: res.error }

  const v = res.verdict
  const label = { X: first.arm, Y: second.arm }
  const scores = {}
  for (const side of ['X', 'Y']) scores[label[side]] = v[side]
  const totals = Object.fromEntries(Object.entries(scores)
    .map(([arm, s]) => [arm, Object.values(s ?? {}).reduce((a, b) => a + (Number(b) || 0), 0)]))
  return {
    scores, totals,
    winner: v.winner === 'tie' ? 'tie' : label[v.winner],
    margin: v.margin, why: v.why,
    notes: Object.fromEntries(['X', 'Y'].flatMap((s) =>
      [[`${label[s]}_strongest`, v[`${s}_strongest`]], [`${label[s]}_weakest`, v[`${s}_weakest`]]])),
    presentedFirst: first.arm, cost: res.cost,
    rubric: (cfg.rubric ?? RUBRIC).map(([k]) => k),
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  resolveSecrets(['ANTHROPIC_API_KEY'])
  for (const [k, v] of Object.entries(parseEnvFile(ENV_FILE)))
    if (!process.env[k]) process.env[k] = v
  const runs = fs.readdirSync(RESULTS).filter((d) => fs.existsSync(path.join(RESULTS, d, 'run.json'))).sort()
  const id = process.argv[2] ?? runs[runs.length - 1]
  console.log(`judging ${id}…`)
  const out = await judgeRun(id)
  if (out.error) { console.error('  ' + out.error); process.exit(1) }
  const file = path.join(RESULTS, id, 'run.json')
  const run = JSON.parse(fs.readFileSync(file, 'utf8'))
  run.judgement = out
  fs.writeFileSync(file, JSON.stringify(run, null, 2))
  console.log(`  winner: ${out.winner} (${out.margin})`)
  for (const [arm, t] of Object.entries(out.totals)) console.log(`    ${arm.padEnd(14)} ${t}/60`)
  console.log(`  ${out.why}`)
  console.log(`  written to results/${id}/run.json`)
}
