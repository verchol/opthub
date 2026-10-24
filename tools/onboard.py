#!/usr/bin/env python3
"""onboard — the day-0 scan (docs/onboarding-spec.md): which savings in the defaults model are
real here, and how big. Runs P0 to P5 in order and spends nothing.

    python3 tools/onboard.py                       # last 30 days -> data/private/onboard/<date>/
    python3 tools/onboard.py --dry                 # print every field that would leave, write nothing
    python3 tools/onboard.py --admin-report usage.json   # raw-API customers: P1 from the Admin usage report

  P0 inventory       sources, window, retention, platform, gateway, the counting check
  P1 cache-status    tools/cachestatus.py
  P2 conformance     the stored result of tools/probe_cache.py; never run from here (it spends)
  P3 gap-scan        tools/gapscan.py
  P4 effort-sizing   tools/savings.py --classes
  P5 subagent-share  tools/sessiongraph.py

Writes inventory.json, findings.jsonl (one opthub.finding/1 record per lever and population,
emitted or silent) and report.html, rendered from those records alone. No prompt text, tool
input or path is in any of them. With fewer than 7 days or 20 sessions, the free probes don't run
and the report says to collect first.

The day-1 config is the T0 findings, applied in shadow for 7 days (SPEC §16). Their total is
marginal: P1 and P3 both act on cache input dollars, so only the larger of the two counts.
"""
import argparse, collections, datetime as dt, html, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import cachestatus, gapscan, onboardlib as ob, probe_cache, ratecard, savings, sessiongraph, sessions  # noqa: E402

REPO = os.path.dirname(HERE)
OUT = os.environ.get("OPTHUB_ONBOARD") or os.path.join(REPO, "data", "private", "onboard")
MIN_DAYS, MIN_SESSIONS = 7, 20
SHADOW_DAYS = 7


def retention():
    try:
        with open(os.path.expanduser("~/.claude/settings.json")) as fh:
            return json.load(fh).get("cleanupPeriodDays") or 30
    except (OSError, ValueError):
        return 30


def platform(S):
    ids = {q["model"] for s in S for q in s["reqs"] + s["subs"]}
    if os.environ.get("CLAUDE_CODE_USE_BEDROCK") or any("anthropic." in m for m in ids):
        return "bedrock"
    if os.environ.get("CLAUDE_CODE_USE_VERTEX") or any("@" in m for m in ids):
        return "vertex"
    return "anthropic"


def inventory(S, counts, win, root, admin_report, capture_dir):
    oldest = sessions.oldest_on_disk(root)
    days = win["days"] or 0
    return collections.OrderedDict(
        schema="opthub.inventory/1", ratecard=ratecard.VERSION, window=win,
        sessions=len(S), spend_usd=round(sum(s["cost"] for s in S), 4),
        sources=dict(transcripts=bool(S), admin_report=bool(admin_report), capture=os.path.isdir(capture_dir)),
        retention=dict(cleanup_period_days=retention(),
                       oldest_on_disk=oldest.date().isoformat() if oldest else None),
        platform=platform(S), gateway=bool(os.environ.get("ANTHROPIC_BASE_URL")),
        counting=dict(records=counts["records"], requests=counts["requests"],
                      records_per_request=round(counts["records"] / counts["requests"], 3) if counts["requests"] else None),
        enough=days >= MIN_DAYS and len(S) >= MIN_SESSIONS,
        why=None if days >= MIN_DAYS and len(S) >= MIN_SESSIONS else
            f"collect first: {days:g} days and {len(S)} sessions, need {MIN_DAYS} days and {MIN_SESSIONS} sessions")


