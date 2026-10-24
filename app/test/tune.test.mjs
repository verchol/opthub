import { flagsFor, score, rank, SEARCH_SPACE, reasonerPrompt } from '../tune.mjs'

let fails = 0
const ok = (name, cond, got) => { console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : `  got: ${JSON.stringify(got)}`}`); if (!cond) fails++ }

console.log('\nflags built from the search space')
ok('stock config produces no flags', flagsFor({ id: 'x', model: 'opus' }).length === 0, flagsFor({ id: 'x', model: 'opus' }))
const f = flagsFor({ effort: 'medium', autocompact: '400000', excludeDynamicSystemPrompt: true,
                     strictMcpConfig: false, settingSources: 'project', tools: 'Bash Read Write Edit' })
ok('effort flag', f.includes('--effort medium'), f)
ok('autocompact flag', f.includes('--autocompact 400000'), f)
ok('boolean true becomes a bare flag', f.includes('--exclude-dynamic-system-prompt-sections'), f)
ok('boolean false is omitted', !f.some(x => x.includes('strict-mcp-config')), f)
ok('spaces are quoted', f.includes('--tools "Bash Read Write Edit"'), f)
const fa = flagsFor({ agents: { reviewer: { description: 'r', prompt: 'p', model: 'sonnet' } } })
ok('json knob is double-encoded for the shell', fa[0].startsWith('--agents "{') , fa)
ok('model is not a flag here (runBundle adds it)', !f.some(x => x.startsWith('--model')), f)
ok('every flagged knob in the space is reachable',
   Object.entries(SEARCH_SPACE).filter(([, v]) => v.flag).every(([k, v]) => {
     const val = v.kind === 'bool' ? true : v.kind === 'json' ? { a: 1 } : (v.values ? v.values.find(Boolean) : 'x')
     return flagsFor({ [k]: val }).some(s => s.startsWith(v.flag))
   }))

console.log('\nscoring and ranking')
const recs = [
  { id: 'a', grade: { passed: 69, total: 69 }, cost: 3.61, turns: 43, wallSec: 2178, usage: { output_tokens: 100, cache_read_input_tokens: 900 } },
  { id: 'b', grade: { passed: 69, total: 69 }, cost: 1.07, turns: 7, wallSec: 346 },
  { id: 'c', grade: { passed: 40, total: 69 }, cost: 0.20, turns: 3, wallSec: 100 },
  { id: 'd', fatal: 'sandbox died' },
  { id: 'e', grade: { total: 0 }, cost: 0.5 },
]
const s = recs.map(score)
const r = rank(s)
ok('correctness wins before cost', r[0].id === 'b', r.map(x => x.id))
ok('cost breaks a correctness tie', r[1].id === 'a', r.map(x => x.id))
ok('a worse pass rate loses to a dearer perfect run', r.indexOf(r.find(x => x.id === 'c')) > 1, r.map(x => x.id))
ok('fatal sinks to the bottom', r.at(-1).id === 'd', r.map(x => x.id))
ok('ungraded reports null, not zero', s.find(x => x.id === 'e').passRate === null)
ok('tokens summed when usage present', s.find(x => x.id === 'a').tokens === 1000, s.find(x => x.id === 'a').tokens)

console.log('\nthe reasoner prompt')
const p = reasonerPrompt({
  manifest: { task: { name: 'regex', title: 'a regex engine', file: 'rex.py' }, gradeable: true,
              fidelity: 'replay', fidelityNote: 'n', session: { intent: 'i' } },
  generations: [{ configs: [{ id: 'baseline', rationale: 'stock' }, { id: 'cheap', effort: 'medium', rationale: 'test effort' }],
                  scores: s.slice(0, 2) }],
  budget: '4', candidatesPerGen: 3, repeats: 1,
})
ok('names every knob it may move', Object.keys(SEARCH_SPACE).every(k => p.includes(k)))
ok('states the sample size', p.includes('1 run per candidate'))
ok('warns about noise at n=1', /not distinguishable from noise|inside the noise/.test(p))
ok('carries prior results forward', p.includes('cheap') && p.includes('69/69'))
ok('forbids inventing flags', /does not exist in Claude Code/.test(p))

const pu = reasonerPrompt({ manifest: { gradeable: false, fidelity: 'restart', fidelityNote: 'n', session: { intent: 'do a thing' } },
                            generations: [], budget: '4', candidatesPerGen: 3, repeats: 1 })
ok('says plainly when nothing can be graded', /NO — there is no test suite/.test(pu))

console.log(fails ? `\n${fails} failed\n` : '\nall passed\n')
process.exit(fails ? 1 : 0)
