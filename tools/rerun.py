#!/usr/bin/env python3
"""rerun — replay a real Claude Code session with new flags, judge it blind, draw the radar.

The one tool in tools/ that can spend money. `plan` and `report` never do;
`run` and `judge` call `claude -p` and refuse to start without --yes.

    python3 tools/rerun.py plan <session-id> --goal cost          # free: writes plan, prints commands
    python3 tools/rerun.py run    <run-id> --yes                  # replays every arm, every repeat
    python3 tools/rerun.py judge  <run-id> --yes                  # blind pairwise score of the diffs
    python3 tools/rerun.py report <run-id>                        # free: radar + tables -> report.html
    python3 tools/rerun.py go <session-id> --goal cost --repeats 3 --yes   # all four
    python3 tools/rerun.py plan <session-id> --goal cost --dynamic  # + a third arm, flags from tools/tune.py

How a run is built, and why:

  * Two arms, never one. `baseline` replays the session's prompts with the flags the
    original ran with (dominant model, last effort); the candidate replays the same
    prompts with the goal's flags. Arms are compared to each other, never to the
    original session (CLAUDE.md) — the original ran on a moving repo with a human
    in the loop, so its numbers are not a control.
  * Same start state. Each arm/repeat gets a fresh copy of the repo at the last
    commit before the session started (`git archive`), committed as `base`, so the
    final artifact is `git diff base` and is comparable across arms. Uncommitted
    work the original had is not recoverable; the report says so.
  * Same prompts, same order. Every human prompt of the original (slash commands
    rebuilt as `/name args`; tool results, bash echoes and task notifications
    dropped) is sent as one `claude -p` turn; turn 1 pins `--session-id`, later
    turns `--resume` it. Each arm/repeat is therefore a new session on this machine
    and shows up in tools/sessions.py and /lenops like any other.
  * Local Docker sandbox by default (--sandbox docker). Each arm/repeat gets one
    container from sandbox/docker/: read-only rootfs, no capabilities, uid 10001, an
    --internal network whose only way out is an allowlisting proxy (api.anthropic.com,
    Bedrock). The repo copy is the one writable mount, plus a per-cell $HOME so
    `--resume` finds the session between turns. Because the box is the boundary, the
    agent runs with bypassPermissions and can use Bash like the original did. After
    the run its transcript is copied into ~/.claude/projects, so it still shows up
    as a new session. --sandbox host runs `claude -p` directly (acceptEdits). Not E2B:
    no microVM, no sandbox spend, and a container shares the host kernel.
  * The judge is blind. It sees the task and two diffs labelled A and B, in random
    order, twice with positions swapped, never the arm names, flags or costs. Its
    model must not be one an arm runs on (SPEC §6.1.1). Its own cost is reported.
  * Best and dynamic. The goal arm runs the goal's preset — one fixed "best known"
    answer for every session. --dynamic adds a third arm whose flags tools/tune.py
    picks from this session's own measurements (context, thinking share, files
    edited). Each candidate gets its own verdict against the baseline.
  * Cost is `priced` — transcript tokens at list rates (tools/sessions.py), the
    same unit as every other number in docs/. n = 1 is not a finding: the report
    prints a verdict only at --repeats >= 3.

Everything lands in data/private/reruns/<run-id>/ (gitignored): prompts, diffs and
paths stay on this machine. OPTHUB_PROJECTS and OPTHUB_RERUNS relocate the transcript
store and the run directory (examples/golden uses both). Secrets come from the shell
or the repo's .env (tools/envfile.py).
"""
import argparse, datetime as dt, glob, html, json, math, os, random, re, shutil, statistics, subprocess, sys, time, uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sessions import PRICE, req_cost, DEFAULT_MODEL  # noqa: E402
import envfile, tune  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.environ.get("OPTHUB_RERUNS") or os.path.join(ROOT, "data", "private", "reruns")
PROJECTS = os.environ.get("OPTHUB_PROJECTS") or os.path.expanduser("~/.claude/projects")
JUDGE = "claude-opus-5"                       # SPEC §8 judge.pinned
CRITERIA = ["correctness", "completeness", "code_quality", "scope", "tests", "clarity"]

# Goal -> candidate flags and what "won" means. Each preset is one lever from
# docs/optimizers.md; --flags overrides the preset and keeps the goal's verdict rule.
GOALS = {
    "cost":    dict(flags=["--model", "claude-sonnet-5", "--effort", "medium"],
                    lever="model-downgrade + effort-tune", wins="cost lower, quality and done no worse"),
    "speed":   dict(flags=["--effort", "low"],
                    lever="effort-tune", wins="wall time lower, quality and done no worse"),
    "quality": dict(flags=["--effort", "max"],
                    lever="effort up", wins="quality higher, done no worse"),
}


# ----------------------------------------------------------------- transcript

def find_transcripts(sid, root=PROJECTS):
    """Main transcript plus any subagent files written beside it."""
    main = glob.glob(os.path.join(root, "*", f"{sid}.jsonl"))
    subs = glob.glob(os.path.join(root, "*", sid, "**", "*.jsonl"), recursive=True)
    return main + subs


def records(files):
    for f in files:
        for line in open(f, errors="replace"):
            if line.startswith("{"):
                try:
                    yield json.loads(line)
                except ValueError:
                    pass


