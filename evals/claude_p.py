#!/usr/bin/env python3
"""Evals for `opt claude -p … --compare`: does optimize mode do the same job as plain `claude -p`?

Each case is an example in app/examples/claude-p/<name>/ (project/, task.md, a hidden check.py, and a
reference solution/ that proves the check can pass). A case is judged three ways:

  deterministic  the run's own files: every arm finished, n >= 3 a side, one model, every arm passes the
                 hidden check (as it was at run time, and as it stands now), the claims audit re-run from
                 the files finds the comparison fair, and the real credential appears in no file the run left
  blind          a grader agent sees each pair (plain-i vs optimized-i) as A and B, shuffled, and scores
                 both diffs against the task; the key stays in key.json until `record`
  verdict        optimized does the same job when the comparison is fair (every check but the hidden
                 check's), optimized passes the hidden check as it stands at least as often as plain, and
                 plain is not preferred in a majority of blind pairs

    python3 evals/claude_p.py list
    python3 evals/claude_p.py preflight                  # free: Docker, credential, images, each case well-posed
    python3 evals/claude_p.py run all --yes [--repeats 3 --level balanced]   # SPENDS: opt claude example, per case
    python3 evals/claude_p.py check <case|all>           # free: deterministic checks on the latest run
    python3 evals/claude_p.py blind <case|all>           # free: the A/B packet for the grader
    python3 evals/claude_p.py record <case|all>          # free: checks + grade.json + key -> result.json
    python3 evals/claude_p.py report                     # evals/CLAUDE-P-RESULTS.md

Work goes to data/private/evals/claude-p/<case>/ (OPTHUB_EVALS moves it). `run` refuses without --yes.
"""
import datetime as dt, glob, json, os, random, re, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
EXAMPLES = os.path.join(REPO, "app", "examples", "claude-p")
WORK = os.path.join(os.environ.get("OPTHUB_EVALS") or os.path.join(REPO, "data", "private", "evals"), "claude-p")
OPT = ["node", os.path.join(REPO, "app", "opt.mjs")]
OUTCOME_CLAIMS = ("cheaper",)
KEY_CLAIMS = ("same-input", "same-model", "same-client", "finished", "same-result", "warm", "credential", "trail")


def cases():
    return sorted(d for d in os.listdir(EXAMPLES) if os.path.exists(os.path.join(EXAMPLES, d, "task.md")))


def pick(arg):
    names = cases() if arg in (None, "all") else [arg]
    for n in names:
        if n not in cases():
            sys.exit(f"no case {n}: {', '.join(cases())}")
    return names


def node(js):
    r = subprocess.run(["node", "--input-type=module", "-e", js], cwd=REPO, capture_output=True, text=True)
    return r.stdout.strip()


def out_root():
    return node("import { outRoot } from './app/lib/local-run.mjs'; console.log(outRoot())")


def check_case(name, project=None):
    """Run a case's hidden check on a copy of project (default: the untouched one), optionally with solution/."""
    ex = os.path.join(EXAMPLES, name)
    with tempfile.TemporaryDirectory() as t:
        shutil.copytree(os.path.join(ex, "project"), t, dirs_exist_ok=True)
        if project == "solution":
            shutil.copytree(os.path.join(ex, "solution"), t, dirs_exist_ok=True)
        r = subprocess.run([sys.executable, os.path.join(ex, "check.py")], cwd=t, capture_output=True, text=True, timeout=300)
        return r.returncode, (r.stdout.strip().splitlines() or [""])[-1]


# ------------------------------------------------------------------ preflight (free)

