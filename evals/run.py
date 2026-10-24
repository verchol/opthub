#!/usr/bin/env python3
"""The Claude-run evals for docs/use-cases.md: a task a person would hand Claude, answered by one agent,
graded blind by another against a rubric, with deterministic checks on top. Free: every command runs
on the synthetic workspace from evals/fixture.py, with no credentials and an egress trap.

    python3 evals/run.py list                  # every card and its last result
    python3 evals/run.py prepare EV-02         # fixture + the card's commands -> data/private/evals/EV-02/
                                               #   task.md (for the answerer), rubric.md (for the grader), env.sh
    python3 evals/run.py check EV-02           # deterministic checks on answer.md -> checks.json
    python3 evals/run.py record EV-02          # checks.json + grade.json -> result.json
    python3 evals/run.py report                # evals/RESULTS.md from every result.json

One eval, end to end: prepare; an answerer agent reads task.md and writes answer.md; check; a grader
agent that has not seen the answerer's work reads rubric.md and writes grade.json; record.
grade.json: {"R1": {"score": 1, "why": "..."}, ...}, each score 0, 0.5 or 1.
"""
import datetime as dt, glob, json, os, re, shlex, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import fixture as fx  # noqa: E402

REPO = fx.REPO
CARDS = os.path.join(HERE, "cases")
WORK = os.environ.get("OPTHUB_EVALS") or os.path.join(REPO, "data", "private", "evals")
NUM = re.compile(r"\$\s?\d[\d,]*(?:\.\d+)?|\b\d+(?:\.\d+)?%|\b\d{1,3}(?:,\d{3})+\b")


def cards():
    out = {}
    for f in sorted(glob.glob(os.path.join(CARDS, "*.json"))):
        with open(f) as fh:
            c = json.load(fh)
        out[c["id"]] = c
    return out


def card(eid):
    c = cards().get(eid)
    return c or sys.exit(f"no card {eid}; python3 evals/run.py list")


def subst(s, ctx):
    return re.sub(r"\{(\w+)(?::([\w-]+))?\}", lambda m: ctx[m.group(1)][m.group(2)] if m.group(2) else ctx[m.group(1)], s)


