#!/usr/bin/env python3
"""loopscan — mine local Claude Code history for recurrent / event-based loops.

Source of every number in docs/experiments.md § E1.

    python3 tools/loopscan.py [--days 31] [--json out.json]

Reads ~/.claude/projects/*/*.jsonl (the Claude Code transcript store). Every
assistant record carries message.usage, so cost is computed from billed tokens,
not estimated. Cost is *API list-price equivalent* — this traffic ran on a
Claude Code subscription and was not billed per token.

Prices come from tools/ratecard.py.
"""
import argparse, collections, datetime as dt, glob, json, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ratecard import W1H, W5, rates, request_key, split_write  # noqa: E402
import ratecard  # noqa: E402

# Prompt signatures that identify a loop rather than a human turn.
LOOP_SIGS = [
    ("cc-title-gen",      "Write the title in the predominant language"),
    ("lightllm-intent",   "Classify the request below into exactly ONE of these intents"),
]


def scan(root, cutoff):
    sessions, loops, timeline = {}, collections.Counter(), collections.defaultdict(list)
    seen = set()
    for f in sorted(glob.glob(os.path.join(root, "*", "*.jsonl"))):
        proj = os.path.basename(os.path.dirname(f))
        for line in open(f, errors="replace"):
            if not line.startswith("{"):
                continue
            try:
                r = json.loads(line)
            except ValueError:
                continue
            ts = r.get("timestamp")
            if not ts:
                continue
            t = dt.datetime.fromisoformat(ts.replace("Z", "+00:00"))
            if t < cutoff:
                continue
            sid = r.get("sessionId") or r.get("session_id") or os.path.basename(f)[:-6]
            s = sessions.setdefault(sid, dict(
                proj=proj, cwd=r.get("cwd", ""), entry=r.get("entrypoint", ""),
                start=t, end=t, reqs=0, models=collections.Counter(),
                inp=0, w5=0, w1=0, cr=0, out=0, think=0, cost=0.0, mix=collections.Counter(), ctx=[],
                tools=collections.Counter(), prompts=[]))
            s["start"], s["end"] = min(s["start"], t), max(s["end"], t)
            if r.get("cwd"):
                s["cwd"] = r["cwd"]
            if r.get("entrypoint"):
                s["entry"] = r["entrypoint"]

            if r.get("type") == "assistant":
                msg = r.get("message") or {}
                u = msg.get("usage") or {}
                if u and request_key(r) not in seen:
                    seen.add(request_key(r))
                    m = msg.get("model", "")
                    w5, w1 = split_write(u)
                    s["reqs"] += 1
                    s["models"][m] += 1
                    s["inp"] += u.get("input_tokens", 0)
                    s["w5"] += w5
                    s["w1"] += w1
                    s["cr"] += u.get("cache_read_input_tokens", 0)
                    s["out"] += u.get("output_tokens", 0)
                    s["think"] += (u.get("output_tokens_details") or {}).get("thinking_tokens", 0)
                    pt = ratecard.parts(m, u, default=None) or {}
                    s["mix"].update(pt)
                    s["cost"] += sum(pt.values())
                    s["ctx"].append(u.get("input_tokens", 0)
                                    + u.get("cache_read_input_tokens", 0)
                                    + u.get("cache_creation_input_tokens", 0))
                    timeline[sid].append((t, u.get("cache_read_input_tokens", 0),
                                          u.get("cache_creation_input_tokens", 0), m))
                for b in (msg.get("content") or []):
                    if isinstance(b, dict) and b.get("type") == "tool_use":
                        s["tools"][b.get("name", "?")] += 1

            elif r.get("type") == "user" and not r.get("isSidechain"):
                c = (r.get("message") or {}).get("content")
                txt = c if isinstance(c, str) else "".join(
                    b.get("text", "") for b in c
                    if isinstance(b, dict) and b.get("type") == "text") if isinstance(c, list) else ""
                for name, sig in LOOP_SIGS:
                    if sig in txt:
                        loops[name] += 1
                        loops[name + ":chars"] += len(txt)
                        break
                else:
                    if txt.strip() and not txt.startswith("<local-command"):
                        s["prompts"].append((t.isoformat(), txt[:600]))
    return sessions, loops, timeline


def ttl_counterfactual(timeline):
    """What a 5-minute TTL would have cost instead of the 1-hour TTL actually used."""
    actual = counter = 0.0
    forced_reqs = forced_tok = 0
    for sid, v in timeline.items():
        v.sort()
        prev = None
        for t, cr, cw, model in v:
            p, _, rd = rates(model) or (0, 0, 0)
            actual += (cw * p * W1H + cr * p * rd) / 1e6
            gap = (t - prev).total_seconds() if prev else 1e9
            if gap > 300 and cr > 0:            # 5m entry would have expired: full re-write
                counter += (cw + cr) * p * W5 / 1e6
                forced_reqs += 1
                forced_tok += cr
            else:
                counter += (cw * p * W5 + cr * p * rd) / 1e6
            prev = t
    return actual, counter, forced_reqs, forced_tok


