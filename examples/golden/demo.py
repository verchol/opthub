#!/usr/bin/env python3
"""Golden demo — synthetic sessions through the real pipeline, best vs dynamic parameters.

    python3 examples/golden/demo.py              # offline: free, deterministic, ~2 s
    python3 examples/golden/demo.py --check      # ... and diff every step against expected/
    python3 examples/golden/demo.py --update     # ... and rewrite expected/ (after a deliberate change)
    python3 examples/golden/demo.py --live --yes # replay for real in the Docker sandbox — spends money

Five steps, each a real tool run as a subprocess, so every command printed here is one
you can run yourself against your own sessions (drop the env vars):

  1 inspect   tools/sessions.py   what ran, what it cost
  2 classify  tools/savings.py    where the money went, headroom per lever
  3 decide    tools/tune.py       dynamic flags for each session, next to the goal's best preset
  4 verify    tools/rerun.py plan --dynamic, then run + judge
              (offline: synth.simulate() stands in for run + judge and says so everywhere)
  5 compare   tools/rerun.py report   one verdict per candidate arm

Then it writes summary.json and how-it-works.html (the "how it works" page, with this
run's numbers). Offline numbers are SYNTHETIC: read them to learn the pipeline, never quote them.
"""
import argparse, difflib, json, os, re, shlex, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(HERE, "out")
EXPECTED = os.path.join(HERE, "expected")
REPO = os.path.join(HERE, "repo")
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, "tools"))
import rerun, synth  # noqa: E402

ENV = dict(os.environ, TZ="UTC", OPTHUB_PROJECTS=os.path.join(OUT, "projects"),
           OPTHUB_RERUNS=os.path.join(OUT, "reruns"), PYTHONDONTWRITEBYTECODE="1")
SINCE = "2026-10-01"
TOOLS = "tools"


def tool(step, *argv, record=True, echo=True):
    """Run one tool, echo it, keep its output for the golden check."""
    cmd = [sys.executable, os.path.join(ROOT, TOOLS, argv[0])] + list(argv[1:])
    shown = "python3 " + shlex.join([f"{TOOLS}/{argv[0]}"] + list(argv[1:])).replace(ROOT + "/", "")
    if echo:
        print(f"\n$ {shown}")
    r = subprocess.run(cmd, cwd=ROOT, env=ENV, capture_output=True, text=True)
    text = re.sub(r"\(\d+d old\)", "(<age>)", (r.stdout + r.stderr).replace(ROOT, "<repo>"))
    if echo or r.returncode:
        print(text.rstrip())
    if r.returncode:
        sys.exit(f"{argv[0]} failed (exit {r.returncode})")
    if record:
        LOG.setdefault(step, []).append(f"$ {shown}\n{text}")
    return r.stdout


def head(n, name, what):
    print(f"\n{'=' * 78}\n{n}  {name.upper()} — {what}\n{'=' * 78}")


LOG = {}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--check", action="store_true", help="diff each step's output against expected/")
    ap.add_argument("--update", action="store_true", help="rewrite expected/ from this run")
    ap.add_argument("--live", action="store_true", help="replay for real (Docker sandbox, claude -p); needs --yes")
    ap.add_argument("--yes", action="store_true")
    ap.add_argument("--repeats", type=int, default=3)
    a = ap.parse_args()
    if a.live and not a.yes:
        sys.exit("--live replays 3 sessions x up to 3 arms x repeats with claude -p and spends money — add --yes")
    if a.live and (a.check or a.update):
        sys.exit("--check/--update compare the deterministic offline run; not with --live")

    shutil.rmtree(OUT, ignore_errors=True)
    ids = synth.write_sessions(ENV["OPTHUB_PROJECTS"], REPO)
    print(f"wrote {len(ids)} synthetic sessions to examples/golden/out/projects "
          f"(fixture repo examples/golden/repo) — SYNTHETIC, no real prompts or paths")

    head(1, "inspect", "what ran and what it cost")
    tool("1-inspect", "sessions.py", "--root", ENV["OPTHUB_PROJECTS"], "--since", SINCE, "--sort", "cost", "--full-id")

    head(2, "classify", "where the money went, headroom per lever (priced / guess / detector)")
    tool("2-classify", "savings.py", "--root", ENV["OPTHUB_PROJECTS"], "--since", SINCE)

    head(3, "decide", "best preset vs dynamic parameters, per session")
    best = rerun.GOALS["cost"]["flags"]
    print(f"best (goal 'cost' preset, same for every session): {' '.join(best)}")
    decisions = {}
    for key, sid in ids.items():
        decisions[key] = json.loads(tool("3-decide", "tune.py", sid, "--json", record=False, echo=False))
        tool("3-decide", "tune.py", sid)

    head(4, "verify", "replay every arm 3x, judge blind" + ("" if a.live else " — SIMULATED offline"))
    runs = {}
    for key, sid in ids.items():
        rid = f"golden-{key}"
        tool("4-verify", "rerun.py", "plan", sid, "--goal", "cost", "--dynamic", "--repeats", str(a.repeats),
             "--from-dir", "--run-id", rid, "--test-cmd", "python3 -m unittest -q")
        plan = os.path.join(ENV["OPTHUB_RERUNS"], rid, "plan.json")
        if a.live:
            tool("4-verify", "rerun.py", "run", rid, "--yes", record=False)
            tool("4-verify", "rerun.py", "judge", rid, "--yes", record=False)
        else:
            synth.simulate(plan, ENV["OPTHUB_PROJECTS"])
            print(f"simulated: {rid} — arms, diffs and judge scores from examples/golden/synth.py")
        runs[key] = rid

    head(5, "compare", "one verdict per candidate arm, against the baseline arm")
    for key, rid in runs.items():
        tool("5-compare", "rerun.py", "report", rid)

    summary = build_summary(ids, decisions, runs, best, simulated=not a.live)
    json.dump(summary, open(os.path.join(OUT, "summary.json"), "w"), indent=2)
    page = os.path.join(HERE, "how-it-works.html")
    if not a.live:                    # the committed page carries the deterministic offline numbers
        tpl = open(os.path.join(HERE, "how-it-works.template.html")).read()
        open(page, "w").write(tpl.replace("/*__DATA__*/null", json.dumps(summary, separators=(",", ":"))))
    print_summary(summary)
    print(f"\nreports : examples/golden/out/reruns/golden-*/report.html")
    print(f"page    : examples/golden/how-it-works.html")

    if a.update:
        shutil.rmtree(EXPECTED, ignore_errors=True)
        os.makedirs(EXPECTED)
        for step, chunks in LOG.items():
            open(os.path.join(EXPECTED, f"{step}.txt"), "w").write("\n".join(chunks))
        json.dump(summary, open(os.path.join(EXPECTED, "summary.json"), "w"), indent=2)
        print(f"updated : examples/golden/expected/ ({len(LOG) + 1} files)")
    if a.check:
        sys.exit(check(summary))


