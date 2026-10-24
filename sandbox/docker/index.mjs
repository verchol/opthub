/**
 * The Docker provider: a local container with a read-only source mount, one writable directory,
 * no capabilities, and no route out except an allowlisting proxy. See README.md for what it
 * guarantees and how each guarantee is verified (`./sandbox.sh verify`).
 *
 * The images and the proxy are shared with tools/rerun.py, which drives the same names from
 * Python: opthub/agent:0.1, opthub/egress:0.1.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DIR = path.dirname(fileURLToPath(import.meta.url))
/** build | verify | run <dir> | shell <dir> | down */
export const SANDBOX_SH = path.join(DIR, 'sandbox.sh')
export const ALLOWLIST = path.join(DIR, 'allowlist.txt')
