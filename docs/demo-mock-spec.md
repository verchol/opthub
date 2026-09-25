# opthub — four-terminal demo mock

**Status:** v0.2 · **Date:** 2026-09-22 · **Target:** Lovable (paste this whole file as the prompt)

*v0.2 re-tells the story around three claims (§0.1) and re-bases every number on `SPEC.md` v0.2:
`cache-priming` is a detector, not a lever; `context-lifecycle` is the top lever; routing is
per-turn by class, never per-session. v0.1's cache-priming hero number was a naive-client figure
that the E1 measurement killed (README → "What the measurements changed").*

---

## 0. What to build, in one paragraph

A single-page React app that looks like a developer's screen split into **four terminal panes**. It
plays a **scripted, pre-recorded demo** of a 22-minute coding session: the developer works in pane 1;
opthub shadows that work in pane 2, a conventional prompt-only router runs the same session in pane
4, and pane 3 is the central policy and report. **Nothing calls a real API.** Every character of
output is fixed data in one file. The app is a player: it types the script out on a timeline with
play/pause, speed, and per-beat scrubbing.

Build it as **Vite + React + TypeScript + Tailwind + Recharts**. No backend, no auth, no router. All
demo content lives in `src/demo/script.ts` so it can be edited without touching components.

### 0.1 The three claims, and where each one is on screen

The demo exists to make three claims visible. Every beat serves at least one. If a build decision
makes one of these harder to see, it is the wrong decision.

| # | Claim | Where the viewer sees it |
|---|---|---|
| **C1** | **The decision element lives on the developer's machine, in the session — not as rules on a central LLM gateway.** A gateway sees one request. The edge sees the session: which tools ran, whether files were edited, how deep the thread is, what the last six turns were about. | Every shadowed prompt in pane ② prints two classifications side by side: `gateway view (prompt only)` and `session view (opthub)`. They agree on beats 1–3 and **disagree on beat 4**, where the prompt-only view would have routed a security review to the cheap model. Pane ④ *is* the prompt-only router, run to completion, and it ships the bug. |
| **C2** | **Rules and metrics are set centrally and feed the judge.** Governance is central — routable classes, `never_downgrade` classes, the pinned judge, the accuracy threshold — and it is pushed to every machine. The decision is local; the policy it obeys is not. | Pane ③ opens by printing `policy v14` and its push status. Every gate verdict in pane ② names the pinned judge and its shadow. The final report shows edge evidence flowing *back* into the central rule (`non-coding/*` confidence up; no evidence yet to widen to `coding/mechanical`). |
| **C3** | **Route *parts* of a session by classification — not the session.** Non-coding turns (explain, summarize, PR description, commit message) go to a cheap model with a **scoped, fresh context**; coding turns stay. Whole-session routing is never proposed. | Beats 3 and 5 route; beats 1, 2, 4 do not. On beat 3 pane ② prints the scoped context size (`6.1k, not the 51k session`) next to the line *"a gateway can switch the model; it cannot shrink the context"* — which is the reason C3 needs C1. |

---

## 1. Layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  opthub demo          ⏸ ▶  1× 2× 4×    ● ● ● ● ●   beat 3/5 · explain        │  56px control bar
├───────────────────────────────────┬──────────────────────────────────────────┤
│ ① MAIN                       LIVE │ ② EXPERIMENT                  SHADOWING  │
│ ~/acme-api — claude               │ ~/acme-api — claude · /experiment         │
│                                   │                                          │
│   day-to-day coding session       │   the edge judge: classify, replay,       │
│   real work, real cost            │   blind-grade, price. + rate-this card   │
│                                   │                                          │
├───────────────────────────────────┼──────────────────────────────────────────┤
│ ③ POLICY                CENTRAL   │ ④ GATEWAY ROUTER          PROMPT-ONLY    │
│ opthub admin                      │ ~/acme-api — claude via router --no-gates │
│                                   │                                          │
│   central rules, judge config,    │   a conventional router: decides from    │
│   charts, attribution report      │   the prompt, before the answer exists   │
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
| ③ POLICY | `opthub admin` | `CENTRAL` | `#199e70` aqua |
| ④ GATEWAY ROUTER | `~/acme-api — claude via router --no-gates` | `PROMPT-ONLY` | `#c98500` yellow |

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
type PaneId = 'main' | 'experiment' | 'policy' | 'router';

