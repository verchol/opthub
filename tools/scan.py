#!/usr/bin/env python3
"""scan — `opt scan`, the v1 product (docs/release-plan-v1.md): one command over the transcripts,
three layers, one rate card, one report. Free and read-only; no text leaves the machine.

    python3 tools/scan.py                          # last 30 days -> data/private/scan/<date>/
    python3 tools/scan.py --dry                    # print every field that would leave; write nothing
    python3 tools/scan.py --admin-report usage.json
    python3 tools/scan.py rollup DIR [DIR ...]     # one org view from several developers' scans

  layer 1  Claude Code settings   onboarding probes P0-P4 (tools/onboard.py), plus the dynconfig levers
                                  they do not cover: fast mode, model switches, unused tools, an output hook
  layer 2  model routing          each thread group (subagent type, skill, main loop by session class)
                                  re-priced on the cheaper tier it could move to: Haiku 5.5 for threads
                                  that only read, Sonnet 5.5 for the rest of Opus, with the prefix re-buy a
                                  skill switch on the main thread pays and Haiku's 100K price step
  layer 3  other strategies       the Optimization Atlas (docs/atlas/scenarios.json): which scenarios the
                                  first two layers measured, two more detectors (split sessions, model
                                  upgrade), and the rest listed as not measurable from transcripts

Writes inventory.json, findings.jsonl (opthub.finding/1 with a `layer` field), report.html, and a day-1
profile per repo under profiles/: the T0 knobs that repo's own sessions support, applied in shadow for
7 days by the launcher (release plan phase 2). Profiles name the repo, so they never leave the machine.

Every routing finding is T2: proposed, never applied, and only when the ceiling projected to 30 days
clears 3x the replays that would verify it (SPEC §6.4).
"""
import argparse, collections, datetime as dt, glob, hashlib, html, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import dynconfig, gapscan, onboard, onboardlib as ob, ratecard, savings, sessiongraph  # noqa: E402

REPO = os.path.dirname(HERE)
OUT = os.environ.get("OPTHUB_SCAN") or os.path.join(REPO, "data", "private", "scan")
ATLAS = os.path.join(REPO, "docs", "atlas", "scenarios.json")
HAIKU, SONNET = "claude-haiku-5-5", "claude-sonnet-5-5"
PENALTY = sessiongraph.TOKEN_PENALTY          # a smaller model spends more tokens on the same work (guess)
VERIFY_ARMS, VERIFY_REPEATS, VERIFY_TOP, MIN_ROI = 2, 3, 3, 3.0
LONG_CTX = dynconfig.LONG_CTX
DYN_LEVERS = {   # dynconfig lever -> (lever id, tier, label, what changes)
    "fast": ("fast-mode", "T0", "measured", "fast mode off"),
    "switch": ("cache-config", "T0", "measured", "no model switch mid-session"),
    "tools": ("tool-schema-slimming", "T1", "priced", "drop tools a session never calls"),
    "hook": ("output-shaping", "T1", "guess", "output-filter hook on large Bash results"),
}
# Atlas scenario -> what in this scan measures it
COVERS = {"prompt-caching": "cache-status", "cache-ttl": "gap-scan", "cache-prewarm": "cache-conformance",
          "effort": "effort-sizing", "thinking-cap": "effort-sizing", "fast-mode": "fast-mode",
          "tool-search": "tool-schema-slimming", "prefix-trim": "tool-schema-slimming",
          "route-whole-task": "routing", "route-side-calls": "routing", "cascade": "routing",
          "local-offload": "routing", "split-sessions": "context-lifecycle", "compaction": "context-lifecycle",
          "context-editing": "output-shaping", "model-upgrade": "model-upgrade"}


def tag(layer, F):
    for f in F:
        f["layer"] = layer
    return F


# ------------------------------------------------------------------ layer 1: settings

def dyn_rows(root, since, sids):
    return [r for r in (dynconfig.analyse(s) for s in dynconfig.load(root, since).values())
            if r["cost"] > 0 and r["sid"] in sids]


def verify_cost(costs):
    """Replays that would verify a T1/T2 change: its top sessions, baseline and changed arm, 3 repeats."""
    return sum(sorted(costs, reverse=True)[:VERIFY_TOP]) * VERIFY_ARMS * VERIFY_REPEATS


