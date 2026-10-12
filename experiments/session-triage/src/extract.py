#!/usr/bin/env python3
"""C1 features from local transcripts — numbers and booleans only, never text.

Reads ~/.claude/projects/*/*.jsonl on this machine and writes one row per session to
data/private/features.jsonl (gitignored). Prompt text is read here, matched against
the flag patterns below, and dropped: the output carries `mentions_deadline: true`,
never the sentence it came from. That is the whole privacy design, the same as J2's
sender features — the external classifier sees what the prompt was *about*, not what
it said.

    python3 tools/savings.py --days 30 --csv experiments/session-triage/data/private/ledger.csv
    python3 experiments/session-triage/src/extract.py --days 30
    python3 experiments/session-triage/src/run.py \
        --ledger data/private/ledger.csv --features data/private/features.jsonl

The join key is (start second, cwd), which is what savings.py writes, so run both with
the same --days or a session whose start fell outside one window will not join.
"""

import argparse
import datetime as dt
import glob
import json
import math
import os
import pathlib
import re
import statistics
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from evidence import session_key  # noqa: E402

FLAGS = {
    "mentions_prod_or_incident": r"\b(prod(uction)?|incident|outage|down|broken|hotfix|p[01]|sev[12]?|rollback)\b",
    "mentions_deadline": r"\b(urgent|asap|today|tonight|tomorrow|deadline|eod|by (mon|tue|wed|thu|fri)\w*)\b",
    "mentions_demo_or_meeting": r"\b(demo|meeting|call with|present(ation)?|investor|customer)\b",
    "mentions_background_or_later": r"\b(background|overnight|while i sleep|no rush|later|night|without (my )?approv\w*|batch)\b",
    "mentions_research_or_explore": r"\b(research|explore|investigate|compare|survey|read (about|through)|summari[sz]e)\b",
    "mentions_docs_or_writing": r"\b(readme|docs?|document(ation)?|spec|write[- ]?up|blog|post)\b",
    "mentions_fix_or_test": r"\b(fix|bug|error|failing|test|debug|stack ?trace)\b",
}
EDIT = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
READ = {"Read", "Grep", "Glob", "LS"}
WEB = {"WebFetch", "WebSearch"}
AGENT = {"Task", "Agent"}
TOPIC_GAP_S = 30 * 60
# Work signals: how hard the work looked, counted from tool calls and their results.
# Paths and code are counted, never kept.
TEST_CMD = re.compile(r"\b(pytest|py\.test|unittest|npm (run )?test|pnpm test|yarn test|jest|vitest|mocha|go test|cargo test|make test|mvn test|gradle test|rspec)\b")
TEST_FAIL = re.compile(r"(\b\d+ failed\b|\bFAILED\b|\bFAIL\b|AssertionError|Tests?:\s+\d+ failed|failures?=\d*[1-9])")
GIT_COMMIT = re.compile(r"\bgit (commit|revert)\b")
# Claude Code settings: what the session ran with, read from the transcript's own fields.
# Enums and counts only; these are the knobs the optimization methods turn.
CC_FIELDS = ("entrypoint", "version", "effort", "permissionMode")


def _text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def _is_human(r):
    if r.get("type") != "user" or r.get("isSidechain") or r.get("isMeta"):
        return False
    c = (r.get("message") or {}).get("content")
    if isinstance(c, list) and c and all(isinstance(b, dict) and b.get("type") == "tool_result" for b in c):
        return False
    t = _text(c).strip()
    return bool(t) and not t.startswith(("<command-", "<local-command", "<bash-input>", "<bash-stdout>",
                                          "<bash-stderr>", "<task-notification", "Caveat:", "Write the title",
                                          "[Request interrupted"))


def _lines(x):
    return len(x.splitlines()) if isinstance(x, str) else 0


def work_call(s, b):
    name, i = b.get("name", ""), b.get("input") or {}
    if name in EDIT and i.get("file_path"):
        s["edits"][i["file_path"]] = s["edits"].get(i["file_path"], 0) + 1
        if name == "Write":
            s["lines"] += _lines(i.get("content"))
        elif name == "MultiEdit":
            s["lines"] += sum(max(_lines(e.get("old_string")), _lines(e.get("new_string"))) for e in i.get("edits") or [])
        else:
            s["lines"] += max(_lines(i.get("old_string")), _lines(i.get("new_string")))
    elif name == "Bash":
        cmd = str(i.get("command", ""))
        if TEST_CMD.search(cmd):
            s["tests"].add(b.get("id"))
        if GIT_COMMIT.search(cmd):
            s["commits"] += 1


def work_result(s, b):
    if b.get("is_error"):
        s["tool_err"] += 1
    if b.get("tool_use_id") in s["tests"]:
        body = b.get("content")
        body = body if isinstance(body, str) else " ".join(x.get("text", "") for x in body or [] if isinstance(x, dict))
        if b.get("is_error") or TEST_FAIL.search(body):
            s["test_fail"] += 1


def _bump(d, v):
    if v not in (None, ""):
        d[str(v)] = d.get(str(v), 0) + 1


def cc_record(s, r):
    cc = s["cc"]
    for k in CC_FIELDS:
        _bump(cc[k], r.get(k))
    if r.get("advisorModel"):
        s["advisor"] += 1
    if r.get("type") == "system" and r.get("subtype") == "compact_boundary":
        s["compactions"] += 1
    if r.get("type") == "system" and r.get("subtype") == "stop_hook_summary" and r.get("hookCount"):
        s["hooks"] += 1
    m = r.get("message")
    if r.get("type") == "assistant" and isinstance(m, dict) and m.get("usage") and not r.get("isSidechain"):
        if m.get("model") and m["model"] != "<synthetic>":
            _bump(cc["model"], m["model"])
        _bump(cc["speed"], (m.get("usage") or {}).get("speed"))