def human_prompt(r):
    """The text a person typed, or None for machine-made user records."""
    if r.get("type") != "user" or r.get("isSidechain") or r.get("isMeta"):
        return None
    c = (r.get("message") or {}).get("content")
    if isinstance(c, list):
        if any(isinstance(b, dict) and b.get("type") == "tool_result" for b in c):
            return None
        c = "\n".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
    if not isinstance(c, str) or not c.strip():
        return None
    name = re.search(r"<command-name>(.*?)</command-name>", c, re.S)
    if name:                                   # slash command -> "/name args"
        args = re.search(r"<command-args>(.*?)</command-args>", c, re.S)
        return f"{name.group(1).strip()} {args.group(1).strip() if args else ''}".strip()
    if c.lstrip().startswith("<"):             # bash echo, task notification, caveat
        return None
    return c.strip()


def read_session(sid):
    files = find_transcripts(sid)
    if not files:
        sys.exit(f"no transcript for {sid} under {PROJECTS}")
    prompts, models, cwds, effort, start = [], {}, {}, None, None
    for r in records(files[:1]):
        ts = r.get("timestamp")
        if ts:
            t = dt.datetime.fromisoformat(ts.replace("Z", "+00:00"))
            start = t if start is None else min(start, t)
        if r.get("cwd"):
            cwds[r["cwd"]] = cwds.get(r["cwd"], 0) + 1
        if isinstance(r.get("effort"), str):
            effort = r["effort"]
        m = (r.get("message") or {}).get("model")
        if m and (r.get("message") or {}).get("usage") and not m.startswith("<"):
            models[m] = models.get(m, 0) + 1
        p = human_prompt(r)
        if p:
            prompts.append(p)
    return dict(sid=sid, prompts=prompts, start=start.isoformat() if start else None,
                cwd=max(cwds, key=cwds.get) if cwds else None,
                model=max(models, key=models.get) if models else DEFAULT_MODEL, effort=effort)


def measure(sid, root=PROJECTS):
    """Priced cost, tokens and cache share of a replayed session, from its transcript."""
    m = dict(reqs=0, cost=0.0, out_tok=0, in_tok=0, cache_read=0)
    for r in records(find_transcripts(sid, root)):
        u = (r.get("message") or {}).get("usage")
        if not u:
            continue
        m["reqs"] += 1
        m["cost"] += req_cost((r.get("message") or {}).get("model") or DEFAULT_MODEL, u)
        m["out_tok"] += u.get("output_tokens", 0)
        m["cache_read"] += u.get("cache_read_input_tokens", 0)
        m["in_tok"] += (u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0)
                        + u.get("cache_creation_input_tokens", 0))
    m["cache_hit"] = m["cache_read"] / m["in_tok"] if m["in_tok"] else 0.0
    return m


# ------------------------------------------------------------------ workspace

def sh(cmd, cwd=None, inp=None):
    return subprocess.run(cmd, cwd=cwd, input=inp, capture_output=True, text=True)


def snapshot(src, start_iso, dest, from_dir=False):
    """Copy the repo as it was when the session started into dest, committed as `base`."""
    os.makedirs(dest)
    note = None
    commit = None
    if not from_dir and sh(["git", "-C", src, "rev-parse", "--git-dir"]).returncode == 0:
        commit = sh(["git", "-C", src, "rev-list", "-1", f"--before={start_iso}", "HEAD"]).stdout.strip()
    if commit:
        tar = subprocess.run(["git", "-C", src, "archive", commit], capture_output=True)
        subprocess.run(["tar", "-x", "-C", dest], input=tar.stdout, check=True)
        note = f"last commit before session start ({commit[:10]}); uncommitted work at the time is not included"
    else:
        shutil.copytree(src, dest, dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns(".git", "node_modules", ".venv", "venv", "__pycache__"))
        note = "copy of the directory as it is today, not as it was when the session started"
    g = ["git", "-c", "user.name=rerun", "-c", "user.email=rerun@localhost"]
    sh(g + ["init", "-q"], dest)
    sh(g + ["add", "-A"], dest)
    sh(g + ["commit", "-qm", "base", "--allow-empty"], dest)
    return note


def artifact(dest):
    sh(["git", "add", "-A"], dest)
    diff = sh(["git", "diff", "--cached", "HEAD"], dest).stdout
    files = adds = dels = 0
    for line in sh(["git", "diff", "--cached", "--numstat", "HEAD"], dest).stdout.splitlines():
        a, d, _ = line.split("\t", 2)
        files += 1
        adds += int(a) if a.isdigit() else 0
        dels += int(d) if d.isdigit() else 0
    return diff, dict(files=files, adds=adds, dels=dels)


# -------------------------------------------------------------------- sandbox
# The Docker provider in sandbox/docker/, driven from Python: the same names and images as
# sandbox.sh there, so a box built or started by either is reused by the other.

SBX_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "sandbox", "docker")
NET_INT, NET_OUT, PROXY = "opthub-sbx-internal", "opthub-sbx-egress", "opthub-egress"
AGENT_IMG, PROXY_IMG = "opthub/agent:0.1", "opthub/egress:0.1"
# The box authenticates with the subscription OAuth token only. An API key is never
# handed in: Claude Code prefers it over OAuth, which would silently bill the API.
AUTH_ENV = "CLAUDE_CODE_OAUTH_TOKEN"
BOX_WORK, BOX_HOME = "/work/out", "/home/agent"