def layer1(F_onboard, rows, win, usd):
    out = [f for f in F_onboard if f["probe"] != "subagent-share"]          # P5 is part of layer 2
    days = max(win["days"] or 0, 1)
    for k, (lever, tier, label, what) in DYN_LEVERS.items():
        pop = [r for r in rows if r[k] > 0.005]
        d = sum(r[k] for r in pop)
        cur = sum(r["cost"] for r in pop)
        verify = verify_cost([r["cost"] for r in pop])
        if d <= ob.floor(usd):
            status, note = "silent", f"${d:.2f}, under the ${ob.floor(usd):.2f} floor"
        elif tier != "T0" and d * 30 / days <= MIN_ROI * verify:
            status, note = "silent", f"30-day ceiling ${d * 30 / days:.2f} does not clear {MIN_ROI:g}x the replays' ${verify:.2f}"
        else:
            status, note = "emit", None
        out.append(ob.finding("dynconfig", lever, tier, f"sessions where '{what}' applies", len(pop), cur, win, cur, what,
                              cur - d, label, status, ("apply-shadow" if tier == "T0" else "run-sweep") if status == "emit" else "none",
                              usd, note=note))
    return tag(1, out)


# ------------------------------------------------------------------ layer 2: routing

def price_on(q, target, penalty=PENALTY):
    """A request's cost on another model with `penalty` x the tokens (ratecard applies Haiku's 100K step)."""
    u = {k: int(v * penalty) for k, v in q["u"].items() if isinstance(v, (int, float))}
    w5, w1 = ratecard.split_write(q["u"])
    u["cache_creation"] = dict(ephemeral_5m_input_tokens=int(w5 * penalty), ephemeral_1h_input_tokens=int(w1 * penalty))
    return ratecard.req_cost(target, u), ratecard.prompt_tokens(u) > ratecard.LONG.get(target, (float("inf"),))[0]


def groups(S):
    """{(kind, name): [(session, [requests])]} for subagent types, skills on the main thread, and main loops."""
    G = collections.defaultdict(lambda: collections.defaultdict(list))
    for s in S:
        for q in s["subs"]:
            G[("subagent", q["agent"] or "subagent")][s["sid"]].append(q)
        for q in s["reqs"]:
            G[("skill", q["skill"])][s["sid"]].append(q) if q["skill"] else G[("main", savings.session_class(s))][s["sid"]].append(q)
    by_sid = {s["sid"]: s for s in S}
    return {k: [(by_sid[sid], qs) for sid, qs in v.items()] for k, v in G.items()}


def target_for(kind, reqs):
    models = {ratecard.canonical(q["model"]) for q in reqs}
    tools = {t for q in reqs for t in q["tools"]}
    if all(m.startswith("claude-haiku") for m in models):
        return None, "already on Haiku"
    if kind != "main" and tools <= sessiongraph.READ_ONLY:
        return HAIKU, "only reads"
    if any(m.startswith(("claude-opus", "claude-fable")) for m in models):
        return SONNET, "writes or runs commands"
    return None, "already on a mid tier"


def rebuy(reqs, target):
    """A skill on the main thread switches model: each invocation re-writes the context on the target."""
    out, prev = 0.0, None
    for q in reqs:
        if prev is None or (q["t"] - prev["t"]).total_seconds() > 60:   # a new invocation
            p = (ratecard.rates(target) or ratecard.rates(ratecard.DEFAULT_MODEL))[0]
            out += ob.ctx(q) * p * ratecard.W1H / 1e6
        prev = q
    return out


def layer2(S, win, usd):
    days = max(win["days"] or 0, 1)
    out = []
    for (kind, name), members in sorted(groups(S).items(), key=lambda kv: kv[0]):
        reqs = [q for _, qs in members for q in qs]
        cur = sum(ob.cost(q) for q in reqs)
        target, why = target_for(kind, reqs)
        pred = f"{kind} {name}"
        if target is None:
            out.append(ob.finding("routing", "model-routing", "T2", pred, len(members), cur, win, cur, "keep", cur, "priced",
                                  "silent", "none", usd, note=why))
            continue
        priced = [price_on(q, target) for q in reqs]
        cf = sum(c for c, _ in priced) + (rebuy(reqs, target) if kind == "skill" else 0.0)
        long_ = sum(1 for _, x in priced if x)
        verify = verify_cost([s["cost"] for s in {s["sid"]: s for s, _ in members}.values()])
        proj = (cur - cf) * 30 / days
        if cur - cf <= ob.floor(usd):
            status, note = "silent", f"${cur - cf:.2f} on {target}, under the floor"
        elif proj <= MIN_ROI * verify:
            status, note = "silent", f"30-day ceiling ${proj:.2f} does not clear {MIN_ROI:g}x the replays' ${verify:.2f}"
        else:
            status, note = "emit", f"{why}; {PENALTY}x tokens on the smaller model (guess)"
        if kind == "main" and target == SONNET:
            note += "; a main loop on Sonnet re-ran 2.4-3.9x more per task (n=2)"
        if long_:
            note += f"; {long_} requests land in Haiku's 100K price step"
        out.append(ob.finding("routing", "model-routing", "T2", pred, len(members), cur, win, cur, f"{target} for {kind} {name}",
                              cf, "priced", status, "run-sweep" if status == "emit" else "none", usd, note=note))
    return tag(2, out)