type LineKind =
  | 'prompt'      // "› add idempotency keys…"  — types character by character
  | 'tool'        // "⏺ Read(src/routes/payments.ts)"
  | 'result'      // "  ⎿  312 lines"
  | 'text'        // Claude's prose, indented 2
  | 'diff'        // "⏺ Update(src/db/schema.ts)   +11 -0"  — colorize +n/-n
  | 'metric'      // "── 47,200 tok in · 1,840 out · $0.94 · 38s"
  | 'class'       // the two-line classification block — see §5, renders in a 2-col grid
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
starts. After beat 5, hold on the final report for 4s, then show a subtle `⟲ replay` affordance
centered in the control bar. Do not loop automatically.

### The `class` block

Every shadowed prompt in pane ② prints a classification block. Render it as a two-column grid,
labels in `--text-muted`, values in `--text-secondary`, the disagreeing row (beat 4 only) in
`--warning` with a `≠` glyph between the columns:

```
  gateway view (prompt only)   coding/edit           p=0.81
  session view  (opthub)       coding/edit           p=0.99   Update×2 · Write×1 · thread 1
```

The two columns are the point of the demo (C1). Do not collapse them into one line.

---

## 5. The scripted session

The developer is fixing a production incident in `acme-api`, a Node/TypeScript payments service.
Pane ④ runs the same five prompts through a conventional router that classifies **from the prompt
text alone** and picks the cheapest model whose class allows it, with no gate on the answer — the
design every router in `docs/router-comparison.md` shares.

| Beat | Prompt | Session class | Routes? | Point it makes |
|---|---|---|---|---|
| 1 | idempotency keys | `coding/edit` | no | Cache is already 96.8% warm — the detector says *nothing to do*; the money is in context and effort |
| 2 | flaky checkout test | `coding/debug` | no | `context-lifecycle` wins — and a human rates it *worse* |
| 3 | explain the retry logic for the incident doc | `non-coding/explain` | **yes** | Partial-session routing with a **scoped** context (C3); the gateway cannot shrink the context (C1) |
| 4 | "anything in the diff that'd bite us?" | `review/security` | **blocked** | Prompt-only view says `summarize`; session view says `review/security`; central policy blocks (C1, C2). Pane ④ ships the bug |
| 5 | PR description | `non-coding/pr-description` | **yes** | Routing is obviously right; scoped context makes it nearly free |

Per-beat cost, which every chart and report must agree with:

| Beat | ① MAIN | ② EXPERIMENT | ④ ROUTER |
|---|---:|---:|---:|
| 1 | $0.94 | $0.41 | $0.06 |
| 2 | $0.71 | $0.33 | $0.05 |
| 3 | $0.24 | $0.05 | $0.02 |
| 4 | $2.61 | $0.76 | $0.21 |
| 5 | $0.32 | $0.08 | $0.04 |
| **Session** | **$4.82** | **$1.63** | **$0.38** |

Cumulative series for the chart: MAIN `[0.94, 1.65, 1.89, 4.50, 4.82]`, EXPERIMENT
`[0.41, 0.74, 0.79, 1.55, 1.63]`, ROUTER `[0.06, 0.11, 0.13, 0.34, 0.38]`.

