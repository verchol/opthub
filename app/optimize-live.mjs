#!/usr/bin/env node
/**
 * opt claude optimize — runtime optimization (epic RO, opthub docs/runtime-optimization.md).
 *
 * Starts Claude Code inside the opthub Docker sandbox with your terminal attached. Every
 * request it sends goes through LLM Ultra Light (ult.mjs), which classifies it, decides
 * keep / route / local, and writes a hash-chained audit log.
 *
 *   opt claude optimize [project-dir] [flags] [-- <claude args>]
 *   opt claude optimize audit [run] [--verify] [--json]
 *   opt claude optimize status
 *   opt claude optimize install-command
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { STATE, PACKAGE_ROOT, stateDir } from './lib/state.mjs'
import { loadConfig } from './lib/ult/config.mjs'
import { projectKey } from './lib/ult/context-store.mjs'
import { createUlt } from './lib/ult/server.mjs'
import { warmLocal, localModels } from './lib/ult/capacity.mjs'
import { withMachine } from './lib/model-scores.mjs'
import { readAudit, verifyAudit, summarize } from './lib/ult/audit.mjs'
import { verifyCredential } from './lib/ult/upstream.mjs'
import { launcherCredential, authMode, readStoredToken, storeToken, deleteStoredToken, storedTokenLocation, credentialFromValue } from './lib/ult/credentials.mjs'
import { Progress } from './lib/progress.mjs'
import { SANDBOX_SH } from '../sandbox/docker/index.mjs'

const C = process.stdout.isTTY ? { b: '\x1b[1m', d: '\x1b[2m', g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', x: '\x1b[0m' } : { b: '', d: '', g: '', y: '', r: '', x: '' }
const IMAGE = process.env.OPT_AGENT_IMAGE ?? 'opthub/agent:0.1'
export const NET_INT = 'opthub-sbx-internal', NET_OUT = 'opthub-sbx-egress', PROXY = 'opthub-egress'
const SANDBOX_OUT = path.resolve((process.env.OPT_SANDBOX_OUT ?? path.join(os.homedir(), '.opthub', 'sandbox-out')).replace(/^~(?=$|\/)/, os.homedir()))
export const DUMMY_KEY = 'sk-ant-opthub-ult-sandbox-not-a-real-key-0000'

/**
 * Agents runtime optimization can put behind the router. The launcher is written against
 * this table so another agent (Codex CLI, Aider, …) is one entry plus its sandbox wiring.
 */
export const AGENTS = {
  claude: { label: 'Claude Code', binary: 'claude', protocol: 'anthropic', baseUrlEnv: 'ANTHROPIC_BASE_URL' },
}

export const USAGE = `
${C.b}opt claude optimize${C.x} — Claude Code in the sandbox, every request through LLM Ultra Light

  opt claude optimize [project-dir] [flags] [-- <claude args>]

    --mode shadow|route          shadow records only (default) · route acts
    --sandbox docker|host        docker (default) · host = no sandbox, for development
    --workspace copy|rw|ro       copy (default) · rw mounts the real checkout · ro read-only
    --model <id>                 main model for Claude Code
    --local-model <ollama tag>   local target (e.g. qwen2.5-coder:1.5b); enables local routes
    --no-local                   disable local routes
    --routing local              small tasks (explain, summarize, PR text; short, a person's turn) answered by
                                 local Ollama from a scoped context; everything else and every failure on the
                                 frontier model. Implies --mode route and --local-cloud. --routing frontier pins.
    --local-cloud                the local tier: Ollama for what capacity admits, tev1 when rules are unsure
                                 (opt install sets it up; stays in shadow unless --mode route)
    --ollama-url <url>           Ollama's address as the router sees it
    --jev | --no-jev             ask Jev when rules are unsure (needs JEV_API_KEY)
    --route <class>=<target>     override one route, repeatable (target: keep, local, local:<m>, remote:<m>)
    --pin frontier               never reroute; still classify and audit
    --config <file>              extra config layer
    --audit-prompts              store prompt text in the audit log (off by default)
    --port <n>                   router port (default 8787)
    --dry-run                    print resolved config and commands, start nothing
    --skip-auth-check            start even if the credential check fails
    --auth [token]               use this credential for the session: sk-ant-oat… (subscription) or sk-ant-api…
                                 (API key, bills credits). No value: asked at a hidden prompt. env:NAME: from a
                                 variable. -: from stdin. A value on the command line lands in shell history.
    --save                       with --auth: keep it in the Keychain for next time

  opt claude optimize audit [run] [--verify] [--json]   decisions of a run (latest by default)
  opt claude optimize status                             running optimize sessions
  opt claude optimize install-command                    install /optimize-live into ~/.claude/commands
  opt claude optimize login | logout                     store / remove the Claude subscription token the sandbox uses
  opt claude optimize clean                              remove containers left by a crashed or killed session

  ${C.d}auth: your Claude subscription by default (a token from \`claude setup-token\`, kept in the Keychain).
        An API key is used only with AUTH_MODE=api-key, and bills API credits.${C.x}

  ${C.d}agents: ${Object.keys(AGENTS).join(', ')} — more to come; the router speaks each agent's API${C.x}
`