# ------------------------------------------------------------------ layer 3: other strategies

def layer3(S, rows, win, usd, measured):
    F = []
    pop = [r for r in rows if r["x1"] > 0.005]
    x1 = sum(r["x1"] for r in pop)
    F.append(ob.finding("atlas", "context-lifecycle", "T2", "sessions with requests above 150K context", len(pop),
                        sum(r["cost"] for r in pop), win, x1, "a new session per task (/clear)", 0.0, "priced",
                        "emit" if x1 > ob.floor(usd) else "silent", "none", usd,
                        note="input re-sent above 150K context: a ceiling; it needs the person, not a setting or a replay"))
    pop = [r for r in rows if r["opus55"] > 0.005]
    up = sum(r["opus55"] for r in pop)
    F.append(ob.finding("atlas", "model-upgrade", "T1", "sessions still on Opus 5 or 4.8", len(pop),
                        sum(r["cost"] for r in pop), win, up, "Opus 5.5", 0.0, "priced",
                        "emit" if up > ob.floor(usd) else "silent", "run-sweep" if up > ob.floor(usd) else "none", usd,
                        note="same tokens at Opus 5.5 rates"))
    tag(3, F)
    with open(ATLAS) as fh:
        atlas = json.load(fh)["scenarios"]
    found = {f["probe"] for f in measured + F} | {f["lever"] for f in measured + F}
    cover = [dict(id=sc["id"], name=sc["name"], atlas_evidence=sc["evidence"],
                  measured_by=COVERS[sc["id"]] if COVERS.get(sc["id"]) in found else None) for sc in atlas]
    return F, cover


# ------------------------------------------------------------------ day-1 profiles

def profiles(S, usd):
    """Per repo: the T0 knobs its own sessions support. Only TTL and fast mode are T0 settings today."""
    out = {}
    for proj, ss in sorted(_by(S, "project_dir").items()):
        win, spend = ob.window(ss), sum(s["cost"] for s in ss)
        settings, why = {}, []
        for f in gapscan.probe(ss, win, spend):
            if f["status"] == "emit" and f["counterfactual"]["policy"] in ("5m", "1h"):
                settings["promptCacheTtl"] = f["counterfactual"]["policy"]
                why.append(dict(probe="gap-scan", population=f["population"]["predicate"], delta_usd=f["delta"]["usd"]))
                break
        if settings:
            out[proj] = dict(schema="opthub.profile/1", repo=proj, mode="shadow", shadow_days=onboard.SHADOW_DAYS,
                             ratecard=ratecard.VERSION, window=win, settings=settings, evidence=why)
    return out


def _by(S, key):
    d = collections.defaultdict(list)
    for s in S:
        d[s[key]].append(s)
    return d


# ------------------------------------------------------------------ run, report, rollup

def scan(root, since, admin_report=None):
    inv, F0 = onboard.scan(root, since, admin_report)
    S, _ = ob.load(root, since)
    win, usd = inv["window"], inv["spend_usd"]
    if not inv["enough"]:
        return inv, tag(1, F0), [], {}
    rows = dyn_rows(root, since, {s["sid"] for s in S})
    L1 = layer1(F0, rows, win, usd)
    L2 = layer2(S, win, usd)
    L3, cover = layer3(S, rows, win, usd, L1 + L2)
    inv["atlas"] = cover
    return inv, L1 + L2 + L3, cover, profiles(S, usd)