def build_summary(ids, decisions, runs, best, simulated):
    out = dict(simulated=simulated, best=best, sessions=[])
    for key, sid in ids.items():
        d = os.path.join(ENV["OPTHUB_RERUNS"], runs[key])
        p = json.load(open(os.path.join(d, "plan.json")))
        rerun.OUT = ENV["OPTHUB_RERUNS"]
        arms, _ = rerun.collect(p)
        b = arms[0]
        s = synth.BY_KEY[key]
        prof = decisions[key]["profile"]
        out["sessions"].append(dict(
            key=key, sid=sid, prompts=s["prompts"], files=s["files"],
            profile={k: prof[k] for k in ("model", "effort", "reqs", "ctx_p50", "think_share", "files_edited")},
            dynamic=decisions[key]["flags"], why=decisions[key]["why"],
            arms=[dict(name=x["name"], flags=x["flags"], n=x["n"], cost=round(x["cost"], 4),
                       quality=x["quality"], done=round(x["done"], 3), wall=x["wall"], reqs=x["reqs"],
                       out_tok=x["out_tok"],
                       verdict=None if x is b else rerun.verdict_one(p, b, x)) for x in arms]))
    return out


def print_summary(s):
    print(f"\n{'=' * 78}\nSUMMARY — goal cost{'  [SIMULATED]' if s['simulated'] else ''}\n{'=' * 78}")
    print(f"{'session':<14} {'arm':<9} {'flags':<46} {'cost':>7} {'q/60':>5} {'done':>5}  verdict")
    for x in s["sessions"]:
        for arm in x["arms"]:
            q = f"{arm['quality']:.0f}" if arm["quality"] is not None else "–"
            v = "" if arm["verdict"] is None else ("WINS" if " wins " in arm["verdict"] else "does not clear")
            print(f"{x['key']:<14} {arm['name']:<9} {' '.join(arm['flags']):<46} ${arm['cost']:>6.2f} {q:>5} "
                  f"{arm['done'] * 100:>4.0f}%  {v}")


def norm(text):
    return re.sub(r"[ \t]+\n", "\n", text)


def check(summary):
    if not os.path.isdir(EXPECTED):
        print("no expected/ yet — run with --update first")
        return 1
    bad = 0
    got = {step: "\n".join(chunks) for step, chunks in LOG.items()}
    got["summary.json"] = json.dumps(summary, indent=2)
    for step, text in got.items():
        name = step if step.endswith(".json") else f"{step}.txt"
        path = os.path.join(EXPECTED, name)
        want = open(path).read() if os.path.exists(path) else ""
        if norm(want) != norm(text):
            bad += 1
            print(f"\nDIFF {name}:")
            sys.stdout.writelines(list(difflib.unified_diff(want.splitlines(True), text.splitlines(True),
                                                            "expected", "got", n=1))[:40])
    print(f"\ngolden check: {len(got) - bad}/{len(got)} match" + ("" if not bad else " — see diffs above"))
    return 1 if bad else 0


if __name__ == "__main__":
    main()
