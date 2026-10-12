# opthub

**Find out whether a cheaper way of running a coding agent actually does the same job — by running it, not by arguing about it.**

Every Claude Code session on a machine leaves a transcript. opthub reads them, works out where the money went, proposes a cheaper configuration, then **re-runs the real session under that configuration in cloud sandboxes and grades the result blind.** A configuration that is cheaper and worse is reported as cheaper and worse.

The project exists because the usual alternative is a spreadsheet of list prices and a confident opinion.

---

## Two repositories

| | what it is |
|---|---|
| **`demos/opthub`** *(this repo)* | the spec, the measurements, and the read-only analysis tools. Nothing here spends money. |
| **`sandbox/e2b`** *(not yet published)* | the working implementation: the hub, the experiment loop, the sandbox templates, the report. |

They are deliberately separate. This repo is where a claim gets written down and argued with; the other is where it gets executed. `SPEC.md` is versioned (currently **v0.4**) and `PROGRESS.md` is the dated log of what each measurement changed.

---

## Status — 2026-10-07

Where the project stands, newest first. Each line has a dated entry in [`PROGRESS.md`](PROGRESS.md).

| date | what | state |
|---|---|---|
| 10-04 | **Optimization Atlas** ([`docs/atlas/`](docs/atlas/)) — 38 scenarios in 8 layers, each with the exact knob it changes; `engine.js` prices best and worst case in $/month against a workload you set. Trust labels: 5 measured, 8 priced, 6 published, 19 guess | built |
| 10-04 | **Hub Sessions tab priced by the atlas** — and a **3× cost bug fixed**: every Opus 5 request was priced at $15/$75. Hub total fell $5,951 → $1,919, in line with Triage's $1,971 | built; 1-hour cache writes (2×) still billed at 1.25× in the hub |
| 09-30 | **Epic RO — runtime optimization** (`SPEC.md` v0.4 §16, [`docs/runtime-optimization.md`](docs/runtime-optimization.md)). `opt claude optimize` runs Claude Code in the Docker sandbox behind **ULT**, a router that classifies each request and decides keep / route / local, with a hash-chained audit log. Shadow mode by default | live once: a request routed to Haiku 4.5 cost $0.0645 vs $0.2581 on Opus 5.5 (n = 1). **Blocked** on an expired OAuth token in the implementation repo |
| 09-30 | **LLM Light profiles** — five bundles (`laptop-guarded` … `frontier-governed`) rendered into a LiteLLM config + routing hook; Hub → Profiles | tested on mock upstreams only; convergence with ULT proposed, not done |
| 09-29 | **`SPEC.md` v0.3** — where sessions live today (§5.3), centralising derived ~1 KB records while transcripts stay at the edge (§5.4), architecture at scale (§5.5). Re-runs, not storage, are the cost that scales | spec only |
| 09-29 | **J3 — session triage with Jev** ([`experiments/session-triage/`](experiments/session-triage/)) and **Hub → Triage**. With work signals, Jev answers the model question on 22 of 54 sessions; the 32 `unclear` ones queue for a blind-judged Sonnet re-run | runnable; no owner-labelled gold set yet |
| 09-29 | **Evidence catalog** ([`docs/evidence-catalog.md`](docs/evidence-catalog.md)) — 110 public savings claims checked against opthub's own numbers | done |
| 09-25 | **J2 — email triage with Jev** ([`experiments/email-triage/`](experiments/email-triage/)) and **J1 — judge calibration spec** ([`docs/judge-calibration-spec.md`](docs/judge-calibration-spec.md)) | J2 runnable on synthetic data only; J1 spec only |
| 09-22 | **Router prior art** ([`docs/router-comparison.md`](docs/router-comparison.md)) and the **pluggable judge** (`SPEC.md` §6.1.1) | done |

**Blocked / open right now:** the implementation repo (`sandbox/e2b`) is still unpublished and has uncommitted ULT work · ULT needs a valid provider credential · LLM Light and ULT overlap and need one design · every comparison is still `n = 1` per arm.

---

## What is built

### The Optimization Hub — `opt hub start`

A local server over the transcript store. Rail on the left, list in the middle, the selected item on the right.

- **Sessions** — every session on the machine, with its median context per request, its cost, and an estimated optimization potential. This tab reports; it does not spend.
- **Optimization → Sessions / Catalog / Runs** — where experiments are launched, what levers exist, and what every run found.
- **Analytics** — opened from a session, never from the sidebar, so it always says which session it is about. Real per-turn series: context carried, cumulative cost, the priced input mix, output with thinking split out.
- **ROI** — artifact value per dollar.

