#!/usr/bin/env python3
"""dynconfig — what each session on this machine would have cost with a Claude Code
configuration chosen for *that* session ("dynamic" configuration). Free and read-only.

    python3 tools/dynconfig.py [--root DIR] [--since YYYY-MM-DD] [--top 15]
                               [--out data/private/dynconfig]

Lever catalog: the "Claude Config & Routing Levers" doc (model, reasoning, context, cache,
routing). Every lever that the transcripts can price is evaluated per session; the rest are
listed in the report as not measurable from transcripts.

Counting: Claude Code writes one transcript record per content block and repeats the API
response's usage on each, so usage is counted once per request (message.id, else requestId).
Summing every record overstates cost about 2x on this machine. Subagent transcripts
(<project>/<session>/subagents/*.jsonl) are counted with their parent session.

Attribution is marginal, in applied order (SPEC R1): each lever acts on what the levers before it
left. Never add the standalone ceilings at the bottom to the stacked total.

  #  lever                         evidence   rule (fires per session when ...)
  1  fast mode off                 measured   any request ran with usage.speed == "fast"
  2  no model switch mid-session   measured   the main chain changed model: that request's cache
                                              write would have been a read
  3  cache TTL per session         measured   5m vs 1h simulated against the session's real gaps
  4  drop unused tools at launch   priced     tool definitions offered (api-request-shape) but never
                                              called; chars/4 tokens; only sessions with a shape
  5  output-filter hook            guess      Bash results over 8,000 chars cut to 2,000 (failures
                                              only); chars/4 tokens; re-read until compaction or end
  6  effort down one level         guess      thinking >= 50% of output tokens (tools/tune.py rule);
                                              assumes 50% fewer thinking tokens
  7  subagents on Haiku            priced     subagent spend re-priced at Haiku 4.5 list rates
  8  Opus 5 / 4.8 -> Opus 5.5      priced     same tokens at Opus 5.5 list rates

  Standalone ceilings, NOT stacked:
  X1 new session per task (/clear) priced ceiling: input re-sent above 150k context. A user
                                              action, not configuration.
  X2 main loop on Sonnet / Haiku   priced ceiling (tools/tune.py model rule). Re-runs measured it
                                              2.4-3.9x MORE expensive per task (n=2): do not ship.
"""
import argparse, collections, csv, datetime as dt, glob, json, os, statistics, sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
PRICE = {k: tuple(v) for k, v in json.load(open(os.path.join(REPO, "app", "config", "ult.default.json")))["prices"].items()}
# Not in the price table: Haiku 5.5 is priced at Haiku 4.5 list rates (conservative: the levers doc
# cites a lower published price), the 1M-context Opus 5 id at Opus 5 rates.
ALIAS = {"claude-haiku-5-5": "claude-haiku-4-5", "claude-haiku-4-5-20251001": "claude-haiku-4-5",
         "claude-opus-5[1m]": "claude-opus-5"}
HAIKU, OPUS55, SONNET = "claude-haiku-4-5", "claude-opus-5-5", "claude-sonnet-5"
OLD_OPUS = {"claude-opus-5", "claude-opus-4-8"}
W5, W1H, READ = 1.25, 2.0, 0.1
LONG_CTX, SMALL_FILES, SMALL_REQS, THINK_HEAVY = 150_000, 2, 12, 0.5     # tools/tune.py
HOOK_OVER, HOOK_KEEP, CHARS_PER_TOKEN, EFFORT_CUT = 8_000, 2_000, 4, 0.5
EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
LEVERS = ["fast", "switch", "ttl", "tools", "hook", "effort", "subagent", "opus55"]
LABEL = {"fast": "fast mode off", "switch": "no model switch mid-session", "ttl": "cache TTL per session",
         "tools": "drop unused tools at launch", "hook": "output-filter hook", "effort": "effort down one level",
         "subagent": "subagents on Haiku", "opus55": "Opus 5 / 4.8 -> Opus 5.5"}
EVIDENCE = {"fast": "measured", "switch": "measured", "ttl": "measured", "tools": "priced", "hook": "guess",
            "effort": "guess", "subagent": "priced", "opus55": "priced"}


def price(model):
    return PRICE.get(ALIAS.get(model, model))


