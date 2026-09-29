#!/usr/bin/env python3
"""Run every arm over the corpus and write results.json.

Arms are named for what they vary, never for what they are hoped to prove. An arm
that varies nothing against another arm is reported as 'no change'.
"""

import argparse
import json
import pathlib
import sys
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from redact import redact_record                      # noqa: E402
from features import build_sender_index, features_for  # noqa: E402
from score import score_run                            # noqa: E402
from classifiers.rules import RulesClassifier          # noqa: E402

HERE = pathlib.Path(__file__).resolve().parents[1]


def load_corpus(path):
    raws, gold = [], {}
    for line in pathlib.Path(path).read_text().splitlines():
        if not line.strip():
            continue
        rec = json.loads(line)
        raws.append(rec)
        if rec.get("gold"):
            gold[rec["id"]] = rec["gold"]
    return raws, gold


def build_arms(taxonomy, which):
    arms = [RulesClassifier()]
    if "jev" in which:
        from classifiers.jev import JevClassifier
        arms += [JevClassifier(taxonomy, with_context=False),
                 JevClassifier(taxonomy, with_context=True)]
    if "llm" in which:
        from classifiers.llm import LangChainClassifier
        arms += [LangChainClassifier(taxonomy, with_context=False),
                 LangChainClassifier(taxonomy, with_context=True)]
    if "local" in which:
        from classifiers.llm import LangChainClassifier
        arms.append(LangChainClassifier(taxonomy, True, model="qwen3:8b", provider="ollama"))
    return arms


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", default=str(HERE / "data" / "seed-synthetic.jsonl"))
    ap.add_argument("--taxonomy", default=str(HERE / "taxonomy.json"))
    ap.add_argument("--arms", default="rules", help="comma list: rules,jev,llm,local")
    ap.add_argument("--out", default=str(HERE / "data" / "results.json"))
    ap.add_argument("--dry-run", action="store_true", help="print the payload for one email and stop")
    a = ap.parse_args()

    taxonomy = json.loads(pathlib.Path(a.taxonomy).read_text())
    raws, gold = load_corpus(a.corpus)
    me = {"oleg@canarian.io"}
    idx = build_sender_index(raws, me)

    prepared = [(redact_record(r), features_for(r, idx, me)) for r in raws]

    if a.dry_run:
        from classifiers.jev import build_request
        r, f = prepared[0]
        print(json.dumps(build_request(r, f, taxonomy), indent=2, ensure_ascii=False))
        return

    which = set(a.arms.split(","))
    results = {"generated_at": datetime.now(timezone.utc).isoformat(), "n_corpus": len(raws),
               "n_gold": len(gold), "arms": {}}

    for arm in build_arms(taxonomy, which):
        preds = {}
        for r, f in prepared:
            preds[r["id"]] = arm.classify(r, f if arm.uses_context else None)
        results["arms"][arm.name] = {
            "uses_context": arm.uses_context,
            "scores": score_run(gold, preds, taxonomy) if gold else None,
            "predictions": {k: {"labels": v.labels, "outcome": v.outcome,
                                "confidence": v.confidence, "latency_ms": v.latency_ms}
                            for k, v in preds.items()},
        }
        s = results["arms"][arm.name]["scores"]
        if s:
            print(f"{arm.name:16s} macro-F1(action)={s['axes']['action']['macro_f1']:.3f} "
                  f"critical-recall={s['action_critical_recall']} "
                  f"abstain={s['axes']['action']['abstain_rate']:.2f} "
                  f"p50={s['latency_ms_p50']}ms ${s['cost_usd_per_1k']}/1k")

    pathlib.Path(a.out).write_text(json.dumps(results, indent=2, ensure_ascii=False))
    print(f"\nwrote {a.out}")


if __name__ == "__main__":
    main()
