#!/usr/bin/env python3
"""hostcost — what the same Claude Code traffic costs on Anthropic's tiers, on a serverless
open-weights API, on a local Ollama tier, and on a GPU endpoint hosted per customer.
Free, no network, stdlib only.

    python3 tools/hostcost.py                       # every table
    python3 tools/hostcost.py --routed 0.1,0.25,0.5 # share of spend a cheaper tier takes
    python3 tools/hostcost.py --current sonnet-5.5  # the model the customer runs today
    python3 tools/hostcost.py --json                # machine-readable

Why this exists: Claude Code traffic is mostly cache reads. The price of the *cached-input* line,
not the headline input price, decides what a tier costs. A tier is compared on the same token
shape, measured from the pinned E1b ledger (docs/data/e1b-sessions.csv), never on list price alone.

Labels on every input (CLAUDE.md, Rules for numbers):
  F  vendor price page or official doc, dated     M  measured, from a pinned file in this repo
  V  third party or single source, dated          G  guess, basis stated      U  derived, unmeasured
Every dedicated-GPU row is `priced`: list GPU rates, a ceiling. Nothing here was measured on a GPU.
Quality is not in this file: a cheaper tier that fails the task costs more, not less
(docs/dynamic-config-analysis.md X2: Sonnet main loop 2.4-3.9x MORE per task, n=2;
docs/evidence-catalog.md: open weights 7.1x cheaper and 18 points worse, n=1).

Known limits of the shape: tools/savings.py folds uncached input into read$ at the full input rate, so a
few uncached tokens are counted here as ten cache reads each (negligible on Claude Code traffic, not
measurable from the ledger). The routed slice is assumed to look like the short-context sessions.
"""
import argparse, csv, json, math, os

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
LEDGER = os.path.join(REPO, "docs", "data", "e1b-sessions.csv")

# ---------------------------------------------------------------- Anthropic, F: platform pricing
# https://platform.claude.com/docs/en/about-claude/pricing, read 2026-10-24. USD per 1M tokens.
# (input, 5m write, 1h write, cache read, output)
ANTHROPIC = {
    "opus-5.5":        (4.00, 5.00,  8.00, 0.20, 20.00),
    "sonnet-5.5":      (2.00, 2.50,  4.00, 0.10, 10.00),
    "haiku-5.5":       (0.10, 0.125, 0.20, 0.01,  0.50),   # prompts <= 100K tokens
    "haiku-5.5>100K":  (0.50, 0.625, 1.00, 0.05,  2.50),   # whole request reprices above 100K
}
# E1b was priced per model by tools/savings.py; Opus 5 is 98% of its dollars, so Opus 5 list rates turn
# its dollars back into tokens (the shape moves by <0.5% if the other 2% is priced exactly).
OPUS5 = (5.00, 6.25, 10.00, 0.50, 25.00)


# ---------------------------------------------------------------- traffic shape, M
def shape_from_ledger(keep=lambda r: True, write_ttl="1h", path=LEDGER):
    """Per 1M input tokens of real Claude Code traffic: cache reads, cache writes, output.

    The ledger holds dollars by line (read$, write$, out$). Ratios are used, so the ~2x per-record
    overcount in savings.py (PROGRESS 2026-10-23) cancels. write_ttl is G: the development machine ran
    1h on every session dynconfig saw (docs/dynamic-config-analysis.md §2, lever 3). The 5m variant only
    re-divides the same write dollars by the 5m price; it is a conversion sensitivity, not a TTL scenario.
    """
    rows = [r for r in csv.DictReader(open(path)) if keep(r)]
    read_usd = sum(float(r["read$"]) for r in rows)
    write_usd = sum(float(r["write$"]) for r in rows)
    out_usd = sum(float(r["out$"]) for r in rows)
    w_price = OPUS5[2] if write_ttl == "1h" else OPUS5[1]
    reads, writes, out = read_usd / OPUS5[3], write_usd / w_price, out_usd / OPUS5[4]
    inp = reads + writes
    return {"read": reads / inp, "write": writes / inp, "out": out / inp, "sessions": len(rows)}


SHORT = lambda r: float(r["ctx_p50"]) <= 100_000   # sessions whose median request fits Haiku's low tier


def usd_per_m_input(rates, shape, ttl="1h"):
    """$ per 1M input tokens of `shape` on an Anthropic tier, prompt caching on."""
    inp, w5, w1h, rd, out = rates
    return shape["read"] * rd + shape["write"] * (w1h if ttl == "1h" else w5) + shape["out"] * out