**`opt watch`** is the same thing in a terminal, redrawn in place, with a status per session:

| status | evidence |
|---|---|
| `live` | wrote to its transcript in the last 90 seconds |
| `open` | a `claude` process is running in that directory and this is its newest session — on screen, waiting on a human |
| `idle` | wrote in the last 30 minutes, nothing running there now |
| `closed` | neither |

`open` exists because a five-minute mtime window cannot tell a session where someone is thinking from one that ended in July.

### The experiment loop

Pick a session and a lever. The loop ships that session's own working directory into E2B microVMs, replays its request with one parameter changed, and grades what comes out.

- **Arms are named `baseline`, `exp1`, `exp2`…**, each tagged with the one phrase naming what it varies — derived from the arm's *parameters*, never from the label a model wrote for it.
- **An arm that varies nothing is flagged.** A planner once proposed "frontier, no compaction" when the baseline already had compaction off; the report now says `no change` and calls the resulting delta a noise floor rather than a finding.
- **Grading is blind.** Six criteria scored 1–10 by a second model, arms presented in randomised order with identities withheld.
- **The judge is pluggable** (`SPEC.md` §6.1.1). One pinned backend produces the score of record; optional *shadow* judges — TypeSafe's Jev Choice model for the pairwise half, a local open-weights model through Ollama, or a free-tier API — score the same pairs and are reported alongside, never instead. A shadow is promoted only after it agrees with the pinned judge often enough.
- **Arms are compared against each other, never against the original session.** A replay reaches an answer in five turns where the real session took seven hundred; "cheaper than the original" would be measuring the replay's incompleteness.

The written contract is `docs/report-spec.md` in the implementation repo: the eight blocks in order, and five rules a report may not break.

### The lever catalog

`config/optimizations.json` — **13 levers, 8 runnable from the client, 4 that need a gateway in the request path.** The parameter surface is taken from Kong AI Gateway's AI plugins, because Kong has already enumerated what an LLM gateway can tune. Levers opthub cannot execute are still listed, with the plugin and config that would enable them, rather than omitted.

Each estimate labels its own confidence:

| label | means |
|---|---|
| `priced` | this session's own tokens re-priced at another model's published rate — arithmetic, and still a ceiling nobody reaches |
| `guess` | a range with a stated basis and no measurement behind it |
| `detector` | measured, and it says no |

### Sandbox templates

| dir | what runs inside |
|---|---|
| `template/` | Claude Code + LiteLLM + headroom — the A/B arms |
| `template/openmodel/` | Ollama + an open-weights model, served locally |
| `template/kong/` | Kong AI Gateway in front of Bedrock, Claude Code pointed at it unmodified |
| `template/docker/` | **local** — a container instead of a microVM: read-only source mount, one writable directory, `--cap-drop ALL`, and egress only through an allowlisting proxy. `./sandbox.sh verify` asserts all eight guarantees. Same shape as the E2B path, weaker isolation (shared kernel), no sandbox spend. |

`template/kong/optimization-params.yaml` is the written spec of the whole gateway parameter surface — every knob, its default, its range, what it trades against, and a `not_available_at_the_gateway` section, because the split between what a gateway can do and what only the client can do is the useful part.

### Installing it

```sh
brew tap verchol/opthub && brew install opthub     # once the tap is published
opt sessions                                       # needs no credentials
opt hub start
```

The formula installs a wrapper that sets `OPT_HOME=~/.opthub`, so runs and
reports are written to the user's home rather than into the Cellar, which is
replaced on every upgrade. `lib/state.mjs` is the seam: run from a clone,
results stay next to the code as they always have. Packaging lives in
`e2b/packaging/` — `make-dist.sh` builds the tarball and refuses to build if a
credential-shaped string is in it.

### Showing it

Deployed at **<https://opthub-demo.fly.dev/>** (user `demo`, password held as a
Fly secret). `e2b/deploy/` is a read-only copy for demos: the same page and the same URLs,
serving a frozen snapshot instead of a transcript store, with every run
disabled three ways over — 403 on every POST, the run control rendered
disabled, and no credentials in the image. `tools/hub-snapshot.mjs` writes the
snapshot and rewrites absolute home paths to `~`. One `shared-cpu-1x` machine
on Fly that suspends when idle.

### Analysis tools (this repo, read-only)

