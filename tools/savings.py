#!/usr/bin/env python3
"""savings — per-session cost decomposition and per-lever headroom.

Companion to tools/loopscan.py. Answers: for every session in the window, what
did it cost, where did the money go, and how much could each candidate lever
have taken off *that specific session*.

    python3 tools/savings.py --days 32 [--top 15] [--csv out.csv]

READ THE LEVER TABLE BEFORE QUOTING A NUMBER. Exactly one lever (C) is measured.
The others are headroom ceilings computed from measured tokens under a stated
assumption, and the assumption is the part that needs an experiment.

  A  prefix-trim      scenario  25% less re-sent prefix -> 25% of read$+write$   [needs E2]
  B  effort-tune      scenario  50% fewer thinking tokens                        [needs E3]
  C  ttl-5m           MEASURED  simulate 5m TTL against real inter-arrival gaps
  D  model-downgrade  CEILING   Opus 5 -> Sonnet 5 list rates on the same tokens [G2 will fight]

A and B are multiplicative-ish and roughly independent (input side vs output
side). C is measured and usually negative. D is a ceiling nobody should ship
without an eval; it is here to size the prize, not to propose the change.
"""
import argparse, collections, csv, datetime as dt, glob, json, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ratecard import W1H, W5, parts, rates, req_cost, request_key, split_write  # noqa: E402

SONNET = "claude-sonnet-5"
TRIM, EFFORT = 0.25, 0.50          # lever A and B assumptions


def walk(root, cutoff):
    S, seen = {}, set()
    for f in sorted(glob.glob(os.path.join(root, "*", "*.jsonl"))):
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
            s = S.setdefault(sid, dict(
                cwd=r.get("cwd", ""), entry=r.get("entrypoint", ""), start=t, reqs=0,
                read=0.0, write=0.0, out=0.0, think=0.0, cost=0.0, sonnet=0.0,
                ttl_act=0.0, ttl_cf=0.0, forced=0, cr=0, w=0, otok=0, ttok=0,
                models=collections.Counter(), ctx=[], prompt="", prev=None))
            if r.get("cwd"):
                s["cwd"] = r["cwd"]
            if r.get("entrypoint"):
                s["entry"] = r["entrypoint"]
            s["start"] = min(s["start"], t)

            if r.get("type") == "user" and not r.get("isSidechain") and not s["prompt"]:
                c = (r.get("message") or {}).get("content")
                txt = c if isinstance(c, str) else "".join(
                    b.get("text", "") for b in c
                    if isinstance(b, dict) and b.get("type") == "text") if isinstance(c, list) else ""
                txt = re.sub(r"<[^>]+>", " ", txt)
                txt = re.sub(r"\s+", " ", txt).strip()
                if txt and not txt.startswith("Write the title"):
                    s["prompt"] = txt[:90]

            if r.get("type") != "assistant":
                continue
            msg = r.get("message") or {}
            u = msg.get("usage") or {}
            if not u or request_key(r) in seen:
                continue
            seen.add(request_key(r))
            m = msg.get("model", "")
            p = rates(m)
            if not p:
                continue
            inp, outp, rd = p
            w5, w1 = split_write(u)
            cr = u.get("cache_read_input_tokens", 0)
            raw = u.get("input_tokens", 0)
            ot = u.get("output_tokens", 0)
            th = (u.get("output_tokens_details") or {}).get("thinking_tokens", 0)

            pt = parts(m, u)
            read_c = pt["read"] + pt["input"]
            write_c = pt["write"]
            out_c = pt["output"]
            s["reqs"] += 1
            s["models"][m] += 1
            s["read"] += read_c
            s["write"] += write_c
            s["out"] += out_c
            s["think"] += th * outp / 1e6
            s["cost"] += read_c + write_c + out_c
            s["cr"] += cr; s["w"] += w5 + w1; s["otok"] += ot; s["ttok"] += th
            s["ctx"].append(raw + cr + w5 + w1)
            # lever D: same tokens, Sonnet 5 list rates
            s["sonnet"] += req_cost(SONNET, u)
            # lever C: 5m TTL simulated against the real gap to the previous request
            gap = (t - s["prev"]).total_seconds() if s["prev"] else 1e9
            s["ttl_act"] += ((w5 * W5 + w1 * W1H) + cr * rd) * inp / 1e6
            if gap > 300 and cr > 0:
                s["ttl_cf"] += (w5 + w1 + cr) * W5 * inp / 1e6
                s["forced"] += 1
            else:
                s["ttl_cf"] += ((w5 + w1) * W5 + cr * rd) * inp / 1e6
            s["prev"] = t
    return {k: v for k, v in S.items() if v["reqs"]}


