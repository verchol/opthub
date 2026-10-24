/**
 * שנה טובה detector — the hub's one unserious lever, and the only one that
 * pays for itself immediately.
 *
 * Around Rosh Hashanah a particular request shows up: *make me a New Year card
 * with pomegranates*. It is a perfectly reasonable thing to want. It is also a
 * thing this agent cannot do — Claude Code writes files, it does not generate
 * images — so the session always ends the same way: some turns of the model
 * explaining that, then offering to hand-write you an SVG of a pomegranate.
 *
 * That offer is where the money goes. The detector prices the explanation.
 *
 * Everything below is measured from the session's own transcript. The joke is
 * that the arithmetic is real.
 *
 *   node lib/shana-tova.mjs "draw me a shana tova card with pomegranates"
 */

const SIGNALS = {
  greeting: [
    /\bshanah?\s*tovah?\b/i, /\bl'?shanah?\s*tovah?\b/i,
    /\brosh\s*hashan\w*/i, /\bjewish\s*new\s*year\b/i,
    /\bhigh\s*holidays?\b/i, /\byamim\s*noraim\b/i,
    /שנה\s*טובה/, /ראש\s*השנה/, /גמר\s*חתימה\s*טובה/,
  ],
  image: [
    /\bimages?\b/i, /\bpictures?\b/i, /\b(greeting\s*)?cards?\b/i, /\bposters?\b/i,
    /\bdraw\b/i, /\billustrat\w*/i, /\bgraphics?\b/i, /\bwallpaper\b/i,
    /\bgenerate\b[^.]{0,30}\b(png|jpe?g|svg|art)\b/i, /\bdall[\s-]?e\b/i, /\bmidjourney\b/i,
    /תמונה/, /כרטיס\s*ברכה/, /ברכה/, /לצייר/,
  ],
  motif: [
    /\bpomegranates?\b/i, /\bapples?\s*(and|&|with|in)\s*honey\b/i, /\bhoney\b/i,
    /\bshofars?\b/i, /\brams?\s*horn\b/i, /\bchallah\b/i, /\bdates?\s*and\s*figs\b/i,
    /רימון/, /רימונים/, /תפוח/, /דבש/, /שופר/, /חלה/,
  ],
}

const hits = (text, list) => list.filter((re) => re.test(text)).length

/** Does this request want a New Year card the agent cannot draw? */
export function detect(text = '') {
  const t = String(text)
  const g = hits(t, SIGNALS.greeting), i = hits(t, SIGNALS.image), m = hits(t, SIGNALS.motif)
  // greeting alone is a nice thing to say; greeting + image is a bill
  const hit = g > 0 && (i > 0 || m > 0)
  const confidence = Math.min(1, (g * 0.5 + i * 0.3 + m * 0.2))
  return { hit, confidence: +confidence.toFixed(2), greeting: g, image: i, motif: m }
}

const VERDICTS = [
  { over: 5, text: 'This is the most expensive pomegranate ever rendered.' },
  { over: 1, text: 'You could have bought actual honey.' },
  { over: 0.2, text: 'Roughly one supermarket apple. Fair enough.' },
  { over: 0, text: 'Cheap enough to be sincere.' },
]

/**
 * Price the attempt. Every number here is the session's own — the only invented
 * part is the unit, and a card is a perfectly good unit.
 */
export function priceIt(session, det = detect(session?.intent)) {
  if (!det.hit) return null
  const cost = session?.cost ?? 0
  // an "attempt" is a tool-using turn: each one is the model trying again
  const attempts = Math.max(1, Math.round((session?.turns ?? 1) / 3))
  const perCard = cost / attempts
  const verdict = VERDICTS.find((v) => cost > v.over)?.text ?? VERDICTS[VERDICTS.length - 1].text
  return {
    cost, attempts, perCard,
    // 100g of pomegranate seeds, give or take, at a supermarket
    pomegranates: cost / 3.5,
    honeyJars: cost / 6.0,
    verdict,
    note: 'Claude Code writes files; it does not generate images. What this session bought was '
        + 'the conversation in which that becomes clear, plus — if it got that far — a hand-authored SVG '
        + 'of a pomegranate. Which is arguably more thoughtful than a stock photo.',
    wish: 'שנה טובה ומתוקה',
  }
}

/** The whole feature in one call, for a session record. */
export function shanaTova(session) {
  const det = detect(session?.intent)
  if (!det.hit) return null
  return { ...det, ...priceIt(session, det) }
}

// ------------------------------------------------------------------ cli
if (import.meta.url === `file://${process.argv[1]}`) {
  const text = process.argv.slice(2).join(' ')
  if (!text) { console.log('usage: node lib/shana-tova.mjs "<prompt>"'); process.exit(1) }
  const det = detect(text)
  console.log(`\n  "${text}"\n`)
  console.log(`  greeting signals ${det.greeting} · image ${det.image} · motif ${det.motif}`)
  console.log(`  verdict: ${det.hit ? `New Year card attempt (confidence ${det.confidence})` : 'not a card attempt'}\n`)
  if (det.hit) {
    const p = priceIt({ intent: text, cost: 2.4, turns: 9 }, det)
    console.log(`  on a $${p.cost.toFixed(2)} / ${9}-turn session that would be:`)
    console.log(`    ${p.attempts} attempt(s) · $${p.perCard.toFixed(2)} per card`)
    console.log(`    ${p.pomegranates.toFixed(1)} actual pomegranates · ${p.honeyJars.toFixed(1)} jars of honey`)
    console.log(`    ${p.verdict}\n    ${p.wish}\n`)
  }
}
