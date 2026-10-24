"""synth — synthetic Claude Code sessions and simulated replays for the golden demo.

Everything here is SYNTHETIC. Nothing is measured, and no number this module
produces may be quoted outside examples/golden. It exists so the real tools —
sessions.py, savings.py, tune.py, rerun.py — can be run end to end, for free and
deterministically, on transcripts that contain no one's prompts or paths.

Two halves:

  write_sessions()  three original sessions in Claude Code's transcript format,
                    against the fixture repo in examples/golden/repo. Their shapes
                    are chosen so best and dynamic parameters disagree.
  simulate()        stands in for `rerun.py run` + `judge`: writes, for every arm
                    and repeat of a plan, a replay transcript, a diff and a
                    result.json measured by rerun.measure(), plus a judge.json.

The simulator's model of the world (the only invented part):

  * Each session has a difficulty d in [0, 1]. A setting has a capability c:
    opus 1.00, sonnet 0.70, haiku 0.30, plus effort low -0.15, medium -0.05,
    high 0, max +0.05. Quality (judge total /60) loses 20 * max(0, d - c).
  * A loss above 3 points fails the tests on one repeat in three.
  * Tokens: a replay sends ~55% of the original's requests; thinking scales with
    effort (low 0.35, medium 0.6, high 1, max 1.4); smaller models take a few
    more requests. Cost is then priced by rerun.measure() from the transcript,
    exactly as for a real replay.
"""
import datetime as dt, json, os, random, sys, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "tools"))
import rerun  # noqa: E402

NS = uuid.UUID("6f1d2a9e-0d6b-4d1e-9f57-2b3c4d5e6f70")
OPUS, SONNET, HAIKU = "claude-opus-5-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"
CAP = {OPUS: 1.0, SONNET: 0.70, HAIKU: 0.30}
EFFORT_CAP = {"low": -0.15, "medium": -0.05, "high": 0.0, "max": 0.05, None: 0.0}
EFFORT_THINK = {"low": 0.35, "medium": 0.6, "high": 1.0, "max": 1.4, None: 1.0}
MODEL_REQS = {OPUS: 1.0, SONNET: 1.1, HAIKU: 1.25}
MODEL_SECS = {OPUS: 1.0, SONNET: 0.7, HAIKU: 0.4}

SESSIONS = [
    dict(key="fix-rounding", start="2026-10-02T09:12:00+00:00", reqs=9, ctx=(24_000, 38_000),
         out=700, think=0.62, d=0.10, q0=51, files=["invoice.py"],
         prompts=["invoice.total() is a cent off for some carts — tests/test_invoice.py shows it. Fix it.",
                  "Run the tests and confirm."]),
    dict(key="csv-export", start="2026-10-03T14:05:00+00:00", reqs=24, ctx=(52_000, 118_000),
         out=1100, think=0.34, d=0.60, q0=49, files=["report.py", "cli.py", "tests/test_report.py", "README.md"],
         prompts=["Add a CSV export to the monthly report: report.to_csv(rows) and a --csv flag on cli.py.",
                  "Add a test that the CSV round-trips through the csv module.",
                  "Document the flag in README.md."]),
    dict(key="slow-report", start="2026-10-06T08:30:00+00:00", reqs=44, ctx=(140_000, 320_000),
         out=1500, think=0.56, d=0.85, q0=47, files=["report.py", "ledger.py", "tests/test_report.py"],
         prompts=["`python3 cli.py 200000` takes far too long. Find out why.",
                  "Make report.monthly() linear without changing its output. Prove the output is identical.",
                  "Add a test that guards against the quadratic version coming back."]),
]
BY_KEY = {s["key"]: s for s in SESSIONS}

PATCH = {
    "fix-rounding": [("invoice.py", 2, 2)],
    "csv-export": [("report.py", 14, 0), ("cli.py", 6, 2), ("tests/test_report.py", 12, 0), ("README.md", 4, 0)],
    "slow-report": [("report.py", 11, 4), ("tests/test_report.py", 16, 0)],
}


