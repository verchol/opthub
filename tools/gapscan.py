#!/usr/bin/env python3
"""gapscan — P3 gap-scan (docs/onboarding-spec.md): which cache TTL and keep-alive policy fits
each session population, priced against the sessions' real gaps. Free, read-only.

    python3 tools/gapscan.py                     # last 30 days
    python3 tools/gapscan.py --since 2026-10-01 [--json]

Built from tools/savings.py lever C. Its `5m` policy is lever C with two reads it no longer
re-prices: a session's first request (it reads Claude Code's shared prefix, cached by earlier
sessions) and a read after a gap longer than the session's own TTL (something kept it warm). With
those, a policy equal to the one a session ran prices it exactly as run. Five
policies, priced on the input side (reads and writes) of each session's main thread:

  current          as run
  5m / 1h          one TTL everywhere: a request after a gap longer than the TTL re-writes its prefix
  smart            5 minutes inside the agent loop, 1 hour across a turn end: a max_tokens 0 ping at
                   each turn end reads the prefix and writes the reply at 1 hour
  smart+keepalive  smart, plus a ping every 55 minutes of idle while it pays: while
                   P(resume before the entry would expire | idle so far) x re-write cost > ping cost,
                   from this window's own turn-end gaps

Populations are the SPEC §2.4 write:read buckets (§6.6: propose per population, never on the
aggregate). A policy is emitted only when it beats `current` by more than max(1% of window spend,
$1) and its sign holds on all k = 5 sub-windows (§6.5). Smart policies stay `unconfirmed`, out of
totals, until P2 (tools/probe_cache.py) has passed for the platform and model.
"""
import argparse, collections, datetime as dt, math, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import onboardlib as ob, probe_cache  # noqa: E402
from ratecard import DEFAULT_MODEL, W1H, W5, canonical, rates, split_write  # noqa: E402

POLICIES = ["5m", "1h", "smart", "smart+keepalive"]
SMART = {"smart", "smart+keepalive"}
PING_EVERY = 55 * 60
MAX_PINGS = 26                       # a day of keep-alive at most
BUCKETS = [("write:read > 2.0", 2.0, math.inf), ("write:read 1.0-2.0", 1.0, 2.0),
           ("write:read 0.5-1.0", 0.5, 1.0), ("write:read < 0.5", 0.0, 0.5)]


def write_read(s):
    w = sum(sum(split_write(q["u"])) for q in s["reqs"])
    r = sum(q["u"].get("cache_read_input_tokens", 0) for q in s["reqs"])
    return w / r if r else math.inf


def bucket(s):
    x = write_read(s)
    return next(name for name, lo, hi in BUCKETS if lo <= x < hi or (hi == math.inf and x >= lo))


def turn_end_gaps(sessions):
    """Seconds from each turn end to the next request; a session's last turn end never resumes (inf)."""
    g = []
    for s in sessions:
        m = s["reqs"]
        for i, q in enumerate(m):
            if q["stop"] == "end_turn":
                g.append((m[i + 1]["t"] - q["t"]).total_seconds() if i + 1 < len(m) else math.inf)
    return g


def keepalive_pings(gaps, rd):
    """How many 55-minute pings after a turn end pay for themselves on this window's gaps."""
    if not gaps:
        return 0
    edge = rd / (W5 - rd)            # ping cost / what a read saves over a re-write, per prefix token
    n = 0
    for j in range(1, MAX_PINGS + 1):
        sent_at, old, new = j * PING_EVERY, 3600 + (j - 1) * PING_EVERY, 3600 + j * PING_EVERY
        idle = [x for x in gaps if x > sent_at]
        if not idle or sum(1 for x in idle if old < x <= new) / len(idle) <= edge:
            break
        n = j
    return n


