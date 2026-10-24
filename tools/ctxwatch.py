#!/usr/bin/env python3
"""
ctxwatch — live context-window meter for a Claude Code session.

Tails a session transcript and prints one line per request as it lands:
context in, the delta since the previous request, where those tokens came
from, and the running API-list-equivalent cost.

Unlike /context this costs nothing and does not perturb what it measures —
it reads the transcript from disk instead of spending a turn to ask.

  python3 tools/ctxwatch.py                    # watch the newest session here
  python3 tools/ctxwatch.py --once             # print history and exit
  python3 tools/ctxwatch.py --session <uuid>   # a specific session
  python3 tools/ctxwatch.py --project ~/.claude/projects/-Users-<you>-foo
"""
import argparse, glob, json, os, sys, time, datetime as dt

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ratecard import req_cost  # noqa: E402

WINDOW = 1_000_000          # Opus 5 context window

C = {"dim":"\033[2m","red":"\033[31m","grn":"\033[32m","yel":"\033[33m",
     "cyn":"\033[36m","bold":"\033[1m","off":"\033[0m"}
def c(s, k): return f"{C[k]}{s}{C['off']}" if sys.stdout.isatty() else str(s)

def rows(path):
    out = []
    try: fh = open(path, encoding="utf-8", errors="replace")
    except OSError: return out
    with fh:
        for line in fh:
            try: r = json.loads(line)
            except Exception: continue
            u = (r.get("message") or {}).get("usage")
            if not u or not isinstance(u, dict): continue
            ctx = (u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0)
                   + u.get("cache_creation_input_tokens", 0))
            if ctx: out.append((r.get("timestamp", ""), ctx, u, (r.get("message") or {}).get("model")))
    return out

def bar(ctx, w=22):
    n = min(w, int(round(ctx / WINDOW * w)))
    return c("█" * n, "cyn") + c("░" * (w - n), "dim")

def emit(i, ts, ctx, u, prev, total):
    t = ts[11:19] if len(ts) > 19 else "--:--:--"
    d = ctx - prev if prev is not None else 0
    ds = "  first" if prev is None else (c(f"{d:+7,}", "yel" if abs(d) > 20000 else "dim"))
    pct = ctx / WINDOW * 100
    pc = "red" if pct > 80 else "yel" if pct > 50 else "grn"
    print(f"{c(t,'dim')} {i:>4} {bar(ctx)} {c(f'{ctx:>9,}','bold')} "
          f"{c(f'{pct:>5.1f}%',pc)} {ds}  "
          f"{c('r','dim')}{u.get('cache_read_input_tokens',0):>8,} "
          f"{c('w','dim')}{u.get('cache_creation_input_tokens',0):>7,} "
          f"{c('+','dim')}{u.get('input_tokens',0):>6,} "
          f"{c('out','dim')}{u.get('output_tokens',0):>6,}  "
          f"{c(f'${total:>7.2f}','dim')}", flush=True)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--session", help="session UUID (default: newest in --project)")
    ap.add_argument("--project", default=None, help="project dir under ~/.claude/projects")
    ap.add_argument("--once", action="store_true", help="print and exit, don't follow")
    ap.add_argument("--interval", type=float, default=2.0)
    a = ap.parse_args()

    proj = a.project or os.path.expanduser(
        "~/.claude/projects/" + os.getcwd().replace("/", "-"))
    if a.session:
        path = os.path.join(proj, a.session + ".jsonl")
    else:
        f = sorted(glob.glob(os.path.join(proj, "*.jsonl")), key=os.path.getmtime)
        if not f: sys.exit(f"no transcripts in {proj}")
        path = f[-1]

    print(c(f"ctxwatch · {os.path.basename(path)[:8]} · window {WINDOW:,}", "bold"))
    print(c(f"{'time':<8} {'#':>4} {'':<22} {'context':>9} {'used':>6} {'delta':>7}  "
            f"{'read':>9}{'write':>8}{'fresh':>7}{'out':>9}  {'cum $':>8}", "dim"))

    seen, prev, total = 0, None, 0.0
    while True:
        rs = rows(path)
        for i in range(seen, len(rs)):
            ts, ctx, u, model = rs[i]
            total += req_cost(model, u)
            emit(i + 1, ts, ctx, u, prev, total)
            prev = ctx
        seen = len(rs)
        if a.once: break
        try: time.sleep(a.interval)
        except KeyboardInterrupt:
            print(c(f"\n{seen} requests · peak "
                    f"{max((r[1] for r in rs), default=0):,} · ${total:.2f}", "bold")); break

if __name__ == "__main__":
    main()
