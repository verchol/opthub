#!/usr/bin/env python3
"""cachestatus — P1 cache-status (docs/onboarding-spec.md): is caching on, at which TTL, and how
much input goes uncached. Free, read-only.

    python3 tools/cachestatus.py                                 # transcripts, last 30 days
    python3 tools/cachestatus.py --since 2026-10-01 [--json]
    python3 tools/cachestatus.py --admin-report usage.json       # raw-API customers

Per session: uncached share = uncached / (uncached + read + write); hit rate = read / (read + write);
TTL mix from the 5-minute and 1-hour write split. Emits `cache-enable` (T0) when more than 50% of
input is uncached on sessions with at least two requests; silent when the hit rate is at least 90%
(the cache-priming precedent, SPEC §7).

The counterfactual is `priced`: on the main thread, a request within 5 minutes of the previous one
reads the previous request's prompt from cache and writes the rest at 5 minutes; any other request
writes its whole prompt at 5 minutes.

--admin-report reads the JSON the Admin API returns for GET /v1/organizations/usage_report/messages
(one response, or a list of pages), grouped by api_key_id and model. Admin aggregates have no
sessions, so the ceiling is uncached input x (1 - read multiplier) on keys that never read the
cache. Fast-mode, US-only and batch spend are printed only when non-zero.
"""
import argparse, collections, datetime as dt, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import onboardlib as ob  # noqa: E402
from ratecard import DEFAULT_MODEL, W1H, W5, rates, split_write  # noqa: E402

UNCACHED_EMIT, HIT_SILENT = 0.50, 0.90


def tokens(reqs):
    t = collections.Counter()
    for q in reqs:
        w5, w1 = split_write(q["u"])
        t.update(uncached=q["u"].get("input_tokens", 0), read=q["u"].get("cache_read_input_tokens", 0), w5=w5, w1=w1)
    return t


def shares(t):
    inp, w = t["uncached"] + t["read"] + t["w5"] + t["w1"], t["w5"] + t["w1"]
    return dict(uncached=t["uncached"] / inp if inp else 0.0, hit=t["read"] / (t["read"] + w) if t["read"] + w else 0.0,
                ttl_1h=t["w1"] / w if w else 0.0)


def input_cost(q):
    p, _, rd = rates(q["model"]) or rates(DEFAULT_MODEL)
    w5, w1 = split_write(q["u"])
    return (q["u"].get("input_tokens", 0) + q["u"].get("cache_read_input_tokens", 0) * rd + w5 * W5 + w1 * W1H) * p / 1e6


def cached_cost(reqs):
    """Input-side dollars of a main thread had every request cached at 5 minutes."""
    total, prev = 0.0, None
    for q in reqs:
        p, _, rd = rates(q["model"]) or rates(DEFAULT_MODEL)
        P = ob.ctx(q)
        hit = min(ob.ctx(prev), P) if prev and (q["t"] - prev["t"]).total_seconds() <= 300 else 0
        total += (hit * rd + (P - hit) * W5) * p / 1e6
        prev = q
    return total


def probe(sessions, win, window_usd):
    pop = [s for s in sessions if len(s["reqs"]) >= 2]
    t = tokens(q for s in pop for q in s["reqs"] + s["subs"])
    sh = shares(t)
    cur = sum(input_cost(q) for s in pop for q in s["reqs"])
    cf = sum(cached_cost(s["reqs"]) for s in pop)
    if not pop:
        status, note = "silent", "no session with two or more requests"
    elif sh["hit"] >= HIT_SILENT:
        status, note = "silent", f"cache hit {100 * sh['hit']:.1f}%: nothing to win"
    elif sh["uncached"] <= UNCACHED_EMIT:
        status, note = "silent", f"caching is on: {100 * sh['uncached']:.1f}% of input uncached, hit {100 * sh['hit']:.1f}%"
    elif cur - cf <= ob.floor(window_usd):
        status, note = "silent", f"{100 * sh['uncached']:.1f}% uncached, but caching saves ${cur - cf:.2f}, under the floor"
    else:
        status, note = "emit", f"{100 * sh['uncached']:.1f}% of input uncached, hit {100 * sh['hit']:.1f}%, 1h writes {100 * sh['ttl_1h']:.0f}%"
    return [ob.finding("cache-status", "cache-config", "T0", "sessions with 2+ requests", len(pop),
                       sum(s["cost"] for s in pop), win, cur, "cache-enable (5m, automatic)", cf, "priced", status,
                       "apply-shadow" if status == "emit" else "none", window_usd, note=note)]


