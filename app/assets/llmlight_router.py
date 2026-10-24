"""LLM Light — the per-request decision inside LiteLLM, driven by a profile.

Loaded by LiteLLM as a custom callback (litellm_settings.callbacks: llmlight_router.handler).
It reads llmlight_profile.json next to it — written by lib/llmlight.mjs when a profile is
rendered — and for every request:

  1. works out what kind of call it is, from the model name Claude Code asked for:
       background  ANTHROPIC_DEFAULT_HAIKU_MODEL=llmlight-background  (titles, summaries)
       subagent    CLAUDE_CODE_SUBAGENT_MODEL=llmlight-subagent        (Task subagents)
       main        anything else                                        (the coding loop)
  2. applies the profile's rules, first match wins, then never_downgrade;
  3. rewrites data["model"] to a tier (tier-frontier / tier-mid / tier-small) that
     model_list maps to a real model;
  4. appends one audit line per decision and per result. Audit lines carry numbers and
     names only — never prompt or response text.

The decision is local and costs no model call: the session's own classes (from Triage,
where Jev answered them) are baked into the profile at apply time, not fetched per request.
"""

import json
import os
import time

try:
    from litellm.integrations.custom_logger import CustomLogger
except Exception:  # importable without litellm, for tests
    class CustomLogger:  # type: ignore
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
TIERS = ("frontier", "mid", "small")
RANK = {t: i for i, t in enumerate(TIERS)}  # lower index = stronger


def _load(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except Exception:
        return None


def _text(messages, system):
    """Last user message plus system text, lower-cased, for keyword checks only. Never stored."""
    parts = []
    if isinstance(system, str):
        parts.append(system)
    elif isinstance(system, list):
        parts += [b.get("text", "") for b in system if isinstance(b, dict)]
    for m in reversed(messages or []):
        if m.get("role") == "user":
            c = m.get("content")
            parts.append(c if isinstance(c, str) else " ".join(
                b.get("text", "") for b in c or [] if isinstance(b, dict) and b.get("type") == "text"))
            break
    return " ".join(parts).lower()


def call_kind(model):
    m = str(model or "").lower()
    if m == "llmlight-background" or "haiku" in m:
        return "background"
    if m == "llmlight-subagent":
        return "subagent"
    return "main"


def decide(profile, data):
    """(tier, reason) for one request. Pure function — the tests call it directly."""
    r = profile.get("routing") or {}
    kind = call_kind(data.get("model"))
    tools = len(data.get("tools") or [])
    msgs = len(data.get("messages") or [])
    facts = {"call": kind, "tools": tools, "messages": msgs, **(profile.get("sessionClasses") or {})}
    tier, reason = r.get("default", "frontier"), "default"
    for rule in r.get("rules") or []:
        when = rule.get("when") or {}
        ok = True
        for k, v in when.items():
            if k == "minMessages":
                ok &= msgs >= v
            elif k == "maxTools":
                ok &= tools <= v
            elif isinstance(v, list):
                ok &= facts.get(k) in v
            else:
                ok &= facts.get(k) == v
        if ok:
            tier, reason = rule["to"], rule.get("why") or f"rule {when}"
            break
    words = r.get("neverDowngrade") or []
    if words and RANK.get(tier, 0) > 0:
        text = _text(data.get("messages"), data.get("system"))
        hit = next((w for w in words if w.lower() in text), None)
        if hit:
            tier, reason = "frontier", f"never_downgrade: '{hit}'"
    return tier, reason, kind


class LLMLight(CustomLogger):
    def __init__(self, profile_path=None):
        self.path = profile_path or os.path.join(HERE, "llmlight_profile.json")
        self.profile = _load(self.path) or {"id": "missing", "routing": {"default": "frontier"}}
        audit = self.profile.get("audit") or {}
        self.audit_path = os.path.expanduser(audit.get("path") or os.path.join(HERE, "llmlight-audit.jsonl"))
        self.audit_on = audit.get("log", "decisions") != "off"

    def _audit(self, row):
        if not self.audit_on:
            return
        row = {"ts": time.time(), "profile": self.profile.get("id"), **row}
        try:
            with open(self.audit_path, "a") as fh:
                fh.write(json.dumps(row) + "\n")
        except Exception:
            pass  # audit must never break a request

    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        requested = data.get("model")
        tier, reason, kind = decide(self.profile, data)
        data["model"] = f"tier-{tier}"
        md = data.setdefault("metadata", {})
        md["llmlight"] = {"tier": tier, "call": kind, "requested": requested}
        self._audit({"event": "route", "call": kind, "requested": requested, "tier": tier, "reason": reason,
                     "messages": len(data.get("messages") or []), "tools": len(data.get("tools") or [])})
        return data

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        # LiteLLM's own record of the call: the deployment that actually served it and its cost.
        slo = kwargs.get("standard_logging_object") or {}
        group = str(slo.get("model_group") or "")
        self._audit({"event": "result",
                     "tier": group[5:] if group.startswith("tier-") else None,
                     "model_group": group, "deployment": slo.get("model"),
                     "cost_usd": slo.get("response_cost", kwargs.get("response_cost")),
                     "input_tokens": slo.get("prompt_tokens"), "output_tokens": slo.get("completion_tokens"),
                     "latency_s": slo.get("response_time")})

    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
        self._audit({"event": "error", "model": kwargs.get("model"),
                     "error": type(kwargs.get("exception")).__name__ if kwargs.get("exception") else "unknown"})


handler = LLMLight()