def claude_code(s, main_turns):
    """The settings a session ran with: the dominant value of each, plus shares and counts."""
    cc = s["cc"]
    top = lambda d: max(d, key=d.get) if d else None   # noqa: E731
    eff = cc["effort"]
    ver = top(cc["version"])
    return {
        "entrypoint": top(cc["entrypoint"]),
        "version": ".".join(ver.split(".")[:2]) if ver else None,
        "model": (top(cc["model"]) or "").replace("claude-", "").replace("-20251001", "") or None,
        "effort": top(eff),
        "effort_high_share": round(eff.get("high", 0) / (sum(eff.values()) or 1), 2) if eff else None,
        "permission_mode": top(cc["permissionMode"]),
        "fast_mode_share": round(cc["speed"].get("fast", 0) / (sum(cc["speed"].values()) or 1), 2),
        "advisor_on": s["advisor"] > 0,
        "compactions": s["compactions"],
        "hooks_active": s["hooks"] > 0,
        "mcp_servers": len(s["mcp"]),
        "subagent_request_share": round(s["side"] / ((s["side"] + main_turns) or 1), 2),
    }


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
            s = S.setdefault(sid, {"cwd": "", "start": t, "last": t, "human": [], "asst_t": [],
                                   "tools": {}, "side": 0, "main": 0,
                                   "flags": {k: False for k in FLAGS},
                                   "edits": {}, "lines": 0, "tests": set(), "test_fail": 0,
                                   "tool_err": 0, "commits": 0,
                                   "cc": {k: {} for k in CC_FIELDS + ("model", "speed")},
                                   "advisor": 0, "compactions": 0, "hooks": 0, "mcp": set()})
            if r.get("cwd"):
                s["cwd"] = r["cwd"]
            s["start"], s["last"] = min(s["start"], t), max(s["last"], t)
            cc_record(s, r)
            if r.get("type") == "assistant" and (r.get("message") or {}).get("usage"):
                s["side" if r.get("isSidechain") else "main"] += 1
                if not r.get("isSidechain"):
                    s["asst_t"].append(t)
                for b in (r.get("message") or {}).get("content") or []:
                    if isinstance(b, dict) and b.get("type") == "tool_use":
                        s["tools"][b.get("name", "")] = s["tools"].get(b.get("name", ""), 0) + 1
                        if b.get("name", "").startswith("mcp__"):
                            s["mcp"].add(b["name"].split("__")[1])
                        work_call(s, b)
            elif r.get("type") == "user":
                content = (r.get("message") or {}).get("content")
                for b in content if isinstance(content, list) else []:
                    if isinstance(b, dict) and b.get("type") == "tool_result":
                        work_result(s, b)
            if _is_human(r):
                s["human"].append(t)
                txt = _text(r["message"]["content"]).lower()
                for k, pat in FLAGS.items():
                    if not s["flags"][k] and re.search(pat, txt):
                        s["flags"][k] = True
                # txt goes out of scope here; nothing below can reach it
    return S


def features(s):
    human = sorted(s["human"])
    asst = sorted(s["asst_t"])
    gaps = []  # reply-to-next-prompt: how long the person took to answer
    for h in human[1:]:
        prev = [a for a in asst if a < h]
        if prev:
            gaps.append((h - prev[-1]).total_seconds())
    tools = s["tools"]
    n_tools = sum(tools.values()) or 1

    def share(match):
        return round(sum(v for k, v in tools.items() if match(k)) / n_tools, 2)

    q = sorted(gaps)
    return {
        "human_prompts": len(human),
        "reply_gap_median_s": int(statistics.median(q)) if q else None,
        "reply_gap_p90_s": int(q[math.ceil(0.9 * len(q)) - 1]) if q else None,
        "topic_breaks": sum(1 for g in gaps if g > TOPIC_GAP_S),
        "span_minutes": int((s["last"] - s["start"]).total_seconds() // 60),
        "spans_multiple_days": s["last"].astimezone().date() != s["start"].astimezone().date(),
        "tool_share": {"edit": share(EDIT.__contains__), "bash": share("Bash".__eq__),
                       "read_search": share(READ.__contains__),
                       "web_or_mcp": share(lambda k: k in WEB or k.startswith("mcp__")),
                       "subagent": share(AGENT.__contains__)},
        "work_signals": {
            "files_touched": len(s["edits"]),
            "lines_changed": s["lines"],
            "files_edited_3plus_times": sum(1 for v in s["edits"].values() if v >= 3),
            "test_runs": len(s["tests"]),
            "test_runs_failed": s["test_fail"],
            "tool_errors": s["tool_err"],
            "git_commits": s["commits"],
        },
        "subagent_request_share": round(s["side"] / ((s["side"] + s["main"]) or 1), 2),
        "prompt_flags": s["flags"],
        "claude_code": claude_code(s, s["main"]),
    }


def main():
    here = pathlib.Path(__file__).resolve().parents[1]
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=os.path.expanduser("~/.claude/projects"))
    ap.add_argument("--days", type=float, default=30)
    ap.add_argument("--out", default=str(here / "data" / "private" / "features.jsonl"))
    a = ap.parse_args()
    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=a.days)
    S = walk(a.root, cutoff)
    out = pathlib.Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w") as fh:
        for sid, s in S.items():
            if not s["main"]:
                continue  # zero-billable sessions have no ledger row to join
            start = s["start"].astimezone(dt.timezone.utc).isoformat().replace("+00:00", "")
            fh.write(json.dumps({"key": session_key(start, s["cwd"]), "session_id": sid, "features": features(s)}) + "\n")
    print(f"wrote {out} ({sum(1 for s in S.values() if s['main'])} sessions)")


if __name__ == "__main__":
    main()
