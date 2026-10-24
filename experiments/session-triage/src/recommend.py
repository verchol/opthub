#!/usr/bin/env python3
"""Turn a classified run into Claude Code settings you can copy, and a script you can run.

    python3 src/recommend.py                         # latest live run in data/private/
    python3 src/recommend.py --arm human             # what your own gold labels recommend
    python3 src/recommend.py --copy settings         # also put settings.json on the clipboard
    python3 src/recommend.py --copy script           # ... or apply.sh

    data/private/recommend/apply.sh                  # plan: prints what it would do, changes nothing
    data/private/recommend/apply.sh apply            # does it: claude, llm and other sections
    data/private/recommend/apply.sh apply claude     # one section only

Reads results.json (run.py) and prices every session with methods.py, exactly like
export_hub.py. A method becomes a recommendation for a project when the sessions it
unlocks hold at least --share of that project's spend; the same rule over all sessions
gives the global fragment. Three sections in apply.sh:

  claude   merge per-project settings into <project>/.claude/settings.local.json
           (backed up first): `model` for routing, `env.CLAUDE_CODE_SUBAGENT_MODEL`
           for side-calls. Effort and context have no settings key we have verified,
           so they are printed as the launch flags METHODS lists, not written.
  llm      re-classify: score.py (rules, + Jev when JEV_API_KEY is set — one paid call
           per session), and the interactive gold pass when run at a terminal.
  other    sandbox re-run plan for sessions whose model question went unanswered
           (plan only, spends nothing), batch candidates, and the check to run a week on.

Every saving is a headroom estimate with its method's label (priced / guess), marginal in
methods.py's applied order. It is not a measurement: only the sandbox re-run says the
cheaper configuration did the same job. Not everything here is verified to work — the
script prints before it acts, and `apply` is opt-in. Output goes to data/private/
(gitignored): it names your projects.
"""

import argparse
import json
import os
import pathlib
import shlex
import shutil
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from evidence import load                    # noqa: E402
from methods import METHODS, session_methods  # noqa: E402

EXP = pathlib.Path(__file__).resolve().parents[1]
REPO = EXP.parents[1]
PRIV = EXP / "data" / "private"
ARMS = ("jev-C1", "hybrid-C1", "rules-C1", "jev-C0", "hybrid-C0", "rules-C0")
LABEL = {m[0]: m[5] for m in METHODS}
KNOB = {m[0]: m[3] for m in METHODS}


def usd(x):
    return f"-${-x:,.2f}" if x < 0 else f"${x:,.2f}"


def pick_arm(results, want):
    arms = results["arms"]
    order = [want] if want else [a for a in ARMS if a in arms]
    for a in order:
        if a in arms:
            return a
    sys.exit(f"no arm {want or 'from ' + ', '.join(ARMS)} in results.json — have: {', '.join(arms)}")


def score_sessions(results, arm, d):
    """One methods.py row set per session, from the arm's labels (and probabilities when stored)."""
    rows = {r["id"]: r["labels"] for r in results["arms"][arm]["eval"]["rows"]}
    preds = results["arms"][arm].get("predictions") or {}
    feats = d / "features.jsonl"
    out = []
    for s in load(results["ledger"], feats if feats.exists() else None):
        p = preds.get(s["id"]) or {}
        labels = rows.get(s["id"]) or p.get("labels") or {}
        if not labels:
            continue
        F = s["features"] or {}
        sv = session_methods(s["ledger"], labels, p.get("probabilities"), p.get("confidence"), F.get("claude_code"),
                             F.get("subagent_request_share"), s["evidence"]["context_tokens_median"])
        out.append((s, labels, sv))
    return out


def recommend(scored, share):
    """Per project and overall: which methods to switch on, and what they are worth on this run."""
    groups = defaultdict(list)
    for s, labels, sv in scored:
        groups[s["ledger"]["cwd"]].append((s, labels, sv))
    groups["*"] = scored

    def one(items):
        spend = sum(s["ledger"]["cost"] for s, _, _ in items)
        m = defaultdict(lambda: {"sessions": 0, "spend": 0.0, "saving": 0.0, "notes": defaultdict(int)})
        for s, _, sv in items:
            for r in sv["methods"]:
                if r["unlocked"]:
                    x = m[r["id"]]
                    x["sessions"] += 1
                    x["spend"] += s["ledger"]["cost"]
                    x["saving"] += r["saving"] if r["id"] != "batch" else (r["savingFloor"] or 0)
                    x["notes"][r["note"]] += 1
        # a method that loses money at its floor is never recommended (batch on cache-heavy sessions)
        on = {k: v for k, v in m.items() if spend and v["spend"] / spend >= share and (v["saving"] > 0 or k == "fast-mode")}
        settings, flags, tips = {}, [], []
        if "route" in on:
            to = max(on["route"]["notes"], key=on["route"]["notes"].get)
            settings["model"] = "haiku" if to.startswith("to Haiku") else "sonnet"
        if "side-calls" in on:
            settings.setdefault("env", {})["CLAUDE_CODE_SUBAGENT_MODEL"] = "haiku"
        if "effort" in on:
            flags.append("--effort medium")
        if "context" in on:
            tips.append("context: " + max(on["context"]["notes"], key=on["context"]["notes"].get))
        if "batch" in on:
            tips.append("batch: these sessions could run headless (claude -p) and be queued; "
                        "floor counts the cache lost")
        if "fast-mode" in on:
            tips.append("fast mode (/fast) is where paying more fits: blocking-now and someone waiting")
        return {"sessions": len(items), "spend": round(spend, 4), "settings": settings, "flags": flags, "tips": tips,
                "methods": {k: {"sessions": v["sessions"], "spendShare": round(v["spend"] / spend, 3) if spend else 0,
                                "saving": round(v["saving"], 4), "label": LABEL[k], "recommended": k in on}
                            for k, v in sorted(m.items(), key=lambda kv: -kv[1]["saving"])}}

    return {cwd: one(items) for cwd, items in groups.items()}