// ---------------------------------------------------------------- args
export function parseArgs(argv) {
  const dd = argv.indexOf('--')
  const claudeArgs = dd >= 0 ? argv.slice(dd + 1) : []
  const a = dd >= 0 ? argv.slice(0, dd) : argv
  const f = { routes: [], positional: [] }
  const need = (i, name) => { if (i + 1 >= a.length || a[i + 1].startsWith('--')) throw new Error(`${name} needs a value`); return a[i + 1] }
  for (let i = 0; i < a.length; i++) {
    const t = a[i]
    const [k, inline] = t.includes('=') && t.startsWith('--') ? [t.slice(0, t.indexOf('=')), t.slice(t.indexOf('=') + 1)] : [t, undefined]
    const val = () => inline ?? need(i++, k)
    switch (k) {
      case '--mode': f.mode = val(); break
      case '--sandbox': f.sandbox = val(); break
      case '--workspace': f.workspace = val(); break
      case '--model': f.model = val(); break
      case '--local-model': f.localModel = val(); break
      case '--no-local': f.noLocal = true; break
      case '--local-cloud': f.localCloud = true; break
      case '--routing': f.routing = val(); break
      case '--ollama-url': f.ollamaUrl = val(); break
      case '--jev': f.jev = true; break
      case '--no-jev': f.jev = false; break
      case '--route': f.routes.push(val()); break
      case '--pin': f.pin = val(); break
      case '--config': f.config = val(); break
      case '--audit-prompts': f.auditPrompts = true; break
      case '--port': f.port = Number(val()); break
      case '--dry-run': f.dryRun = true; break
      case '--skip-auth-check': f.skipAuthCheck = true; break
      case '--auth':
        // --auth alone (or --auth prompt) asks at a hidden prompt; --auth - reads stdin;
        // --auth env:NAME reads a variable; anything else is the value itself.
        if (inline !== undefined) f.auth = inline
        else if (i + 1 < a.length && !a[i + 1].startsWith('--')) f.auth = a[++i]
        else f.auth = 'prompt'
        break
      case '--save': f.save = true; break
      case '--live': break   // SPEC §10 spells it `optimize --live`; live is the only mode here
      case '--verify': f.verify = true; break
      case '--json': f.json = true; break
      case '-h': case '--help': f.help = true; break
      default:
        if (t.startsWith('--')) throw new Error(`unknown flag ${t}`)
        f.positional.push(t)
    }
  }
  f.sandbox ??= 'docker'
  f.workspace ??= 'copy'
  if (!['docker', 'host'].includes(f.sandbox)) throw new Error(`--sandbox must be docker or host`)
  if (!['copy', 'rw', 'ro'].includes(f.workspace)) throw new Error(`--workspace must be copy, rw or ro`)
  return { flags: f, claudeArgs }
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
const sh = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...o })
const quote = (a) => /^[A-Za-z0-9_./:=@,+-]+$/.test(a) ? a : `'${String(a).replace(/'/g, `'\\''`)}'`

// ---------------------------------------------------------------- launch
async function launch(flags, claudeArgs, agent = 'claude', secretReport = null, authOverride = null) {
  const projectDir = path.resolve(flags.positional[0] ?? process.cwd())
  if (!fs.existsSync(projectDir)) throw new Error(`no such directory: ${projectDir}`)
  const docker = flags.sandbox === 'docker'
  const { config, sources, hash } = loadConfig({ projectDir, configFile: flags.config, flags })
  withMachine(config, STATE)
  // Load the local model now, so the first request it takes does not pay the load. Best effort.
  if (config.local.enabled && !flags.dryRun) for (const model of localModels(config)) warmLocal({ baseUrl: config.local.baseUrl, model, keepAlive: config.local.keepAlive })
  if (!docker) config.listen.host = '127.0.0.1'
  const runId = `ult-${path.basename(projectDir).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 24)}-${stamp()}`
  const runDir = flags.dryRun ? path.join(STATE, 'results', runId) : stateDir('results', runId)
  const key = projectKey(projectDir)
  const ctxDir = flags.dryRun ? path.join(STATE, 'ult', 'context') : stateDir('ult', 'context')
  const resolvedFile = path.join(runDir, 'ult.config.json')
  if (!flags.dryRun) fs.writeFileSync(resolvedFile, JSON.stringify({ agent, config, hash, sources, project: projectDir, runId }, null, 2))

  const cred = authOverride ?? launcherCredential(process.env, { secretReport })
  if (process.stdout.isTTY && !flags.dryRun) process.stdout.write(`\x1b]0;opthub ${agent} optimize · ${config.mode} · ${path.basename(projectDir)}\x07`)
  console.log(`${C.b}opt ${agent} optimize${C.x} ${C.d}${runId}${C.x}`)
  console.log(`  project   ${projectDir}`)
  console.log(`  sandbox   ${docker ? `docker · workspace ${flags.workspace}` : `${C.y}none (host mode — for development)${C.x}`}`)
  console.log(`  mode      ${config.mode === 'shadow' ? `shadow ${C.d}(decide and record, change nothing)${C.x}` : `${C.g}route${C.x}`}${config.policy.pin ? ` · pinned ${config.policy.pin}` : ''}`)
  console.log(`  local     ${config.local.enabled ? `${config.local.model} @ ${docker ? config.local.dockerBaseUrl : config.local.baseUrl}` : 'disabled'}`)
  const jevLocal = /\/\/(127\.0\.0\.1|localhost|host\.docker\.internal)/.test(config.classifier.jev.endpoint ?? '')
  console.log(`  jev       ${config.classifier.jev.enabled ? (jevLocal ? `on, ${config.classifier.jev.model} on local Ollama` : process.env.JEV_API_KEY ? 'on' : `${C.y}on, but JEV_API_KEY is not set — rules only${C.x}`) : 'off'}`)
  console.log(`  config    ${hash} ${C.d}${sources.map(s => path.relative(process.cwd(), s) || s).join(' → ')}${C.x}`)
  console.log(`  audit     ${path.join(runDir, 'audit.jsonl')}`)
  if (docker) {
    const what = cred ? (cred.kind === 'oauth' ? `Claude subscription ${C.d}(token from ${cred.source})${C.x}` : `${C.y}API key — bills API credits${C.x} ${C.d}(from ${cred.source})${C.x}`)
      : `${C.r}no ${authMode() === 'api-key' ? 'API key (AUTH_MODE=api-key)' : 'Claude subscription token'}${C.x}`
    console.log(`  auth      ${what} ${C.d}→ router only; the agent gets a dummy key${C.x}`)
  }

  return docker
    ? launchDocker({ flags, claudeArgs, config, projectDir, runId, runDir, resolvedFile, ctxDir, key, cred })
    : launchHost({ flags, claudeArgs, config, projectDir, runId, runDir, ctxDir, key, hash })
}

async function launchHost({ flags, claudeArgs, config, projectDir, runDir, ctxDir, key, hash }) {
  // Only this session gets the status line; the person's own settings are untouched.
  const settingsFile = path.join(runDir, 'claude-settings.json')
  const statusCmd = `node ${quote(path.join(PACKAGE_ROOT, 'lib', 'ult', 'statusline.mjs'))}`
  const args = ['--settings', settingsFile, ...(config.remote.defaultModel ? ['--model', config.remote.defaultModel] : []), ...claudeArgs]
  if (!flags.dryRun) fs.writeFileSync(settingsFile, JSON.stringify({ statusLine: { type: 'command', command: statusCmd, refreshInterval: 5 } }, null, 2))
  if (flags.dryRun) {
    console.log(`\n${C.d}# dry run — would start ULT in-process on 127.0.0.1:${config.listen.port}, then:${C.x}`)
    console.log(`ANTHROPIC_BASE_URL=http://127.0.0.1:${config.listen.port} claude ${args.map(quote).join(' ')}`)
    return 0
  }
  const logFile = path.join(runDir, 'ult.log')
  const logFd = fs.openSync(logFile, 'a')
  const ult = createUlt({ config, runDir, contextFile: path.join(ctxDir, `${key}.json`), configHash: hash, stateDir: STATE, log: (m) => fs.writeSync(logFd, `${new Date().toISOString()} ${m}\n`) })
  let addr
  try { addr = await ult.listen(config.listen.port, '127.0.0.1') } catch { addr = await ult.listen(0, '127.0.0.1') }
  console.log(`  router    http://127.0.0.1:${addr.port} ${C.d}(log ${logFile})${C.x}\n`)
  const code = await new Promise(resolve => {
    const child = spawn('claude', args, { cwd: projectDir, stdio: 'inherit', env: { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${addr.port}` } })
    child.on('exit', (c) => resolve(c ?? 0))
    child.on('error', (e) => { console.error(`${C.r}could not start claude: ${e.message}${C.x}`); resolve(127) })
  })
  await ult.close()
  fs.closeSync(logFd)
  printSummary(path.join(runDir, 'audit.jsonl'))
  return code
}

/** Async spawn, so the progress display keeps moving while Docker works. */
const run = (cmd, args, o = {}) => new Promise(resolve => {
  const c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...o })
  let stdout = '', stderr = ''
  c.stdout?.on('data', d => stdout += d); c.stderr?.on('data', d => stderr += d)
  c.on('close', status => resolve({ status, stdout, stderr }))
  c.on('error', e => resolve({ status: -1, stdout: '', stderr: e.message }))
})

/** Images, networks and the egress proxy; built or started only when missing. */
export async function ensureSandbox() {
  const [a, b, nets, ps] = await Promise.all([
    run('docker', ['image', 'inspect', IMAGE]), run('docker', ['image', 'inspect', 'opthub/egress:0.1']),
    run('docker', ['network', 'ls', '--format', '{{.Name}}']), run('docker', ['ps', '--format', '{{.Names}}']),
  ])
  let built = false, started = false
  if (a.status !== 0 || b.status !== 0) {
    const r = await run('bash', [SANDBOX_SH, 'build'])
    if (r.status !== 0) throw new Error(`sandbox image build failed:\n${r.stderr.slice(-800)}`)
    built = true
  }
  if (!nets.stdout.includes(NET_INT) || !nets.stdout.includes(NET_OUT) || !ps.stdout.split('\n').includes(PROXY)) {
    const r = await run('bash', [SANDBOX_SH, 'up'])
    if (r.status !== 0) throw new Error(`sandbox up failed:\n${r.stderr.slice(-800)}`)
    started = true
  }
  return { built, started }
}

async function prepareWorkspace(mode, projectDir, dest) {
  if (mode !== 'copy') return projectDir
  // APFS clone first (instant, no extra disk), plain copy otherwise. Includes uncommitted files.
  let r = await run('cp', ['-Rc', projectDir + '/.', dest])
  if (r.status !== 0) r = await run('cp', ['-R', projectDir + '/.', dest])
  if (r.status !== 0) throw new Error(`could not copy the workspace: ${r.stderr}`)
  return dest
}

/** Claude Code's first-run questions, answered, so the sandbox opens straight to the prompt. */
function seedHome(runDir, workdir) {
  const home = path.join(runDir, 'home')
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true, theme: 'dark', autoUpdates: false,
    customApiKeyResponses: { approved: [DUMMY_KEY.slice(-20)], rejected: [] },
    projects: { [workdir]: { hasTrustDialogAccepted: true, allowedTools: [] } },
  }, null, 2))
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
    cleanupPeriodDays: 3650,
    statusLine: { type: 'command', command: 'node /opt/opthub/statusline.mjs', refreshInterval: 5 },
  }, null, 2))
  return home
}

export function credentialHelp(cred, check) {
  const lines = [`the router's credential was rejected — ${check.status}${check.message ? `: ${check.message}` : ''}`,
    `  it is the ${cred.kind === 'oauth' ? 'Claude subscription token' : 'API key'} from ${cred.source}`]
  if (cred.kind === 'oauth') lines.push('  fix:',
    '    opt claude optimize login            new subscription token (claude setup-token), saved to the Keychain',
    '    opt claude optimize --auth           paste a subscription token or API key for this session (add --save to keep it)',
    '    opt claude optimize --sandbox host   no Docker; uses the claude you are already logged in to')
  else lines.push('  an API key bills API credits, not your Claude plan; the account needs credit.',
    '  To use your plan instead: opt claude optimize --auth   (paste a subscription token, sk-ant-oat…)')
  return lines.join('\n')
}

/**
 * `docker run` arguments for one LLM Ultra Light container: read-only, no capabilities, only the
 * router's own files mounted, the credential passed by name (its value is in the docker process's
 * environment only). Shared by the interactive launcher and `opt claude -p`.
 */
export function routerRunArgs({ name, owner, runDir, ctxDir, key, cred, port }) {
  return ['run', '-d', '--name', name, ...owner, '--label', 'opthub.role=ult',
    '--network', NET_OUT, '--add-host', 'host.docker.internal:host-gateway',
    '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '128', '--memory', '512m', '--user', '10001:10001', '--entrypoint', 'node',
    // Only the router's own files — never the whole package (it may hold .env files).
    '--mount', `type=bind,source=${path.join(PACKAGE_ROOT, 'ult.mjs')},target=/opt/opthub/ult.mjs,readonly`,
    '--mount', `type=bind,source=${path.join(PACKAGE_ROOT, 'lib', 'ult')},target=/opt/opthub/lib/ult,readonly`,
    '--mount', `type=bind,source=${path.join(PACKAGE_ROOT, 'lib', 'state.mjs')},target=/opt/opthub/lib/state.mjs,readonly`,
    '--mount', `type=bind,source=${path.join(PACKAGE_ROOT, 'config', 'ult.default.json')},target=/opt/opthub/config/ult.default.json,readonly`,
    '--mount', `type=bind,source=${runDir},target=/run/ult`,
    '--mount', `type=bind,source=${ctxDir},target=/ctx`,
    ...(cred?.env ? ['--env', cred.env] : []),
    '--env', `ULT_AUTH_MODE=${cred?.kind === 'api-key' ? 'api-key' : 'subscription'}`,
    ...(process.env.JEV_API_KEY ? ['--env', 'JEV_API_KEY'] : []),
    '--env', 'OPT_HOME=/tmp/opthub',
    IMAGE, '/opt/opthub/ult.mjs', '--config', '/run/ult/ult.config.json', '--run-dir', '/run/ult',
    '--context-file', `/ctx/${key}.json`, '--host', '0.0.0.0', '--port', String(port), '--in-docker']
}

async function launchDocker({ flags, claudeArgs, config, projectDir, runId, runDir, resolvedFile, ctxDir, key, cred }) {
  const id = runId.slice(-15).replace(/[^0-9a-z-]/gi, '')
  const ultName = `opthub-ult-${id}`, agentName = `opthub-agent-${id}`
  const port = config.listen.port
  const workdir = '/work/project'
  const wsCopy = path.join(SANDBOX_OUT, runId, 'project')
  const ws = flags.workspace === 'copy' ? wsCopy : projectDir

  const credEnv = cred?.env ?? null
  // Every container says which session and which launcher owns it, so orphans can be found.
  const ultAlias = `ult-${id}`
  const owner = ['--label', `opthub.session=${id}`, '--label', `opthub.launcher=${process.pid}@${os.hostname()}`]
  const ultRun = routerRunArgs({ name: ultName, owner, runDir, ctxDir, key, cred, port })

  // Created while the workspace copies and the router boots; started with the terminal attached.
  // The router's address goes into /etc/hosts: no shared name, no DNS lookup per connection.
  const agentCreate = (home, ultIp) => ['create', ...(process.stdin.isTTY ? ['-i', '-t'] : []), '--name', agentName,
    ...owner, '--label', 'opthub.role=agent', '--add-host', `${ultAlias}:${ultIp}`,
    '--network', NET_INT, '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m', '--tmpfs', '/home/agent:rw,nosuid,size=256m,uid=10001,gid=10001',
    '--mount', `type=bind,source=${ws},target=${workdir}${flags.workspace === 'ro' ? ',readonly' : ''}`,
    '--mount', `type=bind,source=${path.join(home, '.claude')},target=/home/agent/.claude`,
    '--mount', `type=bind,source=${path.join(home, '.claude.json')},target=/home/agent/.claude.json`,
    '--mount', `type=bind,source=${path.join(PACKAGE_ROOT, 'lib', 'ult', 'statusline.mjs')},target=/opt/opthub/statusline.mjs,readonly`,
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '512', '--memory', '4g', '--cpus', '4',
    '--env', 'HTTP_PROXY=http://egress:8888', '--env', 'HTTPS_PROXY=http://egress:8888',
    '--env', 'http_proxy=http://egress:8888', '--env', 'https_proxy=http://egress:8888',
    '--env', `NO_PROXY=localhost,127.0.0.1,${ultAlias}`, '--env', `no_proxy=localhost,127.0.0.1,${ultAlias}`,
    '--env', `ANTHROPIC_BASE_URL=http://${ultAlias}:${port}`, '--env', `ANTHROPIC_API_KEY=${DUMMY_KEY}`, '--env', 'CLAUDE_CODE_OAUTH_TOKEN=',
    '--env', 'DISABLE_AUTOUPDATER=1', '--env', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
    '--env', `TERM=${process.env.TERM ?? 'xterm-256color'}`, '--env', `COLORTERM=${process.env.COLORTERM ?? ''}`,
    '--workdir', workdir, '--entrypoint', 'claude',
    IMAGE, ...(config.remote.defaultModel ? ['--model', config.remote.defaultModel] : []), ...claudeArgs]

  if (flags.dryRun) {
    console.log(`\n${C.d}# dry run — resolved config${C.x}`)
    console.log(JSON.stringify(config, null, 2))
    console.log(`\n${C.d}# credential for the router: ${cred ? `${cred.kind} from ${credEnv}` : 'NONE — set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN (claude setup-token)'}${C.x}`)
    console.log(`${C.d}# 1. workspace${C.x}\n${flags.workspace === 'copy' ? `cp -Rc ${quote(projectDir)}/. ${quote(ws)}` : `# ${flags.workspace}: ${projectDir}`}`)
    console.log(`${C.d}# 2. router${C.x}\ndocker ${ultRun.map(quote).join(' ')}`)
    console.log(`docker network connect --alias ${ultAlias} ${NET_INT} ${ultName}`)
    console.log(`${C.d}# 3. Claude Code, your terminal attached${C.x}\ndocker ${agentCreate(path.join(runDir, 'home'), '<router-ip>').map(quote).join(' ')}`)
    console.log(`docker start -ai ${agentName}`)
    return 0
  }

  if (!cred) throw Object.assign(new Error(authMode() === 'api-key'
    ? 'AUTH_MODE=api-key but no ANTHROPIC_API_KEY is available'
    : 'the sandbox needs your Claude subscription token. Run once:\n    opt claude optimize login     (runs `claude setup-token`; billed to your plan, not API credits)\n  or skip Docker:  opt claude optimize --sandbox host   (uses the claude you are logged in to)'),
    { code: 'CREDENTIAL', kind: authMode() === 'api-key' ? 'api-key' : 'oauth' })
  if (flags.workspace === 'rw') console.log(`  ${C.y}workspace rw: the agent writes to your real checkout${C.x}`)
  console.log('')

  // Both containers go on every way out: normal exit, error, Ctrl-C, terminal closed, kill.
  // Removal takes ~5s on a busy Docker Desktop, so it runs detached and outlives this process;
  // `kill -9` is the one path it cannot catch, and the orphan sweep at the next start covers it.
  let removed = false
  const cleanup = () => {
    if (removed) return
    removed = true
    spawn('docker', ['rm', '-f', ultName, agentName], { detached: true, stdio: 'ignore' }).unref()
  }
  process.on('exit', cleanup)
  for (const [sig, code] of [['SIGTERM', 143], ['SIGHUP', 129]]) process.on(sig, () => { cleanup(); process.exit(code) })
  // Ctrl-C belongs to Claude Code while it runs; before that, it cancels the launch.
  let attached = false
  process.on('SIGINT', () => { if (!attached) { cleanup(); process.exit(130) } })

  const prog = new Progress(6)
  await Promise.all([
    prog.step('checking Docker', async () => {
      const r = await run('docker', ['version', '--format', '{{.Server.Version}}'])
      if (r.status !== 0) throw new Error('Docker is not running — start Docker Desktop, or use --sandbox host')
      const swept = await reapOrphans()
      return { version: r.stdout.trim(), swept }
    }, { doneLabel: v => `Docker ${v.version}${v.swept.length ? ` · removed ${v.swept.length} left-over container${v.swept.length > 1 ? 's' : ''}` : ''}` }),
    flags.skipAuthCheck
      ? prog.step('credential check skipped', async () => ({ ok: true }))
      : prog.step('checking the credential', async () => {
        const r = await verifyCredential(cred, config.remote.baseUrl)
        // Rejected: stop now, before any container is started for a session that cannot answer.
        if (!r.ok && ([401, 403].includes(r.status) || /credit balance/i.test(r.message ?? ''))) { prog.abort(); throw Object.assign(new Error(credentialHelp(cred, r)), { code: 'CREDENTIAL', kind: cred.kind }) }
        return r
      }, { doneLabel: r => r.ok ? `credential valid (${cred.kind})` : `credential not confirmed (${r.status || r.message}) — continuing` }),
  ])

  await prog.step('checking sandbox images and network', ensureSandbox,
    { doneLabel: r => r.built ? 'sandbox images built, network up' : r.started ? 'sandbox network started' : 'sandbox ready' })

  const home = seedHome(runDir, workdir)
  if (flags.workspace === 'copy') fs.mkdirSync(wsCopy, { recursive: true })   // a bind source must exist before `docker create`
  let routerIp
  const routerAttached = new Promise((resolve, reject) => { routerIp = { resolve, reject } })
  await Promise.all([
    prog.step('copying workspace', () => prepareWorkspace(flags.workspace, projectDir, wsCopy),
      { doneLabel: flags.workspace === 'copy' ? 'workspace copied' : `workspace ${flags.workspace} (no copy)` }),
    prog.step('starting router', async () => {
      // The chosen credential, by value, only in this docker process's environment.
      const env = { ...process.env, ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' }
      env[cred.env] = cred.value
      let r = await run('docker', ultRun, { env })
      if (r.status !== 0) { const e = new Error(`router container failed to start: ${r.stderr.trim()}`); routerIp.reject(e); throw e }
      r = await run('docker', ['network', 'connect', '--alias', ultAlias, NET_INT, ultName])
      if (r.status !== 0) { const e = new Error(`could not attach the router to ${NET_INT}: ${r.stderr.trim()}`); routerIp.reject(e); throw e }
      const ip = (await run('docker', ['inspect', '-f', `{{(index .NetworkSettings.Networks "${NET_INT}").IPAddress}}`, ultName])).stdout.trim()
      if (!ip) { const e = new Error('could not read the router address'); routerIp.reject(e); throw e }
      routerIp.resolve(ip)
      const probe = `fetch('http://127.0.0.1:${port}/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`
      for (let i = 0; i < 80; i++) {
        if ((await run('docker', ['exec', ultName, 'node', '-e', probe])).status === 0) return
        await new Promise(res => setTimeout(res, 125))
      }
      const logs = await run('docker', ['logs', ultName])
      throw new Error(`router did not become healthy:\n${logs.stdout}${logs.stderr}`)
    }, { doneLabel: 'router healthy' }),
    prog.step('creating sandbox container', async () => {
      const r = await run('docker', agentCreate(home, await routerAttached))
      if (r.status !== 0) throw new Error(`sandbox container failed: ${r.stderr.trim()}`)
    }, { doneLabel: 'sandbox container ready' }),
  ])
  prog.finish('starting Claude Code in the sandbox — your prompts go there now')

  attached = true
  const code = await new Promise(resolve => {
    const child = spawn('docker', ['start', '-ai', agentName], { stdio: 'inherit' })
    child.on('exit', (c) => resolve(c ?? 0))
    child.on('error', (e) => { console.error(e.message); resolve(1) })
  })
  const logs = await run('docker', ['logs', ultName])
  fs.writeFileSync(path.join(runDir, 'ult.log'), logs.stdout + logs.stderr)
  cleanup()
  printSummary(path.join(runDir, 'audit.jsonl'))
  console.log(`  ${C.d}cleanup   removing ${ultName} and ${agentName} (in the background)${flags.workspace === 'copy' ? '; the workspace copy is kept — it holds your changes' : ''}${C.x}`)
  if (flags.workspace === 'copy') {
    console.log(`\n  ${C.b}your changes${C.x} are in ${ws}`)
    if (fs.existsSync(path.join(projectDir, '.git'))) {
      console.log(`  ${C.d}review:${C.x} git -C ${quote(ws)} status`)
      console.log(`  ${C.d}bring back (after committing inside the copy):${C.x} git -C ${quote(projectDir)} fetch ${quote(ws)} HEAD:opthub/optimize-${id}`)
    } else console.log(`  ${C.d}compare:${C.x} diff -ru ${quote(projectDir)} ${quote(ws)}`)
  }
  return code
}

// ---------------------------------------------------------------- orphans
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }

/**
 * Containers whose session is over: labelled ones whose launcher process is gone (this host),
 * and unlabelled ones from before labels (a router with no agent, or an agent that has exited).
 * @returns {Promise<string[]>} names removed
 */
export async function reapOrphans({ dry = false } = {}) {
  const r = await run('docker', ['ps', '-a', '--filter', 'name=opthub-', '--format', '{{.Names}}|{{.State}}|{{.Label "opthub.launcher"}}|{{.Label "opthub.role"}}'])
  if (r.status !== 0) return []
  const rows = r.stdout.trim().split('\n').filter(Boolean).map(l => { const [name, state, launcher, role] = l.split('|'); return { name, state, launcher, role } })
    .filter(x => /^opthub-(ult|agent)-/.test(x.name))
  const host = os.hostname()
  const byId = (n) => n.replace(/^opthub-(ult|agent)-/, '')
  const orphan = rows.filter(x => {
    if (x.launcher) {
      const [pid, h] = x.launcher.split('@')
      return h === host && !alive(Number(pid))
    }
    if (x.name.startsWith('opthub-agent-')) return x.state !== 'running'
    return !rows.some(y => y.name === `opthub-agent-${byId(x.name)}` && y.state === 'running')
  }).map(x => x.name)
  if (orphan.length && !dry) spawn('docker', ['rm', '-f', ...orphan], { detached: true, stdio: 'ignore' }).unref()
  return orphan
}

async function cmdClean() {
  const gone = await reapOrphans()
  console.log(gone.length ? `removing ${gone.length} left-over container${gone.length > 1 ? 's' : ''}: ${gone.join(', ')}` : 'nothing to clean — no left-over optimize containers')
  console.log(`${C.d}workspace copies are kept (they hold changes): ${SANDBOX_OUT}${C.x}`)
  return 0
}

// ---------------------------------------------------------------- audit / status
const money = (n) => n == null ? '—' : `$${n.toFixed(n < 1 ? 4 : 2)}`

function printSummary(file) {
  if (!fs.existsSync(file)) return console.log(`\n  ${C.d}no requests were made${C.x}`)
  const e = readAudit(file), s = summarize(e), v = verifyAudit(file)
  console.log(`\n${C.b}ULT summary${C.x} ${C.d}${file}${C.x}`)
  console.log(`  requests  ${s.requests} · acted on ${s.acted} · fallbacks ${s.fallbacks} · errors ${s.errors} · chain ${v.ok ? `${C.g}ok${C.x}` : `${C.r}BROKEN at line ${v.brokenAt}${C.x}`}`)
  console.log(`  classes   ${Object.entries(s.byClass).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · ') || '—'}`)
  console.log(`  decisions ${Object.entries(s.byDecision).map(([k, n]) => `${k} ${n}`).join(' · ') || '—'}`)
  const would = e.filter(x => x.kind === 'request' && x.mode === 'shadow' && x.proposed && x.proposed.decision !== 'keep')
  if (would.length) console.log(`  shadow    would have acted on ${would.length}: ${Object.entries(would.reduce((a, x) => (a[`${x.proposed.decision} ${x.proposed.target}`] = (a[`${x.proposed.decision} ${x.proposed.target}`] ?? 0) + 1, a), {})).map(([k, n]) => `${k} ×${n}`).join(' · ')}`)
  console.log(`  cost      ${money(s.costUsd)} actual · ${money(s.counterfactualUsd)} on the requested models · saved ${money(s.counterfactualUsd - s.costUsd)} ${C.d}(priced from returned usage)${C.x}`)
}

function latestRun() {
  const dir = path.join(STATE, 'results')
  if (!fs.existsSync(dir)) return null
  const runs = fs.readdirSync(dir).filter(d => d.startsWith('ult-') && fs.existsSync(path.join(dir, d, 'audit.jsonl')))
    .map(d => ({ d, t: fs.statSync(path.join(dir, d, 'audit.jsonl')).mtimeMs })).sort((a, b) => b.t - a.t)
  return runs[0]?.d ?? null
}

function cmdAudit(flags) {
  const run = flags.positional[1] ?? latestRun()
  if (!run) { console.log('no optimize runs yet'); return 1 }
  const file = run.endsWith('.jsonl') ? run : path.join(STATE, 'results', run, 'audit.jsonl')
  if (!fs.existsSync(file)) { console.error(`no audit log at ${file}`); return 1 }
  if (flags.verify) {
    const v = verifyAudit(file)
    console.log(v.ok ? `${C.g}✓${C.x} ${v.entries} entries, hash chain intact` : `${C.r}✗ chain broken at line ${v.brokenAt}: ${v.reason}${C.x}`)
    return v.ok ? 0 : 30
  }
  if (flags.json) { console.log(JSON.stringify(summarize(readAudit(file)), null, 2)); return 0 }
  const entries = readAudit(file).filter(e => e.kind === 'request')
  console.log(`${C.d}seq  time      class                       src     decision  target${C.x}`)
  for (const e of entries.slice(-40)) {
    const t = (e.ts ?? '').slice(11, 19)
    const shadow = e.mode === 'shadow' && e.proposed && e.proposed.decision !== 'keep' ? ` ${C.d}(would ${e.proposed.decision} ${e.proposed.target})${C.x}` : ''
    console.log(`${String(e.seq).padStart(3)}  ${t}  ${String(e.class).padEnd(26)}  ${String(e.source).padEnd(6)}  ${String(e.decision).padEnd(8)}  ${e.target ?? ''}${shadow}`)
  }
  printSummary(file)
  return 0
}

async function cmdStatus() {
  const orphans = await reapOrphans({ dry: true })
  const r = sh('docker', ['ps', '-a', '--filter', 'name=opthub-', '--format', '{{.Names}}\t{{.Status}}'])
  const lines = (r.stdout ?? '').trim().split('\n').filter(l => /^opthub-(ult|agent)-/.test(l))
  console.log(lines.length ? lines.map(l => orphans.includes(l.split('\t')[0]) ? `${l}  ${C.y}left over — opt claude optimize clean${C.x}` : l).join('\n') : 'no optimize sessions running')
  const last = latestRun()
  if (last) console.log(`${C.d}latest run: ${last} — opt claude optimize audit ${last}${C.x}`)
  return 0
}

function cmdInstallCommand() {
  const src = path.join(PACKAGE_ROOT, 'template', 'claude', 'commands', 'optimize-live.md')
  const dest = path.join(os.homedir(), '.claude', 'commands', 'optimize-live.md')
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  if (fs.existsSync(dest) && fs.readFileSync(dest, 'utf8') !== fs.readFileSync(src, 'utf8')) {
    console.error(`${dest} exists and differs — not overwriting. Remove it first.`); return 1
  }
  fs.copyFileSync(src, dest)
  console.log(`installed /optimize-live → ${dest}`)
  return 0
}

/** y/N question on the terminal; Enter means yes. */
function confirm(question, dflt = true) {
  return new Promise((resolve) => {
    process.stdout.write(question)
    process.stdin.setRawMode?.(false)
    process.stdin.resume()
    process.stdin.once('data', (d) => {
      process.stdin.pause()
      const a = d.toString().trim()
      resolve(a ? /^y/i.test(a) : dflt)
    })
  })
}

/**
 * Hidden read of a pasted token. A long token can arrive wrapped over several lines and inside
 * bracketed-paste markers, so input is collected until the paste goes quiet after an Enter,
 * then escape sequences and all whitespace are removed (a token has none).
 */
export function cleanToken(raw) {
  return String(raw).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\s+/g, '')
}

function readSecret(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt)
    const stdin = process.stdin
    let buf = '', timer = null
    const finish = () => { stdin.setRawMode?.(false); stdin.pause(); stdin.off('data', onData); process.stdout.write('\n'); resolve(cleanToken(buf)) }
    const onData = (d) => {
      const text = d.toString('utf8')
      if (text.includes('\u0003')) { stdin.setRawMode?.(false); process.stdout.write('\n'); process.exit(130) }
      for (const ch of text) { if (ch === '\u007f') buf = buf.slice(0, -1); else buf += ch }
      clearTimeout(timer)
      // Enter ends input only once the paste has stopped arriving.
      if (/[\r\n]/.test(text) && cleanToken(buf)) timer = setTimeout(finish, 200)
    }
    stdin.setRawMode?.(true); stdin.resume(); stdin.on('data', onData)
  })
}