def docker_ready():
    """Images built, networks present, proxy running, a credential to hand in. Exits if not."""
    if shutil.which("docker") is None or sh(["docker", "info"]).returncode != 0:
        sys.exit("docker is not running — start it, or pass --sandbox host")
    if not os.environ.get(AUTH_ENV):
        sys.exit(f"the sandbox cannot read your keychain login: run `claude setup-token`,\n"
                 f"export {AUTH_ENV}=<token>, then re-run")
    for img, df in ((AGENT_IMG, "Dockerfile.agent"), (PROXY_IMG, "Dockerfile.egress")):
        if sh(["docker", "image", "inspect", img]).returncode != 0:
            print(f"building {img} ...")
            if subprocess.run(["docker", "build", "-f", os.path.join(SBX_DIR, df), "-t", img, SBX_DIR]).returncode:
                sys.exit(f"docker build of {img} failed")
    if sh(["docker", "network", "inspect", NET_INT]).returncode:
        sh(["docker", "network", "create", "--internal", NET_INT])
    if sh(["docker", "network", "inspect", NET_OUT]).returncode:
        sh(["docker", "network", "create", NET_OUT])
    if sh(["docker", "inspect", "-f", "{{.State.Running}}", PROXY]).stdout.strip() != "true":
        # Start on the network with a route out, then attach the internal one under
        # the alias the agent resolves; the other order fails (template README).
        sh(["docker", "rm", "-f", PROXY])
        sh(["docker", "run", "-d", "--name", PROXY, "--network", NET_OUT, "--restart", "unless-stopped", PROXY_IMG])
        sh(["docker", "network", "connect", "--alias", "egress", NET_INT, PROXY])
        for _ in range(20):
            if sh(["docker", "inspect", "-f", "{{.State.Running}}", PROXY]).stdout.strip() == "true":
                break
            time.sleep(0.5)
        else:
            sys.exit("egress proxy failed to start:\n" + sh(["docker", "logs", PROXY]).stderr[-500:])


class Box:
    """One long-lived container per arm/repeat; each prompt is a `docker exec`."""

    def __init__(self, name, repo, home):
        self.name = name
        os.makedirs(home, exist_ok=True)
        if sys.platform.startswith("linux"):     # bind mounts keep host uids on Linux
            sh(["chmod", "-R", "a+rwX", repo, home])
        proxy = "http://egress:8888"
        cmd = ["docker", "run", "-d", "--name", name, "--network", NET_INT, "--read-only",
               "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m",
               "--mount", f"type=bind,source={repo},target={BOX_WORK}",
               "--mount", f"type=bind,source={home},target={BOX_HOME}",
               "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
               "--pids-limit", "512", "--memory", "4g", "--cpus", "4", "-w", BOX_WORK]
        for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
            cmd += ["-e", f"{k}={proxy}"]
        cmd += ["-e", "NO_PROXY=localhost,127.0.0.1"]
        cmd += ["-e", AUTH_ENV]                  # by name only: the value never hits argv
        sh(["docker", "rm", "-f", name])
        r = sh(cmd + [AGENT_IMG, "sleep", "infinity"])
        if r.returncode:
            sys.exit(f"sandbox failed to start: {r.stderr.strip()[-400:]}")
        self.version = self.exec(["claude", "--version"]).stdout.strip()

    def exec(self, argv):
        return sh(["docker", "exec", "-w", BOX_WORK, self.name] + argv)

    def stop(self):
        sh(["docker", "rm", "-f", self.name])


def publish_transcript(sid, home, repo):
    """Copy a sandboxed session into ~/.claude/projects so sessions.py and /lenops list it.

    Records say cwd=/work/out inside the box; they are rewritten to the host copy
    of the repo, which is also the project directory name Claude Code would use."""
    src_root = os.path.join(home, ".claude", "projects")
    dest = os.path.join(PROJECTS, re.sub(r"[^A-Za-z0-9]", "-", repo))
    for f in find_transcripts(sid, src_root):
        # <src_root>/<project>/<sid>.jsonl or <src_root>/<project>/<sid>/subagents/x.jsonl
        out = os.path.join(dest, *os.path.relpath(f, src_root).split(os.sep)[1:])
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with open(f, errors="replace") as fi, open(out, "w") as fo:
            for line in fi:
                try:
                    r = json.loads(line)
                except ValueError:
                    fo.write(line)
                    continue
                if r.get("cwd") == BOX_WORK:
                    r["cwd"] = repo
                fo.write(json.dumps(r, separators=(",", ":")) + "\n")
    return dest


# ----------------------------------------------------------------------- plan