def preflight():
    ok = True

    def say(good, what, detail=""):
        nonlocal ok
        ok &= good
        print(f"  {'✓' if good else '✗'} {what}" + (f"  — {detail}" if detail else ""))
    d = subprocess.run(["docker", "version", "--format", "{{.Server.Version}}"], capture_output=True, text=True)
    say(d.returncode == 0, "Docker is running", d.stdout.strip() or d.stderr.strip()[-120:])
    kind = node("import './app/secrets.mjs'; import { launcherCredential } from './app/lib/ult/credentials.mjs';"
                "const c = launcherCredential(process.env); console.log(c ? c.kind + ' from ' + c.source : 'none')")
    say(kind != "none" and bool(kind), "a Claude credential", kind)
    say(kind.startswith("oauth"), "it is a subscription token, not an API key (API keys bill credits)", kind.split(" ")[0])
    imgs = subprocess.run(["docker", "images", "--format", "{{.Repository}}"], capture_output=True, text=True).stdout.split()
    say("opthub/agent" in imgs, "the sandbox image opthub/agent is built", "built on first run otherwise")
    for n in cases():
        if not os.path.isdir(os.path.join(EXAMPLES, n, "solution")):
            say(False, f"{n}: has a reference solution/")
            continue
        c0, l0 = check_case(n)
        c1, l1 = check_case(n, "solution")
        say(c0 != 0 and c1 == 0, f"{n}: check fails untouched, passes with solution/", f"{l0} / {l1}")
        dry = subprocess.run(OPT + ["claude", "example", n, "--dry-run", "--level", "balanced", "--repeats", "3"], cwd=REPO,
                             capture_output=True, text=True, timeout=120)
        txt = dry.stdout + dry.stderr
        say(dry.returncode == 0 and "plain side" in txt and "ANTHROPIC_BASE_URL" in txt, f"{n}: dry run prints both sides",
            f"exit {dry.returncode}")
    print("ready" if ok else "not ready")
    return 0 if ok else 1


# ------------------------------------------------------------------ run (spends)

def run(names, repeats, level, budget):
    for n in names:
        d = os.path.join(WORK, n)
        os.makedirs(d, exist_ok=True)
        stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        argv = OPT + ["claude", "example", n, "--repeats", str(repeats), "--level", level, "--budget", str(budget), "--json"]
        print(f"{n}: {' '.join(argv[2:])}", flush=True)
        r = subprocess.run(argv, cwd=REPO, capture_output=True, text=True, timeout=3600)
        with open(os.path.join(d, f"run-{stamp}.stderr.txt"), "w") as fh:
            fh.write(re.sub(r"\x1b\[[0-9;]*m", "", r.stderr))
        try:
            j = json.loads(r.stdout[r.stdout.index("{"):])
        except ValueError:
            print(f"  ✗ no run JSON (exit {r.returncode}); stderr in {d}/run-{stamp}.stderr.txt")
            continue
        with open(os.path.join(d, "latest.json"), "w") as fh:
            json.dump({"run": j["run"], "dir": os.path.join(out_root(), j["run"]), "exit": r.returncode,
                       "repeats": repeats, "level": level, "started": stamp}, fh, indent=1)
        s = j.get("claims", {})
        print(f"  {j['run']}  exit {r.returncode}  verdict {(j.get('verdict') or {}).get('verdict')}  "
              f"claims {s.get('verified')} verified / {s.get('failed')} failed / {s.get('notProven')} not proven")


def latest(name):
    p = os.path.join(WORK, name, "latest.json")
    if not os.path.exists(p):
        sys.exit(f"{name}: no run yet — python3 evals/claude_p.py run {name} --yes")
    with open(p) as fh:
        return json.load(fh)


# ------------------------------------------------------------------ check (free, from the run's files)

