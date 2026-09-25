# opthub — progress log

## 2026-08-24 · Phase 1 spec v0.1
- `SPEC.md` — Phase 1 demo spec. Artifact: https://claude.ai/code/artifact/9fa56212-9fe6-4ca1-957f-f317a9a4bbcd
- Decisions: agent is untrusted (read-only mount, signed proposal only, host re-runs gates);
  optimizer tiers T0/T1/T2 set autonomy; ROI gate so verification pays for itself.

## 2026-08-24 · Optimizer candidates costed
- `tools/costmodel.py` — computes marginal $/1k per optimizer. Source of every number in docs.
- `docs/optimizers.md` — deep-dive on all five candidates.
- **Correction:** SPEC.md §09 numbers were placeholders, not computed. Real figures:
  cache-priming −64.4% (not −31%); cumulative −84.4% (not −41%). $63.50 → $9.93 per 1k.
- Three rules found: attribution must be marginal in applied order; T0 runs first; after caching
  only the uncached suffix and output are worth accuracy risk.
- Open: latency gate must split TTFT from total (caching is a TTFT win, not a wall-clock win).

## 2026-08-25 · Optimizer cookbook (worked examples)
- `docs/optimizers-cookbook.md` — per optimizer: before/after request, `usage` proof, per-line
  cost arithmetic, gate verification snippet, reproducible failure. Verified against the current
  Anthropic caching reference; all $ figures expand `tools/costmodel.py`.
- Three new findings from writing the examples:
  - **F5** `defer_loading` + tool search is the non-destructive form of tool-schema-slimming —
    turns F2's silent production failure into one extra search call. (ADR-0007)
  - **F6** cache invalidation is avoidable for 2 of 3 tiers (`role: "system"` messages today;
    `tool_addition`/`tool_removal` behind a beta). Model switch has no escape hatch. (ADR-0008)
  - **F7** adopt the cache-diagnosis beta as the gate's verifier instead of a replay heuristic —
    payload shape must be read off a live response first, not guessed. (ADR-0009)
- Also documented: `max_tokens: 0` pre-warming (latency, not cost — wrong tool for this workload),
  1h TTL economics (2× write, break-even at 3 requests), and that the 1% write-rate assumption
  breaks entirely below one request per 5 minutes.

## 2026-08-25 · Four-terminal demo mock spec
- `docs/demo-mock-spec.md` — paste-into-Lovable spec for the 2×2 terminal demo
  (main / experiment / admin / cheapest). Vite+React+TS+Tailwind+Recharts, no backend,
  100% scripted from `src/demo/script.ts`.
- Scripted as 5 beats of one incident-fix session on `acme-api`: $4.82 actual → $1.63 gated
  (−66.2%) → $0.38 ungated floor (−92.1%, wrong twice).
- Two demo decisions worth keeping: (1) beat 2's rating goes **against** opthub, so the loop is
  seen recording a loss; (2) the cheapest pane misses a HIGH security finding on beat 4, which
  is what makes the tier system legible instead of decorative.
- Chart colors are the validated categorical slots 1–3 + a one-hue sequential ramp for the
  waterfall; status red/green stay reserved for gate verdicts, never series.

## 2026-08-30 · E1 — one month of local loops (experiments log opened)
- `docs/experiments.md` — running experiment log for use-case prioritization.
  `tools/loopscan.py` (month aggregate + loop detection) and `tools/savings.py` (per-session
  ledger + per-lever headroom) are the source of every number. Window pinned with `--since`,
  because a relative `--days` boundary moves the totals between runs.
  Full ledger: `docs/data/e1-sessions.csv` (215 sessions).
- 2026-07-30 → 08-30: 3,479 requests, $518.18 API-list equivalent (subscription traffic — not a
  bill). Six loops found, all **event**-triggered; zero cron/routine/`/loop`.
- Findings that move the spec:
  - **E1-F5** 52.9% of the spend is requests whose session median context is **≥250k tokens**;
    top 2 sessions are 52.9% of the month. Cost is concentrated in session *length*, and no
    candidate optimizer addresses it.
  - **E1-F4** cache-priming is dead on this workload — measured hit rate **96.8%**. The −64.4%
    headline in `optimizers.md` is a naive-client number. Demote to a *detector*; gate on
    measured hit rate first.
  - **E1-F6** the obvious TTL win **loses**: 1h→5m costs **+$4.03** and is worse in **168 of 215
    sessions** once the 253 forced prefix re-writes are simulated. Best argument in the repo for
    the non-optional gate.
  - **E1-F7** output is 19% of the bill, 27% of it thinking. **Effort is untested** and
    within-model — cheapest experiment, largest untested surface.
  - **E1-F3** the highest-frequency loop (381 title-gen fires) has **no usage record anywhere
    local** — it cannot be costed from transcripts at all. Hard evidence for wire-level capture.
  - **E1-F2** loops are 1.4% of spend here; one human at a keyboard is 98.6%.
    Re-scope the "recurring workload" framing.