def levers(s):
    a = TRIM * (s["read"] + s["write"])
    b = EFFORT * s["think"]
    c = s["ttl_act"] - s["ttl_cf"]        # positive = 5m is cheaper
    d = s["cost"] - s["sonnet"]
    return a, b, c, d


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=32)
    ap.add_argument("--since", help="pin the window start, YYYY-MM-DD (overrides --days)")
    ap.add_argument("--top", type=int, default=15)
    ap.add_argument("--root", default=os.path.expanduser("~/.claude/projects"))
    ap.add_argument("--csv")
    a = ap.parse_args()
    cutoff = (dt.datetime.fromisoformat(a.since).replace(tzinfo=dt.timezone.utc) if a.since
              else dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=a.days))
    S = walk(a.root, cutoff)
    for sid, s in S.items():
        s["sid"] = sid
    rows = sorted(S.values(), key=lambda x: -x["cost"])
    tot = sum(s["cost"] for s in rows)

    hdr = (f"{'#':>3} {'cost$':>7} {'req':>4} {'ctx-p50':>8} {'read$':>7} {'write$':>7} "
           f"{'out$':>6} {'think$':>7} | {'A trim':>7} {'B eff':>6} {'C ttl':>7} {'D sonnet':>8}  where")
    print(hdr); print("-" * len(hdr))
    for i, s in enumerate(rows[:a.top], 1):
        ctx = sorted(s["ctx"])
        A, B, C, D = levers(s)
        print(f"{i:>3} {s['cost']:7.2f} {s['reqs']:4d} {ctx[len(ctx)//2]:8d} {s['read']:7.2f} "
              f"{s['write']:7.2f} {s['out']:6.2f} {s['think']:7.2f} | {A:7.2f} {B:6.2f} "
              f"{C:+7.2f} {D:8.2f}  {os.path.basename(s['cwd'])}: {s['prompt'][:34]}")
    rest = rows[a.top:]
    if rest:
        A = sum(levers(s)[0] for s in rest); B = sum(levers(s)[1] for s in rest)
        C = sum(levers(s)[2] for s in rest); D = sum(levers(s)[3] for s in rest)
        print(f"{'...':>3} {sum(s['cost'] for s in rest):7.2f} "
              f"{sum(s['reqs'] for s in rest):4d} {'-':>8} {sum(s['read'] for s in rest):7.2f} "
              f"{sum(s['write'] for s in rest):7.2f} {sum(s['out'] for s in rest):6.2f} "
              f"{sum(s['think'] for s in rest):7.2f} | {A:7.2f} {B:6.2f} {C:+7.2f} {D:8.2f}  "
              f"remaining {len(rest)} sessions")
    A = sum(levers(s)[0] for s in rows); B = sum(levers(s)[1] for s in rows)
    C = sum(levers(s)[2] for s in rows); D = sum(levers(s)[3] for s in rows)
    print("-" * len(hdr))
    print(f"{'ALL':>3} {tot:7.2f} {sum(s['reqs'] for s in rows):4d} {'-':>8} "
          f"{sum(s['read'] for s in rows):7.2f} {sum(s['write'] for s in rows):7.2f} "
          f"{sum(s['out'] for s in rows):6.2f} {sum(s['think'] for s in rows):7.2f} | "
          f"{A:7.2f} {B:6.2f} {C:+7.2f} {D:8.2f}")
    print(f"\nas % of ${tot:.2f}:  A trim {100*A/tot:.1f}%   B effort {100*B/tot:.1f}%   "
          f"C ttl-5m {100*C/tot:+.1f}%   D sonnet-ceiling {100*D/tot:.1f}%")
    print(f"A+B stacked (independent sides of the request): ${A+B:.2f}  ({100*(A+B)/tot:.1f}%)")
    print(f"forced re-writes under 5m TTL: {sum(s['forced'] for s in rows)} requests")

    if a.csv:
        with open(a.csv, "w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["start", "cwd", "entry", "reqs", "models", "ctx_p50", "ctx_max",
                        "cost", "read$", "write$", "out$", "think$",
                        "A_trim25", "B_effort50", "C_ttl5m", "D_sonnet_ceiling", "first_prompt", "session"])
            for s in rows:
                ctx = sorted(s["ctx"])
                A, B, C, D = levers(s)
                w.writerow([s["start"].isoformat(), s["cwd"], s["entry"], s["reqs"],
                            "|".join(f"{k}:{v}" for k, v in s["models"].items()),
                            ctx[len(ctx)//2], ctx[-1],
                            f"{s['cost']:.4f}", f"{s['read']:.4f}", f"{s['write']:.4f}",
                            f"{s['out']:.4f}", f"{s['think']:.4f}",
                            f"{A:.4f}", f"{B:.4f}", f"{C:.4f}", f"{D:.4f}", s["prompt"], s["sid"]])
        print(f"\nwrote {a.csv} ({len(rows)} sessions)")


if __name__ == "__main__":
    main()
