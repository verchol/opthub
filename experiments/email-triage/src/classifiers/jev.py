"""TypeSafe Jev adapter — the Choice primitive, one request, four questions.

Strict validation modelled on alexei-led/pi-model-router extensions/jev.ts:
only a supplied option id is ever accepted, probabilities must cover exactly the
option set and sum to 1, and nothing from the response is persisted except the
validated choice and numeric diagnostics. No retry. Failure means abstain, never a
second advisor.
"""

import json
import os
import time
import urllib.request
import urllib.error
from .base import Classifier, Verdict

ENDPOINT = os.environ.get("JEV_ENDPOINT", "https://api.typesafe.ai/v1/systemone")
MODEL = os.environ.get("JEV_MODEL", "jev-1.13.0")
TIMEOUT_S = float(os.environ.get("JEV_TIMEOUT_MS", "1500")) / 1000
MAX_BYTES = 65536


def build_request(redacted: dict, features: dict | None, taxonomy: dict) -> dict:
    """The exact payload. `features` is None for the context-free arm."""
    state = {"email": redacted}
    if features is not None:
        state["sender_context"] = features
        state["context_note"] = (
            "sender_context is computed locally from this mailbox's own metadata. "
            "It describes the correspondence history, not the message text."
        )
    questions = {}
    for axis, spec in taxonomy["axes"].items():
        questions[axis] = {
            "type": "choice",
            "instructions": spec["question"] + " Choose exactly one option. Choose the option whose description fits the evidence, not the one that sounds most important.",
            "criteria": dict(spec["options"]),
        }
    return {"model": MODEL, "state": state, "questions": questions}


def _valid(answer: dict, allowed: set[str]) -> bool:
    if not isinstance(answer, dict) or answer.get("type") != "choice":
        return False
    if answer.get("choice") not in allowed:
        return False
    probs = answer.get("probabilities")
    if not isinstance(probs, dict) or set(probs) != allowed:
        return False
    vals = list(probs.values())
    if not all(isinstance(v, (int, float)) and 0 <= v <= 1 for v in vals):
        return False
    if abs(sum(vals) - 1) > 0.01:
        return False
    conf = answer.get("confidence")
    return isinstance(conf, (int, float)) and 0 <= conf <= 1


class JevClassifier(Classifier):
    def __init__(self, taxonomy: dict, with_context: bool, api_key: str | None = None):
        self.taxonomy = taxonomy
        self.uses_context = with_context
        self.name = f"jev-{'C1' if with_context else 'C0'}"
        self.api_key = api_key or os.environ.get("JEV_API_KEY", "")

    def classify(self, r, f):
        payload = build_request(r, f if self.uses_context else None, self.taxonomy)
        body = json.dumps(payload).encode()
        req = urllib.request.Request(
            ENDPOINT, data=body,
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
        )
        t0 = time.perf_counter()
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
                raw = json.loads(resp.read(MAX_BYTES))
        except urllib.error.HTTPError as e:
            return Verdict(labels={}, outcome=f"http-{e.code}", latency_ms=int((time.perf_counter() - t0) * 1000))
        except Exception:
            return Verdict(labels={}, outcome="unavailable", latency_ms=int((time.perf_counter() - t0) * 1000))
        dt = int((time.perf_counter() - t0) * 1000)

        answers = raw.get("answers")
        if not isinstance(answers, dict):
            return Verdict(labels={}, outcome="invalid", latency_ms=dt)
        labels, conf, probs = {}, {}, {}
        for axis, spec in self.taxonomy["axes"].items():
            allowed = set(spec["options"])
            a = answers.get(axis)
            if not _valid(a, allowed):
                return Verdict(labels={}, outcome="invalid", latency_ms=dt)
            labels[axis] = a["choice"]
            conf[axis] = a["confidence"]
            probs[axis] = a["probabilities"]
        # nothing else from the response is kept: no explanation, no model echo
        return Verdict(labels=labels, confidence=conf, probabilities=probs,
                       latency_ms=dt, request_id=raw.get("request_id"))