def prepare(eid):
    c = card(eid)
    d = os.path.join(WORK, eid)
    shutil.rmtree(d, ignore_errors=True)
    fxroot, art = os.path.join(d, "fixture"), os.path.join(d, "artifacts")
    os.makedirs(art)
    ids = fx.build(fxroot)
    env = fx.env(fxroot)
    proj = {k: os.path.dirname(f) for k, sid in ids.items() for f in glob.glob(os.path.join(fxroot, "projects", "*", sid + ".jsonl"))}
    ctx = dict(FX=fxroot, SINCE=fx.SINCE, REPO=REPO, SID=ids, PROJ=proj)
    for step in c.get("setup", []):
        argv = [sys.executable if a == "python3" else subst(a, ctx) for a in step["cmd"]]
        r = subprocess.run(argv, cwd=REPO, env=env, capture_output=True, text=True, timeout=300)
        text = re.sub(r"\x1b\[[0-9;]*m", "", r.stdout + (f"\n[stderr]\n{r.stderr}" if r.stderr.strip() else ""))
        with open(os.path.join(art, step["name"] + ".txt"), "w") as fh:
            fh.write(f"$ {' '.join(shlex.quote(a) for a in step['cmd'])}\n[exit {r.returncode}]\n\n{text}")
    for f in c.get("files", []):
        for src in glob.glob(subst(f["from"], ctx)):
            shutil.copy(src, os.path.join(art, f.get("name") or os.path.basename(src)))
    with open(os.path.join(d, "env.sh"), "w") as fh:
        fh.write("# the eval's environment: synthetic transcripts, no credentials, egress trap\n")
        fh.writelines(f"export {k}={shlex.quote(v)}\n" for k, v in env.items() if k in ENV_KEYS)
        fh.writelines(f"unset {k}\n" for k in sorted(fx.SECRETS))
    listing = "\n".join(f"- `{os.path.join(art, a)}`" for a in sorted(os.listdir(art)))
    with open(os.path.join(d, "task.md"), "w") as fh:
        fh.write(f"# {c['id']} — {c['title']}\n\n{subst(c['task'], ctx)}\n\n## What you have\n\n{listing}\n\n"
                 f"Run commands only after `source {os.path.join(d, 'env.sh')}`, from `{REPO}`. Never run a command that "
                 f"spends money (see CLAUDE.md: anything with `--yes`, `opt optimize`, `opt run`, `opt claude -p`, …). "
                 f"If you quote a figure from a command you ran, save that command's output to `{os.path.join(d, 'extra')}/`: "
                 f"every figure in the answer must be found in an artifact or there.\n\n"
                 f"Write your answer, and nothing else, to `{os.path.join(d, 'answer.md')}`.\n")
    rub = "\n".join(f"- **{r['id']}** (weight {r['weight']}{', critical' if r.get('critical') else ''}): {r['text']}" for r in c["rubric"])
    with open(os.path.join(d, "rubric.md"), "w") as fh:
        fh.write(f"# Grading {c['id']} — {c['title']}\n\nThe task the answerer was given:\n\n> "
                 + subst(c["task"], ctx).replace("\n", "\n> ")
                 + f"\n\nArtifacts it had: `{art}`. Its answer: `{os.path.join(d, 'answer.md')}`. "
                 f"Commands the answerer ran itself: `{os.path.join(d, 'extra')}/`. Deterministic checks already run: `{os.path.join(d, 'checks.json')}`.\n\n"
                 f"Score each criterion 0, 0.5 or 1 against the artifacts, not against what seems plausible: "
                 f"open them and verify every claim the answer makes. A criterion you cannot verify scores 0.\n\n{rub}\n\n"
                 f"Write `{os.path.join(d, 'grade.json')}` as {{\"R1\": {{\"score\": 1, \"why\": \"one sentence\"}}, …}}.\n")
    print(f"{eid}: {len(os.listdir(art))} artifacts\n  answerer reads {os.path.join(d, 'task.md')}\n  grader reads   {os.path.join(d, 'rubric.md')}")


ENV_KEYS = {"TZ", "HOME", "OPTHUB_PROJECTS", "OPT_PROJECTS_DIR", "OPTHUB_RERUNS", "OPTHUB_SCAN", "OPTHUB_DYNCONFIG",
            "OPTHUB_ONBOARD", "OPT_HOME", "OPTHUB_ENV_FILE", "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
            "ALL_PROXY", "NO_PROXY", "no_proxy", "NODE_USE_ENV_PROXY", "PYTHONDONTWRITEBYTECODE"}


def norm(n):
    return n.replace(" ", "").replace(",", "").replace("$", "")


def check(eid):
    c, d = card(eid), os.path.join(WORK, eid)
    path = os.path.join(d, "answer.md")
    if not os.path.exists(path):
        sys.exit(f"no answer yet: {path}")
    with open(path) as fh:
        ans = fh.read()
    pool = norm(open(os.path.join(d, "task.md")).read())
    for base, _, files in [w for sub in ("artifacts", "extra") for w in os.walk(os.path.join(d, sub))]:
        for f in files:
            with open(os.path.join(base, f), errors="replace") as fh:
                pool += norm(fh.read())
    out = []
    for k in c.get("checks", []):
        if k["kind"] == "provenance":           # Rules for numbers: every figure comes from a tool
            stray = sorted({n for n in NUM.findall(ans) if norm(n) not in pool})
            out.append(dict(k, ok=not stray, detail=f"not in any artifact: {stray}" if stray else "every figure found"))
        elif k["kind"] == "max_words":
            n = len(ans.split())
            out.append(dict(k, ok=n <= k["n"], detail=f"{n} words"))
        elif k["kind"] == "absent":
            hit = [t for t in k["text"] if t.lower() in ans.lower()]
            out.append(dict(k, ok=not hit, detail=f"found {hit}" if hit else "none found"))
        elif k["kind"] == "regex":
            m = re.search(k["pattern"], ans, re.I | re.S)
            out.append(dict(k, ok=bool(m), detail=f"matched {m.group(0)[:60]!r}" if m else "no match"))
    with open(os.path.join(d, "checks.json"), "w") as fh:
        json.dump(out, fh, indent=1)
    for k in out:
        print(f"  {'✓' if k['ok'] else '✗'} {k['id']} {k['kind']}: {k['detail']}")


