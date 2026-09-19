# opthub — four-terminal demo mock

**Status:** v0.1 · **Date:** 2026-08-25 · **Target:** Lovable (paste this whole file as the prompt)

---

## 0. What to build, in one paragraph

A single-page React app that looks like a developer's screen split into **four terminal panes**. It
plays a **scripted, pre-recorded demo** of a 22-minute coding session: the developer works in pane 1,
and opthub shadows that work in panes 2–4 to find, prove, and price optimizations. **Nothing calls a
real API.** Every character of output is fixed data in one file. The app is a player: it types the
script out on a timeline with play/pause, speed, and per-beat scrubbing.

Build it as **Vite + React + TypeScript + Tailwind + Recharts**. No backend, no auth, no router. All
demo content lives in `src/demo/script.ts` so it can be edited without touching components.

---

## 1. Layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  opthub demo          ⏸ ▶  1× 2× 4×    ● ● ● ● ●   beat 3/5 · migration      │  56px control bar
├───────────────────────────────────┬──────────────────────────────────────────┤
│ ① MAIN                       LIVE │ ② EXPERIMENT                  SHADOWING  │
│ ~/acme-api — claude               │ ~/acme-api — claude · /experiment         │
│                                   │                                          │
│   day-to-day coding session       │   same prompt, optimized, side-by-side    │
│   real work, real cost            │   + rate-this card                       │
│                                   │                                          │
├───────────────────────────────────┼──────────────────────────────────────────┤
│ ③ ADMIN                  ANALYZING│ ④ CHEAPEST                     UNGATED   │
│ opthub admin                      │ ~/acme-api — claude --no-gates            │
│                                   │                                          │
│   charts + attribution report     │   floor price, gates off                 │
│   (renders chart cards inline)    │   ⚠ shows where quality breaks           │
│                                   │                                          │
└───────────────────────────────────┴──────────────────────────────────────────┘
```

- 2×2 CSS grid, fills the viewport, `100dvh`, no page scroll.
- Each pane scrolls **its own** scrollback independently and auto-sticks to the bottom as lines
  arrive. If the user scrolls up in a pane, stop auto-sticking until they scroll back down.
- Below 1100px wide, stack to 1 column and let the page scroll; panes get `min-height: 70vh`.
- A 1px gap between panes shows the page plane through, so the four read as separate windows.

### Pane chrome

Each pane is a window: a 32px title bar with three 10px traffic-light dots
(`#FF5F57 #FEBC2E #28C840`, at 45% opacity so they read as decoration), the title in
`text-secondary`, and a **status chip** pinned right. The chip color is the pane's accent; it pulses
(1.6s ease-in-out opacity 0.55→1) only while that pane is actively emitting.

| Pane | Title | Chip | Accent |
|---|---|---|---|
| ① MAIN | `~/acme-api — claude` | `LIVE` | `#3987e5` blue |
| ② EXPERIMENT | `~/acme-api — claude · /experiment` | `SHADOWING` | `#9085e9` violet |
| ③ ADMIN | `opthub admin` | `ANALYZING` | `#199e70` aqua |
| ④ CHEAPEST | `~/acme-api — claude --no-gates` | `UNGATED` | `#c98500` yellow |

The accent tints only the chrome — title-bar bottom border, chip, and the pane's left edge (2px).
Terminal body text uses the ink tokens below, never the accent.

---

## 2. Visual system

Dark only. This is a terminal mock; do **not** build a light mode.

```css
:root {
  /* planes */
  --page:          #0d0d0d;   /* behind the grid */
  --pane:          #131312;   /* terminal body */
  --pane-bar:      #1a1a19;   /* title bar + chart cards */
  --hairline:      rgba(255,255,255,0.10);
  --grid:          #2c2c2a;

  /* ink */
  --text-primary:  #ffffff;
  --text-secondary:#c3c2b7;
  --text-muted:    #898781;

  /* terminal roles */
  --prompt:        #199e70;   /* the ›  glyph and the typed prompt */
  --tool:          #3987e5;   /* ⏺ Read( … ) tool-call lines */
  --result:        #898781;   /* ⎿  tool result lines */
  --assistant:     #c3c2b7;   /* Claude's prose */
  --metric:        #898781;   /* the ── 47,200 tok · $0.94 footer */
  --add:           #0ca30c;   /* +38 in a diff stat */
  --del:           #d03b3b;   /* -6  in a diff stat */

  /* status — fixed, never themed, never reused as a series color */
  --good:          #0ca30c;
  --warning:       #fab219;
  --serious:       #ec835a;
  --critical:      #d03b3b;
}
```

