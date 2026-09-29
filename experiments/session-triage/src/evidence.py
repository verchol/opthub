"""Evidence for one session: what a classifier may see, kept apart from what it costs.

Two dicts per session, never merged:

  ledger    the money — cost split, model mix. Used by savings.py. Never sent to a
            classifier: a model that sees "$137" will call the session "frontier" for
            the price alone, and the savings number would then be measuring itself.
  evidence  what the classifier sees. C0 is what the pinned ledger alone supports;
            C1 adds the local transcript features from extract.py (gaps, tool mix,
            prompt flags). Neither carries a path, a prompt or a file name.
"""

import csv
import datetime as dt
import json
import pathlib
import re

KINDS = [  # first match wins; the raw path never leaves this module
    ("config", r"/\.claude$|/\.config"),
    ("generated-output", r"/\.graphify/|-out(/|$)"),
    ("knowledge-base", r"(^|/)(kb|[a-z-]*kb|knowledge[a-z-]*)(/|$)|releasekb|canariankb"),
    ("agent-tooling", r"/agents?/|deepagents|langsmith|ollama|lightllm|opthub|graphify"),
    ("marketing", r"/marketing"),
    ("product-repo", r"canarian-mvp|proddna|productiondna|smartcicd"),
    ("demo-repo", r"/demos?/"),
    ("home-or-root", r"^~$|/workspace$|^~/?$"),
]


def project_kind(cwd: str) -> str:
    c = cwd.lower()
    for kind, pat in KINDS:
        if re.search(pat, c):
            return kind
    return "other"


def parse_models(s: str) -> dict[str, int]:
    out = {}
    for part in filter(None, s.split("|")):
        m, _, n = part.rpartition(":")
        out[m] = out.get(m, 0) + int(n or 0)
    return out


def session_key(start: str, cwd: str) -> str:
    """Join key between a ledger row and an extract.py feature row."""
    cwd = re.sub(r"^/Users/[^/]+", "~", cwd)
    return f"{start[:19]}|{cwd}"


def _f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


def load(ledger_csv, features_jsonl=None):
    feats, sids, feats_by_sid = {}, {}, {}
    if features_jsonl and pathlib.Path(features_jsonl).exists():
        for line in pathlib.Path(features_jsonl).read_text().splitlines():
            if line.strip():
                row = json.loads(line)
                feats[row["key"]] = row["features"]
                sids[row["key"]] = row.get("session_id")
                if row.get("session_id"):
                    feats_by_sid[row["session_id"]] = row["features"]

    sessions = []
    for i, r in enumerate(csv.DictReader(open(ledger_csv))):
        start = dt.datetime.fromisoformat(r["start"])
        local = start.astimezone()
        cost, out, think = _f(r["cost"]), _f(r["out$"]), _f(r["think$"])
        ledger = {
            "cost": cost, "read": _f(r["read$"]), "write": _f(r["write$"]),
            "out": out, "think": think, "models": parse_models(r["models"]),
            "ctx_max": int(_f(r["ctx_max"])), "cwd": r["cwd"],
        }
        evidence = {
            "entry_point": "interactive terminal" if r["entry"] == "cli" else "SDK / headless launch",
            "project_kind": project_kind(r["cwd"]),
            "requests": int(_f(r["reqs"])),
            "context_tokens_median": int(_f(r["ctx_p50"])),
            "context_tokens_max": int(_f(r["ctx_max"])),
            "thinking_share_of_output": round(think / out, 2) if out else 0.0,
            "started_local": local.strftime("%a %H:%M"),
        }
        key = session_key(r["start"], r["cwd"])
        sessions.append({
            "id": f"s{i:03d}", "key": key, "ledger": ledger, "evidence": evidence,
            "features": feats.get(key) or feats_by_sid.get(r.get("session")),
            "session_id": r.get("session") or sids.get(key),
        })
    return sessions
