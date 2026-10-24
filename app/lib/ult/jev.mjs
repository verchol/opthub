/**
 * TypeSafe Jev, Choice primitive, one question: which runtime class is this request?
 *
 * Same contract as opthub experiments/session-triage/src/classifiers/jev.py: only a
 * supplied option is accepted, probabilities must cover exactly the option set and sum
 * to 1, no retry, and any failure means abstain. What is sent is counts and booleans —
 * never prompt text, file paths or cost.
 */
export const CLASS_CRITERIA = {
  'coding/edit': 'The person asked for code to be written or changed.',
  'coding/debug': 'The person asked to find or fix a bug, a failing test or an error.',
  'review/security': 'The person asked to review changes for security or correctness risk.',
  'review/general': 'The person asked for a review of code or a change, not security-specific.',
  'non-coding/explain': 'The person asked for an explanation; no code change is expected.',
  'non-coding/summarize': 'The person asked for a summary of material already in the session.',
  'non-coding/pr-description': 'The person asked for prose about a change: PR description, commit message, changelog.',
  'background/utility': 'An automatic side request by the tool itself (titles, topic detection), not the person.',
  'unclear': 'The evidence does not decide.',
}

export function buildJevRequest(pub, model) {
  const { promptSha256, session, thread, ...signals } = pub
  return {
    model,
    state: {
      request: signals,
      note: 'Metadata of one request a coding agent is about to send to a model, computed locally. ' +
            'flags say whether the person\'s latest message mentioned a topic; the message itself is not included. ' +
            'recent counts tool use in the last six assistant turns.',
    },
    questions: {
      task_class: {
        type: 'choice',
        instructions: 'Which kind of work is this request? Choose exactly one option. Choose the option the evidence supports; choose \'unclear\' when it does not decide.',
        criteria: CLASS_CRITERIA,
      },
    },
  }
}

export function validAnswer(a, allowed) {
  if (!a || a.type !== 'choice' || !allowed.has(a.choice)) return false
  const p = a.probabilities
  if (!p || typeof p !== 'object') return false
  const keys = Object.keys(p)
  if (keys.length !== allowed.size || !keys.every(k => allowed.has(k))) return false
  const vals = Object.values(p)
  if (!vals.every(v => typeof v === 'number' && v >= 0 && v <= 1)) return false
  if (Math.abs(vals.reduce((a, b) => a + b, 0) - 1) > 0.01) return false
  return typeof a.confidence === 'number' && a.confidence >= 0 && a.confidence <= 1
}

/** @returns {Promise<{cls, confidence, latencyMs, outcome, requestId?}>} */
export async function askJev(pub, { endpoint, model, timeoutMs, apiKey, fetchImpl = fetch }) {
  const t0 = Date.now()
  const done = (outcome, extra = {}) => ({ cls: null, confidence: 0, outcome, latencyMs: Date.now() - t0, ...extra })
  if (!apiKey) return done('no-key')
  let raw
  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(buildJevRequest(pub, model)),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return done(`http-${res.status}`)
    raw = await res.json()
  } catch (e) {
    return done(e?.name === 'TimeoutError' ? 'timeout' : 'unavailable')
  }
  const a = raw?.answers?.task_class
  if (!validAnswer(a, new Set(Object.keys(CLASS_CRITERIA)))) return done('invalid')
  return { cls: a.choice, confidence: a.confidence, outcome: 'ok', latencyMs: Date.now() - t0, requestId: raw.request_id }
}
