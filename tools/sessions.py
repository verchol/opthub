#!/usr/bin/env python3
"""sessions — list every Claude Code session on this machine in a time window.

Companion to tools/loopscan.py (month aggregate) and tools/savings.py (per-lever
ledger). This one answers the plainest question: what ran, when, where, and what
did it cost. Default window is the last 24 hours.

    python3 tools/sessions.py                      # last 24h
    python3 tools/sessions.py --hours 8
    python3 tools/sessions.py --days 7 --sort cost
    python3 tools/sessions.py --since 2026-07-30 --csv out.csv

`span` is first-to-last record inside the window, not time spent working: a
session resumed across days spans days. That is the point — see the resume
cost note in SPEC §2.3's neighbourhood (E1b: one resumed session tripled).

Two things this tool does that the others deliberately don't:

  * It lists sessions with **zero billable requests** — prompt-only shells and
    the session-title-generation fires that leave a `user` record and no
    assistant record. Those are invisible to a cost ledger by construction
    (E1-F3), so a tool that silently drops them under-reports what ran. They
    are marked `-` in the req column and counted separately.

  * It reports the retention boundary. `~/.claude/projects` is pruned on
    `cleanupPeriodDays` (default 30), so a window that reaches past the oldest
    surviving transcript is truncated by deletion, not by absence of traffic.
    E1b watched $46.25 of history vanish mid-analysis; the footer says whether
    the window you asked for is inside what still exists.
"""
import argparse, collections, csv, datetime as dt, glob, json, os, statistics, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ratecard import DEFAULT_MODEL, req_cost, request_key  # noqa: E402  (sessiongraph.py imports the first two from here)


def walk(root, cutoff):
    S, seen = {}, set()
    for f in sorted(glob.glob(os.path.join(root, "*", "*.jsonl"))):
        fallback_sid = os.path.basename(f)[:-6]
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
            sid = r.get("sessionId") or r.get("session_id") or fallback_sid
            s = S.setdefault(sid, dict(
                sid=sid, cwd=r.get("cwd", ""), entry=r.get("entrypoint", ""),
                start=t, end=t, reqs=0, cost=0.0, out_tok=0, think=0,
                models=collections.Counter(), ctx=[], prompt="", file=f,
                cwds=collections.Counter()))
            if r.get("cwd"):
                s["cwds"][r["cwd"]] += 1
            if r.get("entrypoint"):
                s["entry"] = r["entrypoint"]
            s["start"] = min(s["start"], t)
            s["end"] = max(s["end"], t)

            if r.get("type") == "user" and not r.get("isSidechain") and not s["prompt"]:
                c = r.get("message", {}).get("content")
                if isinstance(c, list):
                    c = " ".join(p.get("text", "") for p in c if isinstance(p, dict))
                if isinstance(c, str) and c.strip():
                    s["prompt"] = " ".join(c.split())[:400]

            u = (r.get("message") or {}).get("usage")
            if not u or request_key(r) in seen:
                continue
            seen.add(request_key(r))
            model = (r.get("message") or {}).get("model") or DEFAULT_MODEL
            s["reqs"] += 1
            s["models"][model] += 1
            s["cost"] += req_cost(model, u)
            s["out_tok"] += u.get("output_tokens", 0)
            s["think"] += (u.get("output_tokens_details") or {}).get("reasoning_tokens", 0)
            s["ctx"].append(u.get("input_tokens", 0)
                            + u.get("cache_read_input_tokens", 0)
                            + u.get("cache_creation_input_tokens", 0))
    return S


def oldest_on_disk(root):
    best = None
    for f in glob.glob(os.path.join(root, "*", "*.jsonl")):
        try:
            with open(f, errors="replace") as fh:
                for line in fh:
                    if not line.startswith("{"):
                        continue
                    try:
                        r = json.loads(line)
                    except ValueError:
                        continue
                    if r.get("timestamp"):
                        t = dt.datetime.fromisoformat(r["timestamp"].replace("Z", "+00:00"))
                        best = t if best is None else min(best, t)
                        break
        except OSError:
            pass
    return best