# ---------------------------------------------------------------- open weights, serverless
# name: (input, cached input or None, output, write multiplier, label, source), USD per 1M, fetched 2026-10-24.
# None = the price page lists no cached price: every input token bills as input. Write multiplier: what a cache
# write costs relative to input (automatic caching bills writes as plain input; Bedrock explicit caching 1.25x,
# 30-minute TTL, so Kimi K3 is slightly underpriced on the 1h shape).
SERVERLESS = {
    "gpt-oss-120b · Fireworks":          (0.15, 0.015, 0.60, 1.0,  "F", "fireworks.ai/pricing"),
    "DeepSeek V4.1 Flash · Fireworks":   (0.30, 0.006, 1.20, 1.0,  "F", "fireworks.ai/pricing"),
    "GLM 5.3 Flash · Fireworks":         (0.15, 0.03,  0.50, 1.0,  "F", "fireworks.ai/pricing"),
    "MiniMax M3 · Fireworks":            (0.30, 0.06,  1.20, 1.0,  "F", "fireworks.ai/pricing"),
    "Qwen3-Coder-480B · DeepInfra":      (0.30, 0.10,  1.00, 1.0,  "F", "deepinfra.com/pricing"),
    "GLM 5.3 · Fireworks":               (1.40, 0.26,  4.40, 1.0,  "F", "fireworks.ai/pricing"),
    "Kimi K3 · Bedrock global":          (3.00, 0.30, 15.00, 1.25, "F", "aws.amazon.com/bedrock/pricing"),
    "Qwen3 Coder Next · Bedrock US":     (0.50, None,  1.20, 1.0,  "F", "aws.amazon.com/bedrock/pricing, no cache price"),
    "MiniMax M2.5 · Bedrock US":         (0.30, None,  1.20, 1.0,  "F", "aws.amazon.com/bedrock/pricing, no cache price"),
}


def usd_serverless(spec, shape):
    inp, cached, outp, wmul = spec[:4]
    if cached is None:
        return inp + shape["out"] * outp
    return shape["read"] * cached + shape["write"] * inp * wmul + shape["out"] * outp


