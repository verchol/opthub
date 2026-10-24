/**
 * The session view of one /v1/messages request — what a gateway that reads only the
 * prompt does not use. Everything returned is counts, booleans and hashes, except
 * `promptText`, which the classifier reads in memory and nothing ever stores or sends.
 */
import crypto from 'node:crypto'

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')

const textOf = (content) => typeof content === 'string'
  ? content
  : Array.isArray(content) ? content.filter(b => b?.type === 'text').map(b => b.text ?? '').join('\n') : ''

const systemText = (system) => typeof system === 'string' ? system : Array.isArray(system) ? system.map(b => b?.text ?? '').join('\n') : ''

/** Claude Code wraps reminders and command output around what the person typed. */
export function humanText(raw) {
  return String(raw ?? '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/<(command-[a-z-]+|local-command-[a-z-]+)>[\s\S]*?<\/\1>/g, ' ')
    .replace(/\s+/g, ' ').trim()
}

/** Claude Code puts the session id in metadata.user_id, as a string or as JSON. */
export function sessionIdOf(body) {
  const uid = body?.metadata?.user_id
  if (!uid) return null
  const m = String(uid).match(/session(?:_?id)?[_"':\s]*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
  return m ? m[1] : null
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS'])

export const FLAG_PATTERNS = {
  mentions_security: /\b(secur\w*|vulnerab\w*|inject\w*|xss|csrf|auth\w*|secret\w*|credential\w*|cve|exploit\w*|sanitiz\w*|bite us)\b/i,
  mentions_review: /\b(review\w*|go over|look over|audit|anything (wrong|off|in (the|this) (diff|pr|change)))\b|before i (open|merge|ship)/i,
  mentions_diff: /\b(diff|pr|pull request|changes?|commit\w*)\b/i,
  mentions_explain: /\b(explain\w*|how does|how do|what does|what is|why does|walk me through|plain english|understand)\b/i,
  mentions_summary: /\b(summar\w*|tl;?dr|recap|overview)\b/i,
  mentions_pr_text: /\b(pr description|pull request description|commit message|changelog|release notes|write (the|a) pr)\b/i,
  mentions_bug: /\b(bug|fix\w*|fail\w*|flaky|error\w*|exception|crash\w*|broken|debug\w*|stack ?trace|regression|doesn'?t work)\b/i,
  mentions_edit: /\b(add|implement\w*|refactor\w*|rename|change|update|create|write|build|migrate|remove|delete|replace)\b/i,
}

export function promptFlags(text) {
  const out = {}
  for (const [k, re] of Object.entries(FLAG_PATTERNS)) out[k] = re.test(text)
  return out
}

export function extractFeatures(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const last = messages.at(-1)
  const lastBlocks = Array.isArray(last?.content) ? last.content : []
  const toolLoop = last?.role === 'user' && lastBlocks.some(b => b?.type === 'tool_result')

  // The most recent message the person typed (not a tool result).
  let promptRaw = ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    const blocks = Array.isArray(m.content) ? m.content : null
    if (blocks && blocks.every(b => b?.type === 'tool_result')) continue
    promptRaw = textOf(m.content); break
  }
  const promptText = humanText(promptRaw)

  // Tool use in the last six assistant turns.
  const recent = { edits: 0, reads: 0, bash: 0, gitDiff: false, subagents: 0, names: {} }
  let seen = 0
  for (let i = messages.length - 1; i >= 0 && seen < 6; i--) {
    const m = messages[i]
    if (m.role === 'assistant') {
      seen++
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b?.type !== 'tool_use') continue
        recent.names[b.name] = (recent.names[b.name] ?? 0) + 1
        if (EDIT_TOOLS.has(b.name)) recent.edits++
        else if (READ_TOOLS.has(b.name)) recent.reads++
        else if (b.name === 'Bash') {
          recent.bash++
          if (/\bgit\s+(diff|show|log\s+-p)\b/.test(String(b.input?.command ?? ''))) recent.gitDiff = true
        } else if (b.name === 'Task' || b.name === 'Agent') recent.subagents++
      }
    } else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b?.type === 'tool_result' && /^diff --git /m.test(textOf(b.content) || (typeof b.content === 'string' ? b.content : ''))) recent.gitDiff = true
      }
    }
  }

  const sys = systemText(body?.system)
  const firstUser = humanText(textOf(messages.find(m => m.role === 'user')?.content)).slice(0, 500)
  const thread = sha(sys.slice(0, 4000) + '\u0000' + firstUser).slice(0, 16)
  const bytes = JSON.stringify(body ?? {}).length
  const tools = Array.isArray(body?.tools) ? body.tools : []

  return {
    session: sessionIdOf(body),
    thread,
    requestedModel: body?.model ?? null,
    stream: !!body?.stream,
    messages: messages.length,
    toolLoop,
    humanTurn: !toolLoop && last?.role === 'user',
    toolsOffered: tools.length,
    thinking: body?.thinking?.type === 'enabled' || body?.thinking?.type === 'adaptive',
    maxTokens: body?.max_tokens ?? null,
    approxInputTokens: Math.round(bytes / 4),
    systemChars: sys.length,
    recent,
    flags: promptFlags(promptText),
    promptChars: promptText.length,
    promptSha256: promptText ? sha(promptText) : null,
    promptText,          // in memory only — see audit.mjs / jev.mjs for what leaves
  }
}

/** Features minus the prompt text: what may be written or sent. */
export function publicFeatures(f) {
  const { promptText, ...rest } = f
  return rest
}