**Type.** Body text in `ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace` at 12.5px /
1.55. Titles and chips at 11px, `letter-spacing: 0.04em`, uppercase for chips only. Chart labels and
the admin report use the same mono — it is a terminal.

**Motion.** Prompts type character-by-character at 16ms/char. Output arrives line-by-line at
34ms/line, with the delays given in the script overriding that for dramatic pauses. A 7px × 15px
block cursor (`--prompt`, blinking 1.1s step-end) sits at the end of whichever pane is currently
typing. Everything scales by the speed multiplier. Respect `prefers-reduced-motion`: skip typing,
render each line instantly, keep the timeline.

---

## 3. The control bar

Left: `opthub demo` wordmark in `--text-secondary`.

Center: `▶ / ⏸` toggle, `⟲` restart, and a speed segmented control `1× 2× 4×` (default 1×).

Right: five beat dots. The current dot is filled with `--text-primary`, past beats
`--text-secondary`, future beats `--grid`. Clicking a dot jumps to the **start of that beat** with
all prior beats' output already rendered in the scrollback (do not replay them). To the right of the
dots, the current beat number and title in `--text-muted`.

Keyboard: `space` play/pause, `←/→` previous/next beat, `r` restart.

Autoplay on load, after a 900ms settle.

---

## 4. Timeline model

The demo is **5 beats**. Each beat is one prompt the developer types in MAIN, mirrored into the other
three panes. Events carry an absolute offset in ms **from the start of their own beat**, so cross-pane
choreography is explicit:

```ts
type PaneId = 'main' | 'experiment' | 'admin' | 'cheapest';

type LineKind =
  | 'prompt'      // "› add idempotency keys…"  — types character by character
  | 'tool'        // "⏺ Read(src/routes/payments.ts)"
  | 'result'      // "  ⎿  312 lines"
  | 'text'        // Claude's prose, indented 2
  | 'diff'        // "⏺ Update(src/db/schema.ts)   +11 -0"  — colorize +n/-n
  | 'metric'      // "── 47,200 tok in · 1,840 out · $0.94 · 38s"
  | 'warn'        // "⚠ diverges from main: …"           — --warning
  | 'critical'    // "✖ missed finding: …"                — --critical
  | 'ok'          // "✔ gate passed: …"                   — --good
  | 'header'      // "── beat 1 ────────────────────"     — --text-muted rule
  | 'rate'        // renders the RateCard component
  | 'chart';      // renders a chart card; `text` is the chart id

interface DemoEvent {
  pane: PaneId;
  at: number;          // ms from beat start
  kind: LineKind;
  text: string;
  hold?: number;       // extra ms to wait after this line before the next
}

interface Beat {
  id: number;
  title: string;       // shown in the control bar
  events: DemoEvent[];
}
```

The player keeps one clock. On each frame it emits every event whose `at ≤ elapsed` into its pane's
scrollback. A beat ends when its last event has finished typing plus 1200ms; then the next beat
starts. After beat 5, hold on the final admin report for 4s, then show a subtle `⟲ replay` affordance
centered in the control bar. Do not loop automatically.

---

## 5. The scripted session

The developer is fixing a production incident in `acme-api`, a Node/TypeScript payments service.

| Beat | Prompt | Shape | Point it makes |
|---|---|---|---|
| 1 | idempotency keys | agentic edit, 47k ctx | Caching is where the money is |
| 2 | flaky checkout test | debugging, long history | Pruning wins — and a human rates it *worse* |
| 3 | write the migration | short, mechanical | Cheap model is genuinely fine here |
| 4 | security review of the diff | quality-critical, 2.6× cost | Gates **block** the downgrade; cheapest misses a real bug |
| 5 | PR description | trivial | Routing is obviously right |

Per-beat cost, which every chart and report must agree with:

| Beat | ① MAIN | ② EXPERIMENT | ④ CHEAPEST |
|---|---:|---:|---:|
| 1 | $0.94 | $0.31 | $0.06 |
| 2 | $0.71 | $0.24 | $0.05 |
| 3 | $0.18 | $0.06 | $0.02 |
| 4 | $2.61 | $0.90 | $0.21 |
| 5 | $0.38 | $0.12 | $0.04 |
| **Session** | **$4.82** | **$1.63** | **$0.38** |

