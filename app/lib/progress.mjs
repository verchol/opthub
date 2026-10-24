/**
 * Step progress for slow launches: finished steps stay on screen with their time, the
 * running step animates with a bar and elapsed seconds. Plain lines when not a TTY.
 *
 *   ✓ docker ready                         0.2s
 *   ✓ credential valid (oauth)             0.6s
 *   ⠹ 3/6 ▕█████████░░░░░░░░░▏ starting router · copying workspace   2.1s
 */
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export class Progress {
  constructor(total, { stream = process.stderr, color = stream.isTTY } = {}) {
    this.total = total
    this.stream = stream
    this.tty = !!stream.isTTY
    this.c = color ? { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' } : { g: '', r: '', y: '', d: '', b: '', x: '' }
    this.done = 0
    this.active = new Map()     // label -> start time
    this.frame = 0
    this.t0 = Date.now()
    this.timer = null
  }

  _secs(ms) { return `${(ms / 1000).toFixed(1)}s` }

  _clear() { if (this.tty) this.stream.write('\r\x1b[2K') }

  _draw() {
    if (!this.tty || !this.active.size || this.aborted) return
    const width = 18
    const fill = Math.round((this.done / this.total) * width)
    const bar = '█'.repeat(fill) + '░'.repeat(width - fill)
    const labels = [...this.active.keys()].join(' · ')
    const since = Math.min(...this.active.values())
    const cols = this.stream.columns ?? 100
    let line = `  ${this.c.y}${FRAMES[this.frame++ % FRAMES.length]}${this.c.x} ${Math.min(this.done + 1, this.total)}/${this.total} ▕${bar}▏ ${labels}  ${this.c.d}${this._secs(Date.now() - since)}${this.c.x}`
    // Keep to one line so \r redraws cleanly.
    const visible = line.replace(/\x1b\[[0-9;]*m/g, '')
    if (visible.length > cols - 1) line = line.slice(0, line.length - (visible.length - cols + 2))
    this.stream.write(`\r\x1b[2K${line}`)
  }

  _tick() {
    if (this.tty && !this.timer) { this.timer = setInterval(() => this._draw(), 80); this.timer.unref?.() }
    this._draw()
  }

  /** Run one step; its label shows while it runs, then a ✓ line with the time. */
  async step(label, fn, { doneLabel } = {}) {
    const t = Date.now()
    this.active.set(label, t)
    if (!this.tty) this.stream.write(`  … ${label}\n`)
    this._tick()
    try {
      const r = await fn()
      this.active.delete(label)
      this.done++
      const note = typeof doneLabel === 'function' ? doneLabel(r) : doneLabel
      this._line(`${this.c.g}✓${this.c.x}`, note ?? label, Date.now() - t)
      return r
    } catch (e) {
      this.active.delete(label)
      this._line(`${this.c.r}✗${this.c.x}`, label, Date.now() - t)
      throw e
    } finally {
      if (!this.active.size) this._stopTimer()
      else this._draw()
    }
  }

  /** Stop drawing: steps still running in parallel finish silently. */
  abort() { this.aborted = true; this._stopTimer() }

  _line(mark, text, ms) {
    if (this.aborted) return
    this._clear()
    const pad = Math.max(1, 44 - text.replace(/\x1b\[[0-9;]*m/g, '').length)
    this.stream.write(`  ${mark} ${text}${' '.repeat(pad)}${this.c.d}${this._secs(ms)}${this.c.x}\n`)
  }

  _stopTimer() { clearInterval(this.timer); this.timer = null; this._clear() }

  /** Last line before handing the terminal to another program. */
  finish(text) {
    this._stopTimer()
    this.stream.write(`  ${this.c.b}▸${this.c.x} ${text} ${this.c.d}(${this._secs(Date.now() - this.t0)} total)${this.c.x}\n`)
  }
}
