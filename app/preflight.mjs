#!/usr/bin/env node
/**
 * Prove the whole chain works before spending anything on the real arms.
 *   1. .env parses and both credentials are present and well-shaped
 *   2. E2B key can actually boot a VM
 *   3. Claude Code installs inside it
 *   4. your subscription token authenticates FROM THAT VM and completes one turn
 *
 * Step 4 is the one that matters: the sandbox has no macOS keychain, so there is
 * no way for it to silently fall back to your local login. If it answers, the
 * token is genuinely portable and the real run will work.
 *
 * Costs: ~90s of one microVM, and one sonnet turn (a fraction of a cent).
 */
import { Sandbox } from '../sandbox/e2b/index.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { ENV_FILE } from './lib/state.mjs'

for (const line of (fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8').split('\n') : [])) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
}

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m'
const ok = (m) => console.log(`  ${G}✓${X} ${m}`)
const bad = (m) => { console.log(`  ${R}✗${X} ${m}`); failed = true }
const warn = (m) => console.log(`  ${Y}!${X} ${m}`)
let failed = false

const OAUTH = process.env.CLAUDE_CODE_OAUTH_TOKEN
const E2B_KEY = process.env.E2B_API_KEY

console.log('\npre-flight\n')

// ---- 1. credentials present and shaped right ------------------------------
console.log('1. credentials')
if (!fs.existsSync(ENV_FILE)) bad('.env does not exist')
else ok('.env found')

if (!E2B_KEY) bad('E2B_API_KEY missing')
else if (!/^e2b_[A-Za-z0-9]{16,}$/.test(E2B_KEY)) warn(`E2B_API_KEY set but unexpected shape (len ${E2B_KEY.length}) — trying anyway`)
else ok(`E2B_API_KEY present (len ${E2B_KEY.length})`)

if (!OAUTH) bad('CLAUDE_CODE_OAUTH_TOKEN missing — run `node auth.mjs`')
else if (!OAUTH.startsWith('sk-ant-oat01-')) bad(`CLAUDE_CODE_OAUTH_TOKEN has the wrong prefix (got "${OAUTH.slice(0, 12)}…"). setup-token emits sk-ant-oat01-… ; sk-ant-api03-… is an API key, not a license token.`)
else ok(`CLAUDE_CODE_OAUTH_TOKEN present, correct prefix (len ${OAUTH.length})`)

if (process.env.ANTHROPIC_API_KEY) warn('ANTHROPIC_API_KEY is still in this shell env; it is blanked inside the sandbox, so it cannot bill API credits')

if (failed) { console.log(`\n${R}pre-flight stopped: fix the above first.${X}\n`); process.exit(1) }

// ---- 2..4 in the sandbox ---------------------------------------------------
let sbx
try {
  console.log('\n2. E2B: booting a VM')
  const t0 = Date.now()
  sbx = await Sandbox.create({ timeoutMs: 10 * 60 * 1000 })
  ok(`sandbox ${sbx.sandboxId} up in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  const env = await sbx.commands.run('node -v; npm -v; python3 -V; whoami; nproc; free -m | awk "NR==2{print \\$2\\" MB\\"}"')
  console.log(env.stdout.trim().split('\n').map((l) => `    ${D}${l}${X}`).join('\n'))

  console.log('\n3. installing Claude Code in the VM')
  const t1 = Date.now()
  const inst = await sbx.commands.run('npm install -g @anthropic-ai/claude-code >/dev/null 2>&1; claude --version', { timeoutMs: 900000 })
  if (inst.exitCode !== 0) { bad(`install failed: ${(inst.stderr || inst.stdout).slice(-400)}`); throw new Error('install') }
  ok(`${inst.stdout.trim()} in ${((Date.now() - t1) / 1000).toFixed(1)}s`)

  console.log('\n4. authenticating with your subscription token, from inside the VM')
  const cmd = `cd /home/user && echo 'Reply with exactly: PREFLIGHT_OK' | claude -p --model sonnet --output-format json --strict-mcp-config --no-session-persistence --dangerously-skip-permissions --max-budget-usd 0.50 > out.json 2> err.txt; echo "EXIT=$?"`
  const run = await sbx.commands.run(cmd, {
    timeoutMs: 180000,
    envs: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH, ANTHROPIC_API_KEY: '', CI: '1', IS_SANDBOX: '1' },
  })
  const raw = await sbx.files.read('/home/user/out.json').catch(() => '')
  const err = await sbx.files.read('/home/user/err.txt').catch(() => '')
  let j = null
  try { j = JSON.parse(raw) } catch {}

  if (!j) {
    bad(`no parsable result (${run.stdout.trim()})`)
    if (err.trim()) console.log(`    ${D}stderr: ${err.trim().slice(-600)}${X}`)
    if (raw.trim()) console.log(`    ${D}stdout: ${raw.trim().slice(-400)}${X}`)
    if (/401|unauthor|invalid.*token|authentication/i.test(err + raw))
      console.log(`\n    ${R}That reads like an auth rejection — re-run \`claude setup-token\` and replace the value in .env.${X}`)
  } else if (j.is_error) {
    bad(`claude returned an error: ${String(j.result).slice(0, 400)}`)
  } else {
    const said = String(j.result ?? '').trim()
    ok(`round trip complete — model replied ${JSON.stringify(said.slice(0, 40))}`)
    ok(`cost $${(j.total_cost_usd ?? 0).toFixed(6)}, ${j.num_turns} turn(s), ${((j.duration_ms ?? 0) / 1000).toFixed(1)}s`)
    if (!/PREFLIGHT_OK/.test(said)) warn('reply did not contain PREFLIGHT_OK, but auth clearly worked')
  }
} catch (e) {
  if (!failed) bad(String(e?.message ?? e))
} finally {
  if (sbx) { await sbx.kill().catch(() => {}); console.log(`\n  ${D}sandbox killed${X}`) }
}

console.log(failed
  ? `\n${R}pre-flight FAILED${X} — not safe to run the arms yet.\n`
  : `\n${G}pre-flight PASSED${X} — E2B boots, Claude Code installs, your license authenticates from a remote VM.\n  ready: node run-demo.mjs\n`)
process.exit(failed ? 1 : 0)