def conformance_finding(S, inv, win, usd):
    model = gapscan.dominant_model(S)
    r = probe_cache.stored(inv["platform"], model)
    dep = f"conformance/{inv['platform']}/{model}/smart-ttl"
    if r:
        status, nxt, note = "silent", "none", f"smart TTL {r['status']} on {r['date']}"
    else:
        status, nxt, note = "unconfirmed", "run-probe", (f"no current result for {inv['platform']} {model}: "
                                                          f"run tools/probe_cache.py conformance --yes (spends cents)")
    return ob.finding("cache-conformance", "cache-config", "T0", f"platform {inv['platform']}, {model}", len(S), usd, win,
                      0.0, "smart-ttl", 0.0, "detector", status, nxt, usd, depends_on=[dep], note=note)


def scan(root, since, admin_report=None, capture_dir=".opthub/cas"):
    S, counts = ob.load(root, since)
    win, usd = ob.window(S), sum(s["cost"] for s in S)
    inv = inventory(S, counts, win, root, admin_report, capture_dir)
    F = [conformance_finding(S, inv, win, usd)]
    side = {}
    if admin_report:
        with open(admin_report) as fh:
            f, side = cachestatus.admin_probe(json.load(fh), win)
        F += f
    if inv["enough"]:
        F += cachestatus.probe(S, win, usd)
        F += gapscan.probe(S, win, usd, inv["platform"])
        F += savings.effort_probe(S, win, usd)
        F += sessiongraph.probe(S, win, usd)
    inv["admin_side_lines_usd"] = side
    return inv, F


def day1(F):
    """T0 findings that emit, and their marginal total: the cache probes share input dollars."""
    t0 = [f for f in F if f["tier"] == "T0" and f["status"] == "emit"]
    cache = [f for f in t0 if f["lever"] == "cache-config"]
    by_probe = collections.defaultdict(float)
    for f in cache:
        by_probe[f["probe"]] += f["delta"]["usd"]
    total = max(by_probe.values(), default=0.0) + sum(f["delta"]["usd"] for f in t0 if f["lever"] != "cache-config")
    return t0, total


def report(inv, F, path):
    e = lambda x: html.escape(str(x))
    usd = lambda x: f"${x:,.2f}"
    emit = sorted([f for f in F if f["status"] == "emit"], key=lambda f: -f["delta"]["usd"])
    t0, t0_total = day1(F)
    queue = [f for f in emit if f["tier"] in ("T1", "T2")]
    quiet = [f for f in F if f["status"] != "emit"]
    w = inv["window"]
    row = lambda f: (f"<tr><td>{e(f['probe'])}</td><td>{e(f['lever'])} ({e(f['tier'])})</td><td>{e(f['population']['predicate'])}"
                     f" <span class=m>n={e(f['population']['sessions'])}</span></td><td>{e(f['counterfactual']['policy'])}</td>"
                     f"<td class=r>{usd(f['delta']['usd'])}</td><td class=r>{f['delta']['pct_of_window']:.1f}%</td>"
                     f"<td>{e(f['label'])}</td><td class=m>{e(f.get('note') or '')}</td></tr>")
    head = "<tr><th>probe</th><th>lever</th><th>population</th><th>change</th><th>saves</th><th>of window</th><th>label</th><th></th></tr>"
    table = lambda rows: f"<table>{head}{''.join(row(f) for f in rows)}</table>" if rows else "<p class=m>none</p>"
    side = "".join(f"<li>{e(k)}: {usd(v)}</li>" for k, v in inv.get("admin_side_lines_usd", {}).items() if k != "total")
    page = f"""<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Onboarding scan</title><style>
:root{{--fg:#1d1d1f;--bg:#fff;--muted:#6e6e73;--line:#e5e5ea}}
@media (prefers-color-scheme:dark){{:root{{--fg:#f2f2f7;--bg:#111;--muted:#98989f;--line:#333}}}}
body{{font:14px/1.5 system-ui,sans-serif;color:var(--fg);background:var(--bg);max-width:1100px;margin:0 auto;padding:16px}}
table{{border-collapse:collapse;width:100%;margin:8px 0 20px}}td,th{{border-bottom:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}}
.r{{text-align:right;white-space:nowrap}}.m{{color:var(--muted)}}h2{{margin-top:28px}}
@media (max-width:700px){{table{{display:block;overflow-x:auto}}}}</style></head><body>
<h1>Onboarding scan</h1>
<h2>1. Window and data</h2>
<p>{e(w['start'])} to {e(w['end'])} ({e(w['days'])} days) · {inv['sessions']} sessions · {usd(inv['spend_usd'])} at list price ·
platform {e(inv['platform'])}{' behind a gateway' if inv['gateway'] else ''} · rate card {e(inv['ratecard'])}</p>
<p class=m>Sources: {', '.join(k.replace('_', ' ') for k, v in inv['sources'].items() if v) or 'none'}.
Retention {inv['retention']['cleanup_period_days']} days; oldest transcript {e(inv['retention']['oldest_on_disk'])}.
Counting: {inv['counting']['records']:,} usage records are {inv['counting']['requests']:,} requests
({e(inv['counting']['records_per_request'])} records per request; a tool that counts records overstates spend by that much).
Inputs {e(w['input_hash'])}.</p>
{f"<p><b>{e(inv['why'])}.</b> Only the stored P2 result is shown.</p>" if not inv['enough'] else ''}
{f"<ul>{side}</ul>" if side else ''}
<h2>2. Findings</h2>{table(emit)}
<h2>3. Safe day-1 config</h2>
<p>T0 only, applied in shadow for {SHADOW_DAYS} days: shadow logs what would change and changes nothing.
Marginal total {usd(t0_total)}.</p>{table(t0)}
<h2>4. Experiment queue</h2><p class=m>T1 and T2 proposals; each cleared 3x its verification cost. Nothing here runs without --yes.</p>{table(queue)}
<h2>5. Silent probes</h2><p class=m>A silent probe is a result: it measured and found nothing to win, or not yet enough to say.</p>{table(quiet)}
</body></html>"""
    with open(path, "w") as fh:
        fh.write(page)