def record(eid):
    c, d = card(eid), os.path.join(WORK, eid)
    with open(os.path.join(d, "checks.json")) as fh:
        checks = json.load(fh)
    with open(os.path.join(d, "grade.json")) as fh:
        grade = json.load(fh)
    missing = [r["id"] for r in c["rubric"] if r["id"] not in grade]
    if missing:
        sys.exit(f"grade.json misses {missing}")
    got = sum(k["ok"] for k in checks) + sum(r["weight"] * float(grade[r["id"]]["score"]) for r in c["rubric"])
    of = len(checks) + sum(r["weight"] for r in c["rubric"])
    blockers = [k["id"] for k in checks if k.get("critical") and not k["ok"]] + \
               [r["id"] for r in c["rubric"] if r.get("critical") and float(grade[r["id"]]["score"]) < 1]
    res = dict(id=eid, title=c["title"], use_cases=c["use_cases"], date=dt.date.today().isoformat(),
               score=round(got / of, 3), threshold=c["pass"], blockers=blockers,
               passed=got / of >= c["pass"] and not blockers,
               failed=[f"{k['id']}: {k['detail']}" for k in checks if not k["ok"]] +
                      [f"{r['id']} ({grade[r['id']]['score']}): {grade[r['id']].get('why', '')}" for r in c["rubric"] if float(grade[r["id"]]["score"]) < 1])
    with open(os.path.join(d, "result.json"), "w") as fh:
        json.dump(res, fh, indent=1)
    print(f"{eid}: {'PASS' if res['passed'] else 'FAIL'}  score {res['score']:.2f} (pass ≥ {c['pass']})"
          + (f"  blockers {blockers}" if blockers else ""))
    for f in res["failed"]:
        print(f"  - {f}")


def results():
    out = {}
    for eid in cards():
        p = os.path.join(WORK, eid, "result.json")
        if os.path.exists(p):
            with open(p) as fh:
                out[eid] = json.load(fh)
    return out


def report():
    rs = results()
    L = ["# Eval results", "", "Generated by `python3 evals/run.py report` from the last run of each card on the synthetic",
         "fixture (`evals/fixture.py`). Synthetic: no figure in an answer may be quoted elsewhere.", "",
         "| eval | use cases | date | score | pass | what lost points |", "|---|---|---|---|---|---|"]
    for eid, c in cards().items():
        r = rs.get(eid)
        if not r:
            L.append(f"| {eid} {c['title']} | {', '.join(c['use_cases'])} | — | — | not run | |")
            continue
        lost = "<br>".join(f.replace("|", "\\|") for f in r["failed"]) or "—"
        L.append(f"| {eid} {c['title']} | {', '.join(c['use_cases'])} | {r['date']} | {r['score']:.2f} | "
                 f"{'**pass**' if r['passed'] else '**fail**'} | {lost} |")
    with open(os.path.join(HERE, "RESULTS.md"), "w") as fh:
        fh.write("\n".join(L) + "\n")
    print(f"evals/RESULTS.md: {len(rs)} of {len(cards())} cards run, {sum(r['passed'] for r in rs.values())} passed")


def main():
    a = sys.argv[1:]
    if not a or a[0] not in ("list", "prepare", "check", "record", "report"):
        sys.exit(__doc__.strip())
    if a[0] == "list":
        rs = results()
        for eid, c in cards().items():
            r = rs.get(eid)
            state = f"{'pass' if r['passed'] else 'FAIL'} {r['score']:.2f} {r['date']}" if r else "not run"
            print(f"{eid}  {c['title']:<44} {','.join(c['use_cases']):<22} {state}")
    elif a[0] == "report":
        report()
    else:
        ids = a[1:] or sys.exit(f"usage: run.py {a[0]} EV-xx [EV-yy …]")
        for eid in (list(cards()) if ids == ["all"] else ids):
            {"prepare": prepare, "check": check, "record": record}[a[0]](eid)


if __name__ == "__main__":
    main()
