#!/usr/bin/env python3
"""Score every recent session for every optimization method — the Hub's "Score with Jev" button.

    python3 src/score.py --days 30                       # rules only when JEV_API_KEY is unset
    JEV_API_KEY=... python3 src/score.py --days 30       # + Jev, one paid call per session (C1 only)
    python3 src/score.py --days 30 --out /tmp/triage.json --dir /tmp/run   # anywhere but the live files
    python3 src/score.py --days 30 --mode interactive --limit 10  # you label the top 10 between steps 4 and 5

One pass, in order, over the live transcripts on this machine:

  1. tools/savings.py   ledger: tokens and dollars per session          (local)
  2. extract.py         counts, flags and Claude Code settings          (local)
  3. tasks.py           task titles for split sessions                  (local, never sent)
  4. run.py             rules, then Jev on the C1 evidence              (one Jev call per session)
  5. export_hub.py      per-method scores and savings -> triage.json    (local)

Before step 1 overwrites anything, the previous run in --dir is copied to
--dir/archive-<its timestamp>/, so a paid Jev run is never lost to the next one.
Everything lands in data/private/ (gitignored): it describes live sessions.
"""

import argparse
import os
import pathlib
import shutil
import subprocess
import sys
import time
from datetime import datetime

HERE = pathlib.Path(__file__).resolve().parent
EXP = HERE.parent
REPO = EXP.parents[1]
FILES = ("ledger.csv", "features.jsonl", "tasks.jsonl", "results.json", "RESULTS.md", "gold.jsonl")


def archive(d: pathlib.Path):
    old = d / "results.json"
    if not old.exists():
        return
    stamp = datetime.fromtimestamp(old.stat().st_mtime).strftime("%Y-%m-%dT%H%M")
    dest = d / f"archive-{stamp}"
    if dest.exists():
        return
    dest.mkdir()
    for f in FILES:
        if (d / f).exists():
            shutil.copy2(d / f, dest / f)
    print(f"archived the previous run to {dest.name}/", flush=True)


def step(n, title, cmd):
    print(f"\n[{n}/5] {title}", flush=True)
    t0 = time.time()
    r = subprocess.run([sys.executable, *map(str, cmd)], cwd=EXP)
    if r.returncode:
        print(f"[{n}/5] failed (exit {r.returncode})", flush=True)
        sys.exit(r.returncode)
    print(f"[{n}/5] done in {time.time() - t0:.0f}s", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--dir", default=str(EXP / "data" / "private"))
    ap.add_argument("--out", default=None, help="triage.json for the hub (default: export_hub.py's)")
    ap.add_argument("--mode", choices=("auto", "interactive"), default="auto",
                    help="interactive: label sessions yourself at step 4 (needs a terminal; the hub uses auto)")
    ap.add_argument("--limit", type=int, default=20, help="interactive: sessions to ask about")
    a = ap.parse_args()
    d = pathlib.Path(a.dir)
    d.mkdir(parents=True, exist_ok=True)
    jev = bool(os.environ.get("JEV_API_KEY"))
    print(f"scoring the last {a.days} days · classifier: {'Jev (jev-1.13.0), C1 evidence' if jev else 'rules only — JEV_API_KEY is not set'}", flush=True)
    archive(d)
    step(1, "ledger", [REPO / "tools" / "savings.py", "--days", a.days, "--top", 0, "--csv", d / "ledger.csv"])
    step(2, "session features + Claude Code settings", [HERE / "extract.py", "--days", a.days, "--out", d / "features.jsonl"])
    step(3, "task titles (local only)", [HERE / "tasks.py", "--days", a.days, "--out", d / "tasks.jsonl"])
    step(4, "classify: rules" + (" + Jev" if jev else ""),
         [HERE / "run.py", "--ledger", d / "ledger.csv", "--features", d / "features.jsonl",
          "--arms", "rules,jev" if jev else "rules", "--ctx", "C1", "--out-dir", d,
          "--mode", a.mode, "--limit", a.limit, "--gold", d / "gold.jsonl"])
    step(5, "score methods, write triage.json", [HERE / "export_hub.py", "--dir", d, *(["--out", a.out] if a.out else [])])
    print(f"\nnext: python3 src/recommend.py --dir {d}   # settings + apply.sh from this run", flush=True)
    print("\nscoring done", flush=True)


if __name__ == "__main__":
    main()
