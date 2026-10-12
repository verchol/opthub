"""Per-method relevance scores and savings — what the Hub's Triage page shows per session.

Each optimization method asks Jev (or rules) one question about the session, answers
with a *score*, and prices what the method would save on that session's own tokens.

  score      probability mass Jev put on the options that unlock the method, 0..1.
             Batch and fast mode need several answers at once, so their score is the
             product of the marginals (independence assumed — stated, not measured).
             Rules give 1 or 0. Runs without stored probabilities (before 2026-10-13)
             fall back to the confidence of the chosen option. A score is how strongly
             the evidence points at the method, never whether the method works: only
             a sandbox re-run says that (SPEC §6.1.1 — confidence never gates).
  unlocked   the chosen option unlocks the method. Only unlocked methods stack into
             the best/worst totals, exactly like savings.py.
  saving     marginal, in applied order (SPEC R1): route -> side-calls -> context ->
             effort -> batch. Each one is priced on what the methods before it left,
             with the earlier ones applied only where unlocked. Never add up the
             per-method `saving` of methods that are not unlocked as if they stacked.
  expected   score x saving. A ranking aid for "what to try first", not a forecast.

  method       question (axis)  unlocking options        rate                                   label
  route        capability       mid, small               Sonnet 5 / Haiku 4.5 list vs current   priced
  side-calls   delegation       small-enough             subagent request share -> Haiku list   priced (share apportioned by requests)
  context      context          separable; continuous    25% of cache read + write $            guess  (= tools/savings.py lever A)
                                when median ctx >= 150k
  effort       reasoning        moderate, light          50% of thinking $, only if effort high guess  (= tools/savings.py lever B)
  batch        deferral+latency within-hours/overnight   -50% ceiling; cache reads at 1x floor  priced ceiling / guess floor
               +urgency         x checks-in/unattended x not blocking-now
  fast-mode    urgency+latency  blocking-now x interactive, on Opus  +100%                  priced — SPEND, never netted
"""

from savings import BATCH, CACHE_READ_MULT, HAIKU_CTX, MID, SMALL, TRIM, current_index, is_opus

EFFORT_CUT = 0.50          # tools/savings.py lever B
LONG_CTX = 150_000         # median context above which a continuous session is a compaction candidate

METHODS = [  # id, title, axis, Claude Code knob, sandbox catalog id, label
    ("route", "Model routing", "capability", "--model sonnet | haiku", "route-cheaper-frontier", "priced"),
    ("side-calls", "Subagents on a small model", "delegation", "CLAUDE_CODE_SUBAGENT_MODEL=haiku", "litellm-route-side-calls", "priced"),
    ("context", "Context compaction / split", "context", "--autocompact <tokens> · /clear between tasks", "context-compaction", "guess"),
    ("effort", "Lower reasoning effort", "reasoning", "--effort medium", "effort-medium", "guess"),
    ("batch", "Defer to batch", "deferral", "claude -p headless + Batch API", None, "priced ceiling · guess floor"),
    ("fast-mode", "Fast mode (spend)", "urgency", "/fast", None, "priced — spend"),
]


def _p(axis, opts, labels, probs, conf):
    """Probability mass on `opts` for one axis, or None when nothing was answered."""
    P = (probs or {}).get(axis)
    if P:
        return round(sum(P.get(o, 0.0) for o in opts), 3)
    lab = (labels or {}).get(axis)
    if lab in (None, "unclear"):
        return None
    if lab in opts:
        return round(float((conf or {}).get(axis, 1.0)), 3)
    return 0.0


def _mul(*xs):
    if any(x is None for x in xs):
        return None
    out = 1.0
    for x in xs:
        out *= x
    return round(out, 3)


