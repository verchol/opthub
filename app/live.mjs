/**
 * Side-by-side live panes, one per sandbox. Falls back to prefixed lines when
 * stdout is not a terminal (piped, backgrounded, CI), so nothing is ever lost.
 */
const ESC = '\x1b'
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')

export class Live {
  constructor(columns, { rows = 14, throttleMs = 120 } = {}) {
    this.cols = columns.map((c) => ({ ...c, lines: [], status: 'waiting…' }))
    this.rows = rows
    this.tty = Boolean(process.stdout.isTTY)
    this.painted = 0
    this.dirty = false
    this.throttleMs = throttleMs
    this.timer = null
    this.stopped = false
  }

  start() {
    if (!this.tty) return
    process.stdout.write(`${ESC}[?25l`)               // hide cursor
    this.timer = setInterval(() => this.dirty && this.paint(), this.throttleMs)
    this.onResize = () => { this.painted = 0; this.dirty = true }
    process.stdout.on('resize', this.onResize)
  }

  stop() {
    if (this.stopped) return
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    if (!this.tty) return
    process.stdout.off('resize', this.onResize)
    this.paint()
    process.stdout.write(`${ESC}[?25h\n`)             // show cursor
  }

  find(id) { return this.cols.find((c) => c.id === id) }

  push(id, line, { dim = false } = {}) {
    const c = this.find(id)
    if (!c) return
    for (const raw of String(line).split('\n')) {
      const t = raw.trimEnd()
      if (!t) continue
      c.lines.push({ t, dim })
      if (c.lines.length > 400) c.lines.shift()
      if (!this.tty) process.stdout.write(`${c.color}[${c.id.slice(0, 14).padEnd(14)}]\x1b[0m ${t}\n`)
    }
    this.dirty = true
  }

  status(id, s) {
    const c = this.find(id)
    if (!c) return
    c.status = s
    if (!this.tty) process.stdout.write(`${c.color}[${c.id.slice(0, 14).padEnd(14)}]\x1b[0m ${ESC}[2m${s}${ESC}[0m\n`)
    this.dirty = true
  }

  /** Hard-wrap to the pane width so a long tool line never bleeds into the neighbour. */
  static fit(text, w) {
    const out = []
    let s = text
    while (s.length > w) { out.push(s.slice(0, w)); s = s.slice(w) }
    out.push(s)
    return out
  }

  paint() {
    if (!this.tty || this.stopped === 'final') return
    this.dirty = false
    const total = Math.max(60, process.stdout.columns || 120)
    const n = this.cols.length
    const gap = 3
    const w = Math.floor((total - gap * (n - 1)) / n)

    const panes = this.cols.map((c) => {
      const body = []
      for (const l of c.lines) for (const piece of Live.fit(l.t, w)) body.push({ t: piece, dim: l.dim })
      const vis = body.slice(-this.rows)
      while (vis.length < this.rows) vis.unshift({ t: '', dim: true })
      return vis
    })

    const buf = []
    if (this.painted) buf.push(`${ESC}[${this.painted}A`)

    const head = this.cols.map((c) => {
      const label = ` ${c.label} `.slice(0, w)
      return `${c.color}${ESC}[1m${label.padEnd(w)}${ESC}[0m`
    }).join(' '.repeat(gap))
    buf.push(`${ESC}[2K${head}`)
    buf.push(`${ESC}[2K${this.cols.map((c) => `${c.color}${'─'.repeat(w)}${ESC}[0m`).join(' '.repeat(gap))}`)

    for (let r = 0; r < this.rows; r++) {
      const row = panes.map((p) => {
        const cell = p[r]
        const txt = cell.t.padEnd(w)
        return cell.dim ? `${ESC}[2m${txt}${ESC}[0m` : txt
      }).join(' '.repeat(gap))
      buf.push(`${ESC}[2K${row}`)
    }

    const foot = this.cols.map((c) => {
      const s = ` ${c.status}`.slice(0, w).padEnd(w)
      return `${c.color}${ESC}[2m${s}${ESC}[0m`
    }).join(' '.repeat(gap))
    buf.push(`${ESC}[2K${foot}`)

    this.painted = this.rows + 3
    process.stdout.write(buf.join('\n') + '\n')
  }
}

/** Turn one stream-json event into a short, useful line. Returns null for noise. */
export function summarize(ev) {
  if (!ev || typeof ev !== 'object') return null
  const brief = (v, n = 52) => {
    const s = String(v ?? '').replace(/\s+/g, ' ').trim()
    return s.length > n ? s.slice(0, n - 1) + '…' : s
  }
  if (ev.type === 'system' && ev.subtype === 'init')
    return [{ t: `session ${String(ev.session_id ?? '').slice(0, 8)} · ${ev.model ?? ''}`, dim: true }]

  if (ev.type === 'assistant') {
    const out = []
    for (const b of ev.message?.content ?? []) {
      if (b.type === 'text' && b.text?.trim()) out.push({ t: brief(b.text.split('\n')[0], 60) })
      if (b.type === 'tool_use') {
        const i = b.input ?? {}
        const arg = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.description ?? i.prompt ?? ''
        out.push({ t: `▸ ${b.name}(${brief(arg, 44)})` })
      }
    }
    return out.length ? out : null
  }
  if (ev.type === 'user') {
    for (const b of ev.message?.content ?? []) {
      if (b.type === 'tool_result') {
        const c = Array.isArray(b.content) ? b.content.map((x) => x.text ?? '').join(' ') : b.content
        const first = brief(String(c ?? '').split('\n').find((l) => l.trim()) ?? '', 54)
        return first ? [{ t: `  ${b.is_error ? '✗' : '·'} ${first}`, dim: true }] : null
      }
    }
    return null
  }
  if (ev.type === 'result')
    return [{ t: `── ${ev.is_error ? 'ERROR' : 'complete'} · ${ev.num_turns} turns · $${(ev.total_cost_usd ?? 0).toFixed(4)}` }]
  return null
}