def cmd_plan(a):
    s = read_session(a.session)
    if not s["prompts"]:
        sys.exit("session has no human prompts to replay")
    if not s["cwd"] or not os.path.isdir(s["cwd"]):
        sys.exit(f"session directory is gone: {s['cwd']!r} — nothing to replay against")
    prompts = s["prompts"][: a.turns] if a.turns else s["prompts"]
    goal = GOALS[a.goal]
    base_flags = ["--model", s["model"]] + (["--effort", s["effort"]] if s["effort"] else [])
    cand_flags = a.flags.split() if a.flags else goal["flags"]
    if base_flags == cand_flags:
        print("note: candidate flags equal baseline flags — this run measures the noise floor")
    arm_models = {s["model"]} | {cand_flags[i + 1] for i, f in enumerate(cand_flags[:-1]) if f == "--model"}
    if a.judge in arm_models:
        sys.exit(f"judge {a.judge} is also an arm's model — pick another --judge (SPEC §6.1.1)")
    arms = [dict(name="baseline", flags=base_flags), dict(name=f"{a.goal}", flags=cand_flags)]
    if a.dynamic:
        dyn_flags, why = tune.choose(tune.profile(s["sid"], PROJECTS))
        for w in why:
            print(f"dynamic  : {w}")
        if dyn_flags in (base_flags, cand_flags):
            print(f"note: dynamic flags equal the {'baseline' if dyn_flags == base_flags else a.goal} arm — no third arm")
        else:
            arms.append(dict(name="dynamic", flags=dyn_flags, why=why))
            arm_models.add(dyn_flags[1])
            if a.judge in arm_models:
                sys.exit(f"judge {a.judge} is also an arm's model — pick another --judge (SPEC §6.1.1)")
    rid = a.run_id or f"rr-{a.session[:8]}-{a.goal}-{dt.datetime.now():%Y%m%d%H%M}"
    plan = dict(id=rid, created=dt.datetime.now().isoformat(timespec="seconds"),
                session=s["sid"], cwd=s["cwd"], start=s["start"], goal=a.goal,
                lever=goal["lever"] if not a.flags else "custom", wins=goal["wins"],
                prompts=prompts, prompts_total=len(s["prompts"]), repeats=a.repeats,
                sandbox=a.sandbox, budget_per_turn=a.budget,
                permission_mode=a.permission_mode or ("bypassPermissions" if a.sandbox == "docker" else "acceptEdits"),
                test_cmd=a.test_cmd, judge=a.judge, from_dir=a.from_dir,
                arms=arms)
    d = os.path.join(OUT, rid)
    os.makedirs(d, exist_ok=True)
    json.dump(plan, open(os.path.join(d, "plan.json"), "w"), indent=2)
    print_plan(plan)
    return rid


def print_plan(p):
    n = len(p["prompts"])
    print(f"run      : {p['id']}")
    print(f"session  : {p['session']}   {n} of {p['prompts_total']} prompts replayed")
    print(f"goal     : {p['goal']}  ({p['lever']}) — wins if {p['wins']}")
    for arm in p["arms"]:
        print(f"arm      : {arm['name']:<9} {' '.join(arm['flags'])}")
    print(f"repeats  : {p['repeats']}" + ("   ** n < 3: the report will not print a verdict **"
                                          if p["repeats"] < 3 else ""))
    where = ("local Docker sandbox (allowlisted egress, no capabilities)" if p.get("sandbox") == "docker"
             else "host, directly")
    print(f"runs in  : {where} · --permission-mode {p['permission_mode']}")
    print(f"judge    : {p['judge']} (blind, pairwise, position-swapped; on the host, no tools)")
    calls = n * p["repeats"] * len(p["arms"])
    print(f"spend    : {calls} claude -p turns, each capped at ${p['budget_per_turn']:.2f} "
          f"(ceiling ${calls * p['budget_per_turn']:.2f}) + {2 * p['repeats'] * (len(p['arms']) - 1)} judge calls")
    print(f"\nnext     : python3 tools/rerun.py run {p['id']} --yes")


def load(rid):
    f = os.path.join(OUT, rid, "plan.json")
    if not os.path.exists(f):
        sys.exit(f"no plan at {f}")
    return json.load(open(f))


# ------------------------------------------------------------------------ run

def cmd_run(a):
    p = load(a.run)
    if not a.yes:
        print_plan(p)
        sys.exit("\nrun spends money — add --yes")
    if p.get("sandbox") == "docker":
        docker_ready()
    d = os.path.join(OUT, p["id"])
    for k in range(p["repeats"]):
        arms = p["arms"] if k % 2 == 0 else p["arms"][::-1]   # alternate order against drift
        for arm in arms:
            cell = os.path.join(d, "arms", arm["name"], str(k))
            if os.path.exists(os.path.join(cell, "result.json")):
                print(f"skip {arm['name']} #{k}: already ran")
                continue
            shutil.rmtree(cell, ignore_errors=True)
            run_cell(p, arm, cell, k)