def shell_path(cwd):
    if not cwd.startswith("~"):
        return shlex.quote(cwd)
    rest = cwd[1:]
    for ch in '\\"$`':
        rest = rest.replace(ch, "\\" + ch)
    return f'"$HOME{rest}"'


def script(rec, scored, arm, d, generated):
    rerun = [s for s, labels, _ in scored if labels.get("capability", "unclear") == "unclear"]
    batch = [s for s, _, sv in scored if any(r["id"] == "batch" and r["unlocked"] for r in sv["methods"])]
    opt_home = os.environ.get("OPT_HOME") or str(EXP.parents[1] / "app")
    L = []
    w = L.append
    w("#!/usr/bin/env bash")
    w(f"# Generated {generated[:16]}Z by experiments/session-triage/src/recommend.py from arm `{arm}`,")
    w(f"# {rec['*']['sessions']} sessions, {usd(rec['*']['spend'])} at list rates. Savings below are headroom")
    w("# estimates (priced = list-rate ceiling, guess = stated assumption), not measurements.")
    w("#   ./apply.sh                    plan: print every step, change nothing")
    w("#   ./apply.sh apply              run the claude, llm and other sections")
    w("#   ./apply.sh apply claude llm   run only those sections")
    w("set -euo pipefail")
    w('GO=0; if [ "${1:-}" = apply ]; then GO=1; shift; fi')
    w('SECTIONS=" ${*:-claude llm other} "')
    w('want() { case "$SECTIONS" in *" $1 "*) return 0;; esac; return 1; }')
    w('run() { if [ "$GO" = 1 ]; then echo "+ $*"; "$@"; else echo "  would run: $*"; fi; }')
    w(f"EXP={shlex.quote(str(EXP))}")
    w(f"OUT={shlex.quote(str(d))}")
    w("")
    w("merge() {  # merge a JSON fragment into a settings file; back the file up first")
    w("  python3 - \"$1\" \"$2\" <<'PY'")
    w("import json, pathlib, shutil, sys, time")
    w("dst, frag = pathlib.Path(sys.argv[1]), json.loads(sys.argv[2])")
    w("cur = json.loads(dst.read_text()) if dst.exists() else {}")
    w("if dst.exists():")
    w("    shutil.copy2(dst, dst.with_name(dst.name + f'.bak-{int(time.time())}'))")
    w("for k, v in frag.items():")
    w("    cur[k] = {**cur[k], **v} if isinstance(v, dict) and isinstance(cur.get(k), dict) else v")
    w("dst.parent.mkdir(parents=True, exist_ok=True)")
    w("dst.write_text(json.dumps(cur, indent=2) + '\\n')")
    w("print(f'  merged into {dst}')")
    w("PY")
    w("}")
    w("")
    w("if want claude; then")
    w('  echo "== claude: Claude Code settings per project"')
    any_proj = False
    for cwd, r in sorted(rec.items(), key=lambda kv: -kv[1]["spend"]):
        if cwd == "*" or not (r["settings"] or r["flags"] or r["tips"]):
            continue
        any_proj = True
        P = shell_path(cwd)
        w(f"  # {cwd} — {r['sessions']} sessions, {usd(r['spend'])}")
        w(f"  echo {shlex.quote('- ' + cwd + ' (' + str(r['sessions']) + ' sessions, ' + usd(r['spend']) + ')')}")
        for k, m in r["methods"].items():
            if m["recommended"]:
                w(f"  #   {k}: {m['sessions']} sessions, {round(100 * m['spendShare'])}% of spend, saving {usd(m['saving'])} ({m['label']})")
        if r["settings"]:
            frag = json.dumps(r["settings"], separators=(",", ":"))
            w(f"  if [ -d {P} ]; then run merge {P}/.claude/settings.local.json {shlex.quote(frag)}; "
              f"else echo \"  skip {cwd}: not on this machine\"; fi")
        if r["flags"]:
            w(f"  echo \"  launch with: (cd {cwd} && claude {' '.join(r['flags'])})   # flag from methods.py, unverified as a setting\"")
        for t in r["tips"]:
            w(f"  echo {shlex.quote('  ' + t)}")
    if not any_proj:
        w('  echo "  nothing reaches the --share threshold; try a lower --share or another arm"')
    g = rec["*"]
    if g["settings"]:
        w(f"  echo {shlex.quote('  overall (every project): ' + json.dumps(g['settings']) + ' — in ' + str(d / 'recommend' / 'settings.json'))}")
        w('  echo "  not written to ~/.claude/settings.json; merge it yourself if it holds everywhere"')
    w("fi")
    w("")
    w("if want llm; then")
    w('  echo "== llm: classify again (rules, + Jev when JEV_API_KEY is set)"')
    w('  if [ -z "${JEV_API_KEY:-}" ]; then echo "  JEV_API_KEY unset: rules only. Set it to add Jev — one paid call per session"; fi')
    w('  run python3 "$EXP/src/score.py" --days 30 --dir "$OUT"')
    w('  if [ -t 0 ]; then run python3 "$EXP/src/run.py" --mode interactive --limit 20 '
      '--ledger "$OUT/ledger.csv" --features "$OUT/features.jsonl" --out-dir "$OUT"')
    w('  else echo "  gold labels need a terminal: python3 $EXP/src/run.py --mode interactive"; fi')
    w('  run python3 "$EXP/src/recommend.py" --dir "$OUT"')
    w("fi")
    w("")
    w("if want other; then")
    w(f'  echo "== other: sandbox re-runs, batch candidates, follow-up"')
    w(f'  echo "  {len(rerun)} sessions have no answer to the model question; the sandbox re-run decides them"')
    w(f"  OPT_HOME=${{OPT_HOME:-{shlex.quote(opt_home)}}}")
    w('  if [ -f "$OPT_HOME/triage-rerun.mjs" ]; then run sh -c "cd \\"$OPT_HOME\\" && node triage-rerun.mjs"   # plan only; add --go yourself')
    w('  else echo "  triage-rerun.mjs not found under $OPT_HOME (expected app/ in this repo)"; fi')
    w(f'  echo "  {len(batch)} sessions unlocked batch: re-launch them headless with claude -p and queue them"')
    w(f'  echo "  in a week, compare: python3 {REPO}/tools/savings.py --days 7  (arms to each other, n >= 3 runs)"')
    w("fi")
    return "\n".join(L) + "\n"