`tools/sessions.py` · `tools/lenops.py` · `tools/loopscan.py` · `tools/savings.py` · `tools/costmodel.py` · `tools/ctxwatch.py` — the source of every number in `docs/`. They cost nothing to run, unlike looping `/context`, which inflates what it measures.

---

## What the measurements changed

v0.2 of the spec exists because v0.1's headline numbers did not survive contact with real data.

- **E1-F5 — cost is concentrated in session *length*.** 52.9% of a month's spend was requests whose session median context was ≥250k tokens; the top two sessions were 52.9% of the month. No candidate optimizer addressed it, so `context-lifecycle` became the top-ranked lever.
- **E1-F4 — cache-priming is dead on this workload.** Measured prompt-cache hit rate 96.8%. The −64.4% headline in `docs/optimizers.md` was a naive-client number. Demoted to a **detector**.
- **E1b-F3 — the TTL lever's sign flips.** 1h vs 5m reversed twice in an hour of wall-clock. Two populations want opposite settings, split by cache write:read ratio *in dollars*. This produced the **stability gate** (§6.5) and the **population rule** (§6.6).
- **E1b-F1 — the transcript store deleted three sessions ($46.25) mid-analysis.** `cleanupPeriodDays` unset defaults to 30 days. E1's run of record is permanently unreproducible. This is why capture owning durable storage is the top infrastructure item.
- **E1-F2 — loops are 1.4% of spend.** One human at a keyboard is 98.6%. The recurring-workload framing and the `supportbot` seed repo were cut.

The pinned ledgers are `docs/data/e1-sessions.csv` (215 sessions) and `docs/data/e1b-sessions.csv` (214 sessions, $508.80). They will decay too. That is the finding, not a caveat. The per-session opening prompts and absolute paths were stripped before publishing — [`docs/data/README.md`](docs/data/README.md) says what is left.

---

## Roadmap

*Last revised 2026-10-07. The dated history of how each item got here is `PROGRESS.md`.*

### Done — what exists and runs

- [x] **Measurements** E1 / E1b — one month of real transcripts, two runs, pinned ledgers in `docs/data/`
- [x] **`SPEC.md` v0.2 → v0.4** — v0.2 rebuilt on measured data (§2 lists what died from v0.1); v0.3 session storage and scale (§5.3–§5.5); v0.4 runtime optimization (§16)
- [x] **Read-only analysis tools** — `sessions` · `lenops` · `loopscan` · `savings` · `costmodel` · `ctxwatch`, plus the `/lenops` command
- [x] **The Optimization Hub** (`opt hub start`) and **`opt watch`** — sessions, per-session analytics, catalog, runs, ROI
- [x] **The experiment loop** — real session replayed in E2B microVMs, arms named by what they vary, no-op arms flagged, blind grading
- [x] **Lever catalog** — 13 levers, 8 runnable, 4 gateway-only, each estimate labelled `priced` / `guess` / `detector`
- [x] **Sandbox templates** — E2B (Claude Code + LiteLLM), open-weights (Ollama), Kong AI Gateway, and the local Docker sandbox with eight verified guarantees
- [x] **Packaging and demo** — Homebrew formula with `OPT_HOME`, read-only Fly deploy at `opthub-demo.fly.dev`
- [x] **Documentation** — the two walkthroughs, *Anatomy of an experiment*, 22 hub screenshots, and the artifact index
- [x] **Router prior art + pluggable judge** — five routers compared; pinned judge of record, shadow judges reported alongside
- [x] **J-series classifier experiments** — J1 judge calibration (spec), J2 email triage, J3 session triage with Jev, surfaced as Hub → Triage with a budgeted re-run queue
- [x] **Sandbox knobs** — arms can vary LiteLLM routing, caching, budget, and Claude Code env / settings / flags; routed arms priced per served model
- [x] **LLM Light profiles** — five profiles, LiteLLM hook, `apply` / `revert`, Hub → Profiles (mock upstreams only)
- [x] **Optimization Atlas** — 38 scenarios priced best/worst case; now the source of the Sessions tab's potential
- [x] **Evidence catalog** — 110 public claims, five of opthub's six headline numbers confirmed by public sources
- [x] **Session graph** — `tools/sessiongraph.py`: a session as tasks linked to models, context, tools, files and subagents; previews in [`docs/preview/session-graph/`](docs/preview/session-graph/), per-session graphs in the Triage export ([`docs/session-graph.md`](docs/session-graph.md))

### Now — close the loop on what exists