def run_cell(p, arm, cell, k):
    repo = os.path.join(cell, "repo")
    note = snapshot(p["cwd"], p["start"], repo, p.get("from_dir"))
    sid = str(uuid.uuid4())
    box = home = None
    if p.get("sandbox") == "docker":
        home = os.path.join(cell, "home")
        box = Box(f"{p['id']}-{arm['name']}-{k}", repo, home)
    turns, wall, errors = [], 0.0, 0
    print(f"\n{arm['name']} #{k}  session {sid}" + (f"  [docker · {box.version}]" if box else "  [host]"))
    for i, prompt in enumerate(p["prompts"]):
        cmd = (["claude", "-p", prompt, "--output-format", "json",
                "--permission-mode", p["permission_mode"],
                "--max-budget-usd", str(p["budget_per_turn"])]
               + (["--session-id", sid] if i == 0 else ["--resume", sid]) + arm["flags"])
        t0 = time.monotonic()
        r = box.exec(cmd) if box else sh(cmd, repo)
        secs = time.monotonic() - t0
        wall += secs
        try:
            out = json.loads(r.stdout)
        except ValueError:
            out = {"is_error": True, "result": (r.stderr or r.stdout)[-500:]}
        err = bool(out.get("is_error")) or r.returncode != 0
        errors += err
        turns.append(dict(turn=i, secs=round(secs, 1), is_error=err,
                          num_turns=out.get("num_turns"), cli_cost=out.get("total_cost_usd")))
        print(f"  turn {i + 1}/{len(p['prompts'])}  {secs:6.1f}s  {'ERROR' if err else 'ok'}")
    tests = None
    if p.get("test_cmd"):                        # agent-written code: run it where the agent ran
        tests = (box.exec(["sh", "-c", p["test_cmd"]]) if box
                 else sh(["sh", "-c", p["test_cmd"]], repo)).returncode == 0
    if box:
        box.stop()
        publish_transcript(sid, home, repo)
    diff, stat = artifact(repo)
    open(os.path.join(cell, "diff.patch"), "w").write(diff)
    res = dict(arm=arm["name"], repeat=k, session=sid, wall=round(wall, 1), turns=turns,
               errors=errors, done=errors == 0, tests=tests, workspace=note, **stat,
               sandbox=f"docker {AGENT_IMG} · {box.version}" if box else "host",
               **measure(sid))
    json.dump(res, open(os.path.join(cell, "result.json"), "w"), indent=2)
    print(f"  ${res['cost']:.2f} priced · {res['wall']:.0f}s · {res['reqs']} req · "
          f"{stat['files']} files +{stat['adds']}/-{stat['dels']}")


# ---------------------------------------------------------------------- judge

JUDGE_TASK = """You are grading two candidate code changes made by coding agents for the same task.
You do not know which agent, model or settings produced either one. Judge only the changes.

Score each change 1-10 on: correctness, completeness, code_quality, scope (did only what was asked),
tests (added or kept passing where appropriate), clarity. An empty diff scores 1 on everything unless
the task needed no code change.

Reply with JSON only, no prose:
{"A": {"correctness": n, ...}, "B": {...}, "preference": "A" | "B" | "tie", "why": "<one sentence>"}"""


def judge_input(prompts, first, second, cap=60000):
    def clip(s):
        return s if len(s) <= cap else s[:cap] + f"\n... [{len(s) - cap} chars truncated]"
    task = "\n\n---\n\n".join(prompts)
    return f"# Task (the user's prompts, in order)\n\n{clip(task)}\n\n# Change A\n\n```diff\n{clip(first)}\n```\n\n# Change B\n\n```diff\n{clip(second)}\n```\n"


def ask_judge(model, body):
    r = sh(["claude", "-p", JUDGE_TASK, "--model", model, "--tools", "", "--output-format", "json",
            "--no-session-persistence"], inp=body)
    try:
        out = json.loads(r.stdout)
        text = out.get("result", "")
        verdict = json.loads(re.search(r"\{.*\}", text, re.S).group(0))
        return verdict, out.get("total_cost_usd") or 0.0
    except (ValueError, AttributeError):
        return None, 0.0


def cmd_judge(a):
    p = load(a.run)
    if not a.yes:
        sys.exit(f"judge spends money ({2 * p['repeats'] * (len(p['arms']) - 1)} calls to "
                 f"{p['judge']}) — add --yes")
    d = os.path.join(OUT, p["id"])
    base = p["arms"][0]["name"]
    scores, spent, log = {}, 0.0, []
    rng = random.Random(p["id"])
    for arm in p["arms"][1:]:
        for k in range(p["repeats"]):
            try:
                bd = open(os.path.join(d, "arms", base, str(k), "diff.patch")).read()
                cd = open(os.path.join(d, "arms", arm["name"], str(k), "diff.patch")).read()
            except OSError:
                print(f"skip #{k}: arm missing — run first")
                continue
            order = [(base, bd), (arm["name"], cd)]
            rng.shuffle(order)
            for swap in (False, True):            # position-swap cancels order bias
                first, second = order[::-1] if swap else order
                v, cost = ask_judge(p["judge"], judge_input(p["prompts"], first[1], second[1]))
                spent += cost
                if not v:
                    print(f"  #{k} swap={swap}: judge reply unparseable, dropped")
                    continue
                for label, (name, _) in (("A", first), ("B", second)):
                    total = sum(int(v.get(label, {}).get(c, 0)) for c in CRITERIA)
                    scores.setdefault(name, {}).setdefault(str(k), []).append(total)
                pref = {"A": first[0], "B": second[0]}.get(v.get("preference"), "tie")
                log.append(dict(repeat=k, swap=swap, preferred=pref, why=v.get("why", "")))
                print(f"  #{k} swap={swap}: prefers {pref}")
    json.dump(dict(judge=p["judge"], spent=spent, scores=scores, log=log),
              open(os.path.join(d, "judge.json"), "w"), indent=2)
    print(f"judge spent ${spent:.2f} (charged to verify, not to either arm)")


# --------------------------------------------------------------------- report

