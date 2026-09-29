"""From class labels to dollars. Each class unlocks at most one lever; the lever's rate
is a published price or a stated assumption, and every figure carries its label
(the same `priced` / `guess` labels as config/optimizations.json).

  lever            unlocked by                                   rate                        label
  route-mid        capability = mid                              Sonnet 5 list vs current    priced
  route-small      capability = small (ctx_max <= 200k, else mid) Haiku 4.5 list vs current  priced
  context-split    context = separable                           25% of cache read+write $   guess  (= savings.py lever A)
  batch            deferral in {within-hours, overnight}
                   AND latency in {checks-in, unattended}
                   AND urgency != blocking-now                   -50% (Batch API)            priced ceiling / guess floor
  fast-mode        urgency = blocking-now AND latency = interactive
                   AND on Opus                                   +100% ($10/$50 vs $5/$25)   priced — SPEND, never netted

Two things the batch row must not hide:
  * Batch requests are single-shot: no tool loop inside a batch. An agent session only
    batches if its loop is flattened or each turn waits for its batch. That is an
    architecture change, which is why deferral also requires nobody to be waiting.
  * Cache hits inside a batch are best-effort. This workload's measured hit rate is
    96.8% (E1-F4), so the floor reprices cache reads at the full input rate. On
    cache-heavy sessions the floor goes NEGATIVE — batching would cost more. The
    report prints both ends, never the midpoint.

Stacking (the `combined` figure): route first (it scales every token), then
context-split on the routed cache $, then batch on what is left. Levers that pick
up the same dollar are not double-counted.

Cost share per model is apportioned by request count. The ledger does not split
dollars by model, and 211 of 214 sessions ran on a single model, so this matters for
three rows.
"""

PRICE_INDEX = {"claude-opus-5-5": 4.0, "claude-fable-5": 10.0, "claude-fable-5-1": 10.0, "claude-opus-5": 5.0, "claude-opus-4-8": 5.0, "claude-sonnet-5": 2.0,
               "claude-haiku-4-5-20251001": 1.0, "claude-haiku-4-5": 1.0}
MID, SMALL = 2.0, 1.0
HAIKU_CTX = 200_000
TRIM = 0.25
BATCH = 0.5
CACHE_READ_MULT = 10  # read is 0.1x input; losing the hit bills it at 1x


def current_index(models: dict) -> float:
    n = sum(models.values()) or 1
    return sum(PRICE_INDEX.get(m, 5.0) * k for m, k in models.items()) / n


def is_opus(models: dict) -> bool:
    return max(models, key=models.get, default="").startswith("claude-opus")


def session_savings(ledger: dict, labels: dict) -> dict:
    C, R, W = ledger["cost"], ledger["read"], ledger["write"]
    cur = current_index(ledger["models"])
    out = {"cost": C, "route": 0.0, "context": 0.0, "batch_ceiling": 0.0, "batch_floor": 0.0,
           "fast_mode_spend": 0.0, "levers": []}

    cap = labels.get("capability")
    target = None
    if cap == "small":
        target = SMALL if ledger["ctx_max"] <= HAIKU_CTX else MID
    elif cap == "mid":
        target = MID
    ratio = min(1.0, target / cur) if target else 1.0
    if ratio < 1.0:
        out["route"] = C * (1 - ratio)
        out["levers"].append("route-small" if target == SMALL else "route-mid")
    C1, R1, W1 = C * ratio, R * ratio, W * ratio

    if labels.get("context") == "separable":
        out["context"] = TRIM * (R1 + W1)
        out["levers"].append("context-split")
    C2 = C1 - out["context"]
    R2 = R1 * (1 - TRIM) if out["context"] else R1

    if (labels.get("deferral") in ("within-hours", "overnight")
            and labels.get("latency") in ("checks-in", "unattended")
            and labels.get("urgency") != "blocking-now"):
        out["batch_ceiling"] = BATCH * C2
        out["batch_floor"] = C2 - BATCH * (C2 + (CACHE_READ_MULT - 1) * R2)
        out["levers"].append("batch")

    if (labels.get("urgency") == "blocking-now" and labels.get("latency") == "interactive"
            and is_opus(ledger["models"])):
        out["fast_mode_spend"] = C
        out["levers"].append("fast-mode(+)")

    out["combined_ceiling"] = out["route"] + out["context"] + out["batch_ceiling"]
    out["combined_floor"] = out["route"] + out["context"] + out["batch_floor"]
    return out


def incoherent(labels: dict) -> list[str]:
    """Answers that contradict each other. Counted, not corrected: a classifier that says
    'blocking-now' and 'overnight' for one session is telling you something about itself."""
    bad = []
    if labels.get("urgency") == "blocking-now" and labels.get("deferral") in ("within-hours", "overnight"):
        bad.append("blocking-now but deferrable")
    if labels.get("latency") == "interactive" and labels.get("deferral") == "overnight":
        bad.append("interactive but overnight")
    if labels.get("capability") == "small" and labels.get("context") == "continuous":
        bad.append("small model but long continuous context")
    return bad