def text_len(c):
    if isinstance(c, str):
        return len(c)
    if isinstance(c, list):
        return sum(len(b.get("text", "")) if isinstance(b, dict) else len(str(b)) for b in c)
    return 0


def load(root, cutoff):
    """{sid: session} with one entry per API request, main chain and subagents apart."""
    S = {}
    files = [(f, False) for f in glob.glob(os.path.join(root, "*", "*.jsonl"))]
    files += [(f, True) for f in glob.glob(os.path.join(root, "*", "*", "subagents", "*.jsonl"))]
    for f, is_sub_file in files:
        sid = os.path.basename(os.path.dirname(os.path.dirname(f))) if is_sub_file else os.path.basename(f)[:-6]
        s = S.setdefault(sid, dict(sid=sid, project=os.path.basename(os.path.dirname(f)) if not is_sub_file
                                   else os.path.basename(os.path.dirname(os.path.dirname(os.path.dirname(f)))),
                                   entry="", start=None, main=[], sub=[], seen=set(), tools_used=collections.Counter(),
                                   tool_names={}, results=[], compactions=[], shapes={}, edited=set(),
                                   effort=collections.Counter(), cc_cost=None))
        for line in open(f, errors="replace"):
            if not line.startswith("{"):
                continue
            try:
                r = json.loads(line)
            except ValueError:
                continue
            ts = r.get("timestamp")
            t = dt.datetime.fromisoformat(ts.replace("Z", "+00:00")) if ts else None
            typ = r.get("type")
            if typ == "cost-state" and not is_sub_file:
                s["cc_cost"] = r.get("totalCostUSD")          # Claude Code's own running total
                continue
            if typ == "api-request-shape" and not is_sub_file:
                s["shapes"][r.get("shapeHash")] = (r.get("shape") or {}).get("tools") or []
                continue
            if t is None or t < cutoff:
                continue
            if r.get("entrypoint") and not s["entry"]:
                s["entry"] = r["entrypoint"]
            s["start"] = t if s["start"] is None else min(s["start"], t)
            side = is_sub_file or bool(r.get("isSidechain"))
            if typ == "system" and r.get("subtype") == "compact_boundary" and not side:
                s["compactions"].append(t)
            msg = r.get("message") if isinstance(r.get("message"), dict) else {}
            if typ == "user" and not side and isinstance(msg.get("content"), list):
                for b in msg["content"]:
                    if isinstance(b, dict) and b.get("type") == "tool_result":
                        s["results"].append((t, b.get("tool_use_id"), text_len(b.get("content"))))
            if typ != "assistant":
                continue
            for b in msg.get("content") or []:
                if isinstance(b, dict) and b.get("type") == "tool_use":
                    s["tool_names"][b.get("id")] = b.get("name")
                    if not side:
                        s["tools_used"][b.get("name")] += 1
                    if b.get("name") in EDIT_TOOLS:
                        s["edited"].add((b.get("input") or {}).get("file_path"))
            u = msg.get("usage")
            model = msg.get("model")
            if not u or not price(model):
                continue
            key = (f, msg.get("id") or r.get("requestId") or r.get("uuid"))
            if key in s["seen"]:
                continue
            s["seen"].add(key)
            if isinstance(r.get("effort"), str) and not side:
                s["effort"][r["effort"]] += 1
            cc = u.get("cache_creation") or {}
            w5, w1 = cc.get("ephemeral_5m_input_tokens", 0), cc.get("ephemeral_1h_input_tokens", 0)
            if w5 + w1 == 0:
                w5 = u.get("cache_creation_input_tokens", 0)
            req = dict(t=t, model=model, raw=u.get("input_tokens", 0), cr=u.get("cache_read_input_tokens", 0),
                       w5=w5, w1=w1, out=u.get("output_tokens", 0),
                       think=(u.get("output_tokens_details") or {}).get("thinking_tokens", 0),
                       fast=u.get("speed") == "fast")
            (s["sub"] if side else s["main"]).append(req)
    for s in S.values():
        s["main"].sort(key=lambda q: q["t"])
        s["sub"].sort(key=lambda q: q["t"])
    return {k: v for k, v in S.items() if v["main"] or v["sub"]}