# (key, label, higher_is_better, formatter)
SPOKES = [("quality", "quality (judge /60)", True, lambda v: f"{v:.0f}"),
          ("done", "done", True, lambda v: f"{v * 100:.0f}%"),
          ("cost", "cost (priced)", False, lambda v: f"${v:.2f}"),
          ("wall", "wall time", False, lambda v: f"{v:.0f}s"),
          ("out_tok", "output tokens", False, lambda v: f"{v / 1000:.1f}k"),
          ("reqs", "requests", False, lambda v: f"{v:.0f}")]


def collect(p):
    d = os.path.join(OUT, p["id"])
    j = {}
    if os.path.exists(os.path.join(d, "judge.json")):
        j = json.load(open(os.path.join(d, "judge.json")))
    arms = []
    for arm in p["arms"]:
        cells = [json.load(open(f)) for f in sorted(glob.glob(os.path.join(d, "arms", arm["name"], "*", "result.json")))]
        if not cells:
            continue
        med = lambda k: statistics.median(c[k] for c in cells)
        q = [statistics.mean(v) for v in j.get("scores", {}).get(arm["name"], {}).values()]
        done = [c["tests"] if c["tests"] is not None else c["done"] for c in cells]
        arms.append(dict(name=arm["name"], flags=arm["flags"], n=len(cells), cells=cells,
                         quality=statistics.median(q) if q else None,
                         done=sum(done) / len(done), cost=med("cost"), wall=med("wall"),
                         out_tok=med("out_tok"), reqs=med("reqs"), cache_hit=med("cache_hit"),
                         files=med("files"), adds=med("adds"), dels=med("dels"),
                         spread={k: (min(c[k] for c in cells), max(c[k] for c in cells))
                                 for k in ("cost", "wall")}))
    return arms, j


def norm(arms, key, higher):
    """Spoke radius in [0.1, 1]: the best arm on each spoke reaches the rim."""
    vals = [a[key] for a in arms if a[key] is not None]
    out = {}
    for a in arms:
        v = a[key]
        if v is None or not vals:
            out[a["name"]] = None
        elif higher:
            out[a["name"]] = max(0.1, v / max(vals)) if max(vals) > 0 else 1.0
        else:
            out[a["name"]] = max(0.1, min(vals) / v) if v > 0 else 1.0
    return out


def verdict(p, arms):
    """One verdict per candidate arm, each against the baseline arm."""
    if len(arms) < 2:
        return "incomplete — an arm has no runs"
    return "; ".join(verdict_one(p, arms[0], c) for c in arms[1:])


def verdict_one(p, b, c):
    n = min(b["n"], c["n"])
    if n < 3:
        return f"no verdict — n = {n} per arm; three repeats is the minimum (n = 1 is not a finding)"
    if b["quality"] is None or c["quality"] is None:
        return "no verdict — not judged yet (run `judge`)"
    holds = c["quality"] >= b["quality"] and c["done"] >= b["done"]
    if p["goal"] == "cost":
        ok = holds and c["cost"] < b["cost"]
    elif p["goal"] == "speed":
        ok = holds and c["wall"] < b["wall"]
    else:
        ok = c["quality"] > b["quality"] and c["done"] >= b["done"]
    return (f"{c['name']} wins on its goal ({p['wins']})" if ok
            else f"{c['name']} does not clear its goal ({p['wins']})")


def radar_svg(arms):
    W, cx, cy, R = 560, 280, 250, 165
    n = len(SPOKES)
    colors = ["var(--arm0)", "var(--arm1)", "var(--arm2)"]
    pt = lambda i, r: (cx + r * R * math.sin(2 * math.pi * i / n), cy - r * R * math.cos(2 * math.pi * i / n))
    parts = [f'<svg viewBox="0 0 {W} 520" role="img" aria-label="radar of arms across six metrics">']
    for ring in (0.25, 0.5, 0.75, 1.0):
        pts = " ".join(f"{x:.1f},{y:.1f}" for x, y in (pt(i, ring) for i in range(n)))
        parts.append(f'<polygon points="{pts}" fill="none" stroke="var(--grid)"/>')
    radii = {k: norm(arms, k, hi) for k, _, hi, _ in SPOKES}
    for i, (k, label, hi, fmt) in enumerate(SPOKES):
        x, y = pt(i, 1.0)
        parts.append(f'<line x1="{cx}" y1="{cy}" x2="{x:.1f}" y2="{y:.1f}" stroke="var(--grid)"/>')
        lx, ly = pt(i, 1.24)
        anchor = "middle" if abs(lx - cx) < 20 else ("start" if lx > cx else "end")
        vals = " · ".join(fmt(a[k]) if a[k] is not None else "–" for a in arms)
        parts.append(f'<text x="{lx:.1f}" y="{ly:.1f}" text-anchor="{anchor}" class="lab">'
                     f'{html.escape(label)} {"↑" if hi else "↓"}</text>'
                     f'<text x="{lx:.1f}" y="{ly + 15:.1f}" text-anchor="{anchor}" class="val">{vals}</text>')
    for ai, a in enumerate(arms):
        pts = [pt(i, radii[k][a["name"]] or 0.0) for i, (k, *_r) in enumerate(SPOKES)]
        s = " ".join(f"{x:.1f},{y:.1f}" for x, y in pts)
        col = colors[ai % 3]
        parts.append(f'<polygon points="{s}" fill="{col}" fill-opacity="0.14" stroke="{col}" stroke-width="2"/>')
        parts += [f'<circle cx="{x:.1f}" cy="{y:.1f}" r="3" fill="{col}"/>' for x, y in pts]
    parts.append("</svg>")
    return "".join(parts)