def sid_of(key, arm="original", k=0):
    return str(uuid.uuid5(NS, f"{key}/{arm}/{k}"))


def ts(t):
    return t.isoformat().replace("+00:00", "Z")


def usage(ctx, prev, out, think):
    write = ctx - prev if prev else ctx
    return {"input_tokens": 6, "cache_read_input_tokens": prev, "cache_creation_input_tokens": write,
            "cache_creation": {"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": write},
            "output_tokens": out,
            "output_tokens_details": {"thinking_tokens": think, "reasoning_tokens": think}}


def transcript(path, sid, cwd, start, prompts, model, effort, reqs, ctx, out, think_share, files, rng, secs=9.0):
    """One session: prompts spread over `reqs` requests, context growing ctx[0] -> ctx[1]."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    t, prev, rows = start, 0, []
    per_prompt = max(1, reqs // len(prompts))
    base = dict(sessionId=sid, cwd=cwd, entrypoint="cli", version="2.4.0", gitBranch="main")
    for i in range(reqs):
        if i % per_prompt == 0 and i // per_prompt < len(prompts):
            t += dt.timedelta(seconds=rng.randint(40, 200) if i else 0)
            rows.append(dict(base, type="user", timestamp=ts(t), uuid=str(uuid.UUID(int=rng.getrandbits(128))),
                             effort=effort, message={"role": "user", "content": prompts[i // per_prompt]}))
        c = int(ctx[0] + (ctx[1] - ctx[0]) * i / max(1, reqs - 1) * rng.uniform(0.95, 1.05))
        c = max(c, prev + 400)
        o = int(out * rng.uniform(0.8, 1.2))
        th = int(o * think_share)
        f = files[(i // 3) % len(files)]
        tool = ("Edit", {"file_path": os.path.join(cwd, f), "old_string": "…", "new_string": "…"}) \
            if i % 3 == 2 else (("Read", {"file_path": os.path.join(cwd, f)}) if i % 3 == 0
                                else ("Bash", {"command": "python3 -m unittest -q"}))
        t += dt.timedelta(seconds=secs * rng.uniform(0.7, 1.3) * (1 + th / 2000))
        tu = str(uuid.UUID(int=rng.getrandbits(128)))
        rows.append(dict(base, type="assistant", timestamp=ts(t), uuid=str(uuid.UUID(int=rng.getrandbits(128))),
                         message={"role": "assistant", "model": model, "usage": usage(c, prev, o, th),
                                  "content": [{"type": "tool_use", "id": tu, "name": tool[0], "input": tool[1]}]}))
        t += dt.timedelta(seconds=rng.uniform(0.5, 3))
        rows.append(dict(base, type="user", timestamp=ts(t), uuid=str(uuid.UUID(int=rng.getrandbits(128))),
                         message={"role": "user", "content": [{"type": "tool_result", "tool_use_id": tu, "content": "ok"}]}))
        prev = c
    with open(path, "w") as fh:
        for r in rows:
            fh.write(json.dumps(r, separators=(",", ":")) + "\n")
    return (t - start).total_seconds()


def project_dir(projects, cwd):
    return os.path.join(projects, "".join(ch if ch.isalnum() else "-" for ch in cwd))


def write_sessions(projects, repo):
    """The three originals. Returns {key: session id}."""
    ids = {}
    for s in SESSIONS:
        sid = sid_of(s["key"])
        rng = random.Random(s["key"])
        transcript(os.path.join(project_dir(projects, repo), f"{sid}.jsonl"), sid, repo,
                   dt.datetime.fromisoformat(s["start"]), s["prompts"], OPUS, "high",
                   s["reqs"], s["ctx"], s["out"], s["think"], s["files"], rng)
        ids[s["key"]] = sid
    return ids


def setting(flags):
    f = dict(zip(flags[::2], flags[1::2]))
    return f.get("--model", OPUS), f.get("--effort")


def loss(s, model, effort):
    return 20 * max(0.0, s["d"] - (CAP.get(model, 1.0) + EFFORT_CAP.get(effort, 0.0)))


def diff_for(s, lost):
    """A diff shaped like the session's change; a lossy arm skips the last file (usually the test)."""
    files = PATCH[s["key"]][:-1] if lost > 3 and len(PATCH[s["key"]]) > 1 else PATCH[s["key"]]
    out = []
    for f, adds, dels in files:
        out += [f"diff --git a/{f} b/{f}", f"--- a/{f}", f"+++ b/{f}", f"@@ -1,{dels} +1,{adds} @@"]
        out += [f"-removed line {i}" for i in range(dels)] + [f"+added line {i}" for i in range(adds)]
    stat = dict(files=len(files), adds=sum(a for _, a, _ in files), dels=sum(d for _, _, d in files))
    return "\n".join(out) + "\n", stat