def main():
    ap = argparse.ArgumentParser(description="Day-0 onboarding scan: P0-P5, free.")
    ap.add_argument("--days", type=float, default=30)
    ap.add_argument("--since", help="YYYY-MM-DD (overrides --days)")
    ap.add_argument("--root", default=ob.PROJECTS)
    ap.add_argument("--admin-report", help="Admin API usage_report/messages JSON export")
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--dry", action="store_true", help="print every field that would leave; write nothing")
    a = ap.parse_args()
    since = (dt.datetime.fromisoformat(a.since).replace(tzinfo=dt.timezone.utc) if a.since
             else dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=a.days))
    inv, F = scan(a.root, since, a.admin_report)
    if a.dry:
        print(ob.dumps(inv))
        for f in F:
            print(ob.dumps(f))
        return
    d = os.path.join(a.out, dt.date.today().isoformat())
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "inventory.json"), "w") as fh:
        fh.write(ob.dumps(inv) + "\n")
    with open(os.path.join(d, "findings.jsonl"), "w") as fh:
        fh.writelines(ob.dumps(f) + "\n" for f in F)
    report(inv, F, os.path.join(d, "report.html"))
    t0, total = day1(F)
    n = collections.Counter(f["status"] for f in F)
    print(f"onboard · {inv['sessions']} sessions · ${inv['spend_usd']:,.2f} · {inv['window']['days']} days · "
          f"{inv['counting']['records_per_request']} records per request")
    if inv["why"]:
        print(f"  {inv['why']}")
    print(f"  findings: {n['emit']} emitted, {n['silent']} silent, {n['unconfirmed']} unconfirmed · day-1 config ${total:,.2f}")
    for f in sorted(F, key=lambda f: (f["status"] != "emit", -f["delta"]["usd"])):
        print(f"  {f['status']:11} {f['probe']:17} {f['population']['predicate']:40} {f['counterfactual']['policy'][:22]:22} "
              f"{f['delta']['usd']:+9.2f}  {f.get('note') or ''}")
    print(f"  -> {os.path.relpath(d, REPO)}/  (inventory.json, findings.jsonl, report.html)")


if __name__ == "__main__":
    main()
