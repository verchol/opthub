/**
 * The E2B provider: a microVM per arm, in E2B's cloud. The only module that loads the `e2b` SDK.
 *
 * `Sandbox` has the SDK's static methods (create, connect, list, kill), and loads the SDK on the
 * first call. So the hub and every `opt` command that never touches E2B start without the
 * package installed and without E2B_API_KEY.
 *
 * Templates (the images a sandbox boots from), each built with its own build.sh:
 *   harness/    the default arm: Claude Code + Python    (E2B_TEMPLATE, default harness-bench)
 *   kong/       Kong AI Gateway in front of Bedrock      (E2B_KONG_TEMPLATE)
 *   openmodel/  Ollama + an open-weights model
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DIR = path.dirname(fileURLToPath(import.meta.url))
export const TEMPLATES = { harness: path.join(DIR, 'harness'), kong: path.join(DIR, 'kong'), openmodel: path.join(DIR, 'openmodel') }

let sdk
async function load() {
  if (sdk) return sdk
  try { sdk = await import('e2b') } catch (e) {
    throw new Error(`the E2B provider needs the e2b package (npm install, at the repo root): ${e.message}`)
  }
  return sdk
}

export const Sandbox = {
  create: async (...a) => (await load()).Sandbox.create(...a),
  connect: async (...a) => (await load()).Sandbox.connect(...a),
  list: async (...a) => (await load()).Sandbox.list(...a),
  kill: async (...a) => (await load()).Sandbox.kill(...a),
}

/** Usable at all: the SDK installs and a key is set. Does not call E2B. */
export async function available() {
  if (!process.env.E2B_API_KEY) return { ok: false, why: 'E2B_API_KEY is not set' }
  try { await load(); return { ok: true } } catch (e) { return { ok: false, why: e.message } }
}
