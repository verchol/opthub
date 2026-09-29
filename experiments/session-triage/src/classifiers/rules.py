"""Deterministic baseline. Free, offline, and it abstains ('unclear') whenever the
evidence does not decide an axis.

Its job is the same as J2's rules arm: no model gets credit for what the entry point
already says. On this ledger the entry point settles a lot — 186 of 214 sessions were
launched by the SDK — but those 186 cost $7.50 between them. The $501 is in 28
interactive sessions, where metadata-only rules have nothing to say about urgency or
deferral. That gap is what a classifier is for.
"""

import time
from .base import Classifier, Verdict

U = "unclear"


class RulesClassifier(Classifier):
    def __init__(self, with_context: bool):
        self.uses_context = with_context
        self.name = f"rules-{'C1' if with_context else 'C0'}"

    def classify(self, e, f):
        t0 = time.perf_counter()
        headless = e["entry_point"].startswith("SDK")
        reqs, ctx = e["requests"], e["context_tokens_median"]
        L = {"urgency": U, "latency": U, "deferral": U, "capability": U, "context": U}

        L["latency"] = "unattended" if headless else "interactive"
        if headless:
            L["deferral"] = "within-hours"
        if reqs <= 15:
            L["context"] = "short"
        elif ctx >= 150_000 and reqs >= 200:
            L["context"] = "continuous"
        if ctx >= 150_000 or e["thinking_share_of_output"] >= 0.3:
            L["capability"] = "frontier"
        elif headless and reqs <= 5 and ctx < 40_000:
            L["capability"] = "small"

        if f:
            flags = f["prompt_flags"]
            gap = f["reply_gap_median_s"]
            if not headless and gap is not None:
                L["latency"] = "interactive" if gap <= 180 else "checks-in"
            if flags["mentions_prod_or_incident"]:
                L["urgency"] = "blocking-now"
            elif flags["mentions_deadline"] or flags["mentions_demo_or_meeting"]:
                L["urgency"] = "same-day"
            elif flags["mentions_background_or_later"] or flags["mentions_research_or_explore"]:
                L["urgency"] = "no-deadline"
            if L["urgency"] == "blocking-now" or L["latency"] == "interactive":
                L["deferral"] = "run-now"
            elif L["urgency"] == "no-deadline" and L["latency"] != "interactive":
                L["deferral"] = "overnight"
            if L["context"] == U and f["topic_breaks"] >= 2:
                L["context"] = "separable"

        return Verdict(labels=L, latency_ms=int((time.perf_counter() - t0) * 1000))