- [ ] **Publish the implementation repo** (`sandbox/e2b`) so the walkthroughs point at code that can be run. It also holds the uncommitted ULT work (`optimize-live.mjs`, `ult.mjs`, `lib/ult/`, 69 checks in `npm test`).
- [ ] **Unblock ULT** — renew the provider credential, then run `opt claude optimize` end to end; routing needs a per-model adapter (four `400`s from Haiku before the first routed request worked).
- [ ] **Converge LLM Light and ULT** into one router (`docs/runtime-optimization.md` §10), and run it against a real upstream.
- [ ] **Gold labels for J3** — twenty interactive sessions labelled by their owner are enough to score `jev-C1`.
- [ ] **Reconcile cache-write pricing** — the hub bills every cache write at 1.25×; Claude Code's 1-hour writes bill at 2× (`tools/savings.py` already does).

- [ ] **Wire-level capture with opthub-owned retention.** The top infrastructure item. The local store expires at 30 days and has already destroyed a run of record; 381 title-generation fires left no usable local record at all (E1-F3). Until capture owns storage, every analysis has a decay date.
- [ ] **Gate runner**, built against the two rejections in `SPEC.md` §11 — accuracy kills `model-routing`, stability kills the TTL change. A gate that has never rejected anything is decoration.
- [ ] **ADRs 0002–0011**, covering `docs/optimizers.md` §5 and the cookbook §6, plus ADR-0010 (stability gate) and ADR-0011 (population rule).
- [ ] **Repeats.** Every comparison is currently `n = 1` per arm, and agent variance makes a sub-15% single-run difference noise. Three repeats is the minimum before quoting a figure; `--repeats` exists and defaults to 1 because repeats cost linearly.

### Next — the experiments that replace assumptions

| id | question | replaces |
|---|---|---|
| **E2** | prefix anatomy — what is actually in the re-sent prefix | lever A's invented 25% |
| **E3** | effort sweep | lever B's invented 50%; the first real G2 exercise |
| **E4** | does the TTL result invert on loop-shaped traffic? | tests UC-6 |
| **E5** | context-lifecycle replay | ranks UC-8, and answers whether it can be T1 |
| **E6** | calibrate the stability gate's sub-window count `k ∈ {3,5,10}` | §14 open question 5 |

Of the four levers priced per session, **only the TTL one is measured.** Prefix-trim (20.4%) and effort (2.4%) are headroom under invented percentages, and the Sonnet ceiling (59.5%) assumes token counts a smaller model probably would not hold. E2 and E3 exist to fix exactly that.

### Then — Phase 1 build-out (`SPEC.md` §12)

- [ ] `opthubd` daemon: capture proxy, journal, CAS, apply engine, gate runner
- [x] **Docker agent sandbox with read-only mount + egress allowlist** — built, `e2b/template/docker/`, eight guarantees asserted by `./sandbox.sh verify`
- [ ] Five gates including stability (§6.5) and the population rule (§6.6)
- [ ] Optimizers in rank order: `context-lifecycle` (7.3) · `prefix-trim` (6.9) · `effort-tuning` (6.0) · `cache-config` (5.7), with `cache-priming` as a **detector only**
- [ ] `model-routing` (6.8) built to be *demonstrably blocked*, not shipped — biggest prize ($308 ceiling), worst odds of passing the accuracy gate
- [ ] Two-part scorer: deterministic + pinned judge
- [ ] `opthub report` terminal dashboard, on real captured history
- [ ] Centralised session records (`opthub.session/1`, `opt ship`) — stage B of the `SPEC.md` §5.5 rollout

### Open questions (`SPEC.md` §14)

1. **Call-site fingerprinting** — file:line is brittle under refactor. Leaning annotation-optional with fingerprint fallback.
2. **Where does an applied T0 change live?** Leaning source diff for T1/T2, lock file for T0.
3. **Journal per-repo or per-machine?** Now leaning per-machine (`~/.opthub/`) with per-repo policy — cost concentrates in sessions, which are per-machine.
4. **Does the agent need write access to a scratch worktree** to run the repo's own tests? Widens the trust boundary; deferred past Phase 1.
5. **Right sub-window count `k` for the stability gate?** Default 5 is a guess. E6.
6. **Does `context-lifecycle` need to be T2?** It is the top-ranked optimizer and its default is "always propose", which may make the highest-value lever the least-used one.

### Carried-forward limits