- **Use cases scored** (`experiments.md` § use cases, scored) — seed for the backlog, nothing
  committed. Rubric: `2 × (0.40·Value + 0.25·Evidence + 0.20·GateEase + 0.15·BuildEase)`.
  1. UC-8 context lifecycle **7.3** · 2. UC-1 prefix trim **6.9** · 3. UC-4 model routing **6.8**
  · 4. UC-5 wire capture **6.7** · 5. UC-2 effort tuning **6.0** · 6. UC-3 cache-config gate
  **5.7** · 7. UC-7 cache-priming **5.3** · 8. UC-6 machine-issued-turn governance **5.0**.
  Two calls worth arguing with: UC-4 has the biggest prize ($308 ceiling) and the worst odds of
  passing G2; UC-6 is the current spec's centre of gravity and ranks **last** on this machine.
- Honest caveat carried in the doc: of the four levers priced per session, only the TTL one is
  measured. Prefix-trim (20.4%) and effort (2.4%) are headroom under invented percentages, and
  the Sonnet ceiling (59.5%) assumes token counts that a smaller model probably would not hold.
  E2/E3 exist to replace those assumptions.

## 2026-09-03 · E1b re-run + SPEC v0.2 rebuilt
- Re-ran E1's pinned command as a robustness check before rebuilding the spec. It stopped being a
  robustness check: **the local transcript store deleted 3 sessions ($46.25) mid-analysis.**
  `cleanupPeriodDays` unset → 30-day default. Oldest surviving transcript is 29 days old.
  8.9% of E1's spend is gone; **E1's run of record is permanently unreproducible.**
- **E1-F6 overturned.** The TTL lever's sign flipped twice in one hour of wall-clock
  (1h wins $4.03 → 5m wins $4.31 → 5m wins $11.46). The second flip was caused by *deletion*,
  not by new traffic. Corrected finding is stronger: the month-level sign is a sampling artifact.
- **E1b-F3** explains it — two populations want opposite settings, split by cache write:read ratio:
  write-heavy (95 sessions) +$12.75 for 5m, read-heavy (104 sessions) −$8.56. The aggregate is a
  near-cancellation; the populations are stable across both runs even though the aggregate is not.
- `SPEC.md` **v0.2** — rebuilt. Artifact: https://claude.ai/code/artifact/04b61779-32dd-4402-8de5-f479b06d131e
  §2 states plainly what died from v0.1 and what held:
  - **Died:** the recurring-workload/`supportbot` framing (programmatic traffic is 1.5% of spend),
    `cache-priming` as the −64.4% headline (96.6% measured hit rate), the five-optimizer catalog,
    the synthetic demo, single-series latency gating.
  - **Held under re-run:** interactive/programmatic split, hit rate, ≥250k-context concentration,
    Opus-5 share, all three lever ratios — each moved <1 point over four days.
  - **New:** `Session` as the primary cost unit · **stability gate** (§6.5, exit 14) ·
    **population rule** (§6.6) · **detector-first rule** (§6.7) · capture owns durable storage
    with `retention: forever` (§5.2) · baselines pinned by content hash, `STALE` proposals, exit 15.
  - Optimizer catalog re-ranked from E1's rubric: `context-lifecycle` (7.3) · `prefix-trim` (6.9) ·
    `model-routing` (6.8, built to be *demonstrably blocked*) · `effort-tuning` (6.0) ·
    `cache-config` (5.7) · `cache-priming` demoted to **detector**.
  - Demo rebuilt on real captured history; `supportbot` seed repo **cut** from Phase 1 scope.
- **ADR-0009 is unblocked.** `diagnostics.cache_miss_reason` is present in local transcripts —
  the cookbook's F7 said the payload shape had to be read off a live response before adopting
  it as the gate's cache verifier. It has been. Shape: `{type, cache_missed_input_tokens}`,
  types seen: `system_changed`, `tools_changed`, `previous_message_not_found`. This replaces
  the replay heuristic with the API's own attribution.
  First read on one session: `system_changed` 305,208 tok ($3.05) vs `tools_changed` 70,376
  ($0.70) — the dominant cache destroyer is the **system prompt changing mid-session**, not
  tool churn. Ranks UC-1 evidence without needing E2's prefix anatomy.
