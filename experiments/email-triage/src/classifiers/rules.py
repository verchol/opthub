"""Deterministic baseline. Free, offline, and on this inbox very hard to beat.

It exists so that no model is credited for the ~85% of mail that a sender-domain
check already handles. A model earns its keep only where this abstains.
"""

import time
from .base import Classifier, Verdict

BULK_DOMAINS = ("substack.com", "medium.com", "redditmail.com", "duolingo.com",
                "aliexpress.com", "ccsend.com", "ghost.io", "deeplearning.ai")
BULK_LOCAL = ("noreply", "no-reply", "newsletter", "subscriptions", "updates", "marketing", "info")
TXN_HINTS = ("invoice", "receipt", "payment", "statement", "billing")
SEC_HINTS = ("verification code", "sign-in", "login", "password", "security alert", "2fa")
CAL_HINTS = ("invitation:", "accepted:", "declined:", "has been scheduled", "google meet")


class RulesClassifier(Classifier):
    name = "rules"
    uses_context = True

    def classify(self, r, f):
        t0 = time.perf_counter()
        subj = (r.get("subject") or "").lower()
        dom = r.get("sender_domain", "")
        labels = {}

        if any(h in subj for h in SEC_HINTS) or r.get("sender_local_class") == "security":
            labels = {"lane": "unclear", "relation": "automated-transactional", "action": "security", "topic": "other"}
        elif any(h in subj for h in CAL_HINTS):
            labels = {"lane": "work", "relation": "automated-transactional", "action": "schedule", "topic": "other"}
        elif any(h in subj for h in TXN_HINTS) or r.get("sender_local_class") == "billing":
            labels = {"lane": "work", "relation": "automated-transactional", "action": "pay-or-sign", "topic": "finance-admin"}
        elif (any(d in dom for d in BULK_DOMAINS)
              or r.get("sender_local_class") in ("noreply", "marketing")
              or (f and f.get("looks_bulk_by_domain"))):
            labels = {"lane": "work", "relation": "automated-bulk", "action": "read-later", "topic": "other"}
        elif f and f.get("i_ever_replied_to_sender") and f.get("addressed_directly"):
            labels = {"lane": "work", "relation": "known-human", "action": "reply", "topic": "other"}

        dt = int((time.perf_counter() - t0) * 1000)
        if not labels:
            return Verdict(labels={}, outcome="abstain", latency_ms=dt)
        return Verdict(labels=labels, confidence={k: 1.0 for k in labels}, latency_ms=dt)
