/**
 * The classifier's memory, per project: which class the current turn of each session
 * has, which model each thread is pinned to, recent class history, and project-wide
 * priors. Survives restarts, so routing improves with use (epic RO, RO-5).
 *
 * One JSON file per project key, written atomically (tmp + rename) and debounced.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export function projectKey(projectDir) {
  const base = path.basename(projectDir || 'default').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40)
  const h = crypto.createHash('sha256').update(path.resolve(projectDir || 'default')).digest('hex').slice(0, 8)
  return `${base}-${h}`
}

const empty = () => ({ version: 1, sessions: {}, threads: {}, priors: { classCounts: {}, overrides: {} } })

export class ContextStore {
  /**
   * @param {object} o
   * @param {string|null} o.file     null keeps everything in memory
   * @param {number} o.history       class-history entries kept per session
   */
  constructor({ file = null, history = 50, writeDelayMs = 250 } = {}) {
    this.file = file
    this.history = history
    this.writeDelayMs = writeDelayMs
    this.data = empty()
    this._timer = null
    if (file && fs.existsSync(file)) {
      try {
        const d = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (d?.version === 1) this.data = { ...empty(), ...d, priors: { ...empty().priors, ...(d.priors ?? {}) } }
      } catch { /* a corrupt store starts fresh; the audit log is the record of truth */ }
    }
  }

  session(id) {
    const k = id ?? '_anon'
    return this.data.sessions[k] ??= { turn: 0, turnClass: null, turnSource: null, history: [], firstSeen: new Date().toISOString() }
  }

  /** A new human prompt: remember its class until the next one. */
  startTurn(sessionId, cls, source, confidence) {
    const s = this.session(sessionId)
    s.turn++
    s.turnClass = cls
    s.turnSource = source
    s.turnConfidence = confidence
    s.history.push({ t: Date.now(), cls, source })
    if (s.history.length > this.history) s.history.splice(0, s.history.length - this.history)
    const pc = this.data.priors.classCounts
    pc[cls] = (pc[cls] ?? 0) + 1
    this.save()
  }

  currentTurn(sessionId) {
    const s = this.data.sessions[sessionId ?? '_anon']
    return s?.turnClass ? { cls: s.turnClass, source: s.turnSource, confidence: s.turnConfidence ?? 0.5 } : null
  }

  threadTarget(thread) { return this.data.threads[thread]?.target ?? null }

  pinThread(thread, target) {
    this.data.threads[thread] = { target, at: new Date().toISOString() }
    this.save()
  }

  /** The class most often seen in this project — the weakest signal, used last. */
  prior() {
    const e = Object.entries(this.data.priors.classCounts).filter(([c]) => c !== 'unclear').sort((a, b) => b[1] - a[1])
    const total = e.reduce((a, [, n]) => a + n, 0)
    return e.length && total >= 5 ? { cls: e[0][0], share: e[0][1] / total } : null
  }

  recordOverride(fromCls, toCls) {
    const k = `${fromCls}->${toCls}`
    this.data.priors.overrides[k] = (this.data.priors.overrides[k] ?? 0) + 1
    this.save()
  }

  save() {
    if (!this.file) return
    clearTimeout(this._timer)
    this._timer = setTimeout(() => this.flush(), this.writeDelayMs)
    this._timer.unref?.()
  }

  flush() {
    if (!this.file) return
    clearTimeout(this._timer)
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1))
    fs.renameSync(tmp, this.file)
  }
}