def fmt_dur(sec):
    if sec < 60:
        return f"{int(sec)}s"
    m, h = int(sec // 60) % 60, int(sec // 3600)
    return f"{h}h{m:02d}m" if h else f"{m}m"


def main():
    ap = argparse.ArgumentParser(
        description="List every Claude Code session in a window (default: last 24h).")
    ap.add_argument("--hours", type=float, default=24, help="window length in hours (default 24)")
    ap.add_argument("--days", type=float, help="window length in days (overrides --hours)")
    ap.add_argument("--since", help="pin the window start, YYYY-MM-DD (overrides --hours/--days)")
    ap.add_argument("--root", default=os.environ.get("OPTHUB_PROJECTS") or os.path.expanduser("~/.claude/projects"))
    ap.add_argument("--sort", choices=["start", "cost", "reqs", "ctx"], default="start")
    ap.add_argument("--project", help="substring filter on the session's cwd")
    ap.add_argument("--billable-only", action="store_true",
                    help="hide sessions with no billable requests")
    ap.add_argument("--full-id", action="store_true", help="print full session UUIDs")
    ap.add_argument("--csv", help="write all rows (always with full ids) to CSV")
    ap.add_argument("--json", help="write all rows to JSON")
    a = ap.parse_args()

    now = dt.datetime.now(dt.timezone.utc)
    if a.since:
        cutoff = dt.datetime.fromisoformat(a.since).replace(tzinfo=dt.timezone.utc)
        label = f"{a.since} -> now"
    else:
        span = dt.timedelta(days=a.days) if a.days else dt.timedelta(hours=a.hours)
        cutoff = now - span
        label = f"last {a.days:g}d" if a.days else f"last {a.hours:g}h"

    S = walk(a.root, cutoff)
    rows = list(S.values())
    if a.project:
        rows = [s for s in rows if a.project.lower() in s["cwd"].lower()]
    hidden = 0
    if a.billable_only:
        hidden = len([s for s in rows if not s["reqs"]])
        rows = [s for s in rows if s["reqs"]]

    for s in rows:
        s["ctx_p50"] = int(statistics.median(s["ctx"])) if s["ctx"] else 0
        s["ctx_max"] = max(s["ctx"]) if s["ctx"] else 0
        s["span"] = (s["end"] - s["start"]).total_seconds()
        if s["cwds"]:
            s["cwd"] = s["cwds"].most_common(1)[0][0]
        s["project"] = os.path.basename(s["cwd"].rstrip("/")) or "~"

    keys = {"start": lambda s: s["start"], "cost": lambda s: -s["cost"],
            "reqs": lambda s: -s["reqs"], "ctx": lambda s: -s["ctx_p50"]}
    rows.sort(key=keys[a.sort])

    billable = [s for s in rows if s["reqs"]]
    silent = [s for s in rows if not s["reqs"]]
    total = sum(s["cost"] for s in rows)

    print(f"window   : {label}   (from {cutoff.astimezone():%Y-%m-%d %H:%M})")
    shown = (f"sessions : {len(rows)}   ({len(billable)} with billable requests, "
             f"{len(silent)} with none)")
    if a.billable_only:
        shown = (f"sessions : {len(rows)} with billable requests"
                 + (f"   ({hidden} with no usage record hidden by --billable-only)"
                    if hidden else ""))
    print(shown)
    print(f"requests : {sum(s['reqs'] for s in rows)}")
    print(f"cost     : ${total:.2f}  (API-list equivalent)")
    if not rows:
        print("\nno sessions in this window.")
        return

    idw = 36 if a.full_id else 8
    print(f"\n{'start':<16} {'span':>7} {'project':<16} {'entry':<8} {'req':>4} "
          f"{'ctx p50':>9} {'cost$':>8}  {'id':<{idw}} prompt")
    print("-" * (79 + idw))
    for s in rows:
        sid = s["sid"] if a.full_id else s["sid"][:8]
        req = str(s["reqs"]) if s["reqs"] else "-"
        ctx = f"{s['ctx_p50']:,}" if s["ctx_p50"] else "-"
        cost = f"{s['cost']:.2f}" if s["reqs"] else "-"
        print(f"{s['start'].astimezone():%Y-%m-%d %H:%M} {fmt_dur(s['span']):>7} "
              f"{s['project'][:16]:<16} {(s['entry'] or '?')[:8]:<8} {req:>4} "
              f"{ctx:>9} {cost:>8}  {sid:<{idw}} {s['prompt'][:52]}")

    if silent:
        print(f"\n{len(silent)} session(s) left no usage record — prompt-only shells or "
              f"title-generation fires.\nThey ran, and they cannot be costed from "
              f"transcripts at all (E1-F3).")

    oldest = oldest_on_disk(a.root)
    if oldest:
        age = (now - oldest).days
        print(f"\nretention: oldest transcript on disk is {oldest.astimezone():%Y-%m-%d} "
              f"({age}d old); cleanupPeriodDays default is 30.")
        if cutoff < oldest:
            print("           ** your window starts BEFORE that — the earlier part was "
                  "deleted,\n              not idle. Totals above are a floor. (E1b-F1) **")

    fields = ["sid", "start", "end", "span", "cwd", "project", "entry", "reqs",
              "models", "ctx_p50", "ctx_max", "out_tok", "think", "cost", "prompt"]
    if a.csv:
        with open(a.csv, "w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=fields, extrasaction="ignore")
            w.writeheader()
            for s in rows:
                w.writerow({**s, "start": s["start"].isoformat(),
                            "end": s["end"].isoformat(),
                            "models": ";".join(f"{m}:{n}" for m, n in s["models"].items()),
                            "cost": round(s["cost"], 4)})
        print(f"\nwrote {a.csv} ({len(rows)} sessions)")
    if a.json:
        with open(a.json, "w") as fh:
            json.dump([{**{k: s[k] for k in fields if k not in ("start", "end", "models")},
                        "start": s["start"].isoformat(), "end": s["end"].isoformat(),
                        "models": dict(s["models"])} for s in rows], fh, indent=2)
        print(f"wrote {a.json} ({len(rows)} sessions)")


if __name__ == "__main__":
    main()
