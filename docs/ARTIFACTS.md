# Published artifacts — index

Where the shareable pages for this project live. Artifacts are private until shared
from the page's own share menu.

**To find them without this file:** `/artifacts` in the Claude Code terminal lists the
ones you own (`o` opens, `c` copies the link), `ctrl+]` reopens the most recent from
the current session, and the gallery is at <https://claude.ai/code/artifacts>.

---

## Current — open these

| page | link | what it is |
|---|---|---|
| **The Saving, Proven** *(long)* | [`de88a013`](https://claude.ai/code/artifact/de88a013-fdbc-4a19-9889-f3830e7f49df) | Nine steps along the value: see what a session could save, run it again under different strategies, read the report. Ends on the radar chart with its colours keyed to the three runs. White theme. Also [`docs/experiment-loop.html`](experiment-loop.html). |
| **The Two-Minute Proof** *(short)* | [`a4eff650`](https://claude.ai/code/artifact/a4eff650-d239-4343-8e40-5549d4b3a615) | The same pass in four steps: where the money is, what could be saved and how sure that is, the 67 cents of experiments, and the radar chart showing what each run traded away. Also [`docs/experiment-loop-short.html`](experiment-loop-short.html). |
| **Anatomy of an Experiment** | [`e65863ac`](https://claude.ai/code/artifact/e65863ac-d6d8-4b39-a0ac-eae1552cf024) | How an experiment definition is composed — prompt, strategy, baseline session, operational limits, verifier — and what the verifier is allowed to see. Also [`docs/anatomy.html`](anatomy.html). |
| **Triage Session Graph** *(preview)* | [`Shcxp8R5`](https://claude.ai/artifact/Shcxp8R56AC575MEmUwxRr) | Hub → Triage → one session, with a new Graph tab: tasks linked to the model, context, tools and files each one used; Tasks tab jumps into the graph. Mock session from `demo-mock-spec.md` §5. Also [`docs/preview/session-graph/triage-graph.html`](preview/session-graph/triage-graph.html). |
| **Session Graph** *(preview)* | [`QrQSzkA4`](https://claude.ai/artifact/QrQSzkA4Cp43ciJGYAF1UV) | The same graph on its own page. Also [`docs/preview/session-graph/session-graph.html`](preview/session-graph/session-graph.html). Rebuild both with `python3 docs/preview/session-graph/build.py`; render a real session with `tools/sessiongraph.py <sid> --html data/private/g.html`. Design: [`session-graph.md`](session-graph.md). |
| **opthub Phase 1 Spec** | [`04b61779`](https://claude.ai/code/artifact/04b61779-32dd-4402-8de5-f479b06d131e) | `SPEC.md` v0.2, rebuilt against measured data. Recorded in `PROGRESS.md` 2026-09-03. |

## Live deploy

| what | where | access |
|---|---|---|
| **The Optimization Hub, read-only** | <https://opthub-demo.fly.dev/> | user `demo`, shared password — held as the Fly secret `HUB_PASSWORD`, deliberately not written down in this repo |

Serves a frozen snapshot of 154 sessions: the same page and the same URLs as a
local hub, with runs disabled. Refresh the data with
`cd e2b/deploy && ./build.sh && fly deploy ./build --app opthub-demo`. Rotate the
password with `fly secrets set HUB_PASSWORD=… --app opthub-demo`.

## Superseded — do not share

| page | link | why |
|---|---|---|
| The Experiment Loop *(first URL)* | [`0d2350e5`](https://claude.ai/code/artifact/0d2350e5-edfd-4c45-9f63-827e10dbe2a6) | **Its share link is pinned to the first version**, titled *Cheaper and Worse*, so anyone opening a copied link gets that build and its stale preview. Republished to `de88a013` above, which is now on its fourth version and titled *The Saving, Proven*. The two have since diverged in wording, length and title &mdash; treat `0d2350e5` as dead, not as an older copy. |
| opthub Phase 1 *(v0.1 spec)* | [`9fa56212`](https://claude.ai/code/artifact/9fa56212-9fe6-4ca1-957f-f317a9a4bbcd) | v0.1. `SPEC.md` §2 lists what died from it: the recurring-workload framing, cache-priming's −64.4% headline, the five-optimizer catalog, the synthetic demo. Recorded in `PROGRESS.md` 2026-08-24. |

---

## Earlier, opthub-related

Listed from the gallery by title and date. These were published by earlier sessions,
so the descriptions below are inferred from what the repos contain, not verified by
re-reading each page.

| page | link | updated | probably |
|---|---|---|---|
| The Optimization Playbook | [`3baa83b7`](https://claude.ai/code/artifact/3baa83b7-b371-4da3-a24c-56513a2320bb) | 2026-09-08 | pairs with `e2b/docs/optimization-practices.html` |
| The sandbox held. The database didn't. | [`95ce0838`](https://claude.ai/code/artifact/95ce0838-3568-4b02-b6ba-e8a56180d907) | 2026-09-07 | a run write-up |
| Baseline vs Optimized | [`2d3ba33c`](https://claude.ai/code/artifact/2d3ba33c-f35a-41ba-bd03-2118753e71d7) | 2026-09-07 | a `report.mjs` run report — that builder's `<title>` is literally *Baseline vs Optimized* |
| Baseline vs Optimized | [`859a1d07`](https://claude.ai/code/artifact/859a1d07-825e-4979-82bb-f96fb3c56d8c) | 2026-09-06 | ” |
| Baseline vs Optimized | [`8c36d76d`](https://claude.ai/code/artifact/8c36d76d-5b43-4b4e-bc42-1e840b73194a) | 2026-09-06 | ” |
| Baseline vs Optimized | [`1c4517b1`](https://claude.ai/code/artifact/1c4517b1-e227-4b92-b88a-1160752b53f4) | 2026-09-05 | ” |
| Baseline vs Optimized | [`a2dc8d8a`](https://claude.ai/code/artifact/a2dc8d8a-9206-443e-9cb8-6499a46c20a7) | 2026-09-05 | ” |
| Regular vs Optimized | [`881a1d1b`](https://claude.ai/code/artifact/881a1d1b-e460-45b5-beff-7ce63fb31b00) | 2026-09-05 | earlier naming of the same report |
| Regular vs Optimized | [`f0630fd8`](https://claude.ai/code/artifact/f0630fd8-12e2-4f89-8ceb-b0e24703d524) | 2026-09-05 | ” |
| Regular vs Optimized | [`d73aa833`](https://claude.ai/code/artifact/d73aa833-944c-4561-84c3-da5c9c78c002) | 2026-09-05 | ” |
| Two Harnesses, One Task | [`5f5da277`](https://claude.ai/code/artifact/5f5da277-d053-4b0a-8984-dfa9d6c45949) | 2026-09-05 | a comparison write-up; URL appears in the repos |
| Harness Economics | [`ff58c45c`](https://claude.ai/code/artifact/ff58c45c-8afa-4e70-a84c-bf44a2a460cb) | 2026-09-05 | pairs with `e2b/docs/harness-economics.html` |
| E2B at Scale — Isolation, Challenges, Gap Map | [`20595912`](https://claude.ai/code/artifact/20595912-c08c-49ef-b965-e91497f0385e) | 2026-09-05 | sandbox infrastructure |

## Adjacent — Canarian / investor

| page | link | updated |
|---|---|---|
| Context, signed — investor one-pager | [`c9c88b86`](https://claude.ai/code/artifact/c9c88b86-8211-4b8d-bff3-9655d294bd6a) | 2026-09-04 |
| Canarian — The Context Supply Chain | [`0d6ce245`](https://claude.ai/code/artifact/0d6ce245-d4ec-4d73-a923-3e5d9b9785ec) | 2026-09-04 |
| Ramp — investor one-pager | [`97832d15`](https://claude.ai/code/artifact/97832d15-c91d-477f-8d99-012373c859ed) | 2026-09-02 |

## Not this project

Also in the gallery, unrelated to opthub: the Rosh Hashanah cards
([`0e577e69`](https://claude.ai/code/artifact/0e577e69-f531-42c9-a0a7-49230f67547d),
[`583c3468`](https://claude.ai/code/artifact/583c3468-3fec-4281-a680-9ceb2c6fff61),
[`8e6e75c4`](https://claude.ai/code/artifact/8e6e75c4-2367-456d-bb00-b5762429ba15),
[`5f742073`](https://claude.ai/code/artifact/5f742073-daf1-4eca-8260-1f2f4f0ac0b4)),
`מכונת המשחקים`, `MiniAV`, the graphify dependency maps
(`Cart Store Dependency Map`, `What connects cartservice to Redis?`), and
`DEMO_SPEC_1.3.md`.

---

## Documents that live in the repos, not as artifacts

| path | what it is |
|---|---|
| [`docs/anatomy.html`](anatomy.html) | the experiment-definition diagram, also published above |
| [`docs/screens/`](screens/INDEX.md) | **every view of the hub, 22 screenshots** — one folder, filenames encoding the nav path, with `INDEX.md` giving the hierarchy and what each view shows |
| [`docs/experiment-loop.html`](experiment-loop.html) | the hub walkthrough, also published above |
| `e2b/docs/report-spec.md` | the report contract: arm naming, the eight blocks in order, five rules a report may not break |
| `e2b/docs/diagram.html` | architecture diagram |
| `e2b/results/<run>/report.html` | one per run — generated, never published unless shared deliberately |
| `e2b/template/kong/optimization-params.yaml` | the gateway parameter surface |
| `e2b/template/docker/` | **the local Docker agent sandbox** — read-only source, one writable mount, no capabilities, egress via an allowlisting proxy; `./sandbox.sh verify` proves all eight guarantees |
| `e2b/deploy/` | **the read-only Fly deploy** — `hub-demo.mjs`, `Dockerfile`, `fly.toml`, `build.sh`, and `README.md` saying what is and is not served |
| `e2b/tools/hub-snapshot.mjs` | freezes the hub's API surface into static JSON for that deploy, rewriting home paths to `~` |
| `e2b/packaging/` | **the Homebrew package** — formula, `make-dist.sh`, `publish-tap.sh`, and what the tarball excludes |

Both HTML documents above are symlinked into `e2b/docs/` so a running hub serves them
at `/docs/anatomy.html` and `/docs/experiment-loop.html`.

---

## Two things worth knowing before sharing one

1. **A share link pins a version.** Republishing does not reach people who already have
   the link until the pin is moved from the artifact's share menu. That is how
   `0d2350e5` ended up serving a title three revisions old.
2. **Link previews cache on top of that.** Once a platform has unfurled a URL, it keeps
   that title and image for a while regardless of what the page now says. A fresh URL is
   the only certain fix.
