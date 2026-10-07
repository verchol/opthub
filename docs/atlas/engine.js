/*
 * Optimization atlas — pricing engine. Pure functions, no I/O.
 *
 *   const base = AtlasEngine.baseline(workload)         // monthly cost and its line items
 *   const rows = AtlasEngine.evaluate(workload, scenarios)   // each scenario: best, worst, basis
 *
 * Every estimate is a best case and a worst case in $/month against the baseline, never one
 * number: most levers can be neutral or negative on some workloads, and the worst case says when.
 * Savings overlap — two levers on the same tokens cannot both take the same dollar — so rows are
 * ranked, never summed.
 *
 * Prices: Anthropic list rates per million tokens, input / output. Cache reads bill at 0.1× input,
 * 5-minute cache writes at 1.25×, 1-hour writes at 2×, Batch at 0.5×, fast mode at 2×.
 */
(function (root) {
  const PRICES = {
    "claude-fable-5-1": { in: 10, out: 50, label: "Claude Fable 5.1" },
    "claude-opus-5-5": { in: 4, out: 20, label: "Claude Opus 5.5" },
    "claude-opus-5": { in: 5, out: 25, label: "Claude Opus 5" },
    "claude-sonnet-5": { in: 2, out: 10, label: "Claude Sonnet 5" },
    "claude-haiku-4-5": { in: 1, out: 5, label: "Claude Haiku 4.5" },
  };
  const READ = 0.1, WRITE5 = 1.25, WRITE1H = 2.0;

  /* The workload. Defaults approximate one developer's measured month in opthub (E-series, J3),
     scaled to a 10-person team: 1.8 sessions/day, ~136 requests per session, 96.8% cache hits. */
  const PARAMS = [
    { id: "devs", label: "Developers", unit: "people", min: 1, max: 500, step: 1, def: 10, group: "Volume" },
    { id: "sessions", label: "Sessions per developer per day", unit: "/day", min: 0.2, max: 20, step: 0.1, def: 1.8, group: "Volume" },
    { id: "days", label: "Working days per month", unit: "days", min: 1, max: 31, step: 1, def: 22, group: "Volume" },
    { id: "requests", label: "Requests per session", unit: "requests", min: 1, max: 1000, step: 1, def: 136, group: "Volume" },
    { id: "model", label: "Main model", unit: "", options: Object.keys(PRICES), def: "claude-opus-5", group: "Requests" },
    { id: "ctx", label: "Context per request", unit: "tokens", min: 1000, max: 1000000, step: 1000, def: 150000, group: "Requests" },
    { id: "out", label: "Output per request", unit: "tokens", min: 50, max: 32000, step: 50, def: 3000, group: "Requests" },
    { id: "think", label: "Share of output that is thinking", unit: "%", min: 0, max: 90, step: 1, def: 30, group: "Requests" },
    { id: "hit", label: "Input read from cache", unit: "%", min: 0, max: 99, step: 0.1, def: 96.8, group: "Cache" },
    { id: "schema", label: "Tool definitions in each request", unit: "tokens", min: 0, max: 100000, step: 500, def: 15000, group: "Requests" },
    { id: "simple", label: "Work a mid model could do", unit: "%", min: 0, max: 100, step: 1, def: 35, group: "Mix" },
    { id: "side", label: "Requests that are subagent or background calls", unit: "%", min: 0, max: 80, step: 1, def: 20, group: "Mix" },
    { id: "unattended", label: "Sessions nobody waits on", unit: "%", min: 0, max: 100, step: 1, def: 10, group: "Mix" },
    { id: "separable", label: "Spend in sessions that mix unrelated tasks", unit: "%", min: 0, max: 100, step: 1, def: 30, group: "Mix" },
    { id: "repeat", label: "Byte-identical repeat requests", unit: "%", min: 0, max: 50, step: 0.5, def: 1, group: "Mix" },
    { id: "neardup", label: "Near-duplicate prompts", unit: "%", min: 0, max: 50, step: 0.5, def: 2, group: "Mix" },
    { id: "urgent", label: "Sessions worth paying for speed", unit: "%", min: 0, max: 100, step: 1, def: 5, group: "Mix" },
    { id: "retry", label: "Requests retried or aborted after billing", unit: "%", min: 0, max: 20, step: 0.5, def: 2, group: "Mix" },
    { id: "sandbox", label: "Sandbox compute spend", unit: "$/month", min: 0, max: 50000, step: 50, def: 300, group: "Infrastructure" },
    { id: "idle", label: "Sandbox time spent idle", unit: "%", min: 0, max: 95, step: 1, def: 50, group: "Infrastructure" },
    { id: "selfhost", label: "Self-hosted model spend", unit: "$/month", min: 0, max: 100000, step: 100, def: 0, group: "Infrastructure" },
  ];
  const defaults = () => Object.fromEntries(PARAMS.map((p) => [p.id, p.def]));

  function inputCostPerReq(w, hit, P) {
    const h = hit / 100;
    return { read: w.ctx * h * READ * P.in / 1e6, write: w.ctx * (1 - h) * WRITE5 * P.in / 1e6 };
  }

  function baseline(w) {
    const P = PRICES[w.model] || PRICES["claude-opus-5"];
    const reqs = w.devs * w.sessions * w.days * w.requests;
    const i = inputCostPerReq(w, w.hit, P);
    const outReq = w.out * P.out / 1e6;
    const read = i.read * reqs, write = i.write * reqs, out = outReq * reqs;
    const think = out * w.think / 100;
    const llm = read + write + out;
    return { reqs, read, write, out, think, input: read + write, llm,
             sandbox: w.sandbox, selfhost: w.selfhost, total: llm + w.sandbox + w.selfhost,
             perDev: (llm + w.sandbox + w.selfhost) / Math.max(1, w.devs), price: P };
  }

  const ratio = (from, to) => Math.min(1, PRICES[to].in / PRICES[from].in);

  /* One function per scenario id: [worst, best] in $/month, and the sentence that says how. */
  const F = {
    "prompt-caching": (w, b) => {
      if (w.hit >= 97) return [0, 0, "Already above 97% cache hits: nothing left to win."];
      const P = b.price, at = (h) => { const c = inputCostPerReq(w, h, P); return (c.read + c.write) * b.reqs };
      return [Math.max(0, b.input - at(Math.max(w.hit, 90))), b.input - at(97),
        `Input re-priced at a 90% (worst) to 97% (best) hit rate, from ${w.hit}%.`];
    },
    "cache-ttl": (w, b) => [-0.1 * b.write, 0.3 * b.write, "−10% to +30% of cache-write spend; the sign depends on how long people pause between turns."],
    "response-cache": (w, b) => [0.5 * w.repeat / 100 * b.llm, w.repeat / 100 * b.llm, `Half to all of the ${w.repeat}% byte-identical repeats answered from cache.`],
    "semantic-cache": (w, b) => [0, 0.8 * w.neardup / 100 * b.llm, `Up to 80% of the ${w.neardup}% near-duplicates answered from cache; zero when matches are unsafe.`],
    "cache-prewarm": () => [0, 0, "Latency only: one early cache write, no cost saving."],
    "model-upgrade": (w, b) => {
      if (!w.model.startsWith("claude-opus-5") || w.model === "claude-opus-5-5") return [0, 0, "Only applies when moving from Opus 5 to Opus 5.5."];
      return [0.5 * 0.2 * b.llm, 0.2 * b.llm, "Opus 5.5 lists 20% below Opus 5. Worst case assumes a behaviour change gives half of it back in extra tokens."];
    },
    "route-whole-task": (w, b) => {
      const r = ratio(w.model, "claude-sonnet-5"); if (r >= 1) return [0, 0, "Already on a mid model."];
      const base = w.simple / 100 * b.llm;
      // measured in opthub (J3): the Sonnet arm cost 2.4× and 3.9× what the Opus arm cost for the same task
      return [base * (1 - 2.4), base * (1 - r), `${w.simple}% of spend at Sonnet prices (best). Worst case: the task costs 2.4× more on Sonnet, the milder of opthub's two measured re-runs.`];
    },
    "route-side-calls": (w, b) => {
      const side = w.side / 100 * b.llm;
      return [side * (1 - ratio(w.model, "claude-sonnet-5")) * 0.5, side * (1 - ratio(w.model, "claude-haiku-4-5")),
        `The ${w.side}% subagent and background calls moved to Haiku (best) or half of them to Sonnet (worst).`];
    },
    "cascade": (w, b) => {
      const base = w.simple / 100 * b.llm, rs = ratio(w.model, "claude-haiku-4-5"), rm = ratio(w.model, "claude-sonnet-5");
      return [base * ((1 - rm) - 0.5), base * ((1 - rs) - 0.25), "Small model first on the simple share; 25% (best) to 50% (worst) of it escalates and pays twice."];
    },
    "local-offload": (w, b) => {
      const off = w.simple / 100 * 0.5 * b.llm, s = 1 - 1 / 7.1;
      return [-off / 7.1, off * s, "Half the simple share served 7.1× cheaper (measured). Worst case: the measured 18-point drop means all of it is redone on the frontier model, so the local run was paid for nothing."];
    },
    "advisor": (w, b) => { const rm = ratio(w.model, "claude-sonnet-5"); return [-0.05 * b.llm, b.llm * (1 - rm) * 0.7 * w.simple / 100 * 2, "Best: most of the mid-model discount kept on the work it can do. Worst: advisor calls and extra turns cost 5% more than today."]; },
    "plan-execute": (w, b) => { const rm = ratio(w.model, "claude-sonnet-5"); return [-0.05 * b.llm, b.llm * (1 - rm) * 0.8 * w.simple / 100, "Best: the simple share executed on the mid model, the plan on the frontier. Worst: a weak plan executed faithfully costs 5% more in rework."]; },
    "distill": (w, b) => [0, 0.85 * w.simple / 100 * b.llm, "Up to 85% off the simple share, before the training cost; zero if the distilled model misses the bar."],
    "effort": (w, b) => [0.2 * b.think, 0.6 * b.think + 0.1 * (b.out - b.think), "20–60% fewer thinking tokens, plus a little shorter output at the best end."],
    "thinking-cap": (w, b) => [0.15 * b.think, 0.5 * b.think, "15–50% of thinking spend. Overlaps lowering effort."],
    "output-length": (w, b) => [0.1 * (b.out - b.think), 0.3 * (b.out - b.think), "10–30% of non-thinking output."],
    "task-budget": (w, b) => [0, 0.05 * b.llm, "Up to 5% of spend: the long tail of runaway tasks."],
    "split-sessions": (w, b) => [0.25 * w.separable / 100 * b.input, 0.5 * w.separable / 100 * b.input, `25–50% of the history cost in the ${w.separable}% of spend that mixes unrelated tasks.`],
    "compaction": (w, b) => [-0.02 * b.input, 0.3 * b.input, "Up to 30% of input; slightly negative when each compaction's summary and cache rebuild cost more than the shorter history saves."],
    "context-editing": (w, b) => [-0.05 * b.input, 0.02 * b.input, "Roughly neutral: each clear rewrites the cached history."],
    "prefix-trim": (w, b) => { const s = Math.min(1, w.schema / w.ctx); return [0.3 * s * b.input, 0.7 * s * b.input, `30–70% of the ${Math.round(s * 100)}% of each request that is tool definitions.`]; },
    "tool-search": (w, b) => { const s = Math.min(1, w.schema / w.ctx); return [0.4 * s * b.input, 0.85 * s * b.input, "40–85% of tool-definition tokens loaded only when searched. Overlaps dropping unused tools."]; },
    "retrieval": (w, b) => [0, 0.3 * b.input, "Up to 30% of input where whole documents sit in context; zero for agents that already read on demand."],
    "prompt-compression": (w, b) => [-0.1 * b.read, 0.5 * b.write, "Half of the uncached input at best; at worst it breaks the cache and loses 10% of read spend."],
    "dedupe-reads": (w, b) => [0.03 * b.input, 0.15 * b.input, "3–15% of input from files read again unchanged."],
    "batch": (w, b) => {
      const u = w.unattended / 100, T = u * b.llm, R = u * b.read;
      return [T - 0.5 * (T + 9 * R), 0.5 * T, `Half price on the ${w.unattended}% nobody waits on (best). Worst: the cache misses inside the batch and cache reads bill at the full input rate.`];
    },
    "fewer-turns": (w, b) => [0.05 * b.input, 0.3 * b.input, "5–30% of input: every saved turn saves one re-send of the context."],
    "failed-requests": (w, b) => [0.5 * w.retry / 100 * b.llm, w.retry / 100 * b.llm, `Half to all of the ${w.retry}% of requests billed and then retried or abandoned.`],
    "preflight": (w, b) => [0, 0.01 * b.llm, "Up to 1%: oversized outliers caught before billing."],
    "fast-mode": (w, b) => {
      if (!["claude-opus-5", "claude-opus-5-5"].includes(w.model)) return [0, 0, "Fast mode is Opus 5 / 5.5 on the Claude API only."];
      const s = -w.urgent / 100 * b.llm; return [s, s, `Spend: twice the price on the ${w.urgent}% of sessions where speed is worth it.`];
    },
    "turn-cap": (w, b) => [0, 0.014 * b.llm, "Up to 1.4% of spend: the share loops took in opthub's measured month."],
    "budgets": () => [0, 0, "A guard: bounds the worst case, saves nothing on a normal day."],
    "showback": (w, b) => [0, 0.1 * b.llm, "Up to 10%, from behaviour change once teams see their own spend."],
    "provider-choice": (w, b) => [-0.05 * b.llm, 0.1 * b.llm, "−5% to +10%: partner prices differ by contract and region."],
    "sandbox-idle": (w, b) => [0.5 * w.idle / 100 * w.sandbox, 0.9 * w.idle / 100 * w.sandbox, `50–90% of the ${w.idle}% of sandbox time spent idle.`],
    "sandbox-rightsize": (w, b) => [0.1 * w.sandbox, 0.4 * w.sandbox, "10–40% of sandbox spend from smaller machines."],
    "selfhost-quant": (w, b) => [0.2 * w.selfhost, 0.5 * w.selfhost, "20–50% of self-hosted spend at lower precision."],
    "selfhost-serving": (w, b) => [0.2 * w.selfhost, 0.6 * w.selfhost, "20–60% of self-hosted spend from better batching and caching."],
  };

  /* Which workload inputs move which scenarios — the "every parameter" table. */
  const MOVES = {
    devs: "*", sessions: "*", days: "*", requests: "*", model: ["model-upgrade", "route-whole-task", "route-side-calls", "cascade", "advisor", "fast-mode"],
    ctx: ["prompt-caching", "split-sessions", "compaction", "prefix-trim", "tool-search", "fewer-turns", "batch"],
    out: ["effort", "thinking-cap", "output-length"], think: ["effort", "thinking-cap"],
    hit: ["prompt-caching", "cache-ttl", "batch", "prompt-compression"], schema: ["prefix-trim", "tool-search"],
    simple: ["route-whole-task", "cascade", "local-offload", "plan-execute", "distill"], side: ["route-side-calls"],
    unattended: ["batch"], separable: ["split-sessions"], repeat: ["response-cache"], neardup: ["semantic-cache"],
    urgent: ["fast-mode"], retry: ["failed-requests"], sandbox: ["sandbox-idle", "sandbox-rightsize"], idle: ["sandbox-idle"],
    selfhost: ["selfhost-quant", "selfhost-serving"],
  };

  function evaluate(w, scenarios) {
    const b = baseline(w);
    return scenarios.map((s) => {
      const f = F[s.id];
      const [worst, best, basis] = f ? f(w, b) : [0, 0, "no formula"];
      return { ...s, worst, best, basis, bestPct: b.total ? best / b.total : 0, worstPct: b.total ? worst / b.total : 0 };
    });
  }

  const api = { PRICES, PARAMS, MOVES, defaults, baseline, evaluate, formulas: Object.keys(F) };
  if (typeof module === "object" && module.exports) module.exports = api;
  root.AtlasEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
