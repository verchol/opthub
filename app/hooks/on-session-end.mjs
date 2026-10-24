#!/usr/bin/env node
// Claude Code Stop hook: record that a session ended, so the hub can surface it.
// The hub also scans transcripts directly, so this is a convenience signal, not a dependency.
import fs from 'node:fs'
import { STATE } from '../lib/state.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
let input = ''
process.stdin.on('data', (d) => (input += d)).on('end', () => {
  let ev = {}; try { ev = JSON.parse(input) } catch {}
  const line = JSON.stringify({ at: new Date().toISOString(), session_id: ev.session_id ?? null, cwd: ev.cwd ?? null }) + '\n'
  try { fs.appendFileSync(path.join(STATE, 'results', '.session-log.jsonl'), line) } catch {}
  process.exit(0)   // never block session end
})