def cost(reqs, policy, pings=0):
    """Input-side dollars of one session's main thread under a policy. A read that no policy can
    take away is never re-priced as a write: the first request's (Claude Code's shared prefix, cached
    by earlier sessions) and one after a gap longer than the TTL the session ran with (something
    else kept that entry warm). So a policy equal to the one the session ran prices it as run."""
    ran = 3600 if sum(split_write(q["u"])[1] for q in reqs) >= sum(split_write(q["u"])[0] for q in reqs) else 300
    total, prev = 0.0, None
    for i, q in enumerate(reqs):
        p, _, rd = rates(q["model"]) or rates(DEFAULT_MODEL)
        w5, w1 = split_write(q["u"])
        cr, w = q["u"].get("cache_read_input_tokens", 0), w5 + w1
        if policy == "current":
            total += (cr * rd + w5 * W5 + w1 * W1H) * p / 1e6
            continue
        gap = (q["t"] - prev["t"]).total_seconds() if prev else 0.0
        warm = gap > ran                     # read survived a gap longer than its own TTL
        after_turn = prev is not None and prev["stop"] == "end_turn"
        if policy == "5m":
            ttl, wm = 300, W5
        elif policy == "1h":
            ttl, wm = 3600, W1H
        else:
            wm = W5
            ttl = 3600 if after_turn else 300
            if after_turn and policy == "smart+keepalive":
                sent = min(pings, int(gap // PING_EVERY))
                total += sent * ob.ctx(prev) * rd * p / 1e6
                ttl = 3600 + sent * PING_EVERY if sent == pings else math.inf
        total += ((cr + w) * wm if gap > ttl and cr > 0 and not warm else cr * rd + w * wm) * p / 1e6
        if policy in SMART and q["stop"] == "end_turn":
            # the turn-end ping: read the prefix, write the reply at 1 hour
            total += (ob.ctx(q) * rd + q["u"].get("output_tokens", 0) * W1H) * p / 1e6
            if policy == "smart+keepalive" and i == len(reqs) - 1:
                total += pings * ob.ctx(q) * rd * p / 1e6      # the user never came back
        prev = q
    return total


def table(sessions, pings):
    """{sid: {policy: dollars}} for current and every policy."""
    return {s["sid"]: {pol: cost(s["reqs"], pol, pings) for pol in ["current"] + POLICIES} for s in sessions if s["reqs"]}


def dominant_model(sessions):
    c = collections.Counter(canonical(q["model"]) for s in sessions for q in s["reqs"])
    return c.most_common(1)[0][0] if c else DEFAULT_MODEL


def probe(sessions, win, window_usd, platform="anthropic"):
    model = dominant_model(sessions)
    pings = keepalive_pings(turn_end_gaps(sessions), (rates(model) or rates(DEFAULT_MODEL))[2])
    T = table(sessions, pings)
    confirmed = probe_cache.stored(platform, model)
    confirmed = bool(confirmed and confirmed.get("status") == "pass")
    dep = f"conformance/{platform}/{model}/smart-ttl"
    out, fl = [], ob.floor(window_usd)
    for name, _, _ in BUCKETS:
        pop = [s for s in sessions if s["sid"] in T and bucket(s) == name]
        spend = sum(s["cost"] for s in pop)
        cur = sum(T[s["sid"]]["current"] for s in pop)
        for group in (["5m", "1h"], ["smart", "smart+keepalive"]):
            best = min(group, key=lambda pol: sum(T[s["sid"]][pol] for s in pop)) if pop else group[0]
            cf = sum(T[s["sid"]][best] for s in pop)
            subs = ob.subwindows(pop)
            deltas = [sum(T[s["sid"]]["current"] - T[s["sid"]][best] for s in g) for g in subs]
            flips = ob.sign_flips(deltas, cur - cf) if subs else None
            smart = group[0] == "smart"
            if not pop:
                status, note = "silent", "no sessions in this population"
            elif cur - cf <= fl:
                status, note = "silent", f"best policy beats current by ${cur - cf:.2f}, under the ${fl:.2f} floor"
            elif flips is None:
                status, note = "silent", f"{len(pop)} sessions: too few for k = {ob.K} sub-windows"
            elif flips:
                status, note = "silent", f"sign flips on {flips} of {ob.K} sub-windows"
            elif smart and not confirmed:
                status, note = "unconfirmed", "smart-TTL billing not yet confirmed on this platform (P2)"
            else:
                status, note = "emit", None
            nxt = {"emit": "apply-shadow", "unconfirmed": "run-probe"}.get(status, "none")
            pol = best + (f" ({pings} keep-alive pings)" if best == "smart+keepalive" else "")
            out.append(ob.finding("gap-scan", "cache-config", "T0", name, len(pop), spend, win, cur, pol, cf,
                                  "measured", status, nxt, window_usd, dict(k=ob.K, sign_flips=flips),
                                  [dep] if smart else [], note))
    return out


def main():
    ap = argparse.ArgumentParser(description="P3 gap-scan: TTL and keep-alive policy per session population.")
    ap.add_argument("--days", type=float, default=30)
    ap.add_argument("--since", help="YYYY-MM-DD (overrides --days)")
    ap.add_argument("--root", default=ob.PROJECTS)
    ap.add_argument("--platform", default="anthropic")
    ap.add_argument("--json", action="store_true", help="print the findings records")
    a = ap.parse_args()
    since = (dt.datetime.fromisoformat(a.since).replace(tzinfo=dt.timezone.utc) if a.since
             else dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=a.days))
    sessions, _ = ob.load(a.root, since)
    win, usd = ob.window(sessions), sum(s["cost"] for s in sessions)
    F = probe(sessions, win, usd, a.platform)
    if a.json:
        for f in F:
            print(ob.dumps(f))
        return
    model = dominant_model(sessions)
    pings = keepalive_pings(turn_end_gaps(sessions), (rates(model) or rates(DEFAULT_MODEL))[2])
    T = table(sessions, pings)
    print(f"gap-scan · {len(sessions)} sessions · ${usd:,.2f} list price · {win['start']} .. {win['end']}")
    print(f"keep-alive: {pings} pings of 55 minutes pay after a turn end, on {model} ({len(turn_end_gaps(sessions))} turn ends)\n")
    print(f"  {'population':20} {'n':>4} {'spend':>9} {'current':>9} " + " ".join(f"{p:>16}" for p in POLICIES))
    for name, _, _ in BUCKETS:
        pop = [s for s in sessions if s["sid"] in T and bucket(s) == name]
        row = {pol: sum(T[s["sid"]][pol] for s in pop) for pol in ["current"] + POLICIES}
        print(f"  {name:20} {len(pop):4d} {sum(s['cost'] for s in pop):9.2f} {row['current']:9.2f} "
              + " ".join(f"{row['current'] - row[p]:+16.2f}" for p in POLICIES))
    print("\n  columns after `current`: dollars saved against it (input side), measured on real gaps\n")
    for f in F:
        print(f"  {f['status']:11} {f['population']['predicate']:20} {f['counterfactual']['policy']:30} "
              f"{f['delta']['usd']:+9.2f}  {f.get('note') or ''}")


if __name__ == "__main__":
    main()
