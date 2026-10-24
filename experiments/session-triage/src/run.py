#!/usr/bin/env python3
"""J3 — classify every session in a ledger, then price what each class unlocks.

    python3 src/run.py                              # rules only, pinned E1b ledger, no egress
    JEV_API_KEY=... python3 src/run.py --arms rules,jev
    python3 src/run.py --dry-run                    # print the Jev payload for the top session
    python3 src/run.py --ledger data/private/ledger.csv --features data/private/features.jsonl --arms rules,jev
    python3 src/run.py --mode interactive --limit 20  # you label the 20 most expensive sessions (gold)

Arms: rules-C0 always; rules-C1 and jev-C1 when --features is given; jev-C0 with --arms jev.
`hybrid` is derived, not called: rules answer, Jev fills only the axes rules left
'unclear' (SPEC §6.7 detector-first). No arm is scored against gold — there is no gold
for "could this have waited" — so what is reported is the money each arm's labels
would move, the agreement between arms, and how often an arm contradicts itself.

--mode auto (default) runs only the classifiers. --mode interactive also asks you, at the
terminal, to label the most expensive sessions (classifiers/human.py); answers go to
--gold and become the `human` arm, and every other arm's agreement with it is the nearest
thing to an accuracy this experiment has. An auto run loads an existing gold file too.
"""

import argparse
import json
import os
import pathlib
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from evidence import load                                   # noqa: E402
from savings import session_savings, incoherent             # noqa: E402
from classifiers.rules import RulesClassifier               # noqa: E402

HERE = pathlib.Path(__file__).resolve().parents[1]
REPO = HERE.parents[1]
LEVERS = [("route", "route to mid/small tier", "priced"),
          ("context", "split separable sessions", "guess"),
          ("batch_ceiling", "batch — cache holds", "priced ceiling"),
          ("batch_floor", "batch — cache lost", "guess floor"),
          ("combined_ceiling", "all levers, stacked — ceiling", ""),
          ("combined_floor", "all levers, stacked — floor", "")]


def build_arms(taxonomy, which, have_features, ctx=("C0", "C1")):
    arms = [RulesClassifier(with_context=False)]
    if have_features:
        arms.append(RulesClassifier(with_context=True))
    if "jev" in which:
        if not os.environ.get("JEV_API_KEY"):
            print("jev: skipped — JEV_API_KEY is not set in this environment")
        else:
            from classifiers.jev import JevClassifier
            if "C0" in ctx:
                arms.append(JevClassifier(taxonomy, with_context=False))
            if have_features and "C1" in ctx:
                arms.append(JevClassifier(taxonomy, with_context=True))
    return arms


def hybrid(rules_labels, jev_labels):
    if not jev_labels:
        return dict(rules_labels)
    return {ax: (v if v != "unclear" else jev_labels.get(ax, "unclear")) for ax, v in rules_labels.items()}


def evaluate(sessions, labels_by_id, taxonomy):
    total = sum(s["ledger"]["cost"] for s in sessions)
    per_opt = {ax: defaultdict(lambda: [0, 0.0, 0.0, 0.0]) for ax in taxonomy["axes"]}
    lever_sum, lever_n, bad = Counter(), Counter(), Counter()
    rows = []
    for s in sessions:
        L = labels_by_id.get(s["id"]) or {}
        sv = session_savings(s["ledger"], L)
        for ax in taxonomy["axes"]:
            cell = per_opt[ax][L.get(ax) or "no-answer"]
            cell[0] += 1
            cell[1] += s["ledger"]["cost"]
            cell[2] += sv["combined_floor"]
            cell[3] += sv["combined_ceiling"]
        for k, _, _ in LEVERS:
            lever_sum[k] += sv[k]
        lever_sum["fast_mode_spend"] += sv["fast_mode_spend"]
        for lv in sv["levers"]:
            lever_n[lv] += 1
        for b in incoherent(L):
            bad[b] += 1
        rows.append((s, L, sv))
    return {"total": total, "per_option": {ax: dict(v) for ax, v in per_opt.items()},
            "levers": dict(lever_sum), "lever_sessions": dict(lever_n),
            "incoherent": dict(bad), "rows": rows}