Cumulative series for the chart: MAIN `[0.94, 1.65, 1.83, 4.44, 4.82]`, EXPERIMENT
`[0.31, 0.55, 0.61, 1.51, 1.63]`, CHEAPEST `[0.06, 0.11, 0.13, 0.34, 0.38]`.

---

### Beat 1 — idempotency keys

**① MAIN** (`at: 0`)

```
› add idempotency keys to POST /v1/payments — the retry storm last night
  double-charged 14 customers

⏺ Read(src/routes/payments.ts)
  ⎿  312 lines
⏺ Grep(pattern: "idempotenc", path: "src")
  ⎿  0 matches
⏺ Read(src/db/schema.ts)
  ⎿  188 lines
⏺ Read(src/middleware/index.ts)
  ⎿  94 lines

  Nothing in the request path dedupes. Two retries 40ms apart both clear the
  balance check before either writes. I'll add a claim row with a unique
  constraint inside the charge transaction, so the second insert fails fast
  and returns the stored response instead of charging again.

⏺ Update(src/db/schema.ts)              +11 -0
⏺ Update(src/routes/payments.ts)        +38 -6
⏺ Write(src/middleware/idempotency.ts)  +52
⏺ Bash(npm test -- payments)
  ⎿  24 passed, 0 failed  (4.1s)

── 47,200 tok in · 1,840 out · $0.94 · 38s
```

