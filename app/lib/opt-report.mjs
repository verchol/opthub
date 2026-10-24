/**
 * results/<run>/run.json + report.html for a session replay.
 *
 * The report is not a second reporting path: `run.json` is written in exactly
 * the schema `report.mjs` already reads, and the HTML comes out of the same
 * `buildHtml` the `opt` CLI calls. A replay report and a benchmark report are
 * therefore the same document — same radar, same raw-numbers table, same blind
 * rubric card — differing only in what was graded.
 *
 * The one genuine difference is the grading. A benchmark run has a hidden suite
 * and reports N/69. A session replay has no suite, so it is rubric-graded and
 * carries `grade.kind: 'artifacts'`, which is the flag report.mjs reads to swap
 * the correctness row for the blind rubric and the measures table for the
 * delivered-files one.
 */
import fs from 'node:fs'
import path from 'node:path'
import { buildHtml } from '../report.mjs'
import { describeLitellm, describeClaude } from './arm-config.mjs'

const short = (s, n = 200) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

/** One arm of a replay, in run.json's shape. */
function armRecord(r, judgement) {
  const levers = [
    `model ${r.modelLabel ?? r.model}`,
    r.compaction ? 'context auto-compaction on' : 'no compaction',
    r.effort ? `--effort ${r.effort}` : 'default effort',
    ...(r.budgetUsd ? [`budget $${r.budgetUsd}`] : []),
    ...(r.flags ? [r.flags] : []),
    ...(r.appendPrompt ? ['prompt directive appended'] : []),
    ...(describeLitellm(r.litellm) ? [`LiteLLM: ${describeLitellm(r.litellm)}`] : []),
    ...(describeClaude(r.claude) ? [`Claude Code: ${describeClaude(r.claude)}`] : []),
  ]
  return {
    arm: r.armId ?? r.label, label: r.label, model: r.modelLabel ?? r.model, levers,
    // what this arm varies, and the parameter evidence that it varies anything
    tag: r.armTag ?? null,
    diff: (r.armDiff ?? []).map((d) => d.say),
    same: !!r.armSame,
    params: { model: r.modelLabel ?? r.model, compaction: !!r.compaction,
              effort: r.effort ?? 'default', budget: r.budgetUsd ?? null },
    sandboxId: r.sandboxId ?? null,
    pricing: r.pricing ?? null,
    trueCost: r.cost ?? 0,
    result: {
      usage: r.usage ?? {},
      num_turns: r.turns ?? 0,
      total_cost_usd: r.reportedCost ?? 0,
      duration_ms: r.durationMs ?? (r.secs ?? 0) * 1000,
      is_error: !!r.isError,
      result: r.err || '',
    },
    // No hidden suite exists for a replay. Saying so explicitly is what stops
    // the report rendering an empty 0/0 correctness row as if it had measured.
    grade: { kind: 'artifacts', total: 0, passed: 0, failures: [], import_ok: true, metrics: r.metrics ?? null },
    linesOfCode: r.metrics ? `${r.metrics.added} added, ${r.metrics.removed} removed` : '—',
    totalWallSec: r.secs ?? 0,
  }
}

export function buildRunJson({ id, session, plan, results, verdict, mode, run }) {
  const judgement = verdict && !verdict.error && verdict.rubric ? verdict : null
  const changesModel = new Set(results.map((r) => r.model)).size > 1
  return {
    runId: run, model: session.model, auth: 'bedrock · aws credits',
    experiment: plan.experiment ?? 'auto grid', control: 'control',
    session: id, task: session.kind, taskTitle: short(session.intent, 90),
    description: plan.rationale,
    lede: `Two identical cloud microVMs replay one real session — ${short(session.intent, 90)} — from the same working directory.`,
    footer: `replayed session ${id.slice(0, 8)} · arms compared against each other, not against the original session ($${session.cost} on ${session.model}, hundreds of turns) · blind rubric, no hidden suite`,
    changesModel,
    arms: results.map((r) => armRecord(r, judgement)),
    judgement,
  }
}

export function writeReport(OUT, ctx) {
  const data = buildRunJson(ctx)
  fs.writeFileSync(path.join(OUT, 'run.json'), JSON.stringify(data, null, 2))
  fs.writeFileSync(path.join(OUT, 'report.html'), buildHtml({ id: ctx.run, data }))
  return data
}