# ---------------------------------------------------------------- dedicated GPU endpoints
# name: (gpus, $/GPU-hour, label, source, displaced tier, resident sessions per replica or None).
# A small model (Qwen3-Coder-30B-A3B class) only stands in for Haiku-class work; a GLM-5.2-class model
# (MIT, 753B, FP8 on 8xH200) is compared with Sonnet 5.5. Quality is assumed equal, which nothing measures.
# Resident sessions: ~35 GB of KV left on an H100 after fp8 weights, 48 KiB fp8 KV per token for
# Qwen3-Coder-30B-A3B (research D, derived from config.json: U), at the 35K-token median context. A replica
# that cannot hold the peak's live routed sessions needs more replicas; the 8-GPU row's KV size is U.
H100_KV_GB, KV_KIB_PER_TOKEN, CTX = 35, 48, 35_000
SMALL_SESSIONS = int(H100_KV_GB / (CTX * KV_KIB_PER_TOKEN * 1024 / 1e9))
DEDICATED = {
    "small model, 1xH100 · DeepInfra":        (1, 2.90, "F", "deepinfra.com/pricing (dedicated via sales)", "haiku-5.5", SMALL_SESSIONS),
    "small model, 1xH100 · AWS p5.4xlarge":   (1, 6.88, "F", "AWS list via Vantage; no H100 in il-central-1", "haiku-5.5", SMALL_SESSIONS),
    "GLM-5.2-class, 8xH200 · DeepInfra":      (8, 3.49, "F", "deepinfra.com/pricing (dedicated via sales)", "sonnet-5.5", None),
    "GLM-5.2-class, 8xH200 · AWS p5en":       (8, 7.91, "F", "AWS list via Vantage; Stockholm nearest", "sonnet-5.5", None),
}
OPS_USD_MONTH = 275_000 / 12   # V: fully loaded GPU infra engineer (IntuitionLabs, 2026-09-05)
OPS_SHARE = 0.10               # G: share of one engineer each per-customer endpoint takes
HOURS_MONTH = 730              # always on
WORK_HOURS = 22 * 12           # G: a warm pool kept up 12 h on working days (scale-to-zero is unrealistic for 8-GPU models)
PEAK_ACTIVE = 0.5              # G: share of developers with a live session at the peak hour


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--devs", default="45,150,500,1000")
    ap.add_argument("--routed", default="0.1,0.25,0.5", help="share of the current spend moved to the target")
    ap.add_argument("--current", default="opus-5.5", choices=["opus-5.5", "sonnet-5.5"])
    ap.add_argument("--ttl", default="1h", choices=["1h", "5m"])
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    devs = [int(x) for x in a.devs.split(",")]
    routed = [float(x) for x in a.routed.split(",")]
    out = {}

    full = shape_from_ledger(write_ttl=a.ttl)
    short = shape_from_ledger(SHORT, write_ttl=a.ttl)
    alt = shape_from_ledger(write_ttl="5m" if a.ttl == "1h" else "1h")
    rows_l = list(csv.DictReader(open(LEDGER)))
    inp_usd = lambda r: float(r["read$"]) + float(r["write$"])
    over = sum(inp_usd(r) for r in rows_l if not SHORT(r)) / sum(inp_usd(r) for r in rows_l)
    out["shape"] = {"all": full, "short": short, "share_input_usd_over_100k": over}

    def table(rows, cols):
        w = [max(len(str(c)), *(len(str(r[i])) for r in rows)) for i, c in enumerate(cols)]
        line = lambda r: "  ".join(str(v).rjust(w[i]) if i else str(v).ljust(w[i]) for i, v in enumerate(r))
        print(line(cols)); print("  ".join("-" * x for x in w))
        for r in rows: print(line(r))

    pct = lambda s: f"{s['read']*100:.1f}% read · {s['write']*100:.1f}% write · {s['out']*100:.2f}% output"
    print(f"== 1. Traffic shape, per input token (M: E1b ledger, writes at {a.ttl}) ==")
    print(f"all {full['sessions']} sessions: {pct(full)}   (writes re-divided at the other TTL's price: {alt['read']*100:.1f}% read)")
    print(f"short-context ({short['sessions']} sessions, median request <= 100K): {pct(short)}")
    print(f"{over:.1%} of input dollars sit in sessions whose median request is over 100K")

    print("\n== 2. Same traffic, $ per 1M input tokens (output included), by tier, all-session shape ==")
    per = {k: usd_per_m_input(v, full, a.ttl) for k, v in ANTHROPIC.items()}
    rows = [(k, f"${v:.4f}", "F", "cached, list price") for k, v in per.items()]
    for name, spec in SERVERLESS.items():
        v = usd_serverless(spec, full); per[name] = v
        rows.append((name, f"${v:.4f}", spec[4], spec[5] + ("" if spec[1] is not None else " (billed uncached)")))
    per["haiku-5.5 main thread"] = over * per["haiku-5.5>100K"] + (1 - over) * usd_per_m_input(ANTHROPIC["haiku-5.5"], full, a.ttl)
    rows.append(("haiku-5.5 main thread (blend)", f"${per['haiku-5.5 main thread']:.4f}", "M", f"{over:.1%} of input $ priced at the >100K tier"))
    rows.append(("local Ollama (marginal)", "$0.0000", "G", "hardware already owned; latency and quality not priced"))
    rows.sort(key=lambda r: float(r[1][1:]))
    rows = [r + (f"{float(r[1][1:]) / per[a.current]:.2f}x",) for r in rows]
    table(rows, ("tier", "$/1M input", "label", "basis", f"vs {a.current}"))
    out["usd_per_m_input"] = per

    # dynconfig priced every cache read at 0.1x input; Opus and Sonnet 5.5 read at 0.05x. Undo that on the
    # development machine's spend before using it as a scenario.
    o = ANTHROPIC["opus-5.5"]
    inflate = usd_per_m_input((o[0], o[1], o[2], 0.1 * o[0], o[4]), full, a.ttl) / usd_per_m_input(o, full, a.ttl)
    spend = {
        "enterprise-avg-low": (150, "F", "code.claude.com/docs/en/costs: $150-250 per developer-month"),
        "enterprise-avg-high": (250, "F", "same page, upper end"),
        "heavy (dev machine)": (round(235.70 / 14 * 30.4 / inflate, 2), "M",
                                f"dynconfig last two weeks x 30.4/14, / {inflate:.2f} for its 0.1x cache reads"),
    }
    out["spend"] = spend

    # Value of a routed slice, as a share r of the current spend. Haiku-class targets (Haiku, local, a small model)
    # take short-context work, priced on the short shape; Sonnet-class targets on the all-session shape.
    ratio = lambda tgt, shp: usd_per_m_input(ANTHROPIC[tgt], shp, a.ttl) / usd_per_m_input(ANTHROPIC[a.current], shp, a.ttl)
    r_haiku, r_sonnet = ratio("haiku-5.5", short), ratio("sonnet-5.5", full)
    out["slice_cost_ratio"] = {"haiku_short": r_haiku, "sonnet_all": r_sonnet}
    print(f"\n== 3. Value of the routed slice per developer-month (current {a.current}) ==")
    print(f"slice cost on Haiku 5.5 = {r_haiku:.4f} x its cost now (short-context shape); on Sonnet 5.5 = {r_sonnet:.3f} x (all sessions).")
    print("Saving = slice now − slice on the target. A free tier (local, or a GPU already paid for) saves the whole slice.")
    print("Quality and extra turns are NOT priced; they only shrink these.")
    rows = []
    for sname, (s, lab, _) in spend.items():
        for r in routed:
            sl = r * s
            rows.append((f"{sname} ${s:.0f} ({lab})", f"{r:.0%}", f"${sl:,.2f}", f"${sl*(1-r_sonnet):,.2f}",
                         f"${sl*(1-r_haiku):,.2f}", f"${sl:,.2f}", f"${sl*r_haiku:,.2f}"))
    table(rows, ("spend scenario", "routed", "slice now", "save→Sonnet5.5", "save→Haiku5.5", "save→free tier",
                 "free tier beyond Haiku5.5"))
    out["slice"] = rows

    print("\n== 4. Dedicated endpoint per customer: break-even developers (priced; quality assumed equal) ==")
    print(f"Fixed = GPUs x $/GPU-h x hours + ops ({OPS_SHARE:.0%} of a ${OPS_USD_MONTH*12:,.0f}/yr engineer, V/G).")
    print(f"Small-model replicas hold {SMALL_SESSIONS} resident {CTX/1000:.0f}K sessions each (U); the peak needs "
          f"{PEAK_ACTIVE:.0%} of developers x routed share live sessions (G). The 8-GPU rows ignore capacity (KV size U).")
    rows = []
    for name, (gpus, rate, lab, src, tgt, cap) in DEDICATED.items():
        for hours, hl in ((HOURS_MONTH, "24x7"), (WORK_HOURS, "12h x 22d")):
            gpu_m = gpus * rate * hours
            ops = OPS_SHARE * OPS_USD_MONTH
            for sname in ("enterprise-avg-high", "heavy (dev machine)"):
                s = spend[sname][0]
                for r in routed:
                    gain = r * s * (r_haiku if tgt == "haiku-5.5" else r_sonnet)   # the slice on the cheapest Anthropic alternative
                    if cap:   # replicas grow with headcount: n devs need ceil(n * PEAK * r / cap) replicas
                        per_dev_gpu = gpu_m * PEAK_ACTIVE * r / cap
                        be = "never" if gain <= per_dev_gpu else f"{math.ceil(next(n for n in range(1, 10**6) if n * gain >= max(1, math.ceil(n * PEAK_ACTIVE * r / cap)) * gpu_m + ops)):,}"
                    else:
                        be = f"{math.ceil((gpu_m + ops) / gain):,}"
                    rows.append((name, hl, f"${gpu_m + ops:,.0f}", f"{sname} ${s:.0f}", f"{r:.0%}", tgt, f"${gain:,.2f}", be))
    table(rows, ("endpoint", "hours", "fixed $/mo (1 replica)", "spend per dev", "routed", "displaces", "value/dev-mo", "break-even devs"))
    out["dedicated"] = rows

    print("\n== 5. Load per active developer (enterprise-avg-high, 8 active hours x 22 days, G) ==")
    T = spend["enterprise-avg-high"][0] / usd_per_m_input(ANTHROPIC[a.current], full, a.ttl) * 1e6
    secs = 22 * 8 * 3600
    print(f"  {T*full['write']/secs:,.0f} new-prefill tok/s and {T*full['out']/secs:,.1f} output tok/s per active developer")
    print(f"  {CTX/1000:.0f}K sessions per H100 replica: {SMALL_SESSIONS}; at 142K (AgentX median request, V): "
          f"{int(H100_KV_GB / (142_000 * KV_KIB_PER_TOKEN * 1024 / 1e9))}")
    print("  peak live sessions, before the routed share: " + ", ".join(f"{d} devs -> {d*PEAK_ACTIVE:.0f}" for d in devs))

    if a.json:
        print(json.dumps(out, indent=1, default=str))


if __name__ == "__main__":
    main()