Pane ② compares **two replays** — a `baseline` arm and an `exp1` arm — never the live session
against a replay (README: *"arms are compared against each other, never against the original
session"*). The `$` shown for ② is the `exp1` arm; the saving is `exp1` vs `baseline`, and the
rate card is **blind**: identities are withheld until the viewer rates.

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

**③ POLICY** (`at: 400` — fires first, before anything is shadowed; this is C2)

```
› policy show
⏺ policy v14 · pushed to 3 machines · this machine: in sync 2m ago

  classes.routable          non-coding/*
  classes.never_downgrade   review/security · coding/debug
  accuracy.relative_drop_max  0.00          must tie or win
  judge.pinned              claude-opus-5   score of record
  judge.shadow              jev-1.13.0      pairwise · agreement 0.88 / 0.85 needed

  the decision is made on the machine. the rules it obeys are made here.
```

**② EXPERIMENT** (`at: 2600` — starts once MAIN's prompt has finished typing)

```
› /experiment
⏺ attached to pane 1 (main) · shadowing every prompt · policy v14
  Read-only mount. Nothing here touches your working tree.

── beat 1 ─────────────────────────────────────────────────
◆ shadowed: "add idempotency keys to POST /v1/payments…"

  gateway view (prompt only)   coding/edit        p=0.81
  session view  (opthub)       coding/edit        p=0.99   Update×2 · Write×1

⏺ levers for this turn  [coding/edit · 47.2k ctx]
     cache-priming        DETECTOR   hit rate 96.8% — nothing to do
     prefix-trim     [T1] 4.1k of system+tools never referenced this turn
     effort-tuning   [T1] xhigh → high · edit has a test suite to catch it
     model-routing   [T2] not a candidate — class is coding/*

⏺ replaying baseline + exp1 in sandbox · blind
✔ judge claude-opus-5 [pinned]  baseline 8.7 · exp1 8.7   shadow jev: exp1 0.51
   tests 24/24 on both arms

── exp1 · 42,900 tok in · 1,790 out · $0.41 · 33s
   vs baseline  −$0.53  (−56.4%)
```

then the rate card (`kind: 'rate'`), which resolves to `tie` after 3.2s and reveals
`A = exp1 · B = baseline`.

**④ GATEWAY ROUTER** (`at: 9200`)

```
› claude via router --no-gates
⏺ router: classify(prompt) → coding/edit p=0.81 → cheapest allowed: claude-haiku-4-5
◆ replaying beat 1

⏺ Read(src/routes/payments.ts)
⏺ Update(src/routes/payments.ts)   +21 -3

  Added an in-memory Map keyed by request id to skip duplicates.

── 39,100 tok in · 610 out · $0.06 · 11s
⚠ diverges — in-memory dedupe is per-process and does not survive a
  restart. The retry storm hit 3 pods. No gate ran; nobody was told.
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

  gateway view (prompt only)   coding/debug       p=0.88
  session view  (opthub)       coding/debug       p=0.97   gh run view · 2 reads · thread 2

⏺ levers  [coding/debug · 38.9k ctx · 11 tool results carried]
     context-lifecycle [T1] 9.4k tok of superseded log tails carried forward
     prefix-trim       [T1] warm from beat 1
     model-routing     [T2] BLOCKED — coding/debug ∈ never_downgrade (policy v14)

⏺ replaying baseline + exp1 · blind
✔ judge claude-opus-5 [pinned]  baseline 8.4 · exp1 8.2   shadow jev: baseline 0.58
   within relative_drop_max? no — 0.2 < threshold only if tie… gate: PASS on tests, WATCH on judge

── exp1 · 29,500 tok in · 1,090 out · $0.33 · 37s
   vs baseline  −$0.38  (−53.5%)
```

> Builder note: keep the awkward "PASS on tests, WATCH on judge" line as written — the gate passed
> on the deterministic check and the judge was split. That is why the human rating below matters.

Rate card resolves to **`A better`** after 3.4s, reveals `A = baseline · B = exp1`, then:

```
◆ recorded: human prefers baseline on this turn
  exp1 dropped the CI log tail that named run 8842119. Same fix,
  weaker citation.
⚠ context-lifecycle flagged on coding/debug — sent to policy as evidence
```

This is the most important 20 seconds of the demo — the loop recording a loss and sending it up.

**④ GATEWAY ROUTER**

```
⏺ router: classify(prompt) → coding/debug p=0.88 → claude-haiku-4-5
◆ replaying beat 2
⏺ Read(test/e2e/checkout.spec.ts)
  Suggested adding `await page.waitForTimeout(500)` before the assertion.
── 31,200 tok in · 380 out · $0.05 · 8s
⚠ diverges — masks the race instead of fixing the fixture.
```

**③ POLICY** — one line: `⏺ evidence received · context-lifecycle × coding/debug · 1 human-against`

---

### Beat 3 — explain the retry logic (partial-session routing)

**① MAIN**

```
› explain how the payments retry logic works today, in plain english — I
  need it for the incident doc

⏺ Read(src/routes/payments.ts)
⏺ Read(src/clients/psp.ts)

  Retries are driven by the PSP client, not the route. On a 5xx or a
  timeout it retries up to 3 times with 200ms, 400ms, 800ms backoff, and
  each retry is a fresh POST with the same body. Nothing above it knows a
  retry happened, which is why the route saw three "first" requests last
  night. The idempotency claim from this morning is what makes those
  three collapse into one.

── 51,300 tok in · 620 out · $0.24 · 14s
```

**② EXPERIMENT**

```
── beat 3 ─────────────────────────────────────────────────
◆ shadowed: "explain how the payments retry logic works today…"

  gateway view (prompt only)   non-coding/explain   p=0.90
  session view  (opthub)       non-coding/explain   p=0.96   0 edits expected · prose answer

⏺ levers  [non-coding/explain · 51.3k ctx]
     context-lifecycle [T1] scope: 2 files + last user turn → 6.1k, not the 51k session
     model-routing     [T2] candidate — non-coding/* ∈ routable → claude-haiku-4-5

  a gateway can switch the model. it cannot shrink the context — it
  sees one request with 51k attached. the edge forks a 6.1k context for
  this turn and returns to the session afterwards.

⏺ T2 requires approval · replaying for evidence only · blind
✔ judge claude-opus-5 [pinned]  baseline 8.9 · exp1 9.1   shadow jev: exp1 0.61

── exp1 · 6,100 tok in · 590 out · $0.05 · 4s
   vs baseline  −$0.19  (−79.2%)
```

Rate card resolves to **`B better`** ("tighter, same facts"), reveals `A = baseline · B = exp1`.

**④ GATEWAY ROUTER**

```
⏺ router: classify(prompt) → non-coding/explain p=0.90 → claude-haiku-4-5
◆ replaying beat 3 · 51,300 tok attached
── 51,300 tok in · 610 out · $0.02 · 6s
✔ matches main
```

> Same class, same model, same answer as ②. Different bill shape: ④ paid to ship 51k tokens ②
> did not send. On this beat the difference is cents; on beat 4 it is the finding.

**③ POLICY** — first chart. The operator types:

```
› show me actual vs optimized so far

⏺ [chart: cumulative]
  3 turns · actual $1.89 · optimized $0.79 · router $0.13
  routed turns: 1 of 3 · class non-coding/explain · judge: exp1 preferred
```

---

### Beat 4 — the review (where the two views disagree)

**① MAIN**

```
› go over the diff before I open the PR — anything in there that'd bite us?

⏺ Bash(git diff main --stat)
  ⎿  7 files changed, 143 insertions(+), 17 deletions(-)
⏺ Bash(git diff main)
  ⎿  1,204 lines
⏺ Read(src/middleware/idempotency.ts)
⏺ Read(src/routes/payments.ts)
⏺ Grep(pattern: "req.headers\[", path: "src")
  ⎿  6 matches

  Three things, one of them serious:

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
◆ shadowed: "go over the diff before I open the PR — anything…"

  gateway view (prompt only)   non-coding/summarize   p=0.71   → would route
  session view  (opthub)    ≠  review/security        p=0.97   git diff 1,204 lines ·
                                                               idempotency.ts · headers[ ·
                                                               thread is a payments incident

⏺ levers  [review/security · 96.4k ctx]
     context-lifecycle [T1] scope to diff + touched files → 61.2k · capped, review needs history
     prefix-trim       [T1] warm
     effort-tuning     [T1] held at xhigh — review class
     model-routing     [T2] BLOCKED — review/security ∈ never_downgrade (policy v14)

⏺ replaying baseline + exp1 · blind
✔ judge claude-opus-5 [pinned]  baseline 9.0 · exp1 9.0   shadow jev: tie 0.50
   all 3 findings reproduced, same severities

── exp1 · 61,200 tok in · 3,180 out · $0.76 · 58s
   vs baseline  −$1.85  (−70.9%)

◆ routing was worth an estimated −$0.44 on this turn and was not taken.
  the prompt says "go over the diff". the session says "security review of
  a payments incident fix". only one of those is visible from a gateway.
```

Rate card resolves to **`tie`**.

**④ GATEWAY ROUTER** — the payoff:

```
⏺ router: classify(prompt) → non-coding/summarize p=0.71 → claude-haiku-4-5
◆ replaying beat 4
⏺ Bash(git diff main)
⏺ Read(src/middleware/idempotency.ts)

  Two things:
  1. MEDIUM — replayed response includes the original Set-Cookie.
  2. LOW — claims are never reaped.

── 58,300 tok in · 940 out · $0.21 · 19s
✖ missed HIGH — unbounded client-controlled idempotency key
  $0.21 instead of $2.61. Classified from the prompt; shipped the incident.
```

Render that `✖` line in `--critical` with an icon **and** the word `missed`, and let it sit for a
long `hold` (2400ms). It is the thesis of the demo.

**③ POLICY**

```
› why didn't routing apply on beat 4

⏺ session view classified review/security (p=0.97); prompt-only view said
  non-coding/summarize (p=0.71)
  policy v14: review/security ∈ never_downgrade  → T2 blocked on this machine
  forgone saving  −$0.44
  pane 4 took it and lost 1 of 3 findings (HIGH)
  → the rule is central. the evidence it needed to fire was only on the machine.
```

---

### Beat 5 — the PR description

**① MAIN**

```
› write the PR description
⏺ Bash(git log main..HEAD --oneline)
  ⎿  6 commits
⏺ Write(.github/PULL_REQUEST_TEMPLATE_filled.md)   +34
── 21,600 tok in · 780 out · $0.32 · 12s
```

**② EXPERIMENT**

```
── beat 5 ─────────────────────────────────────────────────
◆ shadowed: "write the PR description"

  gateway view (prompt only)   non-coding/pr-description   p=0.95
  session view  (opthub)       non-coding/pr-description   p=0.99

⏺ levers  [non-coding/pr-description · 21.6k ctx]
     context-lifecycle [T1] scope: git log + diff --stat → 2.4k
     model-routing     [T2] candidate — non-coding/* ∈ routable → claude-haiku-4-5
✔ judge claude-opus-5 [pinned]  baseline 8.8 · exp1 8.8   shadow jev: tie 0.50
── exp1 · 2,400 tok in · 760 out · $0.08 · 5s
   vs baseline  −$0.24  (−75.0%)
```

**④ GATEWAY ROUTER**

```
⏺ router: classify(prompt) → non-coding/pr-description p=0.95 → claude-haiku-4-5
── 21,600 tok in · 760 out · $0.04 · 6s
✔ matches main
```

**③ POLICY** — the finale. Operator types:

```
› report
```

and the pane renders, in order: the attribution waterfall chart, the per-beat table, then this text
block, each with a `hold` so it reads as a report being assembled:

```
── opthub session report · sess_4f21 ──────────────────────
  22m 41s · 5 turns · claude-opus-5 · policy v14

  actual                                          $4.82
  exp1, all gates passed                          $1.63    −66.2%
  prompt-only router, no gates (pane 4)           $0.38    −92.1% ✖

  ATTRIBUTION — marginal, in applied order
    cache-priming              DETECTOR   hit 96.8% · nothing to do
    [T1] context-lifecycle        −$2.12   −44.0%   auto · 1 flag
    [T1] prefix-trim              −$0.43   −15.9%   auto
    [T1] effort-tuning            −$0.31   −13.7%   auto
    [T2] model-routing (by class) −$0.33   −16.8%   NEEDS APPROVAL · 2 of 5 turns
    [T1] prompt-compaction             —        —   REJECTED 0.96→0.89

  Standalone, model-routing would report −$0.43 (beats 3 + 5). In its
  position it is worth −$0.33, because context-lifecycle already scoped
  those turns before they were routed. Attribution is marginal, in
  applied order — always.

  ROUTED TURNS                2 of 5 · both non-coding/* · both graded ≥ baseline
    the session was never routed. two turns were.

  HUMAN PREFERENCE   4 rated · 2 tie · 1 exp1 · 1 baseline
    beat 2 went to baseline — context-lifecycle dropped a CI log tail.

  EVIDENCE → POLICY
    non-coding/*  confidence ↑   2 routed, 0 against
    coding/debug  context-lifecycle 1 human-against → hold at WATCH
    coding/mechanical  0 evidence → not widened

  THE ROUTER IN PANE 4 IS NOT AN OPTION
    $1.25 cheaper and wrong twice: a per-process dedupe (beat 1) and a
    missed HIGH finding (beat 4). Both turns were classified from the
    prompt. Both were visible from the session.

  ▸ 1 change needs your approval:  model-routing by class  −$0.33/session
```

The last line renders as an actionable row with `[ approve ]  [ decline ]  [ show diff ]` buttons.
Clicking `approve` writes one more line — `✔ approved · policy v15 drafted · applies from next
session · projected $1.30/session` — and updates the cumulative chart's optimized series endpoint.
Nothing else happens; it is a mock.

---

## 6. The rate card

Rendered inline in the EXPERIMENT scrollback wherever an event has `kind: 'rate'`. It is a bordered
box, `--pane-bar` background, 1px `--hairline`, 4px radius, full pane width minus 24px.

**It is blind.** Until the viewer rates, the card shows two answers labeled A and B with the first
two lines of each and **no** model, cost, or token count — any of those would identify the arm.
After the rating, a reveal line appears under the buttons.

```
┌ RATE THIS ──────────────────────────────── beat 2 · blind ─┐
│                                                             │
│  A                            B                             │
│  The test seeds a promo…      The fixture's validUntil…     │
│  It is the fixture that…      On a slow runner the…         │
│                                                             │
│  [ A better ]  [ B better ]  [ tie ]  [ B is wrong ]        │
│                                                             │
│  ▸ A = baseline · B = exp1 (context-lifecycle) · −$0.38     │   ← appears after rating
└─────────────────────────────────────────────────────────────┘
```

Behavior: after the card appears, wait `resolveAfter` ms (3.2–3.6s per beat), then **auto-select** the
scripted answer — animate the chosen button to a filled state (`--text-primary` text on a
`rgba(255,255,255,0.08)` fill) with a 220ms transition, disable the others to 35% opacity, fade the
reveal line in, and let the following scripted lines play. The buttons are also clickable by a live
viewer: a click before the auto-resolve cancels it and uses the click instead, but the following
scripted lines play unchanged.

Scripted resolutions and reveals:

| Beat | Choice | Reveal |
|---|---|---|
| 1 | `tie` | `A = exp1 · B = baseline · −$0.53` |
| 2 | `A better` | `A = baseline · B = exp1 (context-lifecycle) · −$0.38` |
| 3 | `B better` | `A = baseline · B = exp1 (routed, haiku, scoped 6.1k) · −$0.19` |
| 4 | `tie` | `A = exp1 · B = baseline · −$1.85` |

Beat 5 has no card. Note the A/B assignment alternates — that is the position-swap from
`SPEC.md` §6.1.1, and the reveal must match the table exactly.

---

## 7. Charts (policy pane)

Two charts. Both render as **cards inside the terminal scrollback**: `--pane-bar` background, 1px
`--hairline`, 4px radius, 16px padding, full pane width minus 24px, ~200px tall. Recharts, mono
labels at 10px in `--text-muted`, gridlines `--grid` at 1px, no chart borders, no drop shadows.

### 7.1 `cumulative` — spend over the session

Line chart, 3 series, x = beat 1–5, y = cumulative USD. Change over time → line, not bars.

| Series | Color | Notes |
|---|---|---|
| Actual | `#3987e5` | 2px |
| exp1 (gated) | `#d95926` | 2px |
| Prompt-only router | `#199e70` | 2px, `stroke-dasharray: 4 3` |

Categorical slots 1–3 in fixed order — do **not** substitute green-for-good / red-for-bad here.
Status colors are reserved for the `✔ ⚠ ✖` lines and must never become a series color. Legend always
present (3 series), plus a direct label at each line's right end (`$4.82`, `$1.63`, `$0.38`) in
`--text-secondary` — identity is never carried by color alone. 8px markers at each beat; the two
**routed** beats (3 and 5) get a hollow marker on the exp1 series, with a legend note `○ routed turn`.
Crosshair + tooltip on hover showing all three values for that beat. One y-axis only.

### 7.2 `attribution` — marginal waterfall

Horizontal waterfall, top to bottom, showing $4.82 walking down to $1.63.

```
actual                             ████████████████████████  $4.82
  cache-priming        DETECTOR    ·  hit 96.8% · no bar
  context-lifecycle    [T1]        ──────────▌               −$2.12
  prefix-trim          [T1]                ──▌               −$0.43
  effort-tuning        [T1]                 ─▌               −$0.31
  model-routing        [T2]                 ─▌               −$0.33
  prompt-compaction    [T1]        ╌╌╌ rejected ╌╌╌               —
exp1                               ███████▏                  $1.63
```

- Start and end bars: `--text-secondary` at 55% opacity — they are totals, not steps.
- The four decrement bars: one sequential blue ramp, ordered by application order —
  `#6da7ec`, `#3987e5`, `#2a78d6`, `#1c5cab`. Sequential, one hue, light→dark. Never a rainbow.
- `cache-priming`: **no bar**, a single `·` and the text `DETECTOR · hit 96.8% · no bar` in
  `--text-muted`. It is on the chart because its absence is a finding.
- `prompt-compaction`: no filled bar. A 1px dashed `--critical` outline the width the bar *would*
  have had, with the label `REJECTED · eval 0.96 → 0.89` in `--critical`, prefixed by a `✖` icon.
  The icon plus the word REJECTED carry the meaning; the color only reinforces it.
- Tier chips `[T1] [T2]` sit left of each label in `--text-muted`, 10px, 1px `--grid` border.
- Bars are 14px tall with 4px rounded ends on the data end only, 2px gap between adjacent fills.
- Direct value labels at the end of every bar in `--text-secondary`, `tabular-nums`. No axis needed —
  the labels are the axis.
- Hover tooltip per bar: the marginal %, and the standalone % for contrast where they differ
  (model-routing: `marginal −16.8% · standalone −22.0%`).

### 7.3 `beats` — the per-beat table

Not a chart. A plain mono table in the scrollback, no card:

```
  beat  turn                    class                  actual  exp1   router  routed  gate
  ──────────────────────────────────────────────────────────────────────────────────────
   1    idempotency keys        coding/edit             $0.94  $0.41  $0.06   —       T1
   2    flaky checkout test     coding/debug            $0.71  $0.33  $0.05   blocked T1 ⚠
   3    explain retry logic     non-coding/explain      $0.24  $0.05  $0.02   ● haiku T1 T2*
   4    review the diff         review/security         $2.61  $0.76  $0.21   blocked T1 ✖router
   5    PR description          non-coding/pr-descr.    $0.32  $0.08  $0.04   ● haiku T1 T2*
  ──────────────────────────────────────────────────────────────────────────────────────
        session                                         $4.82  $1.63  $0.38   2 of 5  * pending
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
  actual:    [0.94, 1.65, 1.89, 4.50, 4.82],
  exp1:      [0.41, 0.74, 0.79, 1.55, 1.63],
  router:    [0.06, 0.11, 0.13, 0.34, 0.38],
  routedBeats: [3, 5],
};
export const ATTRIBUTION = [
  { id:'actual',            label:'actual',            tier:null, value: 4.82, type:'total' },
  { id:'cache-priming',     label:'cache-priming',     tier:null, delta: null, status:'detector', note:'hit 96.8% · nothing to do' },
  { id:'context-lifecycle', label:'context-lifecycle', tier:'T1', delta:-2.12, marginal:-44.0, standalone:-44.0, status:'auto-flagged' },
  { id:'prefix-trim',       label:'prefix-trim',       tier:'T1', delta:-0.43, marginal:-15.9, standalone:-17.6, status:'auto' },
  { id:'effort-tuning',     label:'effort-tuning',     tier:'T1', delta:-0.31, marginal:-13.7, standalone:-14.9, status:'auto' },
  { id:'model-routing',     label:'model-routing',     tier:'T2', delta:-0.33, marginal:-16.8, standalone:-22.0, status:'needs-approval', note:'by class · 2 of 5 turns' },
  { id:'prompt-compaction', label:'prompt-compaction', tier:'T1', delta: null, status:'rejected', note:'eval 0.96 → 0.89' },
  { id:'exp1',              label:'exp1',              tier:null, value: 1.63, type:'total' },
];
export const RATINGS = [
  { beat:1, resolveAfter:3200, choice:'tie', reveal:'A = exp1 · B = baseline · −$0.53' },
  { beat:2, resolveAfter:3400, choice:'a',   reveal:'A = baseline · B = exp1 (context-lifecycle) · −$0.38' },
  { beat:3, resolveAfter:3200, choice:'b',   reveal:'A = baseline · B = exp1 (routed, haiku, scoped 6.1k) · −$0.19' },
  { beat:4, resolveAfter:3600, choice:'tie', reveal:'A = exp1 · B = baseline · −$1.85' },
];
export const POLICY = {
  version: 14,
  routable: ['non-coding/*'],
  neverDowngrade: ['review/security', 'coding/debug'],
  relativeDropMax: 0.00,
  judge: { pinned: 'claude-opus-5', shadow: 'jev-1.13.0', agreement: 0.88, minAgreement: 0.85 },
};
```

Components: `App`, `ControlBar`, `TerminalPane`, `TerminalLine`, `ClassBlock`, `RateCard`,
`ChartCard`, `CumulativeChart`, `AttributionWaterfall`, `BeatsTable`, and one `usePlayer` hook
owning the clock.

---

## 9. Do not

- **Do not call any API.** No `fetch`, no keys, no env vars. If the build wants a backend, it has
  misread this spec.
- **Do not invent numbers.** Every figure appears in §5 and §8; the panes, the charts, and the report
  must agree to the cent.
- **Do not collapse the two classification columns** into one. The disagreement on beat 4 is C1.
- **Do not show model, cost, or tokens on the rate card before it resolves.** Blind means blind.
- **Do not route a whole session anywhere.** Routing is per-turn, by class, on beats 3 and 5 only.
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
2. All four panes emit in the choreographed order; ③ prints `policy v14` before ② shadows anything;
   ② never gets ahead of ①.
3. Every beat in ② shows the two-column `class` block; beat 4's rows disagree and the session row is
   in `--warning` with `≠`.
4. Beat 2's rate card resolves to **A better**, reveals `A = baseline`, and the flag line follows.
5. Beat 3's ② pane prints `6.1k, not the 51k session` and the "a gateway can switch the model. it
   cannot shrink the context" line.
6. Beat 4's ④ pane shows the `✖ missed HIGH` line in `--critical`.
7. The final report's attribution sums: `4.82 − 2.12 − 0.43 − 0.31 − 0.33 = 1.63`, and
   `cache-priming` appears as a detector with no bar.
8. Rate cards show no model/cost/tokens before resolving; reveals match §6's table exactly.
9. Both charts render inside the policy scrollback; the `beats` table is present in the DOM.
10. Speed control, beat scrubbing, play/pause, and restart all work.
11. No horizontal page scroll at 1280×800; degrades to one column below 1100px.