def report(inv, F, path, title="opt scan"):
    e = lambda x: html.escape(str(x))
    usd = lambda x: f"${x:,.2f}"
    head = "<tr><th>layer</th><th>probe</th><th>lever</th><th>population</th><th>change</th><th>saves</th><th>label</th><th></th></tr>"
    row = lambda f: (f"<tr><td>{f['layer']}</td><td>{e(f['probe'])}</td><td>{e(f['lever'])} ({e(f['tier'])})</td>"
                     f"<td>{e(f['population']['predicate'])} <span class=m>n={e(f['population']['sessions'])}</span></td>"
                     f"<td>{e(f['counterfactual']['policy'])}</td><td class=r>{usd(f['delta']['usd'])}</td>"
                     f"<td>{e(f['label'])}</td><td class=m>{e(f.get('note') or '')}</td></tr>")
    table = lambda rows: f"<table>{head}{''.join(row(f) for f in rows)}</table>" if rows else "<p class=m>none</p>"
    emit = sorted([f for f in F if f["status"] == "emit"], key=lambda f: -f["delta"]["usd"])
    t0, t0_total = onboard.day1(F)
    queue = [f for f in emit if f["next"] == "run-sweep"]
    quiet = [f for f in F if f["status"] != "emit"]
    cover = inv.get("atlas") or []
    atlas = "".join(f"<tr><td>{e(c['name'])}</td><td>{e(c['atlas_evidence'])}</td><td>{e(c['measured_by'] or 'not measurable from transcripts')}</td></tr>"
                    for c in cover)
    w = inv["window"]
    page = f"""<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>{e(title)}</title><style>
:root{{--fg:#1d1d1f;--bg:#fff;--muted:#6e6e73;--line:#e5e5ea}}
@media (prefers-color-scheme:dark){{:root{{--fg:#f2f2f7;--bg:#111;--muted:#98989f;--line:#333}}}}
body{{font:14px/1.5 system-ui,sans-serif;color:var(--fg);background:var(--bg);max-width:1150px;margin:0 auto;padding:16px}}
table{{border-collapse:collapse;width:100%;margin:8px 0 20px}}td,th{{border-bottom:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}}
.r{{text-align:right;white-space:nowrap}}.m{{color:var(--muted)}}h2{{margin-top:28px}}
@media (max-width:700px){{table{{display:block;overflow-x:auto}}}}</style></head><body>
<h1>{e(title)}</h1>
<p>{e(w['start'])} to {e(w['end'])} ({e(w['days'])} days) · {inv['sessions']} sessions · {usd(inv['spend_usd'])} at list price ·
platform {e(inv['platform'])} · rate card {e(inv['ratecard'])} · {inv['counting']['records_per_request']} transcript records per request</p>
{f"<p><b>{e(inv['why'])}.</b></p>" if inv.get('why') else ''}
<h2>Findings</h2><p class=m>Ranked by saving. Layer 1 is settings, 2 routing, 3 everything else.</p>{table(emit)}
<h2>Day-1 profile</h2><p>T0 only, applied in shadow for {onboard.SHADOW_DAYS} days. Marginal total {usd(t0_total)}.
Per-repo profiles are written next to this report and never leave the machine.</p>{table(t0)}
<h2>Experiment queue</h2><p class=m>T1 and T2: each clears 3x the replays that would verify it. Nothing runs without --yes.</p>{table(queue)}
<h2>Optimization Atlas coverage</h2><table><tr><th>scenario</th><th>Atlas evidence</th><th>measured by</th></tr>{atlas}</table>
<h2>Silent</h2><p class=m>Measured, and nothing to win, or not enough data to say.</p>{table(quiet)}
</body></html>"""
    with open(path, "w") as fh:
        fh.write(page)


def rollup(dirs):
    """Sum several developers' findings into one org view. Floors are re-applied to the sums; a
    population any developer found unstable stays silent."""
    acc, invs = {}, []
    for d in dirs:
        with open(os.path.join(d, "inventory.json")) as fh:
            invs.append(json.load(fh))
        with open(os.path.join(d, "findings.jsonl")) as fh:
            for line in fh:
                f = json.loads(line)
                k = (f["layer"], f["probe"], f["lever"], f["population"]["predicate"], f["counterfactual"]["policy"])
                a = acc.setdefault(k, dict(f, population=dict(f["population"], sessions=0, spend_usd=0.0),
                                           current_usd=0.0, counterfactual=dict(f["counterfactual"], usd=0.0), flips=0))
                a["population"]["sessions"] += f["population"]["sessions"] or 0
                a["population"]["spend_usd"] += f["population"]["spend_usd"]
                a["current_usd"] += f["current_usd"]
                a["counterfactual"]["usd"] += f["counterfactual"]["usd"]
                a["flips"] += (f["stability"] or {}).get("sign_flips") or 0
    total = sum(i["spend_usd"] for i in invs)
    out = []
    for a in acc.values():
        d = a["current_usd"] - a["counterfactual"]["usd"]
        a["delta"] = dict(usd=round(d, 4), pct_of_window=round(100 * d / total, 3) if total else 0.0)
        if a["status"] == "unconfirmed":
            pass
        elif a.pop("flips"):
            a["status"], a["note"] = "silent", "a developer's sub-windows flip sign"
        else:
            a["status"] = "emit" if d > ob.floor(total) and a["status"] in ("emit", "silent") and a["label"] != "detector" else a["status"]
        a.pop("flips", None)
        a["window"] = dict(start=min(i["window"]["start"] or "" for i in invs), end=max(i["window"]["end"] or "" for i in invs),
                           days=max(i["window"]["days"] or 0 for i in invs), input_hash=None)
        out.append(a)
    inv = dict(invs[0], sessions=sum(i["sessions"] for i in invs), spend_usd=round(total, 4), developers=len(invs),
               window=out[0]["window"] if out else invs[0]["window"],
               counting=dict(records=sum(i["counting"]["records"] for i in invs), requests=sum(i["counting"]["requests"] for i in invs),
                             records_per_request=None), why=None)
    return inv, sorted(out, key=lambda f: (f["layer"], -f["delta"]["usd"]))


