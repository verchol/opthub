#!/usr/bin/env python3
"""Split each session into the tasks it actually contained. Local only.

A task starts at a person's prompt that follows a long pause (> 30 min from the last
reply, the same `topic_breaks` rule extract.py counts). Each task gets its start time,
prompt and request counts, its own cost (same pricing as tools/savings.py, so a
session's tasks add up to its ledger cost) and a title: the first prompt of the task,
cut to 90 characters.

The title is prompt text, so this output is never sent to Jev. It lands in
data/private/ (gitignored). Before a title is kept it is scrubbed: `!` shell input and
output are skipped entirely (they can carry `export KEY=...`), secret-shaped strings
and e-mail addresses are masked, and home paths become ~.

    python3 src/tasks.py --days 30
"""

import argparse
import datetime as dt
import glob
import json
import os
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from evidence import session_key                          # noqa: E402
from extract import TOPIC_GAP_S, _text                     # noqa: E402

PRICE = {"claude-opus-5-5": (4.0, 20.0), "claude-fable-5": (10.0, 50.0), "claude-fable-5-1": (10.0, 50.0),
         "claude-opus-5": (5.0, 25.0), "claude-opus-4-8": (5.0, 25.0),
         "claude-sonnet-5": (2.0, 10.0), "claude-haiku-4-5-20251001": (1.0, 5.0)}
W5, W1H, READ = 1.25, 2.0, 0.1

NOISE_PREFIX = ("<bash-input>", "<bash-stdout>", "<bash-stderr>", "<command-", "<local-command",
                "<task-notification", "Caveat:", "Write the title", "[Request interrupted")
SECRET = re.compile(r"(sk-[A-Za-z0-9_\-]{8,}|apikey_[A-Za-z0-9_]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[abp]-[A-Za-z0-9\-]{8,}"
                    r"|AKIA[0-9A-Z]{12,}|eyJ[A-Za-z0-9_\-]{20,}|\b[A-Fa-f0-9]{32,}\b|\b[A-Za-z0-9+/_\-]{40,}\b)")
EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")
KEYVAL = re.compile(r"\b([A-Z][A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD|PASS)[A-Z0-9_]*)\s*=\s*\S+")


def cost(model, u):
    p = PRICE.get(model)
    if not p:
        return 0.0
    inp, outp = p
    cc = u.get("cache_creation") or {}
    w5, w1 = cc.get("ephemeral_5m_input_tokens", 0), cc.get("ephemeral_1h_input_tokens", 0)
    if w5 + w1 == 0:
        w5 = u.get("cache_creation_input_tokens", 0)
    return ((u.get("cache_read_input_tokens", 0) * READ + u.get("input_tokens", 0)) * inp
            + (w5 * W5 + w1 * W1H) * inp + u.get("output_tokens", 0) * outp) / 1e6


def title(raw):
    t = re.sub(r"<(system-reminder|pasted_content)[^>]*>.*?</\1>", " ", raw, flags=re.S)
    t = re.sub(r"<[^>]+>", " ", t)
    t = KEYVAL.sub(r"\1=[redacted]", t)
    t = SECRET.sub("[redacted]", t)
    t = EMAIL.sub("[email]", t)
    t = re.sub(r"/Users/[^/\s]+", "~", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t[:90] + ("…" if len(t) > 90 else "")


def human_text(r):
    if r.get("type") != "user" or r.get("isSidechain") or r.get("isMeta"):
        return None
    c = (r.get("message") or {}).get("content")
    if isinstance(c, list) and c and all(isinstance(b, dict) and b.get("type") == "tool_result" for b in c):
        return None
    t = _text(c).strip()
    if not t or t.startswith(NOISE_PREFIX):
        return None
    return t


def walk(root, cutoff):
    S = {}
    for f in glob.glob(os.path.join(root, "*", "*.jsonl")):
        for line in open(f, errors="replace"):
            if not line.startswith("{"):
                continue
            try:
                r = json.loads(line)
            except ValueError:
                continue
            ts = r.get("timestamp")
            if not ts:
                continue
            t = dt.datetime.fromisoformat(ts.replace("Z", "+00:00"))
            if t < cutoff:
                continue
            sid = r.get("sessionId") or os.path.basename(f)[:-6]
            s = S.setdefault(sid, {"cwd": "", "start": t, "events": []})
            if r.get("cwd"):
                s["cwd"] = r["cwd"]
            s["start"] = min(s["start"], t)
            msg = r.get("message") or {}
            if r.get("type") == "assistant" and msg.get("usage"):
                s["events"].append((t, "a", cost(msg.get("model", ""), msg["usage"]), r.get("isSidechain", False)))
            else:
                h = human_text(r)
                if h is not None:
                    s["events"].append((t, "h", title(h), False))
    return S


def split(events):
    events.sort(key=lambda e: e[0])
    tasks, cur, last_reply = [], None, None
    for t, kind, val, side in events:
        if kind == "h":
            if cur is None or (last_reply and (t - last_reply).total_seconds() > TOPIC_GAP_S):
                cur = {"start": t, "title": val or "(no text)", "prompts": 0, "requests": 0, "cost": 0.0}
                tasks.append(cur)
            cur["prompts"] += 1
        else:
            if cur is None:  # requests before any human prompt (headless start)
                cur = {"start": t, "title": "(started without a typed prompt)", "prompts": 0, "requests": 0, "cost": 0.0}
                tasks.append(cur)
            cur["requests"] += 1
            cur["cost"] += val
            if not side:
                last_reply = t
    return [{"start": x["start"].astimezone().strftime("%a %d %b %H:%M"), "title": x["title"],
             "prompts": x["prompts"], "requests": x["requests"], "cost": round(x["cost"], 4)} for x in tasks]


def main():
    here = pathlib.Path(__file__).resolve().parents[1]
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=os.path.expanduser("~/.claude/projects"))
    ap.add_argument("--days", type=float, default=30)
    ap.add_argument("--out", default=str(here / "data" / "private" / "tasks.jsonl"))
    a = ap.parse_args()
    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=a.days)
    out = pathlib.Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with out.open("w") as fh:
        for sid, s in walk(a.root, cutoff).items():
            if not any(e[1] == "a" for e in s["events"]):
                continue
            start = s["start"].astimezone(dt.timezone.utc).isoformat()
            fh.write(json.dumps({"key": session_key(start, s["cwd"]), "session_id": sid, "tasks": split(s["events"])}) + "\n")
            n += 1
    print(f"wrote {out} ({n} sessions)")


if __name__ == "__main__":
    main()
