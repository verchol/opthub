"""Scoring. Macro-F1 per axis, never plain accuracy.

This inbox is ~85% bulk mail. A classifier that answers 'archive'/'automated-bulk'
every time scores ~0.85 accuracy and is worthless, so accuracy is reported only to
show how misleading it is. The number that decides anything is recall on the
action-critical classes: a missed invoice or a missed reply costs real money, a
newsletter filed wrongly costs nothing.
"""

from collections import defaultdict


def _prf(tp, fp, fn):
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    f = 2 * p * r / (p + r) if p + r else 0.0
    return p, r, f


def score_axis(pairs: list[tuple[str, str]]) -> dict:
    """pairs of (gold, pred); pred '' means abstain."""
    classes = sorted({g for g, _ in pairs} | {p for _, p in pairs if p})
    tp, fp, fn = defaultdict(int), defaultdict(int), defaultdict(int)
    abstained = 0
    for g, p in pairs:
        if not p:
            abstained += 1
            fn[g] += 1
            continue
        if g == p:
            tp[g] += 1
        else:
            fp[p] += 1
            fn[g] += 1
    per = {c: dict(zip(("precision", "recall", "f1"), _prf(tp[c], fp[c], fn[c])), support=sum(1 for g, _ in pairs if g == c)) for c in classes}
    answered = [(g, p) for g, p in pairs if p]
    return {
        "per_class": per,
        "macro_f1": sum(v["f1"] for v in per.values()) / len(per) if per else 0.0,
        "accuracy_misleading": sum(1 for g, p in pairs if g == p) / len(pairs) if pairs else 0.0,
        "accuracy_when_answered": sum(1 for g, p in answered if g == p) / len(answered) if answered else 0.0,
        "abstain_rate": abstained / len(pairs) if pairs else 0.0,
        "n": len(pairs),
    }


def score_run(gold: dict, preds: dict, taxonomy: dict) -> dict:
    """gold: id -> {axis: label}; preds: id -> Verdict"""
    out = {"axes": {}, "outcomes": defaultdict(int)}
    for v in preds.values():
        out["outcomes"][v.outcome] += 1
    for axis in taxonomy["axes"]:
        pairs = [(gold[i][axis], preds[i].labels.get(axis, "")) for i in gold if i in preds and axis in gold[i]]
        out["axes"][axis] = score_axis(pairs)

    crit = set(taxonomy["action_critical"])
    ids = [i for i in gold if i in preds and gold[i].get("action") in crit]
    hit = sum(1 for i in ids if preds[i].labels.get("action") == gold[i]["action"])
    out["action_critical_recall"] = hit / len(ids) if ids else None
    out["action_critical_n"] = len(ids)

    lat = sorted(v.latency_ms for v in preds.values() if v.outcome == "ok")
    out["latency_ms_p50"] = lat[len(lat) // 2] if lat else None
    out["latency_ms_p95"] = lat[int(len(lat) * 0.95)] if lat else None
    out["cost_usd_total"] = round(sum(v.cost_usd for v in preds.values()), 6)
    out["cost_usd_per_1k"] = round(out["cost_usd_total"] / len(preds) * 1000, 4) if preds else 0.0
    out["outcomes"] = dict(out["outcomes"])
    return out