def gaps_of(timeline):
    g = []
    for v in timeline.values():
        v.sort()
        g += [(v[i][0] - v[i - 1][0]).total_seconds() for i in range(1, len(v))]
    return sorted(g)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=31)
    ap.add_argument("--since", help="pin the window start, YYYY-MM-DD (overrides --days)")
    ap.add_argument("--root", default=os.environ.get("OPTHUB_PROJECTS") or os.path.expanduser("~/.claude/projects"))
    ap.add_argument("--json")
    a = ap.parse_args()
    cutoff = (dt.datetime.fromisoformat(a.since).replace(tzinfo=dt.timezone.utc) if a.since
              else dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=a.days))
    S, loops, timeline = scan(a.root, cutoff)
    S = {k: v for k, v in S.items() if v["reqs"] or v["prompts"]}

    tot = sum(s["cost"] for s in S.values())
    agg = lambda k: sum(s[k] for s in S.values())
    cr, w1, w5, inp, out, th = agg("cr"), agg("w1"), agg("w5"), agg("inp"), agg("out"), agg("think")

    print(f"window   : {cutoff:%Y-%m-%d} -> now")
    print(f"sessions : {len(S)}   billable requests: {agg('reqs')}   "
          f"active days: {len({s['start'].date() for s in S.values()})}")
    print(f"cost     : ${tot:.2f}  (API list-price equivalent)")
    print(f"tokens   : cache-read {cr/1e6:.1f}M  1h-write {w1/1e6:.1f}M  5m-write {w5/1e6:.1f}M  "
          f"raw-in {inp/1e3:.1f}k  out {out/1e6:.2f}M (thinking {th/1e6:.2f}M)")
    if cr + w1 + w5 + inp:
        print(f"cache    : hit rate {100*cr/(cr+w1+w5+inp):.1f}%")
    mix = sum((s["mix"] for s in S.values()), collections.Counter())
    print(f"cost mix : cache-read ${mix['read']:.2f}  cache-write ${mix['write']:.2f}  "
          f"output ${mix['output']:.2f}   (at each request's model rates)")

    print("\nrequests by model:")
    mc = collections.Counter()
    for s in S.values():
        mc.update(s["models"])
    for m, n in mc.most_common():
        print(f"  {n:6d}  {m}")

    print("\nby entrypoint:")
    for e in sorted({s["entry"] for s in S.values()}):
        g = [s for s in S.values() if s["entry"] == e]
        print(f"  {e:8s} {len(g):4d} sessions  {sum(x['reqs'] for x in g):5d} req  "
              f"${sum(x['cost'] for x in g):8.2f}")

    print("\nloop signatures (fires):")
    for name, _ in LOOP_SIGS:
        n = loops.get(name, 0)
        if n:
            print(f"  {name:18s} {n:5d} fires   "
                  f"~{loops[name+':chars']/n/3.7:,.0f} prompt tokens/fire   "
                  f"~{loops[name+':chars']/3.7/1e3:,.0f}k tokens total")

    g = gaps_of(timeline)
    if g:
        pct = lambda p: g[int(len(g) * p)]
        print(f"\ninter-request gap (s): p50={pct(.5):.0f} p90={pct(.9):.0f} "
              f"p95={pct(.95):.0f} p99={pct(.99):.0f}   "
              f">5min: {100*sum(1 for x in g if x > 300)/len(g):.1f}%")
    act, cf, fr, ft = ttl_counterfactual(timeline)
    print(f"TTL check: actual 1h ${act:.2f}   counterfactual 5m ${cf:.2f}   "
          f"delta ${cf-act:+.2f}  ({fr} forced re-writes, {ft/1e6:.1f}M tokens)")

    print("\ntop sessions by cost:")
    for s in sorted(S.values(), key=lambda x: -x["cost"])[:10]:
        ctx = sorted(s["ctx"])
        p50 = ctx[len(ctx)//2] if ctx else 0
        first = next((p for _, p in s["prompts"]), "")
        print(f"  ${s['cost']:7.2f} {s['reqs']:4d}req ctx-p50={p50:7d} {s['entry']:8s} "
              f"{os.path.basename(s['cwd'])}: {re.sub(r'\\s+',' ',first)[:70]}")

    if a.json:
        out_rows = []
        for sid, s in S.items():
            ctx = sorted(s["ctx"])
            out_rows.append(dict(sid=sid, cwd=s["cwd"], entry=s["entry"],
                                 start=s["start"].isoformat(), end=s["end"].isoformat(),
                                 reqs=s["reqs"], models=dict(s["models"]), cost=s["cost"],
                                 cr=s["cr"], w1=s["w1"], w5=s["w5"], out=s["out"],
                                 ctx_p50=ctx[len(ctx)//2] if ctx else 0,
                                 ctx_max=max(ctx) if ctx else 0,
                                 tools=dict(s["tools"].most_common(12))))
        json.dump(out_rows, open(a.json, "w"), indent=1)
        print(f"\nwrote {a.json}")


if __name__ == "__main__":
    main()