def session_methods(ledger, labels, probs=None, conf=None, cc=None, subagent_share=None, ctx_median=0):
    """One row per method for one session; see the module docstring for every term."""
    L, cc = labels or {}, cc or {}
    C, R, W, T = ledger["cost"], ledger["read"], ledger["write"], ledger["think"]
    cur = current_index(ledger["models"])
    rows = []

    def row(mid, score, unlocked, saving, note, floor=None):
        m = next(x for x in METHODS if x[0] == mid)
        rows.append({"id": mid, "title": m[1], "axis": m[2], "knob": m[3], "catalog": m[4], "label": m[5],
                     "score": score, "unlocked": bool(unlocked), "saving": round(saving, 4),
                     "savingFloor": None if floor is None else round(floor, 4),
                     "pct": round(100 * saving / C, 1) if C else 0.0,
                     "expected": None if score is None else round(score * saving, 4), "note": note})

    # 1. route — the model for the whole session
    cap = L.get("capability")
    Pc = (probs or {}).get("capability") or {}
    want_small = cap == "small" or (cap != "mid" and Pc.get("small", 0) > Pc.get("mid", 0))
    target = SMALL if want_small and ledger["ctx_max"] <= HAIKU_CTX else MID
    ratio = min(1.0, target / cur)
    route = C * (1 - ratio)
    tier = "Haiku" if target == SMALL else "Sonnet"
    unl = cap in ("mid", "small") and ratio < 1.0
    row("route", _p("capability", ("mid", "small"), L, probs, conf), unl, route,
        f"to {tier}" + (" — context over 200k rules out Haiku" if want_small and target == MID else "")
        + ("" if ratio < 1 else " — already on it or cheaper"))
    k = ratio if unl else 1.0
    C1, R1, W1, T1, cur1 = C * k, R * k, W * k, T * k, (target if unl else cur)

    # 2. side-calls — the subagent share of requests, on Haiku
    sa = subagent_share if subagent_share is not None else cc.get("subagent_request_share")
    side = C1 * (sa or 0) * max(0.0, 1 - SMALL / cur1)
    score = _p("delegation", ("small-enough",), L, probs, conf) if sa else 0.0
    row("side-calls", score, L.get("delegation") == "small-enough" and side > 0, side,
        "no subagent requests" if not sa else f"{round(100 * sa)}% of requests were subagents")
    f = (1 - side / C1) if (rows[-1]["unlocked"] and C1) else 1.0
    C2, R2, W2, T2 = C1 * f, R1 * f, W1 * f, T1 * f

    # 3. context — split separable sessions, compact long continuous ones
    long_ctx = ctx_median >= LONG_CTX
    opts = ("separable", "continuous") if long_ctx else ("separable",)
    ctx = TRIM * (R2 + W2)
    ctxl = L.get("context")
    how = ("split: /clear between tasks" if ctxl == "separable" else
           "compact: --autocompact earlier" if ctxl == "continuous" and long_ctx else
           "split or compact" if long_ctx else "split only — context stays short")
    done = cc.get("compactions") or 0
    row("context", _p("context", opts, L, probs, conf), ctxl in opts, ctx,
        how + (f" · compacted {done}× already" if done else ""))
    C3 = C2 - ctx if rows[-1]["unlocked"] else C2
    R3 = R2 * (1 - TRIM) if rows[-1]["unlocked"] else R2

    # 4. effort — fewer thinking tokens; nothing to take if the session already ran at medium or below
    hi = cc.get("effort_high_share")
    eff = EFFORT_CUT * T2 * (C3 / C2 if C2 else 1) if (hi is None or hi >= 0.5) else 0.0
    row("effort", _p("reasoning", ("moderate", "light"), L, probs, conf) if eff else 0.0,
        L.get("reasoning") in ("moderate", "light") and eff > 0, eff,
        "effort not recorded" if hi is None else f"ran at {cc.get('effort')} effort" + ("" if eff else " — nothing to lower"))
    C4 = C3 - eff if rows[-1]["unlocked"] else C3

    # 5. batch — needs three answers at once; the floor is what losing the cache costs
    s = _mul(_p("deferral", ("within-hours", "overnight"), L, probs, conf),
             _p("latency", ("checks-in", "unattended"), L, probs, conf),
             None if _p("urgency", ("blocking-now",), L, probs, conf) is None
             else 1 - _p("urgency", ("blocking-now",), L, probs, conf))
    unl = (L.get("deferral") in ("within-hours", "overnight") and L.get("latency") in ("checks-in", "unattended")
           and L.get("urgency") != "blocking-now")
    ceil = BATCH * C4
    floor = C4 - BATCH * (C4 + (CACHE_READ_MULT - 1) * R3)
    row("batch", s, unl, ceil, f"cache reads are {round(100 * R / C) if C else 0}% of cost — floor {'loses' if floor < 0 else 'keeps'} money",
        floor=floor)

    # 6. fast mode — spend, reported beside the savings and never netted
    opus = is_opus(ledger["models"])
    s = _mul(_p("urgency", ("blocking-now",), L, probs, conf), _p("latency", ("interactive",), L, probs, conf))
    row("fast-mode", s if opus else 0.0, opus and L.get("urgency") == "blocking-now" and L.get("latency") == "interactive",
        -C if opus else 0.0, "doubles the price for faster replies" if opus else "not on Opus")

    sv = [r for r in rows if r["id"] != "fast-mode"]
    best = sum(r["saving"] for r in sv if r["unlocked"])
    worst = best - (rows[4]["saving"] - rows[4]["savingFloor"] if rows[4]["unlocked"] else 0)
    return {"methods": rows, "best": round(best, 4), "worst": round(worst, 4),
            "expected": round(sum(r["expected"] or 0 for r in sv), 4),
            "fastModeSpend": round(C, 4) if rows[5]["unlocked"] else 0.0}