def simulate(plan_path, projects):
    """Write arms/<arm>/<k>/{diff.patch,result.json} and judge.json for one plan."""
    p = json.load(open(plan_path))
    d = os.path.dirname(plan_path)
    s = next(x for x in SESSIONS if sid_of(x["key"]) == p["session"])
    noise = [random.Random(f"{s['key']}/task/{k}").choice([-1, 0, 0, 1]) for k in range(p["repeats"])]
    quality = {}
    for arm in p["arms"]:
        model, effort = setting(arm["flags"])
        lost = loss(s, model, effort)
        for k in range(p["repeats"]):
            rng = random.Random(f"{s['key']}/{arm['name']}/{k}")
            sid = sid_of(s["key"], arm["name"], k)
            task = random.Random(f"{s['key']}/reqs/{k}").uniform(0.9, 1.1)   # same task draw for every arm
            reqs = max(3, round(s["reqs"] * 0.55 * MODEL_REQS.get(model, 1.0) * task))
            secs = 9.0 * MODEL_SECS.get(model, 1.0)
            think = s["out"] * s["think"] * EFFORT_THINK.get(effort, 1.0)       # effort scales thinking only
            out = s["out"] * (1 - s["think"]) + think
            repo = os.path.join(d, "arms", arm["name"], str(k), "repo")
            wall = transcript(os.path.join(project_dir(projects, repo), f"{sid}.jsonl"),
                              sid, repo, dt.datetime.fromisoformat(s["start"]) + dt.timedelta(days=14),
                              p["prompts"], model, effort, reqs, s["ctx"], out, think / out, s["files"], rng, secs)
            diff, stat = diff_for(s, lost)
            cell = os.path.join(d, "arms", arm["name"], str(k))
            os.makedirs(cell, exist_ok=True)
            open(os.path.join(cell, "diff.patch"), "w").write(diff)
            tests = not (lost > 3 and k == 1)
            res = dict(arm=arm["name"], repeat=k, session=sid, wall=round(wall, 1),
                       turns=[dict(turn=i, is_error=False) for i in range(len(p["prompts"]))],
                       errors=0, done=True, tests=tests, simulated=True,
                       workspace="fixture repo examples/golden/repo (simulated replay, nothing ran)",
                       sandbox="simulated — examples/golden/synth.py", **stat, **rerun.measure(sid, projects))
            json.dump(res, open(os.path.join(cell, "result.json"), "w"), indent=2)
            quality.setdefault(arm["name"], {})[str(k)] = max(6, min(60, round(s["q0"] + noise[k] - lost)))
    base = p["arms"][0]["name"]
    scores, log = {}, []
    for arm in p["arms"][1:]:
        for k in range(p["repeats"]):
            for swap in (False, True):
                for name in (base, arm["name"]):
                    scores.setdefault(name, {}).setdefault(str(k), []).append(quality[name][str(k)])
                b, c = quality[base][str(k)], quality[arm["name"]][str(k)]
                log.append(dict(repeat=k, swap=swap, preferred=base if b > c else arm["name"] if c > b else "tie",
                                why="simulated"))
    json.dump(dict(judge=p["judge"] + " (simulated)", spent=0.0, simulated=True, scores=scores, log=log),
              open(os.path.join(d, "judge.json"), "w"), indent=2)
    p["simulated"] = True
    json.dump(p, open(plan_path, "w"), indent=2)
