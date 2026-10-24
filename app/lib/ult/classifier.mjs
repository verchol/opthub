/**
 * One runtime class per request. Order of evidence:
 *   background side calls → turn stickiness (tool loop, "continue") → rules →
 *   Jev when rules are unsure → project prior (weak, never routes on its own).
 * A class is decided on the human prompt and held through that turn's tool loop.
 */
import { publicFeatures } from './features.mjs'
import { askJev } from './jev.mjs'

export const CLASSES = ['coding/edit', 'coding/debug', 'review/security', 'review/general',
  'non-coding/explain', 'non-coding/summarize', 'non-coding/pr-description', 'background/utility', 'unclear']

const CONTINUE = /^(y|yes|ok|okay|sure|go|go ahead|continue|proceed|do it|carry on|next|lgtm|sounds good|please do|keep going)[.! ]*$/i

/** Pure: features → {cls, confidence, why}. No memory, no network. */
export function rulesClassify(f) {
  const fl = f.flags
  if (!f.toolsOffered && f.messages <= 2 && (/haiku/i.test(f.requestedModel ?? '') || (f.maxTokens ?? Infinity) <= 1024)) {
    return { cls: 'background/utility', confidence: 0.9, why: 'no tools, short, small-model side call' }
  }
  if (fl.mentions_pr_text) return { cls: 'non-coding/pr-description', confidence: 0.9, why: 'asks for PR/commit prose' }
  const diffContext = fl.mentions_diff || f.recent.gitDiff || f.recent.edits > 0
  if (fl.mentions_security && (fl.mentions_review || diffContext)) return { cls: 'review/security', confidence: 0.9, why: 'security wording with a diff or review in view' }
  if (fl.mentions_review && diffContext) return { cls: 'review/general', confidence: 0.75, why: 'review wording with a diff in view' }
  if (fl.mentions_security) return { cls: 'review/security', confidence: 0.65, why: 'security wording' }
  if (fl.mentions_bug) return { cls: 'coding/debug', confidence: 0.8, why: 'bug/failure wording' }
  if (fl.mentions_summary && !fl.mentions_edit) return { cls: 'non-coding/summarize', confidence: 0.8, why: 'asks for a summary' }
  if (fl.mentions_explain && !fl.mentions_edit) return { cls: 'non-coding/explain', confidence: 0.8, why: 'asks for an explanation, no change' }
  if (fl.mentions_edit) return { cls: 'coding/edit', confidence: fl.mentions_explain ? 0.55 : 0.7, why: 'change wording' }
  return { cls: 'unclear', confidence: 0.3, why: 'no rule matched' }
}

export class Classifier {
  /**
   * @param {object} o
   * @param {object} o.config   the `classifier` block of the ULT config
   * @param {import('./context-store.mjs').ContextStore} o.store
   * @param {string} [o.jevKey]
   * @param {Function} [o.fetchImpl]
   */
  constructor({ config, store, jevKey = process.env.JEV_API_KEY, fetchImpl = fetch }) {
    this.cfg = config
    this.store = store
    this.jevKey = jevKey
    this.fetchImpl = fetchImpl
  }

  async classify(f) {
    // Side calls never start or change a turn.
    const r = rulesClassify(f)
    if (r.cls === 'background/utility') return { ...r, source: 'rules', turn: false }

    const turn = this.store.currentTurn(f.session)
    if (!f.humanTurn && turn) return { cls: turn.cls, confidence: turn.confidence, source: 'sticky', why: 'tool loop of the current turn', turn: false }
    if (f.humanTurn && turn && CONTINUE.test(f.promptText)) {
      this.store.startTurn(f.session, turn.cls, 'sticky', turn.confidence)
      return { cls: turn.cls, confidence: turn.confidence, source: 'sticky', why: 'continuation of the previous turn', turn: true }
    }

    let out = { ...r, source: 'rules' }
    const jc = this.cfg?.jev
    if (this.cfg?.rules === false) out = { cls: 'unclear', confidence: 0, why: 'rules disabled', source: 'rules' }
    if (jc?.enabled && (out.cls === 'unclear' || out.confidence < (jc.minRuleConfidence ?? 0.6))) {
      const j = await askJev(publicFeatures(f), { ...jc, apiKey: this.jevKey, fetchImpl: this.fetchImpl })
      out.jev = { outcome: j.outcome, latencyMs: j.latencyMs, cls: j.cls, confidence: j.confidence }
      if (j.outcome === 'ok' && j.cls !== 'unclear') out = { ...out, cls: j.cls, confidence: j.confidence, source: 'jev', why: 'rules unsure; Jev decided' }
    }
    if (out.cls === 'unclear') {
      const p = this.store.prior()
      if (p) out = { ...out, cls: p.cls, confidence: Math.min(0.45, p.share * 0.5), source: 'prior', why: `project prior (${Math.round(p.share * 100)}% of turns)` }
    }
    if (f.humanTurn) this.store.startTurn(f.session, out.cls, out.source, out.confidence)
    return { ...out, turn: f.humanTurn }
  }
}