const fingerprint = (t) => `${t.slice(0, 14)}…${t.slice(-4)} (${t.length} chars)`

async function cmdLogin() {
  console.log(`${C.b}opt claude optimize login${C.x} — lets sandboxed sessions use your Claude subscription (billed to your plan, not API credits)\n`)
  console.log(`  ${C.d}1. running \`claude setup-token\` — follow its browser sign-in${C.x}\n`)
  const r = spawnSync('claude', ['setup-token'], { stdio: 'inherit' })
  if (r.status !== 0) { console.error(`${C.r}claude setup-token did not finish (exit ${r.status})${C.x}`); return 1 }
  const token = await readSecret(`\n  2. paste the whole token it printed (sk-ant-oat…; hidden, line breaks are fine), then Enter: `)
  if (!token) { console.error(`${C.r}no token entered${C.x}`); return 1 }
  console.log(`  received ${fingerprint(token)}`)
  if (!/^sk-ant-oat\d*-/.test(token)) console.log(`  ${C.y}that does not start like a subscription token (sk-ant-oat01-…) — compare it with what setup-token printed${C.x}`)
  const check = await verifyCredential({ kind: 'oauth', value: token })
  if (!check.ok) {
    console.error(`  ${C.y}Anthropic answered ${check.status || 'nothing'}${check.message ? `: ${check.message}` : ''}${C.x}`)
    if (check.status === 401) console.error(`  ${C.d}401 means the token itself is not accepted — usually a partial paste; the length above should match the printed token${C.x}`)
    if (!(await confirm(`  Save it anyway? [y/N] `, false))) return 1
  }
  storeToken(token)
  console.log(`  ${C.g}✓${C.x} saved to ${storedTokenLocation()}${check.ok ? ' · verified' : ` · ${C.y}saved unverified${C.x}`}`)
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) console.log(`  ${C.d}this token now takes precedence over CLAUDE_CODE_OAUTH_TOKEN in your shell or the repo's .env${C.x}`)
  return 0
}