def check(name):
    L = latest(name)
    d = L["dir"]
    with open(os.path.join(d, "run.json")) as fh:
        rj = json.load(fh)
    arms = rj["arms"]
    side = lambda s: [a for a in arms if a["side"] == s]
    out = []

    def add(cid, ok, detail):
        out.append(dict(id=cid, ok=bool(ok), detail=detail))
    add("D1-finished", all(a["exit"] == 0 and not a["is_error"] and not a["timed_out"] for a in arms),
        ", ".join(f"{a['label']} exit {a['exit']}{' error' if a['is_error'] else ''}" for a in arms))
    add("D2-repeats", len(side("optimized")) >= 3 and len(side("baseline")) >= 3,
        f"{len(side('optimized'))} optimized, {len(side('baseline'))} plain")
    models = {a["model"] for a in arms}
    add("D3-one-model", len(models) == 1 and None not in models, ", ".join(sorted(map(str, models))))
    add("D4-hidden-check", all(a["check"] == "pass" for a in arms),
        f"plain {sum(a['check'] == 'pass' for a in side('baseline'))}/{len(side('baseline'))} · "
        f"optimized {sum(a['check'] == 'pass' for a in side('optimized'))}/{len(side('optimized'))}")
    au = subprocess.run(OPT + ["claude", "audit", rj["run"], "--json"], cwd=REPO, capture_output=True, text=True)
    try:
        claims = {c["id"]: c for c in json.loads(au.stdout[au.stdout.index("["):])}
    except ValueError:
        claims = {}
    # "cheaper" is the comparison's outcome, reported beside the verdict; every other claim says whether the
    # comparison was fair and the run is what it says it is
    failed = [k for k, c in claims.items() if c["status"] == "failed" and k not in OUTCOME_CLAIMS]
    add("D5-audit", claims and not failed, f"re-audited from files: {len(claims)} claims, failed {failed or 'none'}"
        + "".join(f" · outcome {k}: {claims[k]['status']}" for k in OUTCOME_CLAIMS if k in claims))
    missing = [k for k in KEY_CLAIMS if claims.get(k, {}).get("status") != "verified"]
    add("D6-key-claims", not missing, f"not verified: {missing}" if missing else "all of " + ", ".join(KEY_CLAIMS))
    ws = "ws-" + rj["run"][3:]
    chk = os.path.join(EXAMPLES, name, "check.py")
    now = {}
    for a in arms:                          # one at a time: the timing cases must not share the machine
        r = subprocess.run([sys.executable, chk], cwd=os.path.join(d, a["label"], ws), capture_output=True, text=True, timeout=300)
        now[a["label"]] = "pass" if r.returncode == 0 else "fail: " + "; ".join(x[5:] for x in r.stdout.splitlines() if x.startswith("FAIL "))
    revised = rj.get("check", {}).get("sha256") != sha256_file(chk)
    add("D8-check-as-it-stands", all(v == "pass" for v in now.values()),
        ("check revised since the run · " if revised else "") + f"plain {sum(now[a['label']] == 'pass' for a in side('baseline'))}/{len(side('baseline'))} · "
        f"optimized {sum(now[a['label']] == 'pass' for a in side('optimized'))}/{len(side('optimized'))}"
        + "".join(f" · {k} {v}" for k, v in now.items() if v != "pass"))
    leak = node("import './app/secrets.mjs'; import fs from 'node:fs'; import path from 'node:path';"
                "import { launcherCredential } from './app/lib/ult/credentials.mjs';"
                f"const c = launcherCredential(process.env); const root = {json.dumps(d)}; let n = 0, hit = [];"
                "const walk = (p) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const q = path.join(p, e.name);"
                " if (e.isDirectory()) walk(q); else if (e.isFile() && fs.statSync(q).size < 64e6) { n++; if (c && fs.readFileSync(q).includes(c.value)) hit.push(path.relative(root, q)) } } };"
                "walk(root); console.log(JSON.stringify({ files: n, hit, cred: !!c }))")
    lk = json.loads(leak or '{"files":0,"hit":["(scan failed)"],"cred":false}')
    add("D7-no-credential-in-files", lk["cred"] and not lk["hit"], f"{lk['files']} files scanned; found in {lk['hit'] or 'none'}")
    with open(os.path.join(WORK, name, "checks.json"), "w") as fh:
        json.dump(dict(run=rj["run"], checks=out, verdict=rj.get("verdict"),
                       cost=dict(plain=med([a["cost_usd"] for a in side("baseline")]), optimized=med([a["cost_usd"] for a in side("optimized")])),
                       seconds=dict(plain=med([a["duration_ms"] / 1000 for a in side("baseline") if a["duration_ms"]]),
                                    optimized=med([a["duration_ms"] / 1000 for a in side("optimized") if a["duration_ms"]]))), fh, indent=1)
    print(f"{name} · {rj['run']}")
    for c in out:
        print(f"  {'✓' if c['ok'] else '✗'} {c['id']}: {c['detail']}")


