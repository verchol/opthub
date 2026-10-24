#!/usr/bin/env node
/**
 * Interactive Claude Code login, driven end to end.
 *
 * Boots a sandbox, installs Claude Code, and runs `claude setup-token` on a real
 * PTY bridged to your terminal. The authorize URL is opened in your browser
 * automatically; you approve and paste the code back here. The resulting token
 * is captured, VERIFIED with a live call from inside the sandbox, and only then
 * written to .env.
 *
 *   node auth.mjs
 *
 * Uses your Claude subscription (setup-token requires one). Nothing is billed
 * beyond a few seconds of sandbox time and one tiny verification turn.
 */
import { Sandbox } from '../sandbox/e2b/index.mjs'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ENV_FILE } from './lib/state.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const ENV = ENV_FILE
const CODEFILE = path.join(ROOT, '.authcode')

for (const line of (fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8').split('\n') : [])) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
}

const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', c: '\x1b[36m', d: '\x1b[2m', x: '\x1b[0m' }
const say = (m) => console.log(`${C.c}◆${C.x} ${m}`)
const ok = (m) => console.log(`  ${C.g}✓${C.x} ${m}`)
const bad = (m) => console.log(`  ${C.r}✗${C.x} ${m}`)

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
const TOKEN_RE = /sk-ant-oat01-[A-Za-z0-9_-]{20,}/
const URL_RE = /https?:\/\/[^\s"'<>()\[\]]+/g
// OSC-8 hyperlink: ESC ] 8 ;; <target> BEL. The target is never wrapped; the visible
// label is, and the terminal will happily truncate it mid-query-string.
const OSC8_RE = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]+)(?:\x07|\x1b\\)/g

/** Every URL in view, hyperlink targets included, with glued-on duplicates trimmed. */
function candidateUrls(raw, clean) {
  const out = []
  for (const m of raw.matchAll(OSC8_RE)) out.push(m[1])
  for (const m of clean.matchAll(URL_RE)) out.push(m[0])
  return out.map((u) => {
    const dup = u.indexOf('https://', 8)          // two copies concatenated by wrapping
    return dup > 0 ? u.slice(0, dup) : u
  })
}

/** Only a URL carrying `state=` is usable — without it the callback rejects the request. */
function pickAuthUrl(raw, clean) {
  return candidateUrls(raw, clean)
    .filter((u) => /oauth|authorize/i.test(u) && /[?&]state=/.test(u))
    .sort((a, b) => b.length - a.length)[0] ?? null
}

function writeToken(tok) {
  const keep = (fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8').split('\n') : [])
    .filter((l) => l.trim() && !l.startsWith('CLAUDE_CODE_OAUTH_TOKEN='))
  fs.writeFileSync(ENV, [...keep, `CLAUDE_CODE_OAUTH_TOKEN=${tok}`, ''].join('\n'))
  fs.chmodSync(ENV, 0o600)
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  try { spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref(); return true } catch { return false }
}

async function main() {
  if (!process.env.E2B_API_KEY) {
    console.error('E2B_API_KEY is not set (put it in .env). https://console.e2b.dev/?tab=keys')
    process.exit(1)
  }

  say('booting a sandbox to run the login in')
  const sbx = await Sandbox.create({ timeoutMs: 20 * 60 * 1000 })
  ok(`sandbox ${sbx.sandboxId}`)

  let token = null
  try {
    say('installing Claude Code')
    const inst = await sbx.commands.run('npm install -g @anthropic-ai/claude-code >/dev/null 2>&1; claude --version', { timeoutMs: 900000 })
    if (inst.exitCode !== 0) { bad('install failed'); return }
    ok(inst.stdout.trim())

    // ---- PTY bridged to this terminal --------------------------------------
    let buf = ''
    let raw = ''      // untouched, so OSC-8 targets survive
    let opened = false
    let done = null
    const finished = new Promise((res) => { done = res })

    // Mirror the session, but never print the token — this may be running somewhere logged.
    let pending = ''
    const mirror = (chunk) => {
      let out = pending + chunk
      pending = ''
      const cut = out.search(/sk-ant-oat01-[A-Za-z0-9_-]*$/)   // hold back a partial token
      if (cut >= 0) { pending = out.slice(cut); out = out.slice(0, cut) }
      process.stdout.write(out.replace(/sk-ant-oat01-[A-Za-z0-9_-]{20,}/g, 'sk-ant-oat01-\u2022\u2022\u2022\u2022\u2022\u2022[captured]'))
    }

    const handle = await sbx.pty.create({
      cols: 220, rows: 50, timeoutMs: 15 * 60 * 1000,
      envs: { TERM: 'xterm-256color', ANTHROPIC_API_KEY: '', CI: '' },
      onData: (data) => {
        const chunk = Buffer.from(data).toString('utf8')
        mirror(chunk)
        raw = (raw + chunk).slice(-400000)
        buf = (buf + stripAnsi(chunk)).slice(-200000)

        if (!opened) {
          const u = pickAuthUrl(raw, buf)
          if (u) {
            {
              opened = true
              setTimeout(() => {
                console.log(`\n${C.y}▶ opening in your browser:${C.x}\n  ${u}\n`)
                console.log(`${C.d}  If nothing opened, copy the line above — it is complete.${C.x}`)
                console.log(`${C.d}  Approve, then return the code either way:${C.x}`)
                console.log(`${C.d}     · paste it here + enter, or${C.x}`)
                console.log(`${C.d}     · echo 'THECODE' > .authcode${C.x}\n`)
                openBrowser(u)
              }, 500)
            }
          }
        }
        const m = TOKEN_RE.exec(buf)
        if (m && !token) { token = m[0]; setTimeout(() => done(), 1200) }
      },
    })

    // Accept the code from .authcode as well as the keyboard, so this still works
    // when stdin is not attached (backgrounded, piped, driven by another tool).
    try { fs.unlinkSync(CODEFILE) } catch {}
    const poll = setInterval(async () => {
      let v = ''
      try { v = fs.readFileSync(CODEFILE, 'utf8').trim() } catch { return }
      try { fs.unlinkSync(CODEFILE) } catch {}
      if (!v) return
      console.log(`\n${C.c}◆${C.x} code received from .authcode, submitting`)
      try { await sbx.pty.sendInput(handle.pid, new TextEncoder().encode(v + '\r')) } catch {}
    }, 1000)

    // forward local keystrokes into the sandbox PTY
    const tty = process.stdin.isTTY
    if (tty) process.stdin.setRawMode(true)
    process.stdin.resume()
    const onKey = async (d) => {
      if (d.length === 1 && d[0] === 3) { console.log('\n(aborted)'); done() ; return }  // ctrl-c
      try { await sbx.pty.sendInput(handle.pid, new Uint8Array(d)) } catch {}
    }
    process.stdin.on('data', onKey)

    console.log(`\n${C.d}${'─'.repeat(70)}${C.x}`)
    say('starting `claude setup-token` — this terminal is now the sandbox\'s')
    console.log(`${C.d}${'─'.repeat(70)}${C.x}\n`)
    await sbx.pty.sendInput(handle.pid, new TextEncoder().encode('claude setup-token\r'))

    await Promise.race([finished, new Promise((r) => setTimeout(r, 15 * 60 * 1000))])

    clearInterval(poll)
    try { fs.unlinkSync(CODEFILE) } catch {}
    process.stdin.off('data', onKey)
    if (tty) process.stdin.setRawMode(false)
    process.stdin.pause()
    await sbx.pty.kill(handle.pid).catch(() => {})

    if (pending) { process.stdout.write(pending.replace(/sk-ant-oat01-[A-Za-z0-9_-]+/g, '')); pending = '' }
    console.log(`\n${C.d}${'─'.repeat(70)}${C.x}`)
    if (!token) { bad('no sk-ant-oat01- token appeared in the session'); return }
    ok(`captured a token (${token.length} chars)`)

    // ---- verify BEFORE saving ---------------------------------------------
    say('verifying it with a live call from inside the sandbox')
    const v = await sbx.commands.run(
      `cd /home/user && echo 'Reply with exactly: OK' | claude -p --model sonnet --output-format json --strict-mcp-config --no-session-persistence --dangerously-skip-permissions --max-budget-usd 0.50 > v.json 2> v.err; echo "EXIT=$?"`,
      { timeoutMs: 180000, envs: { CLAUDE_CODE_OAUTH_TOKEN: token, ANTHROPIC_API_KEY: '', CI: '1', IS_SANDBOX: '1' } })
    const vjson = await sbx.files.read('/home/user/v.json').catch(() => '')
    const err = await sbx.files.read('/home/user/v.err').catch(() => '')
    let j = null; try { j = JSON.parse(vjson) } catch {}

    if (!j || j.is_error) {
      bad('the captured token did not authenticate')
      const detail = (j?.result ?? err ?? v.stdout ?? '').toString().trim().slice(-400)
      if (detail) console.log(`    ${C.d}${detail}${C.x}`)
      console.log(`\n  ${C.y}Not written to .env.${C.x} Run \`node auth.mjs\` again.\n`)
      return
    }

    ok(`authenticated — replied ${JSON.stringify(String(j.result).trim().slice(0, 30))}, cost $${(j.total_cost_usd ?? 0).toFixed(6)}`)
    writeToken(token)
    ok(`written to .env (chmod 600)`)
    console.log(`\n${C.g}ready${C.x} — next: node run-demo.mjs --list\n`)
  } finally {
    await sbx.kill().catch(() => {})
    say('sandbox killed')
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
