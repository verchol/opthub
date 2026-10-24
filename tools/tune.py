#!/usr/bin/env python3
"""tune — pick a session's candidate flags from its own measurements ("dynamic" parameters).

The goal presets in tools/rerun.py are one fixed answer for every session ("best"
known flags for the goal). This tool reads one session and picks flags for *that*
session instead: a small one-file fix does not need the model a 300k-context
investigation needs. Free and read-only.

    python3 tools/tune.py <session-id> [--root DIR] [--json]
    python3 tools/rerun.py plan <session-id> --goal cost --dynamic   # adds it as an arm

Every rule is a `guess` (CLAUDE.md, Rules for numbers): a threshold with a stated
basis and no measurement behind it. The replay is what measures it — tune proposes,
rerun.py decides. Rules, in order:

  model   keep      median context >= 150k   long-context work is where a downgrade
                                             is riskiest; context-lifecycle is the lever
          haiku     <= 2 files edited and <= 12 requests   (a small, local change)
          sonnet    otherwise, when the session ran on an Opus/Fable model
  effort  down one  thinking >= 50% of output tokens (high -> medium, max -> high)
          low       ... and the session is small (as above)
          keep      otherwise
"""
import argparse, glob, json, os, statistics, sys

PROJECTS = os.environ.get("OPTHUB_PROJECTS") or os.path.expanduser("~/.claude/projects")
SONNET, HAIKU = "claude-sonnet-5", "claude-haiku-4-5-20251001"
LONG_CTX, SMALL_FILES, SMALL_REQS, THINK_HEAVY = 150_000, 2, 12, 0.5
EFFORT_DOWN = {"max": "high", "xhigh": "high", "high": "medium", "medium": "low", "low": "low"}
EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}


def profile(sid, root=PROJECTS):
    files = glob.glob(os.path.join(root, "*", f"{sid}.jsonl"))
    if not files:
        sys.exit(f"no transcript for {sid} under {root}")
    models, ctx, edited = {}, [], set()
    p = dict(sid=sid, reqs=0, out_tok=0, think=0, effort=None)
    for line in open(files[0], errors="replace"):
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if isinstance(r.get("effort"), str):
            p["effort"] = r["effort"]
        msg = r.get("message") or {}
        for b in msg.get("content") or []:
            if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("name") in EDIT_TOOLS:
                edited.add((b.get("input") or {}).get("file_path"))
        u = msg.get("usage")
        if not u or r.get("isSidechain"):
            continue
        p["reqs"] += 1
        models[msg.get("model")] = models.get(msg.get("model"), 0) + 1
        d = u.get("output_tokens_details") or {}
        p["think"] += d.get("thinking_tokens") or d.get("reasoning_tokens") or 0
        p["out_tok"] += u.get("output_tokens", 0)
        ctx.append(u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0)
                   + u.get("cache_creation_input_tokens", 0))
    p["model"] = max(models, key=models.get) if models else None
    p["ctx_p50"] = int(statistics.median(ctx)) if ctx else 0
    p["files_edited"] = len(edited - {None})
    p["think_share"] = p["think"] / p["out_tok"] if p["out_tok"] else 0.0
    return p


def choose(p):
    """Flags plus one reason per decision. Same flag order as the rerun.py presets."""
    small = p["files_edited"] <= SMALL_FILES and p["reqs"] <= SMALL_REQS
    why = []
    model = p["model"]
    if p["ctx_p50"] >= LONG_CTX:
        why.append(f"model kept ({model}): median context {p['ctx_p50']:,} >= {LONG_CTX:,} — "
                   f"long-context work is where a downgrade is riskiest; try context-lifecycle instead")
    elif small:
        model = HAIKU
        why.append(f"model -> {HAIKU}: {p['files_edited']} file(s) edited in {p['reqs']} requests — a small, local change")
    elif model and ("opus" in model or "fable" in model):
        model = SONNET
        why.append(f"model -> {SONNET}: {p['files_edited']} files, median context {p['ctx_p50']:,} — mid-sized work")
    else:
        why.append(f"model kept ({model}): already below Opus")
    effort = p["effort"]
    if p["think_share"] >= THINK_HEAVY:
        effort = "low" if small else EFFORT_DOWN.get(effort or "high", "medium")
        why.append(f"effort -> {effort}: thinking is {p['think_share']:.0%} of output tokens")
    else:
        why.append(f"effort kept ({effort or 'default'}): thinking is {p['think_share']:.0%} of output tokens")
    flags = ["--model", model] + (["--effort", effort] if effort else [])
    return flags, why


def main():
    ap = argparse.ArgumentParser(description="Pick a session's candidate flags from its own measurements.")
    ap.add_argument("session")
    ap.add_argument("--root", default=PROJECTS)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    p = profile(a.session, a.root)
    flags, why = choose(p)
    if a.json:
        print(json.dumps(dict(profile=p, flags=flags, why=why), indent=2))
        return
    print(f"session  : {p['sid']}")
    print(f"measured : {p['model']} · effort {p['effort'] or '-'} · {p['reqs']} req · "
          f"ctx p50 {p['ctx_p50']:,} · thinking {p['think_share']:.0%} of output · {p['files_edited']} files edited")
    print(f"dynamic  : {' '.join(flags)}   (guess — replay to measure)")
    for w in why:
        print(f"  - {w}")


if __name__ == "__main__":
    main()