def sha256_file(p):
    import hashlib
    with open(p, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def med(xs):
    xs = sorted(x for x in xs if x is not None)
    return None if not xs else (xs[len(xs) // 2] if len(xs) % 2 else (xs[len(xs) // 2 - 1] + xs[len(xs) // 2]) / 2)


# ------------------------------------------------------------------ blind (free)

def diff_of(project, work):
    r = subprocess.run(["diff", "-ruN", "-x", "__pycache__", "-x", "*.pyc", "-x", ".pytest_cache", project, work],
                       capture_output=True, text=True)
    text = r.stdout.replace(project, "a").replace(work, "b")
    text = re.sub(r"^((?:---|\+\+\+) \S+)\t.*$", r"\1", text, flags=re.M)   # mtimes would hint at which side is which
    text = re.sub(r"^diff -ruN .*? (a/\S+) (b/\S+)$", r"diff \1 \2", text, flags=re.M)
    return text or "(no changes)\n"


def blind(name):
    L = latest(name)
    d, ex = L["dir"], os.path.join(EXAMPLES, name)
    with open(os.path.join(d, "run.json")) as fh:
        rj = json.load(fh)
    ws = "ws-" + rj["run"][3:]
    pairs = min(len([a for a in rj["arms"] if a["side"] == "optimized"]), len([a for a in rj["arms"] if a["side"] == "baseline"]))
    rng = random.Random(rj["run"])
    key, parts = {}, []
    with open(os.path.join(ex, "task.md")) as fh:
        task = fh.read().strip()
    for i in range(1, pairs + 1):
        sides = [("plain", f"plain-{i}"), ("optimized", f"optimized-{i}")]
        rng.shuffle(sides)
        key[f"pair-{i}"] = {"A": sides[0][0], "B": sides[1][0]}
        for letter, (_, label) in zip("AB", sides):
            parts.append(f"### Pair {i} · {letter}\n\n```diff\n{diff_of(os.path.join(ex, 'project'), os.path.join(d, label, ws))}```\n")
    w = os.path.join(WORK, name)
    with open(os.path.join(w, "key.json"), "w") as fh:
        json.dump(key, fh, indent=1)
    with open(os.path.join(w, "packet.md"), "w") as fh:
        fh.write(f"# Blind review · {name}\n\nTwo coding agents were each given the same task on the same project. "
                 f"Each pair below shows what agent A and agent B changed (unified diffs against the original project, "
                 f"`{os.path.relpath(os.path.join(ex, 'project'), REPO)}`). You do not know which agent is which, and "
                 f"A in one pair is not necessarily A in another.\n\n## The task\n\n> {task}\n\n"
                 f"## Score each side of each pair, 1 to 5\n\n"
                 f"- **correct**: does the change do what the task (and any docstring it points to) asks, for inputs beyond the visible tests? Read the code; you may run it on a copy of the project.\n"
                 f"- **scope**: does it change only what the task needs? Editing tests, adding unrelated files or rewriting working code loses points.\n"
                 f"- **clarity**: would a reviewer accept it as written: readable, idiomatic, no dead code?\n\n"
                 f"Then **prefer** A, B or tie for the pair, with one sentence on why. Score the code, not its length.\n\n"
                 f"Write `{os.path.join(w, 'grade.json')}` as "
                 f"{{\"pair-1\": {{\"A\": {{\"correct\": 5, \"scope\": 5, \"clarity\": 4}}, \"B\": {{…}}, \"prefer\": \"A|B|tie\", \"why\": \"…\"}}, …}}.\n\n"
                 f"## The diffs\n\n" + "\n".join(parts))
    print(f"{name}: {pairs} pairs -> {os.path.join(w, 'packet.md')}")


# ------------------------------------------------------------------ record, report (free)

def record(name):
    w = os.path.join(WORK, name)
    with open(os.path.join(w, "checks.json")) as fh:
        ck = json.load(fh)
    with open(os.path.join(w, "key.json")) as fh:
        key = json.load(fh)
    with open(os.path.join(w, "grade.json")) as fh:
        grade = json.load(fh)
    pref = {"plain": 0, "optimized": 0, "tie": 0}
    score = {"plain": [], "optimized": []}
    for pair, k in key.items():
        g = grade[pair]
        pref[k[g["prefer"]] if g["prefer"] in ("A", "B") else "tie"] += 1
        for letter in "AB":
            score[k[letter]].append(sum(g[letter][c] for c in ("correct", "scope", "clarity")) / 3)
    by = {c["id"]: c for c in ck["checks"]}
    fair = all(c["ok"] for k, c in by.items() if k not in ("D4-hidden-check", "D8-check-as-it-stands"))
    passes = {s: int(re.search(rf"{s} (\d+)/", by["D8-check-as-it-stands"]["detail"]).group(1)) for s in ("plain", "optimized")}
    runs = {s: int(re.search(rf"{s} \d+/(\d+)", by["D8-check-as-it-stands"]["detail"]).group(1)) for s in ("plain", "optimized")}
    same_job = fair and passes["optimized"] >= passes["plain"] and pref["plain"] <= len(key) / 2
    note = ("both sides miss the task's hidden cases" if passes["plain"] < runs["plain"] and passes["optimized"] < runs["optimized"] else "")
    res = dict(case=name, run=ck["run"], date=dt.date.today().isoformat(), fair=fair,
               failed=[f"{c['id']}: {c['detail']}" for c in ck["checks"] if not c["ok"]],
               check_now={s: f"{passes[s]}/{runs[s]}" for s in passes}, preferred=pref,
               mean_score={k: round(sum(v) / len(v), 2) if v else None for k, v in score.items()},
               cost=ck["cost"], seconds=ck["seconds"], tool_verdict=(ck.get("verdict") or {}).get("verdict"),
               same_job=same_job, note=note)
    with open(os.path.join(w, "result.json"), "w") as fh:
        json.dump(res, fh, indent=1)
    print(f"{name}: {'SAME JOB' if same_job else 'NOT SHOWN'} · fair {'yes' if fair else 'NO'} · hidden check now plain "
          f"{res['check_now']['plain']}, optimized {res['check_now']['optimized']} · blind prefers plain {pref['plain']}, "
          f"optimized {pref['optimized']}, tie {pref['tie']}" + (f" · {note}" if note else ""))
    for f in res["failed"]:
        print(f"  - {f}")


def report():
    L = ["# opt claude -p --compare: eval results", "",
         "Generated by `python3 evals/claude_p.py report`. Each case: `opt claude example <case> --repeats 3 --level balanced`, "
         "then the deterministic checks on the run's files and a blind A/B review of each pair's diffs.", "",
         "Costs are priced from Claude Code's token totals at list rates (not billed), medians per side. n = 3 a side per case: "
         "a direction for these tasks, not a finding for yours.", "",
         "| case | run | fair comparison | hidden check now: plain / optimized | blind: plain / optimized / tie | cost plain → optimized | tool verdict | same job? |",
         "|---|---|---|---|---|---|---|---|"]
    for n in cases():
        p = os.path.join(WORK, n, "result.json")
        if not os.path.exists(p):
            L.append(f"| {n} | — | not run | | | | | |")
            continue
        with open(p) as fh:
            r = json.load(fh)
        pr, unfair = r["preferred"], [f for f in r["failed"] if not f.startswith(("D4", "D8"))]
        L.append(f"| {n} | `{r['run']}` | {'yes' if r['fair'] else 'no: ' + '; '.join(unfair).replace('|', '/')} | "
                 f"{r['check_now']['plain']} / {r['check_now']['optimized']} | {pr['plain']} / {pr['optimized']} / {pr['tie']} | "
                 f"${r['cost']['plain']:.4f} → ${r['cost']['optimized']:.4f} | {r['tool_verdict']} | "
                 f"**{'yes' if r['same_job'] else 'not shown'}**{' (' + r['note'] + ')' if r['note'] else ''} |")
    with open(os.path.join(HERE, "CLAUDE-P-RESULTS.md"), "w") as fh:
        fh.write("\n".join(L) + "\n")
    print("evals/CLAUDE-P-RESULTS.md")


def main():
    a = sys.argv[1:]
    if not a or a[0] not in ("list", "preflight", "run", "check", "blind", "record", "report"):
        sys.exit(__doc__.strip())
    if a[0] == "list":
        for n in cases():
            print(f"{n:<16} {open(os.path.join(EXAMPLES, n, 'task.md')).read().strip()[:100]}")
    elif a[0] == "preflight":
        sys.exit(preflight())
    elif a[0] == "report":
        report()
    elif a[0] == "run":
        if "--yes" not in a:
            sys.exit("run spends: it starts `opt claude example` per case (3 + 3 claude -p runs and a warm-up each) — add --yes")
        opt_val = lambda k, d: a[a.index(k) + 1] if k in a else d
        run(pick(a[1] if len(a) > 1 and not a[1].startswith("--") else "all"), int(opt_val("--repeats", 3)), opt_val("--level", "balanced"),
            float(opt_val("--budget", 1)))
    else:
        for n in pick(a[1] if len(a) > 1 else "all"):
            {"check": check, "blind": blind, "record": record}[a[0]](n)


if __name__ == "__main__":
    main()
