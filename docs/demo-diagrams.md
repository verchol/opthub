# opthub — demo diagrams

**Source of truth:** `docs/demo-mock-spec.md` v0.2 (the four-terminal demo) and `docs/demo-thesis.md`.
Every number here is copied from the spec's per-beat table (§5); change it there first.

**To convert:** each block is plain Mermaid.
- **Slides / PNG / SVG:** `mmdc -i docs/demo-diagrams.md -o docs/screens/diagrams/demo.svg`
  (one file per block), or paste a block into [mermaid.live](https://mermaid.live) and export.
- **Hand-drawn look:** Excalidraw → *More tools → Mermaid to Excalidraw* (flowcharts convert to
  editable shapes; the sequence diagram and chart come in as images).
- **draw.io:** *Arrange → Insert → Advanced → Mermaid*.

Colors are the spec's pane accents (§1): ① blue `#3987e5` · ② violet `#9085e9` ·
③ aqua `#199e70` · ④ yellow `#c98500` · critical `#d03b3b`.

---

## 1. The stage — four panes, three claims

What the audience sees, and what flows between the panes. C1/C2/C3 are the claims in spec §0.1.

```mermaid
flowchart LR
  DEV(["Developer<br/>5 prompts · 22 min<br/>payments incident"])

  subgraph EDGE["Developer machine / sandbox — THE EDGE"]
    direction TB
    MAIN["① MAIN · LIVE<br/>Claude Code, real session<br/><b>$4.82</b>"]
    EXP["② EXPERIMENT · SHADOWING<br/>session-view classifier<br/>LLM Ultra Light + Jev<br/>replay · blind grade<br/><b>$1.63 · −66%</b>"]
  end

  subgraph CENTRAL["Central — opthub"]
    POL["③ POLICY v14 · CENTRAL<br/>routable: non-coding/*<br/>never_downgrade: review/security, coding/debug<br/>judge: opus-5 pinned · jev shadow"]
  end

  subgraph USUAL["The usual way"]
    RT["④ GATEWAY ROUTER · PROMPT-ONLY<br/>no session, no gates<br/><b>$0.38 · wrong twice</b>"]
  end

  CHEAP[("cheaper model")]

  DEV --> MAIN
  MAIN -->|"C1 · whole session:<br/>tools, edits, thread"| EXP
  MAIN -->|"prompt text only"| RT
  POL ==>|"C2 · policy pushed<br/>to 3 machines"| EXP
  EXP -.->|"verdicts + human ratings<br/>= evidence"| POL
  EXP -->|"C3 · one turn,<br/>scoped context 6.1k"| CHEAP
  RT -->|"whole request, 51k"| CHEAP

  classDef main fill:#3987e5,stroke:#3987e5,color:#fff
  classDef exp fill:#9085e9,stroke:#9085e9,color:#fff
  classDef pol fill:#199e70,stroke:#199e70,color:#fff
  classDef rt fill:#c98500,stroke:#c98500,color:#fff
  classDef dim fill:#f4f4f2,stroke:#898781,color:#131312
  class MAIN main
  class EXP exp
  class POL pol
  class RT rt
  class DEV,CHEAP dim
```

---

## 2. The five beats — what the edge decided, what the router did

One row per beat. Top lane: opthub at the edge. Bottom lane: the prompt-only router.
Keep = stays on frontier · Route = cheaper model with scoped context · Blocked = policy said no.

```mermaid
flowchart LR
  subgraph OPT["② opthub — session view"]
    direction LR
    B1["<b>Beat 1</b> · idempotency keys<br/>coding/edit · KEEP<br/>cache 96.8%: nothing to do<br/>$0.94 → $0.41"]
    B2["<b>Beat 2</b> · flaky test<br/>coding/debug · KEEP<br/>context-lifecycle −54%<br/>human rated it worse ⚑"]
    B3["<b>Beat 3</b> · explain retries<br/>non-coding/explain · ROUTE<br/>context 51k → 6.1k<br/>$0.24 → $0.05"]
    B4["<b>Beat 4</b> · review the diff<br/>review/security · BLOCKED<br/>never_downgrade<br/>3 of 3 findings"]
    B5["<b>Beat 5</b> · PR description<br/>non-coding/pr · ROUTE<br/>context 21.6k → 2.4k<br/>$0.32 → $0.08"]
    B1 --> B2 --> B3 --> B4 --> B5
  end

  subgraph GWR["④ prompt-only router"]
    direction LR
    R1["Beat 1 → Haiku<br/>✖ in-memory dedupe<br/>per-process only"]
    R2["Beat 2 → Haiku<br/>⚠ masks the race<br/>with a sleep"]
    R3["Beat 3 → Haiku<br/>✔ same answer<br/>paid for 51k"]
    R4["Beat 4 → Haiku<br/>'summarize' p=0.71<br/>✖ MISSED HIGH"]
    R5["Beat 5 → Haiku<br/>✔ same answer"]
    R1 --> R2 --> R3 --> R4 --> R5
  end

  B4 -. "same prompt,<br/>different class" .- R4

  classDef keep fill:#eef3fc,stroke:#3987e5,color:#131312
  classDef route fill:#efedfc,stroke:#9085e9,color:#131312
  classDef block fill:#e8f6f0,stroke:#199e70,color:#131312
  classDef ok fill:#fdf6e6,stroke:#c98500,color:#131312
  classDef bad fill:#fbeaea,stroke:#d03b3b,color:#131312,stroke-width:2px
  class B1,B2 keep
  class B3,B5 route
  class B4 block
  classDef warn fill:#fef4e0,stroke:#fab219,color:#131312,stroke-width:2px
  class R3,R5 ok
  class R2 warn
  class R1,R4 bad
```

---

## 3. Beat 4, one request — why the decision has to live at the edge (C1)

The thesis of the demo in one exchange. Same prompt; two classifiers; only one can see the session.

```mermaid
sequenceDiagram
  autonumber
  actor Dev as Developer
  participant CC as ① Claude Code
  participant ULT as ② LLM Ultra Light (edge)
  participant POL as ③ Policy v14 (central)
  participant GW as ④ Gateway router
  participant H as Haiku (cheap)

  Dev->>CC: "go over the diff — anything that'd bite us?"
  par edge sees the session
    CC->>ULT: prompt + git diff 1,204 lines + idempotency.ts + payments thread
    ULT-->>CC: review/security · p=0.97
    CC->>POL: route review/security?
    POL-->>CC: never_downgrade · BLOCKED
    Note over CC: stays on frontier · context scoped 96k → 61k<br/>3 of 3 findings · $2.61 → $0.76
  and gateway sees one request
    CC->>GW: prompt text only
    GW-->>GW: non-coding/summarize · p=0.71
    GW->>H: route, no gate
    H-->>GW: 2 findings
    Note over GW,H: ✖ missed HIGH: unbounded client key<br/>$0.21 — and shipped the incident
  end
  CC-)POL: evidence: forgone −$0.44, gate held
```

---

## 4. Phase 1 → Phase 2 — the product behind the demo

The demo shows Phase 2's decision; Phase 1 is where the classifier and the savings come from.

```mermaid
flowchart TB
  subgraph P1["Phase 1 — LEARN (runs today)"]
    direction LR
    T["Claude Code sessions<br/>~/.claude/projects"] --> A["Analyse<br/>cost · context · cache · tools"]
    A --> C["Classify<br/>5 axes · rules + Jev"]
    C --> SP["Saving potential<br/>per strategy · labelled"]
    SP --> X["Prove<br/>sandbox replay · blind grade"]
  end

  POL["③ opthub policy vN<br/>classes · never_downgrade · judge · thresholds"]

  subgraph P2["Phase 2 — ACT at the edge"]
    direction LR
    SK["/optimize skill<br/>in Claude Code"] --> CTX["preload opthub context<br/>policy + dev history + task"]
    CTX --> ULT["LLM Ultra Light<br/>local · Jev-distilled classifier"]
    ULT --> DEC{"each request"}
    DEC -->|keep| F["frontier"]
    DEC -->|"route + scope"| M["cheaper model"]
    DEC -->|local| L["Ultra Light answers"]
    DEC -->|defer| B["batch"]
  end

  X --> POL
  C -->|"labels train the classifier"| ULT
  POL --> CTX
  DEC -.->|"outcomes = evidence"| POL

  classDef pol fill:#199e70,stroke:#199e70,color:#fff
  classDef edge fill:#9085e9,stroke:#9085e9,color:#fff
  class POL pol
  class ULT,DEC edge
```

---

## 5. The money — cumulative spend over the five beats

Spec §7.1 series. Blue = ① actual · violet = ② opthub, all gates passed · yellow = ④ router, no gates.

```mermaid
---
config:
  themeVariables:
    xyChart:
      plotColorPalette: "#3987e5, #9085e9, #c98500"
---
xychart-beta
  title "Cumulative spend, USD"
  x-axis ["beat 1", "beat 2", "beat 3", "beat 4", "beat 5"]
  y-axis "USD" 0 --> 5
  line [0.94, 1.65, 1.89, 4.50, 4.82]
  line [0.41, 0.74, 0.79, 1.55, 1.63]
  line [0.06, 0.11, 0.13, 0.34, 0.38]
```

**Closing line under the chart:** actual **$4.82** · opthub **$1.63 (−66%)**, every gate passed ·
router **$0.38 (−92%)**, *$1.25 cheaper than opthub and wrong twice*.
