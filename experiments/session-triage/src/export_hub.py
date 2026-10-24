#!/usr/bin/env python3
"""Write the classification the Optimization Hub shows under Triage.

    python3 src/export_hub.py                                  # -> app/results/triage.json (or $OPT_HOME/results/)
    python3 src/export_hub.py --out $OPT_HOME/results/triage.json

Reads the live run (data/private/: ledger, features, tasks, results.json) and writes one
record per Claude session, keyed by its session id, which is the id the hub already uses.
The hub's results/ directory is gitignored: task titles are prompt text.

The escalation rule lives here, in one place:

  Jev answers the model question  ->  the answer prices the route lever, as before.
  Jev answers `unclear`           ->  no route saving is counted, and the session is queued
                                      for a re-run on Sonnet in the sandbox
                                      (catalog `route-cheaper-frontier`: baseline vs Sonnet,
                                      blind-judged). The re-run is the answer, not an input:
                                      nothing from it is fed back to Jev as a signal.
"""

import argparse
import json
import os
import pathlib
import sys
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from evidence import load                    # noqa: E402
from methods import METHODS, session_methods  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parents[1]
PRIV = HERE / "data" / "private"
RERUN_EXPERIMENT = "route-cheaper-frontier"


def escalation(labels: dict, verdict_outcome: str) -> dict:
    """Why a session needs the sandbox to answer, or None."""
    if verdict_outcome != "ok":
        return {"needed": True, "experiment": RERUN_EXPERIMENT,
                "reason": f"Jev gave no usable answer ({verdict_outcome})"}
    if labels.get("capability", "unclear") == "unclear":
        return {"needed": True, "experiment": RERUN_EXPERIMENT,
                "reason": "Jev could not tell which model the work needed"}
    return {"needed": False, "experiment": None, "reason": f"Jev answered: {labels['capability']}"}


def main():
    ap = argparse.ArgumentParser()
    default_out = pathlib.Path(os.environ.get("OPT_HOME") or HERE.parents[1] / "app") / "results" / "triage.json"
    ap.add_argument("--out", default=str(default_out))
    ap.add_argument("--arm", default="jev-C1")
    ap.add_argument("--dir", default=str(PRIV), help="where ledger.csv, features.jsonl, tasks.jsonl, results.json are")
    a = ap.parse_args()
    PRIV_ = pathlib.Path(a.dir)

    results = json.loads((PRIV_ / "results.json").read_text())
    # Jev's arm when it ran; otherwise the rules arm, and the page says so
    arm = next(x for x in (a.arm, "rules-C1", "rules-C0") if (results["arms"].get(x) or {}).get("predictions"))
    preds = results["arms"][arm]["predictions"]
    tasks = {}
    if (PRIV_ / "tasks.jsonl").exists():
        for line in (PRIV_ / "tasks.jsonl").read_text().splitlines():
            if line.strip():
                row = json.loads(line)
                tasks[row["key"]] = row["tasks"]
                if row.get("session_id"):
                    tasks[row["session_id"]] = row["tasks"]

    out = []
    for s in load(PRIV_ / "ledger.csv", PRIV_ / "features.jsonl"):
        p = preds.get(s["id"], {})
        labels = p.get("labels") or {}
        F = s["features"] or {}
        cc = F.get("claude_code")
        sv = session_methods(s["ledger"], labels, p.get("probabilities"), p.get("confidence"), cc,
                             F.get("subagent_request_share"), s["evidence"]["context_tokens_median"])
        L = s["ledger"]
        out.append({
            "session": s["session_id"], "key": s["key"],
            "project": "/".join(L["cwd"].rstrip("/").split("/")[-2:]),
            "kind": s["evidence"]["project_kind"], "entry": s["evidence"]["entry_point"],
            "started": s["evidence"]["started_local"], "requests": s["evidence"]["requests"],
            "ctxMedian": s["evidence"]["context_tokens_median"], "ctxMax": L["ctx_max"],
            "cost": round(L["cost"], 4), "cacheRead": round(L["read"], 4),
            "model": max(L["models"], key=L["models"].get).replace("claude-", "").replace("-20251001", ""),
            "labels": labels, "confidence": p.get("confidence") or {},
            "probabilities": p.get("probabilities") or {}, "outcome": p.get("outcome"),
            "best": sv["best"], "worst": sv["worst"], "expected": sv["expected"],
            "levers": [m["id"] for m in sv["methods"] if m["unlocked"] and m["id"] != "fast-mode"],
            "methods": sv["methods"], "fastModeSpend": sv["fastModeSpend"],
            "claudeCode": cc,
            "signals": F.get("work_signals"),
            # exactly what the classifier was shown: counts and enums, no path, prompt or cost
            "sentToJev": {"coding_session": s["evidence"],
                          **({"session_activity": F} if arm.endswith("C1") and F else {})},
            "tasks": (tasks.get(s["session_id"]) or tasks.get(s["key"])) if labels.get("context") == "separable" else None,
            "rerun": escalation(labels, p.get("outcome", "missing")),
        })
    doc = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "classifier": {"arm": arm, "model": "jev-1.13.0" if arm.startswith("jev") else "rules (no model)",
                       "jevRequested": a.arm, "outcomes": results["arms"][arm].get("outcomes")},
        "methods": [{"id": m[0], "title": m[1], "axis": m[2], "knob": m[3], "catalog": m[4], "label": m[5]} for m in METHODS],
        "total": round(sum(x["cost"] for x in out), 2),
        "rerunExperiment": RERUN_EXPERIMENT,
        "sessions": out,
    }
    dest = pathlib.Path(a.out)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(doc, indent=1))
    need = sum(1 for x in out if x["rerun"]["needed"])
    print(f"wrote {dest} — {len(out)} sessions, {need} queued for a re-run on Sonnet "
          f"({sum(1 for x in out if not x['session'])} without a session id)")


if __name__ == "__main__":
    main()