def copy(text):
    for cmd in (["pbcopy"], ["wl-copy"], ["xclip", "-selection", "clipboard"]):
        if shutil.which(cmd[0]):
            subprocess.run(cmd, input=text.encode(), check=True)
            return cmd[0]
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=str(PRIV), help="where run.py wrote results.json (data/ for the pinned run)")
    ap.add_argument("--arm", default=None, help="arm to read labels from (default: " + " > ".join(ARMS) + ")")
    ap.add_argument("--share", type=float, default=0.5, help="share of a project's spend a method must unlock")
    ap.add_argument("--out", default=str(PRIV / "recommend"))
    ap.add_argument("--copy", choices=("settings", "script"), default=None)
    a = ap.parse_args()
    d = pathlib.Path(a.dir).resolve()
    results = json.loads((d / "results.json").read_text())
    arm = pick_arm(results, a.arm)
    scored = score_sessions(results, arm, d)
    if not scored:
        sys.exit(f"arm {arm} has no labelled sessions")
    rec = recommend(scored, a.share)
    generated = datetime.now(timezone.utc).isoformat()

    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    settings = json.dumps(rec["*"]["settings"], indent=2) + "\n"
    (out / "settings.json").write_text(settings)
    (out / "recommend.json").write_text(json.dumps({"generatedAt": generated, "arm": arm, "share": a.share,
                                                    "source": str(d), "projects": rec}, indent=1))
    sh = script(rec, scored, arm, d, generated)
    (out / "apply.sh").write_text(sh)
    (out / "apply.sh").chmod(0o755)

    g = rec["*"]
    print(f"arm {arm} · {g['sessions']} sessions · {usd(g['spend'])} · a method is recommended at ≥{a.share:.0%} of spend\n")
    print(f"{'method':12s} {'sessions':>8s} {'spend %':>8s} {'saving':>10s}  label")
    for k, m in g["methods"].items():
        print(f"{k:12s} {m['sessions']:8d} {100 * m['spendShare']:7.0f}% {usd(m['saving']):>10s}  {m['label']}"
              + ("  ← recommended" if m["recommended"] else ""))
    print("\nsavings are per-method marginal headroom (batch at its floor), not measurements; fast-mode is spend")
    print(f"\noverall settings: {json.dumps(g['settings']) or '{}'}" + (f"   flags: {' '.join(g['flags'])}" if g["flags"] else ""))
    print(f"wrote {out / 'settings.json'}, {out / 'recommend.json'}, {out / 'apply.sh'}")
    print(f"next: {out / 'apply.sh'}          # plan — then add `apply` to run it")
    if a.copy:
        text = settings if a.copy == "settings" else sh
        how = copy(text)
        print(f"copied {a.copy} to the clipboard ({how})" if how else "no clipboard tool found; printed below\n" + text)


if __name__ == "__main__":
    main()