def cmd_report(a):
    p = load(a.run)
    arms, j = collect(p)
    if not arms:
        sys.exit("nothing ran yet — `run` first")
    v = verdict(p, arms)
    b = arms[0]

    # terminal
    print(f"{p['id']} — goal {p['goal']} · {v}" + ("   [SIMULATED — examples/golden]" if p.get("simulated") else "") + "\n")
    print(f"{'metric':<22}" + "".join(f"{a['name']:>16}" for a in arms))
    for k, label, _, fmt in SPOKES + [("cache_hit", "cache hit", True, lambda x: f"{x * 100:.1f}%"),
                                     ("files", "files changed", True, lambda x: f"{x:.0f}")]:
        row = f"{label:<22}"
        for a in arms:
            cell = fmt(a[k]) if a[k] is not None else "–"
            if a is not b and a[k] is not None and b[k]:
                cell += f" ({(a[k] - b[k]) / b[k] * 100:+.0f}%)"
            row += f"{cell:>16}"
        print(row)

    # html
    def delta(a, k):
        if a is b or a[k] is None or not b[k]:
            return ""
        return f' <span class="d">{(a[k] - b[k]) / b[k] * 100:+.1f}%</span>'
    rows = "".join(
        f"<tr><th>{html.escape(label)}</th>"
        + "".join(f"<td>{fmt(a[k]) if a[k] is not None else '–'}{delta(a, k)}</td>" for a in arms) + "</tr>"
        for k, label, _, fmt in SPOKES + [("cache_hit", "cache hit", True, lambda x: f"{x * 100:.1f}%")])
    deliv = "".join(f"<tr><th>{html.escape(a['name'])}</th><td>{a['files']:.0f}</td><td>+{a['adds']:.0f}</td>"
                    f"<td>−{a['dels']:.0f}</td><td>{a['done'] * 100:.0f}%</td></tr>" for a in arms)
    flags = "".join(f"<tr><th>{html.escape(a['name'])}</th><td><code>{html.escape(' '.join(a['flags']))}</code></td>"
                    f"<td>{a['n']}</td></tr>" for a in arms)
    sessions = "".join(f"<li><code>{html.escape(c['session'])}</code> {html.escape(a['name'])} #{c['repeat']} — "
                       f"${c['cost']:.2f}, {c['wall']:.0f}s, {c['reqs']} req</li>" for a in arms for c in a["cells"])
    same = len(arms) > 1 and arms[0]["flags"] == arms[1]["flags"]
    legend = "".join(f'<span class="key" style="--c:var(--arm{i})">{html.escape(a["name"])}</span>' for i, a in enumerate(arms))
    workspace = arms[0]["cells"][0]["workspace"]
    caveats = [f"n = {min(a['n'] for a in arms)} per arm. " + ("Three or more repeats: medians shown." if min(a['n'] for a in arms) >= 3
               else "Below three repeats this is an anecdote, not a finding."),
               "Cost is <b>priced</b>: transcript tokens at list rates, a ceiling — not a bill.",
               "Arms are compared with each other. The original session is not a control and is not on this page.",
               f"Workspace: {html.escape(workspace)}.",
               f"Ran in: {html.escape(arms[0]['cells'][0].get('sandbox', 'host'))}"
               + (" — allowlisted egress, no capabilities; a container shares the host kernel, so this is "
                  "not microVM isolation, and wall time includes no VM boot." if p.get("sandbox") == "docker" else "."),
               "Done = every turn exited without error" + (f", and <code>{html.escape(p['test_cmd'])}</code> passed." if p.get("test_cmd") else "; no test command was given, so it says nothing about correctness."),
               (f"Judge {html.escape(j.get('judge', ''))} saw two diffs in random order, twice with positions swapped, "
                f"no names, flags or costs. It spent ${j.get('spent', 0):.2f}, charged to verify." if j else "Not judged yet: quality spoke is empty.")]
    if same:
        caveats.insert(0, "Both arms ran identical flags: the gap between them is the noise floor, not a result.")
    if p.get("simulated"):
        caveats.insert(0, "<b>Simulated.</b> No arm ran and no judge was called: transcripts, diffs and scores come "
                          "from examples/golden/synth.py. This page teaches the pipeline; never quote its numbers.")
    page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Session rerun report</title>