def cost(q, model=None):
    pi, po = price(model or q["model"])
    return dict(inp=((q["raw"] + q["cr"] * READ) + q["w5"] * W5 + q["w1"] * W1H) * pi / 1e6,
                out=q["out"] * po / 1e6, think=q["think"] * po / 1e6)


def ttl_sim(reqs, ttl, wm):
    """Input cost of the cached prefix under one TTL, against the requests' real gaps."""
    total, prev = 0.0, None
    for q in reqs:
        pi = price(q["model"])[0]
        w = q["w5"] + q["w1"]
        gap = (q["t"] - prev).total_seconds() if prev else 0
        total += ((q["cr"] + w) * wm if prev and gap > ttl and q["cr"] > 0 else q["cr"] * READ + w * wm) * pi / 1e6
        prev = q["t"]
    return total


def analyse(s):
    main, sub = s["main"], s["sub"]
    # buckets the levers act on, keyed (side, model): dollars of input, output (incl. thinking), thinking
    B = collections.defaultdict(lambda: dict(inp=0.0, out=0.0, think=0.0))
    for side, reqs in (("main", main), ("sub", sub)):
        for q in reqs:
            c = cost(q)
            for k in c:
                B[(side, q["model"])][k] += c[k]
    measured = sum(b["inp"] + b["out"] for b in B.values())
    total = lambda: sum(b["inp"] + b["out"] for b in B.values())
    mm = collections.Counter(q["model"] for q in main).most_common(1)
    model = mm[0][0] if mm else (sub[0]["model"] if sub else None)
    pin = price(model)[0] if model else 0
    S, fired = {}, []

    def take(lever, side, mdl, k, dollars):
        b = B[(side, mdl)]
        d = max(0.0, min(dollars, b[k]))
        b[k] -= d
        if k == "think":
            b["out"] -= d
        return d

    # 1 fast mode off: fast requests bill 2x standard
    d = 0.0
    for side, reqs in (("main", main), ("sub", sub)):
        for q in reqs:
            if q["fast"]:
                c = cost(q)
                d += take("fast", side, q["model"], "inp", c["inp"] / 2) + take("fast", side, q["model"], "out", c["out"] / 2)
    S["fast"] = d

    # 2 no model switch mid-session: a switch's cache write would have been a read
    d, prev = 0.0, None
    for q in main:
        if prev and q["model"] != prev:
            extra = (q["w5"] * (W5 - READ) + q["w1"] * (W1H - READ)) * price(q["model"])[0] / 1e6
            d += take("switch", "main", q["model"], "inp", extra)
        prev = q["model"]
    S["switch"] = d

    # 3 cache TTL: simulate the TTL the session used and the other one; keep the cheaper
    if main:
        used_1h = sum(q["w1"] for q in main) > sum(q["w5"] for q in main)
        cur = ttl_sim(main, 3600, W1H) if used_1h else ttl_sim(main, 300, W5)
        alt = ttl_sim(main, 300, W5) if used_1h else ttl_sim(main, 3600, W1H)
        S["ttl"] = take("ttl", "main", model, "inp", max(0.0, cur - alt))
        S["ttl_choice"] = ("5m" if used_1h else "1h") if alt < cur else ("1h" if used_1h else "5m")
    else:
        S["ttl"], S["ttl_choice"] = 0.0, ""

    # 4 drop tools offered but never called (only where Claude Code recorded the request shape)
    if s["shapes"] and main:
        unused = []
        for tools in s["shapes"].values():
            unused.append(sum(len(json.dumps(x)) for x in tools
                              if isinstance(x, dict) and x.get("name") not in s["tools_used"]))
        tok = statistics.mean(unused) / CHARS_PER_TOKEN
        S["tools"] = take("tools", "main", model, "inp", tok * pin * (W5 + READ * (len(main) - 1)) / 1e6)
        S["tools_unused_tok"] = round(tok)
    else:
        S["tools"], S["tools_unused_tok"] = 0.0, None

    # 5 output-filter hook on Bash: big results cut to failures only, re-read until compaction or end
    d = 0.0
    times = [q["t"] for q in main]
    for t, tid, n in s["results"]:
        if s["tool_names"].get(tid) != "Bash" or n <= HOOK_OVER or t is None:
            continue
        stop = min([c for c in s["compactions"] if c > t], default=None)
        later = sum(1 for x in times if x > t and (stop is None or x < stop))
        if later:
            tok = (n - HOOK_KEEP) / CHARS_PER_TOKEN
            d += tok * pin * (W5 + READ * (later - 1)) / 1e6
    S["hook"] = take("hook", "main", model, "inp", d)

    # 6 effort down one level where thinking dominates output (tools/tune.py rule)
    out_tok = sum(q["out"] for q in main)
    think_tok = sum(q["think"] for q in main)
    S["think_share"] = think_tok / out_tok if out_tok else 0
    d = 0.0
    if out_tok and S["think_share"] >= THINK_HEAVY:
        for (side, mdl), b in list(B.items()):
            if side == "main":
                d += take("effort", side, mdl, "think", b["think"] * EFFORT_CUT)
    S["effort"] = d

    # 7 subagents on Haiku: what is left of subagent spend, re-priced
    d = 0.0
    hi, ho = price(HAIKU)
    for (side, mdl), b in list(B.items()):
        if side != "sub" or ALIAS.get(mdl, mdl) == HAIKU:
            continue
        pi, po = price(mdl)
        new_in, new_out, new_think = b["inp"] * hi / pi, b["out"] * ho / po, b["think"] * ho / po
        d += (b["inp"] - new_in) + (b["out"] - new_out)
        h = B[("sub", HAIKU)]
        h["inp"] += new_in; h["out"] += new_out; h["think"] += new_think
        b["inp"] = b["out"] = b["think"] = 0.0
    S["subagent"] = d

    # 8 Opus 5 / 4.8 -> Opus 5.5: whatever is left on the old ids, re-priced
    d = 0.0
    oi, oo = price(OPUS55)
    for (side, mdl), b in list(B.items()):
        if ALIAS.get(mdl, mdl) in OLD_OPUS:
            pi, po = price(mdl)
            d += b["inp"] * (1 - oi / pi) + b["out"] * (1 - oo / po)
            b["inp"] *= oi / pi; b["out"] *= oo / po; b["think"] *= oo / po
    S["opus55"] = d

    # X1 ceiling: input re-sent above LONG_CTX (standalone, original prices)
    x1 = 0.0
    for q in main:
        ctx = q["raw"] + q["cr"] + q["w5"] + q["w1"]
        if ctx > LONG_CTX:
            x1 += cost(q)["inp"] * (ctx - LONG_CTX) / ctx
    # X2 ceiling: tools/tune.py model rule on the main loop (standalone, original prices)
    ctxs = sorted(q["raw"] + q["cr"] + q["w5"] + q["w1"] for q in main)
    p50 = ctxs[len(ctxs) // 2] if ctxs else 0
    target = None
    if main and model and not model.startswith("claude-haiku") and p50 < LONG_CTX:
        target = HAIKU if len(s["edited"]) <= SMALL_FILES and len(main) <= SMALL_REQS else (
            SONNET if model.startswith(("claude-opus", "claude-fable")) else None)
    x2 = sum(sum(cost(q).values()) - cost(q)["think"] - (sum(cost(q, target).values()) - cost(q, target)["think"])
             for q in main) if target else 0.0

    after = total()
    return dict(sid=s["sid"], project=s["project"], entry=s["entry"] or "?", start=s["start"], model=model,
                reqs=len(main), sub_reqs=len(sub), ctx_p50=p50, edited=len(s["edited"]),
                cost=measured, after=after, cc_cost=s["cc_cost"], x1=x1, x2=x2, x2_target=target or "",
                effort_seen=",".join(f"{k}:{v}" for k, v in s["effort"].most_common()), **S)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=os.environ.get("OPTHUB_PROJECTS") or os.path.expanduser("~/.claude/projects"))
    ap.add_argument("--since", help="only requests on or after YYYY-MM-DD (default: everything on disk)")
    ap.add_argument("--top", type=int, default=15)
    ap.add_argument("--out", default=os.path.join(REPO, "data", "private", "dynconfig"))
    a = ap.parse_args()
    cutoff = (dt.datetime.fromisoformat(a.since).replace(tzinfo=dt.timezone.utc) if a.since
              else dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc))
    rows = sorted((analyse(s) for s in load(a.root, cutoff).values()), key=lambda r: -r["cost"])
    rows = [r for r in rows if r["cost"] > 0]
    if not rows:
        sys.exit("no priced requests found")
    tot = sum(r["cost"] for r in rows)
    saved = tot - sum(r["after"] for r in rows)
    days = sorted(r["start"] for r in rows)
    print(f"{len(rows)} sessions, {sum(r['reqs'] + r['sub_reqs'] for r in rows)} requests (deduplicated), "
          f"{days[0]:%Y-%m-%d} .. {days[-1]:%Y-%m-%d}, list-price cost ${tot:,.2f}\n")

    print("stacked, marginal in applied order (SPEC R1):")
    print(f"  {'#':>2} {'lever':32} {'evidence':9} {'saved':>10} {'% of all':>8} {'sessions':>8}")
    for i, k in enumerate(LEVERS, 1):
        v = sum(r[k] for r in rows)
        n = sum(1 for r in rows if r[k] > 0.005)
        print(f"  {i:>2} {LABEL[k]:32} {EVIDENCE[k]:9} ${v:>9,.2f} {100 * v / tot:7.1f}% {n:>8}")
    print(f"     {'dynamic configuration, total':32} {'':9} ${saved:>9,.2f} {100 * saved / tot:7.1f}%")
    x1, x2 = sum(r["x1"] for r in rows), sum(r["x2"] for r in rows)
    print("\nstandalone ceilings, not stacked:")
    print(f"  X1 new session per task (/clear)  priced    ${x1:>9,.2f} {100 * x1 / tot:7.1f}%  user action, not config")
    print(f"  X2 main loop on Sonnet / Haiku    priced    ${x2:>9,.2f} {100 * x2 / tot:7.1f}%  measured 2.4-3.9x MORE in re-runs (n=2)")

    print("\nby entrypoint:")
    for e in sorted({r["entry"] for r in rows}):
        g = [r for r in rows if r["entry"] == e]
        c = sum(r["cost"] for r in g); s_ = c - sum(r["after"] for r in g)
        print(f"  {e:15} {len(g):4d} sessions  ${c:>9,.2f}  saved ${s_:>8,.2f} ({100 * s_ / c if c else 0:.1f}%)")

    pct = sorted(100 * (r["cost"] - r["after"]) / r["cost"] for r in rows)
    q = lambda p: pct[min(len(pct) - 1, int(p * len(pct)))]
    print(f"\nper-session saving, % of that session: p25 {q(.25):.1f}%  median {q(.5):.1f}%  "
          f"p75 {q(.75):.1f}%  p90 {q(.9):.1f}%  max {pct[-1]:.1f}%")

    chk = [r for r in rows if r["cc_cost"]]
    if chk:
        mine, theirs = sum(r["cost"] for r in chk), sum(r["cc_cost"] for r in chk)
        print(f"cross-check on {len(chk)} sessions with Claude Code's own cost-state: "
              f"this tool ${mine:,.2f} vs Claude Code ${theirs:,.2f} ({100 * mine / theirs:.0f}%)")

    print(f"\ntop {a.top} sessions by cost:")
    print(f"  {'session':8} {'entry':8} {'cost$':>8} {'after$':>8} {'saved':>6}  levers that fired")
    for r in rows[:a.top]:
        f_ = [k for k in LEVERS if r[k] > 0.005]
        print(f"  {r['sid'][:8]} {r['entry'][:8]:8} {r['cost']:8.2f} {r['after']:8.2f} "
              f"{100 * (r['cost'] - r['after']) / r['cost']:5.1f}%  {', '.join(f_)}")

    os.makedirs(a.out, exist_ok=True)
    path = os.path.join(a.out, "sessions.csv")
    cols = ["sid", "project", "entry", "start", "model", "reqs", "sub_reqs", "ctx_p50", "edited", "effort_seen",
            "think_share", "cost", "cc_cost", *LEVERS, "after", "ttl_choice", "tools_unused_tok", "x1", "x2", "x2_target"]
    with open(path, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(cols)
        for r in rows:
            w.writerow([r["start"].isoformat() if k == "start" else
                        (f"{r[k]:.4f}" if isinstance(r[k], float) else r[k]) for k in cols])
    print(f"\nwrote {os.path.relpath(path, REPO)} ({len(rows)} sessions; session ids and project names: private)")


if __name__ == "__main__":
    main()
