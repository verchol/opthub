/**
 * Where the harness keeps what it produces.
 *
 * Run from a clone, that is the clone itself — results sit next to the code,
 * which is what every path in this repo has always assumed. Installed through a
 * package manager, the install directory is read-only (and replaced on upgrade),
 * so the caller sets OPT_HOME and results, tuning and exports go there instead.
 *
 *   OPT_HOME=~/.opthub opt experiments ls
 *
 * Only the four directories the harness writes to move. Assets it merely reads
 * — tasks/, flows/, config/, lib/ — stay with the code.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const STATE = process.env.OPT_HOME
  ? path.resolve(process.env.OPT_HOME.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'))
  : PKG

/** The package itself, for assets that ship with the code. */
export const PACKAGE_ROOT = PKG

/** The opthub checkout this package lives in: the Python tools, the scoring pipeline, sandbox/. */
export const REPO_ROOT = path.resolve(PKG, '..')

/** One .env for the whole repo, shared with tools/envfile.py (template: .env.example at the root).
 *  Installed, the checkout is read-only: $OPT_HOME/.env when that exists. */
export const ENV_FILE = process.env.OPT_HOME && fs.existsSync(path.join(STATE, '.env')) ? path.join(STATE, '.env') : path.join(REPO_ROOT, '.env')

/** `stateDir('results')` — created on demand, because callers assume it exists. */
export function stateDir(...parts) {
  const d = path.join(STATE, ...parts)
  try { fs.mkdirSync(d, { recursive: true }) } catch {}
  return d
}
