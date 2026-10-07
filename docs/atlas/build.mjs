// node build.mjs  ->  index.html (engine and data inlined, so the page needs no fetch)
import fs from 'node:fs'
const t = fs.readFileSync('template.html', 'utf8')
const engine = fs.readFileSync('engine.js', 'utf8')
const data = JSON.stringify(JSON.parse(fs.readFileSync('scenarios.json', 'utf8'))).replace(/<\//g, '<\\/')
fs.writeFileSync('index.html', t.replace('__ENGINE__', () => engine).replace('__DATA__', () => data))
console.log('wrote index.html', fs.statSync('index.html').size, 'bytes')