- `/lenops view` (`tools/lenops.py`) — context, preload floor, models, cost mix, cache-miss
  attribution, turn latency, levers. Subcommand form per the naming convention: one command,
  section-named subcommands, one backing script so the cost model lives in one place.
  **Bug fixed:** thinking tokens are `output_tokens_details.thinking_tokens`, not
  `reasoning_tokens` — lever B silently read $0.00 until this was corrected.
- `tools/ctxwatch.py` — live context meter, tails a transcript from disk (validated against
  `/context`: 141,744 vs 141.7k). `tools/lenops.py` + `/lenops` — per-session ops report:
  context, cost mix, cache misses, TTL population and counterfactual, levers. Both are
  read-only and cost nothing, unlike looping `/context`, which inflates what it measures.
  **Note:** the §6.6 population split is on write:read in **dollars**, not tokens — the token
  ratio understates writes ~20x (2.0x vs 0.1x) and puts sessions in the wrong bucket.
- `docs/data/e1b-sessions.csv` — 214 sessions, $508.80, pinned run of record for 2026-09-03.
  It will decay too. That is the finding, not a caveat.

## 2026-09-03 · `tools/sessions.py` — session inventory
- Lists every Claude Code session on this machine in a window. Default **24h**;
  `--hours` / `--days` / `--since`, plus `--sort start|cost|reqs|ctx`, `--project`,
  `--full-id`, `--csv`, `--json`.
- Two deliberate differences from `loopscan`/`savings`, both from E1/E1b:
  - **Counts sessions with zero billable requests** instead of dropping them —
    prompt-only shells and title-gen fires. Over the full window that is **346 sessions**
    that ran and cannot be costed from transcripts at all (E1-F3). A ledger that hides
    them under-reports what the machine did.
  - **Reports the retention boundary.** Prints the oldest transcript on disk and warns
    when the requested window starts before it: *"the earlier part was deleted, not idle;
    totals are a floor"* (E1b-F1).
- `span` is first-to-last record in the window, not active time — a resumed session spans
  days, which is how the langsmith session reads 116h. `cwd` resolves by mode so a session
  that `cd`s doesn't change project label between windows.
- `--full-id` prints UUIDs that feed straight into `claude --resume <id>`.

## 2026-09-04 → 09-14 · Implementation repo: hub, experiment loop, sandboxes, deploy
- Work landed in the separate implementation repo (`sandbox/e2b`, not yet published); this repo
  gained the documentation of it. Summary here so the log has one timeline.
- **Optimization Hub** (`opt hub start`) — local server over the transcript store: Sessions,
  Optimization → Sessions / Catalog / Runs, per-session Analytics, ROI. `opt watch` is the same
  in a terminal with a per-session status (`live` / `open` / `idle` / `closed`); `open` exists
  because an mtime window cannot tell a session where someone is thinking from one that ended
  in July.
- **Experiment loop** — a real session's working directory shipped into E2B microVMs, replayed
  with one parameter changed per arm, graded blind on six criteria by a second model. Arms are
  named from their *parameters*, never from a model-written label; an arm that varies nothing
  is flagged `no change` and its delta reported as the noise floor. Arms compare against each
  other, never against the original session.
- **Lever catalog** — 13 levers, 8 runnable from the client, 4 gateway-only, parameter surface
  taken from Kong AI Gateway's AI plugins. Every estimate labelled `priced` / `guess` / `detector`.
- **Sandbox templates** — E2B (Claude Code + LiteLLM + headroom), open-weights (Ollama), Kong in
  front of Bedrock, and a **local Docker sandbox** (read-only source mount, one writable dir,
  `--cap-drop ALL`, allowlisting egress proxy) with `./sandbox.sh verify` asserting all eight
  guarantees. Closes the Phase 1 "Docker agent sandbox" item.
- **Packaging** — Homebrew formula; wrapper sets `OPT_HOME=~/.opthub` so runs and reports survive
  a Cellar upgrade. `make-dist.sh` refuses to build if a credential-shaped string is in the tarball.
- **Demo deploy** — <https://opthub-demo.fly.dev/>, a frozen 154-session snapshot with every
  run disabled three ways (403 on POST, control rendered disabled, no credentials in the image).