def write(d, inv, F, profs=None, title="opt scan"):
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "inventory.json"), "w") as fh:
        fh.write(ob.dumps(inv) + "\n")
    with open(os.path.join(d, "findings.jsonl"), "w") as fh:
        fh.writelines(ob.dumps(f) + "\n" for f in F)
    report(inv, F, os.path.join(d, "report.html"), title)
    for proj, p in (profs or {}).items():
        os.makedirs(os.path.join(d, "profiles"), exist_ok=True)
        name = hashlib.sha256(proj.encode()).hexdigest()[:12]
        with open(os.path.join(d, "profiles", f"{name}.json"), "w") as fh:
            json.dump(p, fh, indent=1)


def main():
    if sys.argv[1:2] == ["rollup"]:
        dirs = sys.argv[2:]
        if not dirs:
            sys.exit("usage: scan.py rollup DIR [DIR ...]  (each a scan output directory)")
        inv, F = rollup(dirs)
        d = os.path.join(OUT, "rollup-" + dt.date.today().isoformat())
        write(d, inv, F, title=f"opt scan · {inv['developers']} developers")
        print(f"rollup of {inv['developers']} scans · {inv['sessions']} sessions · ${inv['spend_usd']:,.2f} -> {os.path.relpath(d, REPO)}/")
        return
    ap = argparse.ArgumentParser(description="opt scan: three layers over this machine's Claude Code transcripts. Free.")
    ap.add_argument("--days", type=float, default=30)
    ap.add_argument("--since", help="YYYY-MM-DD (overrides --days)")
    ap.add_argument("--root", default=ob.PROJECTS)
    ap.add_argument("--admin-report", help="Admin API usage_report/messages JSON export")
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--dry", action="store_true", help="print every field that would leave; write nothing")
    ap.add_argument("--json", action="store_true", help="print the output directory only")
    a = ap.parse_args()
    since = (dt.datetime.fromisoformat(a.since).replace(tzinfo=dt.timezone.utc) if a.since
             else dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=a.days))
    inv, F, cover, profs = scan(a.root, since, a.admin_report)
    if a.dry:
        print(ob.dumps(inv))
        for f in F:
            print(ob.dumps(f))
        return
    d = os.path.join(a.out, dt.date.today().isoformat())
    write(d, inv, F, profs)
    if a.json:
        print(d)
        return
    t0, total = onboard.day1(F)
    n = collections.Counter(f["status"] for f in F)
    print(f"opt scan · {inv['sessions']} sessions · ${inv['spend_usd']:,.2f} · {inv['window']['days']} days")
    if inv.get("why"):
        print(f"  {inv['why']}")
    print(f"  {n['emit']} emitted, {n['silent']} silent, {n['unconfirmed']} unconfirmed · day-1 profile ${total:,.2f} "
          f"· {len(profs)} repo profile{'s' if len(profs) != 1 else ''}")
    for layer in (1, 2, 3):
        L = [f for f in F if f["layer"] == layer]
        top = sorted(L, key=lambda f: (f["status"] != "emit", -f["delta"]["usd"]))[:6]
        if L:
            print(f"  layer {layer}")
        for f in top:
            print(f"    {f['status']:11} {f['population']['predicate'][:42]:42} {f['counterfactual']['policy'][:26]:26} "
                  f"{f['delta']['usd']:+9.2f}  {(f.get('note') or '')[:70]}")
    if cover:
        print(f"  atlas: {sum(1 for c in cover if c['measured_by'])} of {len(cover)} scenarios measured here")
    print(f"  -> {os.path.relpath(d, REPO)}/report.html")


if __name__ == "__main__":
    main()