// ---------------------------------------------------------------- main
export async function main(argv, { agent = 'claude', resolveSecrets = null } = {}) {
  if (!AGENTS[agent]) { console.error(`${C.r}opt ${agent} optimize: unknown agent. Supported: ${Object.keys(AGENTS).join(', ')}${C.x}`); return 2 }
  let parsed
  try { parsed = parseArgs(argv) } catch (e) { console.error(`${C.r}${e.message}${C.x}\n${USAGE}`); return 2 }
  const { flags, claudeArgs } = parsed
  if (flags.help) { console.log(USAGE); return 0 }
  const sub = flags.positional[0]
  if (sub === 'audit') return cmdAudit(flags)
  if (sub === 'status') return cmdStatus()
  if (sub === 'clean') return cmdClean()
  if (sub === 'install-command') return cmdInstallCommand()
  if (sub === 'login') return cmdLogin()
  if (sub === 'logout') { console.log(deleteStoredToken() ? `removed the subscription token from ${storedTokenLocation()}` : 'no stored subscription token'); return 0 }
  // --auth: an explicit credential for this session, ahead of the Keychain, .env and 1Password.
  let authOverride = null
  if (flags.auth) {
    let value
    if (flags.auth === 'prompt') {
      if (!process.stdin.isTTY) { console.error(`${C.r}--auth needs a terminal to ask; use --auth env:NAME or --auth -${C.x}`); return 2 }
      value = await readSecret(`  paste the token or API key (hidden, line breaks are fine), then Enter: `)
    } else if (flags.auth === '-') value = cleanToken(fs.readFileSync(0, 'utf8'))
    else if (flags.auth.startsWith('env:')) value = cleanToken(process.env[flags.auth.slice(4)] ?? '')
    else {
      value = cleanToken(flags.auth)
      console.error(`${C.d}note: a credential typed on the command line stays in your shell history — next time use --auth alone${C.x}`)
    }
    if (!value) { console.error(`${C.r}--auth: no credential given${C.x}`); return 2 }
    authOverride = credentialFromValue(value, flags.auth.startsWith('env:') ? `$${flags.auth.slice(4)} (--auth)` : '--auth')
    console.log(`  ${C.d}--auth: ${authOverride.kind === 'oauth' ? 'Claude subscription token' : 'API key'} ${fingerprint(value)}${C.x}`)
    // Host mode and the in-process router read the environment; the docker router gets it explicitly.
    process.env[authOverride.env] = value
    process.env.ULT_AUTH_MODE = authOverride.kind === 'api-key' ? 'api-key' : 'subscription'
    if (flags.save) { storeToken(value, authOverride.kind); console.log(`  ${C.g}✓${C.x} saved to ${storedTokenLocation(authOverride.kind)}${authOverride.kind === 'api-key' ? ` ${C.d}(used when AUTH_MODE=api-key)${C.x}` : ''}`) }
  }

  // Resolve op:// references only for a real docker launch (host mode uses the logged-in claude).
  let secretReport = null
  if (!authOverride && resolveSecrets && !flags.dryRun && flags.sandbox !== 'host' && !['audit', 'status', 'clean', 'install-command', 'login', 'logout'].includes(flags.positional[0])) {
    // Subscription mode needs no API key, so 1Password is never asked for one.
    const keys = authMode() === 'api-key' ? ['ANTHROPIC_API_KEY'] : (readStoredToken() ? [] : ['CLAUDE_CODE_OAUTH_TOKEN'])
    try { secretReport = keys.length ? resolveSecrets(keys) : null } catch (e) { console.error(`${C.r}${e.message}${C.x}`); return 1 }
  }
  try { return await launch(flags, claudeArgs, agent, secretReport, authOverride) }
  catch (e) {
    // Subscription token missing or rejected, at a terminal: offer the sign-in now, then continue.
    if (e.code === 'CREDENTIAL' && e.kind === 'oauth' && process.stdin.isTTY && process.stdout.isTTY) {
      console.error(`\n${C.y}${e.message.split('\n')[0]}${C.x}`)
      if (await confirm(`  Sign in with your Claude subscription now? [Y/n] `)) {
        if (await cmdLogin() !== 0) return 1
        console.log('')
        try { return await launch(flags, claudeArgs, agent, null) }
        catch (e2) { console.error(`\n${C.r}opt ${agent} optimize: ${e2.message}${C.x}`); return 1 }
      }
      console.error(`  ${C.d}later: opt claude optimize login   ·   or: opt claude optimize --sandbox host${C.x}`)
      return 1
    } console.error(`\n${C.r}opt ${agent} optimize: ${e.message}${C.x}`); return e.message.includes('Docker is not running') ? 20 : 1 }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(await main(process.argv.slice(2)))
