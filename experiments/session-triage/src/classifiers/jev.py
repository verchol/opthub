"""TypeSafe Jev adapter for sessions — the Choice primitive, one request, five questions.

Same contract as experiments/email-triage/src/classifiers/jev.py (itself modelled on
alexei-led/pi-model-router extensions/jev.ts): only a supplied option id is accepted,
probabilities must cover exactly the option set and sum to 1, nothing from the response
is kept but the validated choice and numeric diagnostics. No retry. Failure means
abstain, never a second advisor.

What is sent: the `evidence` dict (and `features` for C1). No path, no prompt text, no
cost. See evidence.py for why cost is withheld.
"""

import json
import os
import time
import urllib.error
import urllib.request

from .base import Classifier, Verdict

ENDPOINT = os.environ.get("JEV_ENDPOINT", "https://api.typesafe.ai/v1/systemone")
MODEL = os.environ.get("JEV_MODEL", "jev-1.13.0")
TIMEOUT_S = float(os.environ.get("JEV_TIMEOUT_MS", "1500")) / 1000
MAX_BYTES = 65536


def build_request(evidence: dict, features: dict | None, taxonomy: dict) -> dict:
    """The exact payload. `features` is None for the context-free arm."""
    state = {"coding_session": evidence,
             "evidence_note": "Metadata of one Claude Code session, computed locally. "
                              "No prompt or file content is included."}
    if features is not None:
        state["session_activity"] = features
        state["activity_note"] = (
            "session_activity is computed locally from the transcript. reply_gap_* is how long "
            "the person took to answer each reply. prompt_flags say whether the person's "
            "messages mentioned a topic; the messages themselves are not included. work_signals "
            "count how hard the work looked: files and lines changed, files edited again and again, "
            "test runs and how many failed, tool errors, commits. claude_code is what the session ran "
            "with: entry point, model, reasoning effort, permission mode, how many times the context "
            "was compacted, and the share of requests made by subagents.")
    questions = {}
    for axis, spec in taxonomy["axes"].items():
        questions[axis] = {
            "type": "choice",
            "instructions": spec["question"] + " Choose exactly one option. Choose the option "
                            "the evidence supports; choose 'unclear' when it does not decide.",
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

    def classify(self, e, f):
        payload = build_request(e, f if self.uses_context else None, self.taxonomy)
        req = urllib.request.Request(
            ENDPOINT, data=json.dumps(payload).encode(),
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
        )
        t0 = time.perf_counter()
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
                raw = json.loads(resp.read(MAX_BYTES))
        except urllib.error.HTTPError as err:
            return Verdict(labels={}, outcome=f"http-{err.code}", latency_ms=int((time.perf_counter() - t0) * 1000))
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
        return Verdict(labels=labels, confidence=conf, probabilities=probs,
                       latency_ms=dt, request_id=raw.get("request_id"))
