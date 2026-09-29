#!/usr/bin/env python3
"""Write the classification the Optimization Hub shows under Triage.

    python3 src/export_hub.py                                  # -> ~/workspace/sandbox/e2b/results/triage.json
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
from savings import session_savings          # noqa: E402

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
    default_out = pathlib.Path(os.environ.get("OPT_HOME") or pathlib.Path.home() / "workspace/sandbox/e2b") / "results" / "triage.json"
    ap.add_argument("--out", default=str(default_out))
    ap.add_argument("--arm", default="jev-C1")
    a = ap.parse_args()

    results = json.loads((PRIV / "results.json").read_text())
    preds = results["arms"][a.arm]["predictions"]
    tasks = {}
    if (PRIV / "tasks.jsonl").exists():
        for line in (PRIV / "tasks.jsonl").read_text().splitlines():
            if line.strip():
                row = json.loads(line)
                tasks[row["key"]] = row["tasks"]
                if row.get("session_id"):
                    tasks[row["session_id"]] = row["tasks"]

    out = []
    for s in load(PRIV / "ledger.csv", PRIV / "features.jsonl"):
        p = preds.get(s["id"], {})
        labels = p.get("labels") or {}
        sv = session_savings(s["ledger"], labels)
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
            "best": round(sv["combined_ceiling"], 4), "worst": round(sv["combined_floor"], 4),
            "levers": sv["levers"], "fastModeSpend": round(sv["fast_mode_spend"], 4),
            "signals": (s["features"] or {}).get("work_signals"),
            "tasks": (tasks.get(s["session_id"]) or tasks.get(s["key"])) if labels.get("context") == "separable" else None,
            "rerun": escalation(labels, p.get("outcome", "missing")),
        })
    doc = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "classifier": {"arm": a.arm, "model": "jev-1.13.0"},
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