PRIZE = [("capability = mid", "route-mid", {"capability": "mid"}),
         ("capability = small", "route-small", {"capability": "small"}),
         ("context = separable", "context-split", {"context": "separable"}),
         ("deferral = overnight, unattended", "batch",
          {"deferral": "overnight", "latency": "unattended", "urgency": "no-deadline"})]


def prize(sessions):
    out = []
    for label, lever, lab in PRIZE:
        sv = [session_savings(s["ledger"], lab) for s in sessions]
        out.append((label, lever, (sum(x["combined_floor"] for x in sv), sum(x["combined_ceiling"] for x in sv))))
    return out


def agreement(a, b, taxonomy, ids):
    out = {}
    for ax in taxonomy["axes"]:
        both = [(a[i][ax], b[i][ax]) for i in ids if a.get(i) and b.get(i)
                and a[i].get(ax) not in (None, "unclear") and b[i].get(ax) not in (None, "unclear")]
        out[ax] = (sum(x == y for x, y in both) / len(both), len(both)) if both else (None, 0)
    return out


def usd(x):
    return f"-${-x:,.2f}" if x < 0 else f"${x:,.2f}"


def render(results, sessions, taxonomy, ledger_name):
    L = []
    w = L.append
    w("# J3 — session triage: results\n")
    w(f"*Generated {results['generated_at'][:16]}Z by `src/run.py` over `{ledger_name}` — "
      f"{len(sessions)} sessions, {usd(results['total'])} at API list rates.*\n")
    w("Every figure is a headroom estimate from measured tokens under the lever's stated rate "
      "(`src/savings.py`). Nothing here was re-run; the experiment loop is what turns a ceiling "
      "into a measurement.\n")
    w("\n## Size of the prize — every session given the class\n")
    w("The most each class could be worth on this ledger if it were true of every session. "
      "No classifier is involved; this is the ceiling the arms below compete for.\n")
    w("| if every session were… | lever | saving (floor → ceiling) | % of spend |\n|---|---|--:|--:|")
    for label, lever, (lo, hi) in results["prize"]:
        w(f"| {label} | {lever} | {usd(lo)} → {usd(hi)} | {100 * lo / results['total']:.1f}% → {100 * hi / results['total']:.1f}% |")
    for name, r in results["arms"].items():
        ev = r["eval"]
        w(f"\n## Arm `{name}`\n")
        if r.get("outcomes"):
            w("Call outcomes: " + ", ".join(f"{k} {v}" for k, v in r["outcomes"].items()) + "\n")
        w("### Where the money sits, and what each class saves\n")
        w("Saving is the stacked floor → ceiling over the sessions in that class (`src/savings.py`).\n")
        w("| axis | class | sessions | spend | % | saving (floor → ceiling) |\n|---|---|--:|--:|--:|--:|")
        for ax in taxonomy["axes"]:
            for o, (n, c, lo, hi) in sorted(ev["per_option"][ax].items(), key=lambda kv: -kv[1][1]):
                w(f"| {ax} | `{o}` | {n} | {usd(c)} | {100 * c / ev['total']:.0f}% | {usd(lo)} → {usd(hi)} |")
        w("")
        w("### What the classes unlock\n")
        w("| lever | sessions | saving | % of spend | label |\n|---|--:|--:|--:|---|")
        nmap = {"route": ev["lever_sessions"].get("route-mid", 0) + ev["lever_sessions"].get("route-small", 0),
                "context": ev["lever_sessions"].get("context-split", 0),
                "batch_ceiling": ev["lever_sessions"].get("batch", 0),
                "batch_floor": ev["lever_sessions"].get("batch", 0)}
        for k, label, conf in LEVERS:
            v = ev["levers"].get(k, 0.0)
            w(f"| {label} | {nmap.get(k, '')} | {usd(v)} | {100 * v / ev['total']:.1f}% | {conf} |")
        fm = ev["levers"].get("fast_mode_spend", 0.0)
        w(f"\n**Spend, not saving:** {ev['lever_sessions'].get('fast-mode(+)', 0)} sessions are "
          f"`blocking-now` + `interactive` on Opus — fast mode there would add {usd(fm)}. "
          "Classification is also how you decide where paying more is right.\n")
        if ev["incoherent"]:
            w("**Self-contradictions:** " + ", ".join(f"{k} ×{v}" for k, v in ev["incoherent"].items()) + "\n")
        top = sorted(ev["rows"], key=lambda t: -t[0]["ledger"]["cost"])[:10]
        w("\n### Ten most expensive sessions\n")
        w("| session | kind | cost | urgency | latency | deferral | capability | context | levers | saving (floor → ceiling) |")
        w("|---|---|--:|---|---|---|---|---|---|--:|")
        for s, lab, sv in top:
            w(f"| {s['id']} | {s['evidence']['project_kind']} | {usd(sv['cost'])} | "
              + " | ".join(lab.get(ax, "—") for ax in taxonomy["axes"])
              + f" | {', '.join(sv['levers']) or '—'} | {usd(sv['combined_floor'])} → {usd(sv['combined_ceiling'])} |")
    if results.get("agreement"):
        w("\n## Agreement between arms (answered axes only)\n")
        w("| pair | " + " | ".join(taxonomy["axes"]) + " |\n|---|" + "--:|" * len(taxonomy["axes"]))
        for pair, ag in results["agreement"].items():
            w(f"| {pair} | " + " | ".join("—" if v is None else f"{v:.2f} (n={n})" for v, n in ag.values()) + " |")
    return "\n".join(L) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ledger", default=str(REPO / "docs" / "data" / "e1b-sessions.csv"))
    ap.add_argument("--features", default=None, help="extract.py output (C1)")
    ap.add_argument("--taxonomy", default=str(HERE / "taxonomy.json"))
    ap.add_argument("--arms", default="rules", help="comma list: rules,jev")
    ap.add_argument("--out-dir", default=None)
    ap.add_argument("--ctx", default="C0,C1", help="Jev evidence levels to call: C0, C1 or both (one paid call each per session)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--mode", choices=("auto", "interactive"), default="auto",
                    help="auto: classifiers only; interactive: you also label sessions at the terminal")
    ap.add_argument("--limit", type=int, default=20, help="interactive: sessions to ask about this run")
    ap.add_argument("--gold", default=str(HERE / "data" / "private" / "gold.jsonl"),
                    help="human labels, appended as you go (gitignored)")
    a = ap.parse_args()

    taxonomy = json.loads(pathlib.Path(a.taxonomy).read_text())
    sessions = load(a.ledger, a.features)
    have_f = any(s["features"] for s in sessions)
    if a.features:
        print(f"features joined for {sum(1 for s in sessions if s['features'])}/{len(sessions)} sessions")
    # data/RESULTS.md is the committed record of the paid Jev run on the pinned ledger. A rules-only run
    # (free, the README's setup step) goes to data/private/ so it never overwrites that record.
    committed = not a.features and "jev" in a.arms.split(",")
    out_dir = pathlib.Path(a.out_dir or (HERE / "data" / ("" if committed else "private")))
    out_dir.mkdir(parents=True, exist_ok=True)

    if a.dry_run:
        from classifiers.jev import build_request
        s = max(sessions, key=lambda s: s["ledger"]["cost"])
        print(json.dumps(build_request(s["evidence"], s["features"], taxonomy), indent=2))
        return

    results = {"prize": prize(sessions), "generated_at": datetime.now(timezone.utc).isoformat(), "ledger": a.ledger,
               "total": sum(s["ledger"]["cost"] for s in sessions), "arms": {}}
    labels = {}
    for arm in build_arms(taxonomy, set(a.arms.split(",")), have_f, a.ctx.split(",")):
        preds = {s["id"]: arm.classify(s["evidence"], s["features"] if arm.uses_context else None)
                 for s in sessions}
        labels[arm.name] = {k: v.labels for k, v in preds.items()}
        results["arms"][arm.name] = {
            "outcomes": dict(Counter(v.outcome for v in preds.values())) if arm.name.startswith("jev") else None,
            "predictions": {k: {"labels": v.labels, "outcome": v.outcome, "confidence": v.confidence,
                                "probabilities": v.probabilities, "latency_ms": v.latency_ms}
                            for k, v in preds.items()},
        }
    for ctx in ("C0", "C1"):
        if f"jev-{ctx}" in labels and f"rules-{ctx}" in labels:
            labels[f"hybrid-{ctx}"] = {i: hybrid(labels[f"rules-{ctx}"][i], labels[f"jev-{ctx}"][i])
                                       for i in labels[f"rules-{ctx}"]}
            results["arms"][f"hybrid-{ctx}"] = {"outcomes": None, "predictions": None}

    from classifiers.human import HumanLabeller
    human = HumanLabeller(taxonomy, a.gold)
    if a.mode == "interactive":
        if not sys.stdin.isatty():
            sys.exit("--mode interactive needs a terminal; use --mode auto from scripts and the hub")
        suggest = labels.get("hybrid-C1") or labels.get("rules-C1") or labels["rules-C0"]
        hv = human.run(sessions, suggest, a.limit)
    else:
        hv = human.verdicts(sessions)
    if hv:
        labels["human"] = {s["id"]: hv[s["id"]].labels if s["id"] in hv else {} for s in sessions}
        results["arms"]["human"] = {"outcomes": {"labelled": len(hv), "not labelled": len(sessions) - len(hv)},
                                    "predictions": {k: {"labels": v.labels, "outcome": "ok", "confidence": {},
                                                        "probabilities": {}, "latency_ms": 0} for k, v in hv.items()}}

    for name in results["arms"]:
        results["arms"][name]["eval"] = evaluate(sessions, labels[name], taxonomy)
    ids = [s["id"] for s in sessions]
    names = [n for n in labels if not n.startswith("hybrid")]
    if "human" in labels:  # against gold, the derived arms are worth comparing too
        names = [n for n in labels if n != "human"] + ["human"]
    results["agreement"] = {f"{x} vs {y}": agreement(labels[x], labels[y], taxonomy, ids)
                            for i, x in enumerate(names) for y in names[i + 1:]}

    if a.mode == "interactive" or hv:
        out_dir = pathlib.Path(a.out_dir or (HERE / "data" / "private"))  # gold describes your sessions
        out_dir.mkdir(parents=True, exist_ok=True)
    md = render(results, sessions, taxonomy, pathlib.Path(a.ledger).name)
    (out_dir / "RESULTS.md").write_text(md)
    for r in results["arms"].values():
        r["eval"]["rows"] = [{"id": s["id"], "labels": lab, "savings": sv} for s, lab, sv in r["eval"]["rows"]]
    (out_dir / "results.json").write_text(json.dumps(results, indent=2))

    print(f"{'arm':10s} {'route':>9s} {'context':>9s} {'batch floor→ceil':>22s} {'combined floor→ceil':>24s} {'fast+':>9s}")
    for name, r in results["arms"].items():
        lv = r["eval"]["levers"]
        print(f"{name:10s} {usd(lv['route']):>9s} {usd(lv['context']):>9s} "
              f"{usd(lv['batch_floor']) + ' → ' + usd(lv['batch_ceiling']):>22s} "
              f"{usd(lv['combined_floor']) + ' → ' + usd(lv['combined_ceiling']):>24s} {usd(lv['fast_mode_spend']):>9s}")
    print(f"\nof {usd(results['total'])} total · wrote {out_dir / 'RESULTS.md'}")


if __name__ == "__main__":
    main()