# ------------------------------------------------------------------ Admin usage report

def admin_rows(doc):
    pages = doc if isinstance(doc, list) else [doc]
    for page in pages:
        for b in page.get("data") or []:
            for r in b.get("results") or []:
                yield r


def admin(doc):
    """(per key and model token totals, side lines in dollars at list rates)."""
    K, side = collections.defaultdict(collections.Counter), collections.Counter()
    for r in admin_rows(doc):
        cc = r.get("cache_creation") or {}
        t = collections.Counter(uncached=r.get("uncached_input_tokens", 0), read=r.get("cache_read_input_tokens", 0),
                                w5=cc.get("ephemeral_5m_input_tokens", 0), w1=cc.get("ephemeral_1h_input_tokens", 0),
                                out=r.get("output_tokens", 0))
        K[(r.get("api_key_id") or "-", r.get("model") or DEFAULT_MODEL)].update(t)
        p, o, rd = rates(r.get("model")) or rates(DEFAULT_MODEL)
        usd = ((t["uncached"] + t["read"] * rd + t["w5"] * W5 + t["w1"] * W1H) * p + t["out"] * o) / 1e6
        side["total"] += usd
        if r.get("speed") == "fast":
            side["fast mode"] += usd
        if (r.get("inference_geo") or "").lower() in ("us", "us_only"):
            side["US-only"] += usd
        if r.get("service_tier") == "batch":
            side["batch"] += usd
    return K, side


def admin_probe(doc, win):
    K, side = admin(doc)
    total = side["total"]
    cold = {k: t for k, t in K.items() if t["read"] == 0 and t["uncached"]}
    cur = cf = 0.0
    for (key, model), t in cold.items():
        p, _, rd = rates(model) or rates(DEFAULT_MODEL)
        cur += t["uncached"] * p / 1e6
        cf += t["uncached"] * p * rd / 1e6
    if not cold or cur - cf <= ob.floor(total):
        status, note = "silent", f"{len(cold)} keys never read the cache; ceiling ${cur - cf:.2f}, under the floor"
    else:
        status, note = "emit", f"{len(cold)} of {len(K)} key/model pairs never read the cache: a ceiling, not a forecast"
    f = ob.finding("cache-status", "cache-config", "T0", "API keys that never read the cache", len(cold), cur, win,
                   cur, "cache-enable (ceiling)", cf, "priced", status, "apply-shadow" if status == "emit" else "none",
                   total, note=note)
    f["population"]["sessions"] = None          # aggregates: no sessions
    f["population"]["keys"] = len(cold)
    return [f], {k: round(v, 4) for k, v in side.items() if v}


def main():
    ap = argparse.ArgumentParser(description="P1 cache-status: is caching on, at which TTL, how much input is uncached.")
    ap.add_argument("--days", type=float, default=30)
    ap.add_argument("--since", help="YYYY-MM-DD (overrides --days)")
    ap.add_argument("--root", default=ob.PROJECTS)
    ap.add_argument("--admin-report", help="Admin API usage_report/messages JSON export")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    if a.admin_report:
        with open(a.admin_report) as fh:
            doc = json.load(fh)
        F, side = admin_probe(doc, dict(start=None, end=None, days=None, input_hash=None))
        for k, v in side.items():
            print(f"  {k:10} ${v:,.2f}")
    else:
        since = (dt.datetime.fromisoformat(a.since).replace(tzinfo=dt.timezone.utc) if a.since
                 else dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=a.days))
        S, _ = ob.load(a.root, since)
        usd = sum(s["cost"] for s in S)
        F = probe(S, ob.window(S), usd)
        t = tokens(q for s in S for q in s["reqs"] + s["subs"])
        sh = shares(t)
        print(f"cache-status · {len(S)} sessions · ${usd:,.2f} list price")
        print(f"  uncached {100 * sh['uncached']:.1f}% of input · hit rate {100 * sh['hit']:.1f}% · "
              f"1h writes {100 * sh['ttl_1h']:.1f}% of writes")
    for f in F:
        print(ob.dumps(f) if a.json else f"  {f['status']:7} {f['counterfactual']['policy']}: {f['delta']['usd']:+.2f}  {f.get('note') or ''}")


if __name__ == "__main__":
    main()