- **Docs in this repo** — `docs/experiment-loop.html` (nine steps) and `-short.html` (four),
  `docs/anatomy.html`, 22 screenshots in `docs/screens/` captured 2026-09-14, and
  `docs/ARTIFACTS.md` indexing every shared page and the two link-pinning traps.
- One measured result worth carrying: the open-weights arm came back **7.1× cheaper and
  18 points worse** on the blind score, and one of the three arms varied nothing.

## 2026-09-22 · Router prior art + pluggable judge
- `docs/router-comparison.md` — five model routers (Alexei's `pi-model-router`, RouteLLM, LiteLLM,
  Kong AI Gateway, hosted routers) in one format: purpose, five use cases, sandbox/dev-machine
  difficulty, overlap with opthub. Common thread: every router decides *before* the answer exists;
  opthub decides *after*, from a graded replay. Prior art for `model-routing` (UC-4).
- `SPEC.md` §6.1.1 + policy `judge:` block — the LLM judge is now a pluggable component. One
  **pinned** backend (still `claude-opus-5`) is the score of record; **shadow** backends score the
  same pairs and are reported, never gating, until agreement ≥ 0.85 with the pinned judge.
  Added: TypeSafe **Jev** (`jev-1.13.0`) as a pairwise-only shadow — it is a Choice primitive,
  returns per-arm probabilities, cannot fill the 1–10 rubric, and its confidence is decisiveness
  not correctness; **Ollama** open-weights as the free, no-egress shadow; **Gemini Flash / Groq /
  OpenRouter `:free`** as free-tier shadows with rate-limit caveats. Judge cost is charged to the
  verify budget. Free-tier availability is as of today and unverified against current terms.
- `docs/demo-mock-spec.md` → **v0.2**. The four-terminal demo story is re-told around three
  claims, each mapped to a specific line on screen (§0.1): **C1** the decision element is on the
  developer's machine, not rules on a central gateway — every shadowed prompt prints
  `gateway view (prompt only)` beside `session view (opthub)`, and they disagree on beat 4;
  **C2** rules and metrics are central and feed the judge — pane ③ opens with `policy v14`
  pushed to 3 machines, every verdict names the pinned judge and its shadow, and the report shows
  edge evidence flowing back into the rule; **C3** routing is per-turn by class, never per-session
  — beats 3 and 5 route with a *scoped* context (`6.1k, not the 51k session`), which is the thing
  a gateway physically cannot do. Pane ④ is now explicitly *a prompt-only router* rather than
  "cheapest", so it is the counter-example to C1 rather than a straw man.
- Same pass re-based the demo numbers on v0.2: `cache-priming` appears as a **detector** (hit
  96.8%, no bar) instead of the −50% hero the v0.1 mock still carried; `context-lifecycle` is the
  top lever (−$2.12); routing is −$0.33 marginal vs −$0.43 standalone because context-lifecycle
  scoped those turns first — a clean R1 illustration. Rate cards are now blind with position-swap
  and a post-rating reveal (§6.1.1). Session totals unchanged: $4.82 → $1.63 → $0.38.

## 2026-09-19 · Repo made public
- README rewritten as the front door: what is built, what the measurements changed, the roadmap
  with a **Done** block, reading order. Cross-repo relative link removed (404 on GitHub).
- Pre-publish scan: no credentials, tokens or keys in the tree; `.claude/settings.local.json`
  untracked; the demo password is a Fly secret and not written down. The data files and
  screenshots are from real sessions — see the note in `docs/data/` on what they contain.

### Next
- **Publish the implementation repo** so the walkthroughs point at runnable code.
- **Wire-level capture with opthub-owned retention** — top infrastructure item (E1b-F1).
- **Gate runner**, built against the two rejections in SPEC §11 (accuracy kills model-routing,
  stability kills the TTL change). A gate that has never rejected anything is decoration.
- **Repeats.** Every comparison is `n = 1` per arm; three is the minimum before quoting a figure.
- ADRs 0002–0011 for optimizers.md §5 / cookbook §6, plus ADR-0010 stability gate and
  ADR-0011 population rule (E1b-F2, E1b-F3).
- E2 prefix anatomy (replaces lever A's 25%, ranks UC-1) · E3 effort sweep (replaces lever B's
  50%, first real G2 exercise) · E4 does the TTL result invert on loop-shaped traffic? (UC-6) ·
  E5 context-lifecycle replay (ranks UC-8) · E6 calibrate the stability gate's `k ∈ {3,5,10}`
  (SPEC §14 open question 5).
