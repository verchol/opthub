// The repo is self-contained and the sandbox providers stay separate: only sandbox/e2b loads the
// E2B SDK, the providers never import the app, the app and the Python tools find the Docker
// provider in one place, and nothing points outside the checkout. No Docker, no network.
// Run: node sandbox/test.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let fails = 0
const ok = (name, cond, got) => { console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : `  got: ${JSON.stringify(got)}`}`); if (!cond) fails++ }

// what the repo holds: tracked files plus new ones git would add, never ignored output (results/, node_modules/, …)
const FILES = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: REPO, encoding: 'utf8' }).split('\n').filter(Boolean)
  .map((f) => path.join(REPO, f)).filter((f) => fs.existsSync(f))
const walk = (dir, exts) => FILES.filter((f) => f.startsWith(dir + path.sep) && exts.some((x) => f.endsWith(x)))
const rel = (p) => path.relative(REPO, p)
const code = walk(REPO, ['.mjs', '.ts', '.tsx', '.py', '.sh'])

console.log('\nthe E2B SDK')
const sdkUsers = code.filter((f) => /from ['"]e2b['"]|import\(['"]e2b['"]\)|require\(['"]e2b['"]\)/.test(fs.readFileSync(f, 'utf8'))).map(rel)
ok('only sandbox/e2b/index.mjs loads it', sdkUsers.length === 1 && sdkUsers[0] === 'sandbox/e2b/index.mjs', sdkUsers)
const e2b = await import('../sandbox/e2b/index.mjs')
ok('the provider loads without touching E2B', ['create', 'connect', 'list', 'kill'].every((k) => typeof e2b.Sandbox[k] === 'function'))
const saved = process.env.E2B_API_KEY; delete process.env.E2B_API_KEY
ok('no key: unavailable, and says why', (await e2b.available()).ok === false && /E2B_API_KEY/.test((await e2b.available()).why))
if (saved !== undefined) process.env.E2B_API_KEY = saved
ok('every template has its build context', Object.values(e2b.TEMPLATES).every((d) => fs.existsSync(path.join(d, 'e2b.Dockerfile'))))

console.log('\nthe Docker provider')
const docker = await import('../sandbox/docker/index.mjs')
ok('sandbox.sh and both images are there', ['sandbox.sh', 'Dockerfile.agent', 'Dockerfile.egress', 'allowlist.txt', 'tinyproxy.conf'].every((f) => fs.existsSync(path.join(docker.DIR, f))))
const rerun = fs.readFileSync(path.join(REPO, 'tools', 'rerun.py'), 'utf8')
ok('tools/rerun.py builds from the same directory', /SBX_DIR = .*"sandbox", "docker"\)/.test(rerun))
ok('no second copy under tools/', !fs.existsSync(path.join(REPO, 'tools', 'sandbox')))

console.log('\nthe boundary')
const providerImports = walk(path.join(REPO, 'sandbox'), ['.mjs']).filter((f) => /from ['"]\.\.\/\.\.\/app\/|from ['"]\.\.\/app\//.test(fs.readFileSync(f, 'utf8'))).map(rel)
ok('the providers never import the app', providerImports.length === 0, providerImports)

console.log('\nself-contained')
const outside = code.concat(walk(REPO, ['.md', '.json', '.rb'])).filter((f) => !f.endsWith('sandbox/test.mjs'))
  .flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').map((l, i) => [f, i + 1, l]))
  // the old implementation checkout, or anyone's home directory (the demo's /Users/demo and the sandboxes' own homes are fine)
  .filter(([, , l]) => /workspace\/sandbox\/e2b|\/(Users|home)\/(?!demo\b|someone\b|user\b|agent\b)[a-z][\w.-]*\//.test(l))
  .map(([f, n]) => `${rel(f)}:${n}`)
ok('no path into another checkout or a home directory', outside.length === 0, outside)
const links = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: REPO, encoding: 'utf8' }).split('\n').filter(Boolean)
  .map((f) => path.join(REPO, f)).filter((f) => { try { return fs.lstatSync(f).isSymbolicLink() } catch { return false } })
const escaping = links.filter((f) => { const t = path.resolve(path.dirname(f), fs.readlinkSync(f)); return !t.startsWith(REPO + path.sep) || !fs.existsSync(t) }).map(rel)
ok('every symlink resolves inside the repo', escaping.length === 0, escaping)

console.log(fails ? `\n${fails} failed\n` : '\nall passed\n')
process.exit(fails ? 1 : 0)