- **A local export replays the prompt, not the machine.** Anything the session read outside the files it wrote is not in the bundle.
- **A task with no hidden suite falls back to the blind judge**, which is a weaker signal — the report says so in its verdict.
- **The tuner's search space is a declared list**, not everything Claude Code exposes. Adding a knob is one entry in `SEARCH_SPACE` plus one property on the tool schema.
- **`open` status is per-directory.** Two sessions in one cwd mean `open` goes to the newest transcript there. It can be wrong about *which* sibling is on screen; it is not wrong that one of them is.

### Explicitly deferred

Fleet/team aggregation · non-Anthropic providers (interface stubbed) · IDE extension · web dashboard · `batch-collapse` and `transport-tuning` · Windows support · the `supportbot` seed repo (**cut** — real history is the better demo and needs no seeding).

---

## Where sessions live

```
~/.claude/projects/<project-slug>/<session-uuid>.jsonl
```

One JSONL file per session, one line per record. The directory name is the working directory with `/` → `-`, which is how `opt watch` maps a running `claude` process back to a session. The hub re-walks this tree on every request — nothing is cached, which is why live sessions update.

**This store expires.** `cleanupPeriodDays` unset defaults to **30 days**. Set it explicitly if you want history:

```json
{ "cleanupPeriodDays": 3650 }
```

The harness's own records — `results/`, `exports/`, `replays/` in the implementation repo — do not expire. The pinned CSVs in `docs/data/` exist for the same reason.

---

## Documents

Every shareable page for this project is indexed in
[`docs/ARTIFACTS.md`](docs/ARTIFACTS.md) — current links, superseded ones and why,
and the two version-pinning traps worth knowing before you share one.


- [`docs/experiment-loop.html`](docs/experiment-loop.html) — **The saving, proven.** A walkthrough of
  the hub in nine screenshots, following the value rather than the machinery: **see what a session
  could save** (sessions → sorted by cost → saving potential → where the money actually went), **run
  it again under different strategies** (pick one, or let Auto pick; three runs, $0.67), **read the
  report** (the radar chart, the blind score behind it, and what each run changed). The open-weights
  run came back 7.1× cheaper and 18 points worse, and one of the three turned out to vary nothing.
  1.0 MB — the screenshots are embedded, so the file needs nothing else to open.
- [`docs/experiment-loop-short.html`](docs/experiment-loop-short.html) — **The two-minute proof.** The
  same pass in four steps, for someone who will not read nine.
- [`docs/screens/`](docs/screens/INDEX.md) — **Every view of the hub**, 22 screenshots in one
  folder, captured from a live hub over 154 real sessions. Filenames encode the path through the
  app (`NN_<section>-<subtab>__<state>.jpg`) and `INDEX.md` draws the navigation hierarchy,
  including the report a run leaves behind.
- [`docs/anatomy.html`](docs/anatomy.html) — **Anatomy of an experiment.** How the five
  parts of an experiment definition (prompt, strategy, baseline session, operational limits, verifier)
  resolve into arms that are identical except one parameter, and what the verifier is allowed to see.
  The hub serves it at `/docs/anatomy.html` through a symlink in the implementation repo.

- [`docs/atlas/`](docs/atlas/index.html) — **Optimization Atlas.** Every known way to cut an agent's
  cost, with the parameters it changes and its best/worst case on a workload you set.
  `scenarios.json`, `engine.js` and `llms.txt` sit beside the page for agents.
- [`docs/experiment-catalog.html`](docs/experiment-catalog.html) — **Experiment catalog.** Every experiment opthub can run: which
  session to replay, how the result is verified, and the lever's standalone saving on the pinned E1b month.
- [`docs/evidence-catalog.md`](docs/evidence-catalog.md) — 110 public savings claims, graded by
  evidence strength and checked against opthub's measurements.
- [`docs/runtime-optimization.md`](docs/runtime-optimization.md) — epic RO: `opt claude optimize` and ULT.
- [`docs/router-comparison.md`](docs/router-comparison.md) · [`docs/judge-calibration-spec.md`](docs/judge-calibration-spec.md)
  — router prior art, and the J1 judge calibration design.

## Reading order

1. `SPEC.md` §1–§2 — what this is, and what died from v0.1; §5.3–§5.5 and §16 for v0.3/v0.4
2. `docs/experiments.md` — the measurements, and the use cases scored from them
3. `PROGRESS.md` — the dated log (newest last, though entries from 09-29 onward were appended out of order)
4. `docs/optimizers-cookbook.md` — per optimizer: before/after request, `usage` proof, per-line cost arithmetic, gate snippet, reproducible failure
5. The [roadmap](#roadmap) above — what is done, what is next, and what is deliberately deferred

## License

MIT — see [`LICENSE`](LICENSE).
