#!/usr/bin/env node
/**
 * LLM Ultra Light as a standalone process — what the ULT container runs.
 *
 *   node ult.mjs --config <resolved.json> --run-dir <dir> [--context-file <file>]
 *                [--host 0.0.0.0] [--port 8787] [--in-docker] [--quiet]
 *
 * `opt optimize` writes the resolved config and starts this; run it by hand to put the
 * router in front of any Anthropic client (ANTHROPIC_BASE_URL=http://host:port).
 */
import fs from 'node:fs'
import { createUlt } from './lib/ult/server.mjs'
import { validate } from './lib/ult/config.mjs'

const argv = process.argv.slice(2)
const opt = (name, dflt = null) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt }
const has = (name) => argv.includes(name)

const configFile = opt('--config')
const runDir = opt('--run-dir')
if (!configFile || !runDir) {
  console.error('usage: node ult.mjs --config <resolved.json> --run-dir <dir> [--context-file f] [--host h] [--port n] [--in-docker] [--quiet]')
  process.exit(2)
}
const resolved = JSON.parse(fs.readFileSync(configFile, 'utf8'))
const config = validate(resolved.config ?? resolved)
const port = Number(opt('--port', config.listen.port))
const host = opt('--host', config.listen.host)

const ult = createUlt({
  config, runDir,
  contextFile: opt('--context-file'),
  inDocker: has('--in-docker'),
  configHash: resolved.hash ?? null,
  log: has('--quiet') ? () => {} : (m) => console.log(`[ult] ${m}`),
})
const addr = await ult.listen(port, host)
console.log(`[ult] listening on ${addr.address}:${addr.port} · mode ${config.mode} · audit ${ult.auditFile}`)

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await ult.close(); process.exit(0) })