**② EXPERIMENT** (`at: 2600` — starts once MAIN's prompt has finished typing)

```
› /experiment
⏺ attached to pane 1 (main) · shadowing every prompt
  Read-only mount. Nothing here touches your working tree.

── beat 1 ─────────────────────────────────────────────────
◆ shadowed: "add idempotency keys to POST /v1/payments…"

⏺ candidates for this prompt shape  [agentic-edit · 47.2k ctx]
     [T0] cache-priming         31.4k byte-stable prefix, uncached
     [T1] context-pruning       6 stale tool results · 8.1k tok
     [T1] tool-schema-slimming  18 of 22 tools unused in this trace
     [T2] model-routing         blocked — trace edits source files

⏺ applying T0 · replaying prompt
  ⎿  cache_creation_input_tokens   31400
  ⎿  cache_read_input_tokens           0    cold — first of session
✔ gate: token-identical prompt · accuracy check not required for T0

── 44,100 tok in · 1,790 out · $0.31 · 34s
   saving vs main  −$0.63  (−67.0%)
```

then the rate card (`kind: 'rate'`), which resolves to `tie` after 3.2s.

**④ CHEAPEST** (`at: 9200`)

```
› claude --model claude-haiku-4-5 --all-optimizers --no-gates
◆ replaying beat 1

⏺ Read(src/routes/payments.ts)
⏺ Update(src/routes/payments.ts)   +21 -3

  Added an in-memory Map keyed by request id to skip duplicates.

── 39,100 tok in · 610 out · $0.06 · 11s
⚠ diverges from main — in-memory dedupe is per-process and does not
  survive a restart. The retry storm hit 3 pods.
```

**③ ADMIN** (`at: 14000`) — quiet in beat 1, one line only:

```
⏺ session opthub/sess_4f21 · recording · 1 prompt · $0.94 actual
```

---

### Beat 2 — the flaky test (and a rating that goes against opthub)

**① MAIN**

```
› the checkout e2e test has failed 3 of the last 20 CI runs, always on
  "applies promo before tax". find it

⏺ Bash(gh run list --workflow=e2e --limit 20 --json conclusion,databaseId)
  ⎿  20 runs · 3 failure
⏺ Bash(gh run view 8842119 --log-failed | tail -80)
  ⎿  61 lines
⏺ Read(test/e2e/checkout.spec.ts)
  ⎿  240 lines
⏺ Read(src/pricing/promo.ts)
  ⎿  156 lines

  The test seeds a promo with `validUntil: Date.now() + 1000`. On a slow
  runner the assertion lands after expiry, so the promo silently drops and
  tax is computed on the full amount. It is the fixture that is flaky, not
  the pricing code.

⏺ Update(test/e2e/checkout.spec.ts)   +4 -2
⏺ Bash(npm run test:e2e -- --repeat-each=20 checkout)
  ⎿  20 passed, 0 failed  (61s)

── 38,900 tok in · 1,120 out · $0.71 · 44s
```

**② EXPERIMENT**

```
── beat 2 ─────────────────────────────────────────────────
◆ shadowed: "the checkout e2e test has failed 3 of the last 20…"

⏺ candidates  [debug · 38.9k ctx · 11 tool results]
     [T0] cache-priming         prefix warm from beat 1
     [T1] context-pruning       9.4k tok of superseded log tails
     [T2] model-routing         blocked — never_downgrade: debug

⏺ applying T0+T1 · replaying prompt
  ⎿  cache_read_input_tokens    31400    ← warm
  ⎿  input_tokens                4900
✔ gate: eval 0.96 → 0.96 · latency TTFT −64% · total −9%

── 36,300 tok in · 1,090 out · $0.24 · 39s
   saving vs main  −$0.47  (−66.2%)
```

Rate card resolves to **`A better`** after 3.4s, then:

```
◆ recorded: human prefers main on this prompt
  B dropped the CI log tail that named run 8842119. Same conclusion,
  weaker citation.
⚠ context-pruning flagged for review on debug-shaped prompts
```

This is the most important 20 seconds of the demo — it shows the loop recording a loss.

**④ CHEAPEST**

```
◆ replaying beat 2
⏺ Read(test/e2e/checkout.spec.ts)
  Suggested adding `await page.waitForTimeout(500)` before the assertion.
── 31,200 tok in · 380 out · $0.05 · 8s
⚠ diverges from main — masks the race instead of fixing the fixture.
```

**③ ADMIN** — still quiet: `⏺ 2 prompts · $1.65 actual · $0.55 optimized · 1 rating against`

---

### Beat 3 — the migration (cheap model is right)

**① MAIN**

```
› write the migration for the idempotency_claims table

⏺ Read(migrations/0031_add_refund_reason.sql)
  ⎿  22 lines
⏺ Write(migrations/0032_idempotency_claims.sql)   +18
── 9,400 tok in · 420 out · $0.18 · 9s
```

**② EXPERIMENT**

```
── beat 3 ─────────────────────────────────────────────────
◆ shadowed: "write the migration for the idempotency_claims table"

⏺ candidates  [mechanical · 9.4k ctx · 0 branches]
     [T0] cache-priming         warm
     [T2] model-routing         candidate — claude-haiku-4-5
                                classifier: easy (p=0.94)

⏺ T2 requires approval · replaying on haiku for evidence only
✔ gate: eval 0.97 → 0.97 · output byte-identical to main
── 8,900 tok in · 410 out · $0.06 · 4s
   saving vs main  −$0.12  (−66.7%)
```

Rate card resolves to **`B better`** ("same SQL, 5s faster").

**④ CHEAPEST**

```
◆ replaying beat 3
⏺ Write(migrations/0032_idempotency_claims.sql)   +18
── 8,900 tok in · 410 out · $0.02 · 4s
✔ matches main
```

**③ ADMIN** — first chart. The operator types a query:

```
› show me actual vs optimized so far

⏺ [chart: cumulative]
  3 prompts · actual $1.83 · optimized $0.61 · floor $0.13
```

---

### Beat 4 — security review (the gates earn their keep)

**① MAIN**

```
› review the whole diff for security issues before I open the PR

⏺ Bash(git diff main --stat)
  ⎿  7 files changed, 143 insertions(+), 17 deletions(-)
⏺ Bash(git diff main)
  ⎿  1,204 lines
⏺ Read(src/middleware/idempotency.ts)
⏺ Read(src/routes/payments.ts)
⏺ Grep(pattern: "req.headers\[", path: "src")
  ⎿  6 matches

  Three findings, one of them real:

  1. HIGH — the idempotency key is taken straight from a client header and
     used as a primary key with no length bound. A 2MB header pins a 2MB
     row and the unique index degrades. Bound it to 255 and reject longer.
  2. MEDIUM — the stored response is replayed verbatim, including the
     Set-Cookie from the original request. Strip it on replay.
  3. LOW — claims are never reaped. Add a TTL sweep.

⏺ Update(src/middleware/idempotency.ts)   +14 -2
── 96,400 tok in · 3,210 out · $2.61 · 71s
```

**② EXPERIMENT**

```
── beat 4 ─────────────────────────────────────────────────
◆ shadowed: "review the whole diff for security issues…"

⏺ candidates  [review · 96.4k ctx · quality-critical]
     [T0] cache-priming         warm · 31.4k read
     [T1] context-pruning       4.2k tok — capped, review needs history
     [T1] prompt-compaction     REJECTED · eval 0.96 → 0.89
     [T2] model-routing         BLOCKED · policy never_downgrade: security

⏺ applying T0+T1(capped) · replaying prompt
✔ gate: eval 0.96 → 0.96 · all 3 findings reproduced, same severities
── 71,800 tok in · 3,180 out · $0.90 · 63s
   saving vs main  −$1.71  (−65.5%)

◆ T2 was worth an estimated −$0.44 here and was not taken.
  never_downgrade is doing the work the eval cannot: a review that
  misses a finding scores fine on 50 samples.
```

Rate card resolves to **`tie`**.

**④ CHEAPEST** — the payoff:

```
◆ replaying beat 4  [gates disabled]
⏺ Bash(git diff main)
⏺ Read(src/middleware/idempotency.ts)

  Two findings:
  1. MEDIUM — replayed response includes the original Set-Cookie.
  2. LOW — claims are never reaped.

── 58,300 tok in · 940 out · $0.21 · 19s
✖ missed HIGH — unbounded client-controlled idempotency key
  Cost $0.21 instead of $2.61. Shipped the incident.
```

Render that `✖` line in `--critical` with an icon **and** the word `missed`, and let it sit for a
long `hold` (2400ms). It is the thesis of the demo.

**③ ADMIN**

```
› why didn't routing apply on beat 4

⏺ policy: workloads.review.never_downgrade = true
  estimated forgone saving  −$0.44
  pane 4 ran it anyway and lost 1 of 3 findings (HIGH)
  → this is the trade the policy file refuses to make silently
```

---

### Beat 5 — the PR description

**① MAIN**

```
› write the PR description
⏺ Bash(git log main..HEAD --oneline)
  ⎿  6 commits
⏺ Write(.github/PULL_REQUEST_TEMPLATE_filled.md)   +34
── 21,600 tok in · 780 out · $0.38 · 12s
```

**② EXPERIMENT**

```
── beat 5 ─────────────────────────────────────────────────
◆ shadowed: "write the PR description"
⏺ candidates  [summarize · 21.6k ctx]
     [T0] cache-priming    warm
     [T2] model-routing    candidate — claude-haiku-4-5 (p=0.97)
✔ gate: eval 0.95 → 0.95
── 19,800 tok in · 760 out · $0.12 · 7s
   saving vs main  −$0.26  (−68.4%)
```

**④ CHEAPEST**

```
◆ replaying beat 5
── 19,800 tok in · 760 out · $0.04 · 6s
✔ matches main
```

**③ ADMIN** — the finale. Operator types:

```
› report
```

and the pane renders, in order: the attribution waterfall chart, the per-beat table, then this text
block, each with a `hold` so it reads as a report being assembled:

```
── opthub session report · sess_4f21 ──────────────────────
  22m 41s · 5 prompts · claude-opus-5

  actual                                          $4.82
  optimized, all gates passed                     $1.63    −66.2%
  ungated floor (pane 4)                          $0.38    −92.1% ✖

  ATTRIBUTION — marginal, in applied order
    [T0] cache-priming            −$2.41   −50.0%   auto
    [T1] context-pruning          −$0.51   −21.2%   auto · 1 flag
    [T1] tool-schema-slimming     −$0.09    −4.7%   auto
    [T2] model-routing            −$0.18    −9.9%   NEEDS APPROVAL
    [T1] prompt-compaction             —        —   REJECTED 0.96→0.89

  Standalone, tool-schema-slimming would report −$0.24 (−5.0%). It is
  worth −$0.09 in its actual position, because cache-priming already
  took 90% of the prefix price. Attribution is marginal, in applied
  order — always.

  HUMAN PREFERENCE   4 rated · 2 tie · 1 opthub · 1 main
    beat 2 went to main — context-pruning dropped a CI log tail.
    Flagged for review on debug-shaped prompts.

  UNGATED FLOOR IS NOT AN OPTION
    Pane 4 is $1.25 cheaper and wrong twice: a per-process dedupe that
    does not survive a restart (beat 1), and a missed HIGH severity
    finding (beat 4).

  ▸ 1 change needs your approval:  model-routing  −$0.18/session
```

The last line renders as an actionable row with `[ approve ]  [ decline ]  [ show diff ]` buttons.
Clicking `approve` writes one more line — `✔ approved · applies from next session · projected
$1.45/session` — and updates the cumulative chart's optimized series endpoint. Nothing else happens;
it is a mock.

---

## 6. The rate card

Rendered inline in the EXPERIMENT scrollback wherever an event has `kind: 'rate'`. It is a bordered
box, `--pane-bar` background, 1px `--hairline`, 4px radius, full pane width minus 24px.

```
┌ RATE THIS ────────────────────────────────── beat 2 ─┐
│                                                       │
│  A  main            B  optimized        −$0.47        │
│  ─────────────────  ─────────────────                 │
│  38,900 tok · 44s   36,300 tok · 39s                  │
│                                                       │
│  [ A better ]  [ B better ]  [ tie ]  [ B is wrong ]  │
└───────────────────────────────────────────────────────┘
```

Behavior: after the card appears, wait `resolveAfter` ms (3.2–3.6s per beat), then **auto-select** the
scripted answer — animate the chosen button to a filled state (`--text-primary` text on a
`rgba(255,255,255,0.08)` fill) with a 220ms transition, disable the others to 35% opacity, and let the
following scripted lines play. The buttons are also clickable by a live viewer: a click before the
auto-resolve cancels it and uses the click instead, but the following scripted lines play unchanged.

Scripted resolutions: beat 1 `tie`, beat 2 `A better`, beat 3 `B better`, beat 4 `tie`. Beat 5 has no
card.

---

## 7. Charts (admin pane)

Two charts. Both render as **cards inside the terminal scrollback**: `--pane-bar` background, 1px
`--hairline`, 4px radius, 16px padding, full pane width minus 24px, ~200px tall. Recharts, mono
labels at 10px in `--text-muted`, gridlines `--grid` at 1px, no chart borders, no drop shadows.

### 7.1 `cumulative` — spend over the session

Line chart, 3 series, x = beat 1–5, y = cumulative USD. Change over time → line, not bars.

| Series | Color | Notes |
|---|---|---|
| Actual | `#3987e5` | 2px |
| Optimized | `#d95926` | 2px |
| Ungated floor | `#199e70` | 2px, `stroke-dasharray: 4 3` |

Categorical slots 1–3 in fixed order — do **not** substitute green-for-good / red-for-bad here.
Status colors are reserved for the `✔ ⚠ ✖` lines and must never become a series color. Legend always
present (3 series), plus a direct label at each line's right end (`$4.82`, `$1.63`, `$0.38`) in
`--text-secondary` — identity is never carried by color alone. 8px markers at each beat. Crosshair +
tooltip on hover showing all three values for that beat. One y-axis only.

### 7.2 `attribution` — marginal waterfall

Horizontal waterfall, top to bottom, showing $4.82 walking down to $1.63.

```
actual                         ████████████████████████  $4.82
  cache-priming        [T0]    ────────────▌             −$2.41
  context-pruning      [T1]              ──▌             −$0.51
  tool-schema-slimming [T1]                ▌             −$0.09
  model-routing        [T2]                ▌             −$0.18
  prompt-compaction    [T1]    ╌╌╌ rejected ╌╌╌               —
optimized                      ███████▏                  $1.63
```

- Start and end bars: `--text-secondary` at 55% opacity — they are totals, not steps.
- The four decrement bars: one sequential blue ramp, ordered by application order —
  `#6da7ec`, `#3987e5`, `#2a78d6`, `#1c5cab`. Sequential, one hue, light→dark. Never a rainbow.
- `prompt-compaction`: no filled bar. A 1px dashed `--critical` outline the width the bar *would*
  have had, with the label `REJECTED · eval 0.96 → 0.89` in `--critical`, prefixed by a `✖` icon.
  The icon plus the word REJECTED carry the meaning; the color only reinforces it.
- Tier chips `[T0] [T1] [T2]` sit left of each label in `--text-muted`, 10px, 1px `--grid` border.
- Bars are 14px tall with 4px rounded ends on the data end only, 2px gap between adjacent fills.
- Direct value labels at the end of every bar in `--text-secondary`, `tabular-nums`. No axis needed —
  the labels are the axis.
- Hover tooltip per bar: the marginal %, and the standalone % for contrast where they differ
  (tool-schema-slimming: `marginal −4.7% · standalone −5.0%`).

### 7.3 `beats` — the per-beat table

Not a chart. A plain mono table in the scrollback, no card:

```
  beat  prompt              actual   optimized   floor   gates
  ────────────────────────────────────────────────────────────────
   1    idempotency keys     $0.94      $0.31    $0.06   T0
   2    flaky checkout test  $0.71      $0.24    $0.05   T0 T1 ⚠
   3    migration            $0.18      $0.06    $0.02   T0 T2*
   4    security review      $2.61      $0.90    $0.21   T0 T1 ✖floor
   5    PR description       $0.38      $0.12    $0.04   T0 T2*
  ────────────────────────────────────────────────────────────────
        session              $4.82      $1.63    $0.38   * pending
```

Right-align the money columns with `tabular-nums`. This table is also the accessible alternative to
the two charts — keep it in the DOM even when the charts render.

---

## 8. Data file shape

Put everything in `src/demo/script.ts`:

```ts
export const PANES = [ /* id, title, chip, accent — §1 */ ];
export const BEATS: Beat[] = [ /* the 5 beats from §5, as DemoEvent[] */ ];
export const SERIES = {
  labels: ['beat 1','beat 2','beat 3','beat 4','beat 5'],
  actual:    [0.94, 1.65, 1.83, 4.44, 4.82],
  optimized: [0.31, 0.55, 0.61, 1.51, 1.63],
  floor:     [0.06, 0.11, 0.13, 0.34, 0.38],
};
export const ATTRIBUTION = [
  { id:'actual',               label:'actual',               tier:null, value: 4.82, type:'total' },
  { id:'cache-priming',        label:'cache-priming',        tier:'T0', delta:-2.41, marginal:-50.0, standalone:-50.0, status:'auto' },
  { id:'context-pruning',      label:'context-pruning',      tier:'T1', delta:-0.51, marginal:-21.2, standalone:-24.0, status:'auto-flagged' },
  { id:'tool-schema-slimming', label:'tool-schema-slimming', tier:'T1', delta:-0.09, marginal: -4.7, standalone: -5.0, status:'auto' },
  { id:'model-routing',        label:'model-routing',        tier:'T2', delta:-0.18, marginal: -9.9, standalone:-11.0, status:'needs-approval' },
  { id:'prompt-compaction',    label:'prompt-compaction',    tier:'T1', delta: null, status:'rejected', note:'eval 0.96 → 0.89' },
  { id:'optimized',            label:'optimized',            tier:null, value: 1.63, type:'total' },
];
export const RATINGS = [
  { beat:1, resolveAfter:3200, choice:'tie' },
  { beat:2, resolveAfter:3400, choice:'a'   },
  { beat:3, resolveAfter:3200, choice:'b'   },
  { beat:4, resolveAfter:3600, choice:'tie' },
];
```

Components: `App`, `ControlBar`, `TerminalPane`, `TerminalLine`, `RateCard`, `ChartCard`,
`CumulativeChart`, `AttributionWaterfall`, `BeatsTable`, and one `usePlayer` hook owning the clock.

---

## 9. Do not

- **Do not call any API.** No `fetch`, no keys, no env vars. If the build wants a backend, it has
  misread this spec.
- **Do not invent numbers.** Every figure appears in §5 and §8; the panes, the charts, and the report
  must agree to the cent.
- **Do not build a light mode**, a theme toggle, or a settings panel.
- **Do not use a dual-axis chart**, a pie chart, or a rainbow palette.
- **Do not use status green/red as series colors**, and do not recolor a series by whether it is
  "good".
- **Do not add a real terminal emulator** (xterm.js). These are styled `<div>`s.
- **Do not make the panes resizable or draggable.** Fixed 2×2.
- **Do not add sound**, confetti, gradient backgrounds, glow effects, or a typewriter sound.
- **Do not loop the demo automatically.** End on the report and offer replay.

---

## 10. Definition of done

1. Loads, autoplays, and completes all 5 beats without interaction.
2. All four panes emit in the choreographed order; the EXPERIMENT pane never gets ahead of MAIN.
3. Beat 2's rate card resolves to **A better** and the flag line follows it.
4. Beat 4's CHEAPEST pane shows the `✖ missed HIGH` line in `--critical`.
5. The final report's attribution numbers sum: `4.82 − 2.41 − 0.51 − 0.09 − 0.18 = 1.63`.
6. Both charts render inside the admin scrollback, and `beats` table is present in the DOM.
7. Speed control, beat scrubbing, play/pause, and restart all work.
8. No horizontal page scroll at 1280×800; degrades to one column below 1100px.