<style>
:root{{--bg:#fbfaf7;--fg:#1d1d1b;--mut:#6b6a66;--grid:#d9d6cf;--card:#fff;--arm0:#b7791f;--arm1:#0f8a7e;--arm2:#7c4dcc}}
@media (prefers-color-scheme:dark){{:root:not([data-theme="light"]){{--bg:#171715;--fg:#ecebe6;--mut:#a3a19a;--grid:#3a3934;--card:#21201d;--arm0:#e0a04a;--arm1:#3cc2b3;--arm2:#a98af0}}}}
:root[data-theme="dark"]{{--bg:#171715;--fg:#ecebe6;--mut:#a3a19a;--grid:#3a3934;--card:#21201d;--arm0:#e0a04a;--arm1:#3cc2b3;--arm2:#a98af0}}
body{{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0;padding:24px 16px}}
main{{max-width:860px;margin:0 auto}} h1{{font-size:22px;margin:0 0 4px}} h2{{font-size:16px;margin:28px 0 8px}}
.sub{{color:var(--mut)}} .verdict{{background:var(--card);border:1px solid var(--grid);border-radius:8px;padding:12px 14px;margin:16px 0}}
svg{{width:100%;max-width:560px;display:block;margin:0 auto}} .lab{{font-size:12px;fill:var(--fg)}} .val{{font-size:11px;fill:var(--mut)}}
table{{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}} th,td{{text-align:left;padding:6px 8px;border-bottom:1px solid var(--grid)}}
.d{{color:var(--mut);font-size:12px}} .key{{display:inline-flex;align-items:center;gap:6px;margin-right:16px}}
.key::before{{content:"";width:12px;height:12px;border-radius:3px;background:var(--c)}} .wrap{{overflow-x:auto}} code{{font-size:13px}}
</style></head><body><main>
<h1>Session rerun · {html.escape(p['goal'])}</h1>
<div class="sub">{html.escape(p['id'])} · session <code>{html.escape(p['session'][:8])}</code> · {len(p["prompts"])} prompt{"s" if len(p["prompts"]) != 1 else ""} replayed · lever {html.escape(p['lever'])}</div>
<div class="verdict"><b>{html.escape(v)}</b></div>
<h2>Six metrics, one outline per arm</h2>
<p class="sub">Each spoke is scaled to the best arm on it (rim = best). ↑ higher is better, ↓ lower is better. Values print in arm order.</p>
<div>{legend}</div>{radar_svg(arms)}
<h2>What changed</h2><div class="wrap"><table><tr><th>arm</th><th>flags</th><th>runs</th></tr>{flags}</table></div>
<h2>Raw numbers <span class="sub">(median across repeats; delta vs baseline arm)</span></h2>
<div class="wrap"><table><tr><th>metric</th>{''.join(f'<th>{html.escape(a["name"])}</th>' for a in arms)}</tr>{rows}</table></div>
<h2>Delivered <span class="sub">(measured from git diff base, not claimed)</span></h2>
<div class="wrap"><table><tr><th>arm</th><th>files</th><th>added</th><th>removed</th><th>done</th></tr>{deliv}</table></div>
<h2>New sessions</h2><ul>{sessions}</ul>
<h2>Caveats</h2><ul>{''.join(f'<li>{c}</li>' for c in caveats)}</ul>
</main></body></html>"""
    path = os.path.join(OUT, p["id"], "report.html")
    open(path, "w").write(page)
    print(f"\nreport: {path}")


# ------------------------------------------------------------------------- cli

def main():
    envfile.load()
    ap = argparse.ArgumentParser(description="Replay a session with new flags; judge blind; radar report.")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def plan_args(sp):
        sp.add_argument("session", help="session id (full UUID; see tools/sessions.py --full-id)")
        sp.add_argument("--goal", choices=sorted(GOALS), default="cost")
        sp.add_argument("--flags", help='candidate flags, overriding the goal preset, e.g. "--model claude-haiku-4-5-20251001"')
        sp.add_argument("--repeats", type=int, default=3, help="runs per arm (default 3; fewer prints no verdict)")
        sp.add_argument("--turns", type=int, help="replay only the first N prompts")
        sp.add_argument("--budget", type=float, default=2.0, help="--max-budget-usd per turn (default 2.00)")
        sp.add_argument("--sandbox", choices=["docker", "host"], default="docker",
                        help="where arms run: local Docker sandbox (default) or the host directly")
        sp.add_argument("--permission-mode",
                        help="passed to claude -p (default bypassPermissions in docker, acceptEdits on host)")
        sp.add_argument("--test-cmd", help="shell command run in each arm's repo afterwards; exit 0 = done")
        sp.add_argument("--judge", default=JUDGE, help=f"pinned judge model (default {JUDGE})")
        sp.add_argument("--from-dir", action="store_true", help="copy the directory as it is now instead of git archive")
        sp.add_argument("--dynamic", action="store_true", help="add a third arm with flags tools/tune.py picks for this session")
        sp.add_argument("--run-id", help="name the run instead of rr-<session>-<goal>-<time>")

    plan_args(sub.add_parser("plan", help="free: read the session, write the plan"))
    for name in ("run", "judge"):
        sp = sub.add_parser(name, help="spends money")
        sp.add_argument("run")
        sp.add_argument("--yes", action="store_true")
    sub.add_parser("report", help="free: radar + tables").add_argument("run")
    go = sub.add_parser("go", help="plan, run, judge, report")
    plan_args(go)
    go.add_argument("--yes", action="store_true")

    a = ap.parse_args()
    if a.cmd == "plan":
        cmd_plan(a)
    elif a.cmd == "run":
        cmd_run(a)
    elif a.cmd == "judge":
        cmd_judge(a)
    elif a.cmd == "report":
        cmd_report(a)
    else:
        if not a.yes:
            cmd_plan(a)
            sys.exit("\ngo spends money — add --yes")
        rid = cmd_plan(a)
        a.run = rid
        cmd_run(a)
        cmd_judge(a)
        cmd_report(a)


if __name__ == "__main__":
    main()
