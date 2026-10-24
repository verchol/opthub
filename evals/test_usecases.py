#!/usr/bin/env python3
"""Deterministic checks for the use cases in docs/use-cases.md, one test per claim, named by its UC id.

Every command runs as a subprocess, the way a user runs it, on the synthetic workspace from
evals/fixture.py: four transcripts, an empty HOME, a fake .env, and an egress trap. Free: no model
call, no Docker, nothing beyond 127.0.0.1. Stdlib only.

    python3 -m unittest evals/test_usecases.py -v
    python3 -m unittest evals.test_usecases.Visibility -v      # one phase
"""
import csv, json, os, re, shutil, socket, subprocess, sys, tempfile, time, unittest, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import fixture as fx  # noqa: E402

REPO = fx.REPO
FX = ENV = IDS = BEFORE = None
GUARDED = [os.path.join(REPO, d) for d in ("data/private", "app/results", "app/audit")]


def snapshot():
    """Every file under the stores a run must never touch, with its size and mtime."""
    out = {}
    for top in GUARDED:
        for base, dirs, files in os.walk(top):
            dirs[:] = [x for x in dirs if os.path.join(base, x) != os.path.join(REPO, "data", "private", "evals")]   # evals/run.py's own
            for f in files:
                st = os.stat(os.path.join(base, f))
                out[os.path.join(base, f)] = (st.st_size, st.st_mtime_ns)
    return out


def setUpModule():
    global FX, ENV, IDS, BEFORE
    BEFORE = snapshot()
    FX = tempfile.mkdtemp(prefix="opthub-usecases-")
    IDS = fx.build(FX)
    ENV = fx.env(FX)


def tearDownModule():
    shutil.rmtree(FX, ignore_errors=True)
    after = snapshot()
    touched = sorted(k for k in after.keys() | BEFORE.keys() if after.get(k) != BEFORE.get(k))
    if touched:                                   # reported as an ERROR in tearDownModule
        raise AssertionError("the run wrote into the checkout's own stores:\n  " + "\n  ".join(os.path.relpath(t, REPO) for t in touched))


def run(*argv, env=None, ok=True, timeout=120):
    """Run a command from the checkout root; python3 tools/x.py → this interpreter."""
    argv = [sys.executable if a == "python3" else a for a in argv]
    r = subprocess.run(argv, cwd=REPO, env=env or ENV, capture_output=True, text=True, timeout=timeout)
    if ok and r.returncode != 0:
        raise AssertionError(f"{' '.join(argv[1:3])} exited {r.returncode}\n{r.stderr[-1500:]}")
    return r


def py(tool, *args, **kw):
    return run("python3", os.path.join("tools", tool), *args, **kw)


def opt(*args, **kw):
    return run("node", os.path.join("app", "opt.mjs"), *args, **kw)


def dollars(text, label):
    m = re.search(label + r"\s*:?\s*\$\s*([\d,]+\.\d+)", text)
    return float(m.group(1).replace(",", "")) if m else None


def tree_text(d):
    out = []
    for base, _, files in os.walk(d):
        for f in files:
            with open(os.path.join(base, f), errors="replace") as fh:
                out.append(fh.read())
    return "\n".join(out)


# ------------------------------------------------------------------ A. install and init

class Install(unittest.TestCase):
    def test_uc01_cli_lists_the_journey(self):
        r = run(os.path.join(REPO, "opt"), "--help")
        for cmd in ("opt scan", "opt hub start", "opt install", "opt init", "opt session", "opt claude optimize"):
            self.assertIn(cmd, re.sub(r"\x1b\[[0-9;]*m", "", r.stdout), cmd)

    def test_uc01_hub_page_is_built(self):
        self.assertTrue(os.path.exists(os.path.join(REPO, "app", "web", "dist", "index.html")),
                        "app/web/dist missing: npm run build:web")

    def test_uc02_every_secret_is_in_the_template(self):
        import envfile
        with open(os.path.join(REPO, ".env.example")) as fh:
            template = fh.read()
        self.assertEqual([k for k in envfile.KNOWN if k not in template], [])

    def test_uc02_check_masks_values(self):
        r = py("envfile.py", "check")
        self.assertIn("ANTHROPIC_API_KEY", r.stdout)
        self.assertNotIn(fx.FAKE_KEY, r.stdout + r.stderr)
        self.assertRegex(r.stdout, r"ANTHROPIC_API_KEY\s+sk-a… \(\d+ chars\)\s+\.env")

    def test_uc02_check_warns_when_both_credentials_are_set(self):
        r = py("envfile.py", "check", env=dict(ENV, CLAUDE_CODE_OAUTH_TOKEN=fx.FAKE_TOKEN))
        self.assertIn("moves runs onto API billing", r.stdout)
        self.assertNotIn(fx.FAKE_TOKEN, r.stdout)

    def test_uc05_retention_boundary_is_reported(self):
        early = py("sessions.py", "--since", "2026-01-01").stdout
        self.assertIn("your window starts BEFORE that", early)
        late = py("sessions.py", "--since", "2026-10-01").stdout
        self.assertNotIn("BEFORE that", late)


# ------------------------------------------------------------------ B. visibility

class Visibility(unittest.TestCase):
    def test_uc10_inventory_counts_every_session(self):
        r = py("sessions.py", "--since", fx.SINCE, "--sort", "cost", "--full-id")
        self.assertRegex(r.stdout, r"sessions : 4 ")
        for sid in IDS.values():
            self.assertIn(sid, r.stdout)

    def test_uc10_csv_rows_sum_to_the_header_total(self):
        path = os.path.join(FX, "sessions.csv")
        total = dollars(py("sessions.py", "--since", fx.SINCE, "--csv", path).stdout, "cost")
        with open(path) as fh:
            rows = list(csv.DictReader(fh))
        self.assertEqual(len(rows), 4)
        self.assertAlmostEqual(sum(float(x["cost"]) for x in rows), total, delta=0.01)

    def test_uc11_ops_report_for_one_session(self):
        sid = IDS["csv-export"]
        proj = os.path.dirname(next(p for p in walk_jsonl() if sid in p))
        r = py("lenops.py", "view", "--project", proj, "--session", sid)
        self.assertIn(f"lenops view · {sid[:8]} · 24 requests", r.stdout)
        for section in ("CONTEXT", "PRELOAD", "MODELS"):
            self.assertIn(section, r.stdout)

    def test_uc12_graph_agrees_with_the_inventory(self):
        sid = IDS["csv-export"]
        g = py("sessiongraph.py", sid).stdout
        inv = csv_row(sid)
        self.assertIn(f"{inv['reqs']} requests", g)
        self.assertIn(f"${float(inv['cost']):.2f} priced", g)

    def test_uc12_graph_counts_subagents(self):
        g = py("sessiongraph.py", IDS["planted"]).stdout
        self.assertRegex(g, r"\(\+4 in 1 subagents\)")

    def test_uc13_live_meter_prints_once(self):
        proj = os.path.dirname(next(p for p in walk_jsonl() if IDS["slow-report"] in p))
        r = py("ctxwatch.py", "--once", "--project", proj, "--session", IDS["slow-report"])
        self.assertIn("ctxwatch · " + IDS["slow-report"][:8], r.stdout)

    def test_uc13_opt_session_reads_only_the_store_it_is_given(self):
        out = re.sub(r"\x1b\[[0-9;]*m", "", opt("session", "--all", "--local").stdout)
        shown = set(re.findall(r"\b[0-9a-f]{8}\b", out))
        self.assertEqual(shown & {s[:8] for s in IDS.values()}, {s[:8] for s in IDS.values()}, out[-800:])
        self.assertLessEqual(len([ln for ln in out.splitlines() if re.match(r"\s*\d+\s+local", ln)]), 4, out[-800:])

    def test_uc14_hub_serves_the_sessions_it_was_given(self):
        port = free_port()
        p = subprocess.Popen(["node", os.path.join("app", "hub.mjs"), "start", "--no-open"], cwd=REPO,
                             env=dict(ENV, HUB_PORT=str(port)), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        try:
            body = None
            for _ in range(60):
                try:
                    with no_proxy().open(f"http://127.0.0.1:{port}/api/sessions", timeout=2) as resp:
                        body = json.load(resp)
                        break
                except OSError:
                    time.sleep(0.25)
            self.assertIsNotNone(body, "hub never answered")
            ids = {s["id"] for s in body["sessions"] if not s["id"].startswith("agent-")}
            self.assertEqual(ids, set(IDS.values()))
            self.assertTrue(all("potential" in s for s in body["sessions"]))
            with no_proxy().open(f"http://127.0.0.1:{port}/", timeout=2) as resp:
                self.assertIn("<html", resp.read().decode().lower())
        finally:
            p.terminate()
            p.wait(timeout=10)

    @unittest.expectedFailure
    def test_uc14_hub_does_not_list_subagents_as_sessions(self):
        """Known gap: app/lib/sessions-index.mjs walks into <sid>/subagents/ and lists each agent-*.jsonl
        as a session of its own. The fix folds subagent spend into the parent, which moves hub totals."""
        r = run("node", "-e", "import('./app/lib/sessions-index.mjs').then(m => console.log(JSON.stringify("
                "m.buildIndex({ limit: 100 }).sessions.map(s => s.id))))")
        self.assertEqual(sorted(json.loads(r.stdout)), sorted(IDS.values()))

    def test_uc15_one_rate_card_across_tools(self):
        """The same session costs the same in every tool that prices it."""
        sid = IDS["slow-report"]
        inv = float(csv_row(sid)["cost"])
        sav = py("savings.py", "--since", "2026-10-01").stdout
        graph = py("sessiongraph.py", sid).stdout
        self.assertIn(f"{inv:.2f}", sav.splitlines()[2])          # most expensive first
        self.assertIn(f"${inv:.2f} priced", graph)
        dyn = py("dynconfig.py", "--since", "2026-10-01").stdout
        golden = sum(float(csv_row(IDS[k])["cost"]) for k in ("fix-rounding", "csv-export", "slow-report"))
        self.assertIn(f"list-price cost ${golden:.2f}", dyn)

    def test_uc15_rate_card_has_a_version(self):
        self.assertRegex(py("ratecard.py").stdout, r"\d{4}-\d{2}-\d{2}")


# ------------------------------------------------------------------ C. analysis

class Analysis(unittest.TestCase):
    def test_uc20_headroom_is_bounded(self):
        out = py("savings.py", "--since", fx.SINCE).stdout
        pct = [float(x) for x in re.findall(r"(-?[\d.]+)%", out.split("as % of")[1].splitlines()[0])]
        self.assertTrue(pct and all(0 <= p <= 100 for p in pct), pct)
        stacked = dollars(out, r"A\+B stacked \(independent sides of the request\)")
        self.assertLess(stacked, dollars(out, "as % of"))

    def test_uc21_stacked_levers_sum_to_the_total(self):
        out = py("dynconfig.py", "--since", fx.SINCE).stdout
        block = out.split("stacked, marginal in applied order")[1].split("dynamic configuration, total")[0]
        levers = re.findall(r"^\s+\d+ (.+?)\s{2,}(measured|priced|guess|detector)\s+\$\s+([\d.]+)", block, re.M)
        self.assertGreaterEqual(len(levers), 5)
        total = float(re.search(r"dynamic configuration, total\s+\$\s+([\d.]+)", out).group(1))
        self.assertAlmostEqual(sum(float(x[2]) for x in levers), total, delta=0.01 * len(levers))

    def test_uc21_standalone_ceilings_are_not_stacked(self):
        out = py("dynconfig.py", "--since", fx.SINCE).stdout
        self.assertIn("standalone ceilings, not stacked", out)
        self.assertIn("MORE in re-runs", out)                     # main loop on Sonnet: measured worse

    def test_uc22_scan_writes_its_three_files(self):
        r = py("scan.py", "--since", fx.SINCE, "--no-open") if "--no-open" in py("scan.py", "--help").stdout \
            else py("scan.py", "--since", fx.SINCE)
        d = os.path.join(FX, "scan", os.listdir(os.path.join(FX, "scan"))[0])
        for f in ("findings.jsonl", "inventory.json", "report.html"):
            self.assertTrue(os.path.exists(os.path.join(d, f)), f)
        with open(os.path.join(d, "findings.jsonl")) as fh:
            self.assertTrue(all(json.loads(x)["schema"] == "opthub.finding/1" for x in fh if x.strip()))
        self.assertIn("collect first", r.stdout)                  # 4 sessions is under the 20-session floor

    def test_uc22_dry_run_writes_nothing_and_prints_json(self):
        out = os.path.join(FX, "dry")
        r = py("scan.py", "--since", fx.SINCE, "--dry", "--out", out)
        self.assertFalse(os.path.exists(out))
        lines = [x for x in r.stdout.splitlines() if x.strip()]
        self.assertTrue(lines and all(json.loads(x).get("schema", "").startswith("opthub.") for x in lines))

    def test_uc24_rollup_adds_developers(self):
        a = os.path.join(FX, "dev-a")
        b = os.path.join(FX, "dev-b")
        for d in (a, b):
            py("scan.py", "--since", fx.SINCE, "--out", d)
        dirs = [os.path.join(d, os.listdir(d)[0]) for d in (a, b)]
        r = py("scan.py", "rollup", *dirs)
        self.assertRegex(r.stdout, r"rollup of 2 scans · 8 sessions")
        self.assertTrue(any(x.startswith("rollup-") for x in os.listdir(os.path.join(FX, "scan"))))


# ------------------------------------------------------------------ D. optimization

class Optimization(unittest.TestCase):
    def test_uc30_dynamic_flags_are_labelled_guess(self):
        r = py("tune.py", IDS["fix-rounding"])
        self.assertRegex(r.stdout, r"dynamic\s*:.*\(guess — replay to measure\)")
        j = json.loads(py("tune.py", IDS["fix-rounding"], "--json").stdout)
        self.assertEqual(j["flags"][::2], [f for f in j["flags"][::2] if f in ("--model", "--effort")])
        self.assertEqual(len(j["why"]), len(j["flags"]) // 2)

    def test_uc31_plan_is_free_and_has_three_arms(self):
        r = py("rerun.py", "plan", IDS["csv-export"], "--goal", "cost", "--dynamic", "--run-id", "uc31")
        with open(os.path.join(FX, "reruns", "uc31", "plan.json")) as fh:
            plan = json.load(fh)
        self.assertEqual([a["name"] for a in plan["arms"]], ["baseline", "cost", "dynamic"])
        self.assertEqual(plan["repeats"], 3)
        self.assertIn("next     : python3 tools/rerun.py run uc31 --yes", r.stdout)
        self.assertEqual(os.listdir(os.path.join(FX, "reruns", "uc31")), ["plan.json"])

    def test_uc32_spending_commands_refuse_without_yes(self):
        py("rerun.py", "plan", IDS["fix-rounding"], "--goal", "cost", "--run-id", "uc32")
        for step in ("run", "judge"):
            r = py("rerun.py", step, "uc32", ok=False)
            self.assertNotEqual(r.returncode, 0, step)
            self.assertIn("spends money", r.stdout + r.stderr, step)
        self.assertEqual(os.listdir(os.path.join(FX, "reruns", "uc32")), ["plan.json"])

    def test_uc32_cache_probe_refuses_without_yes(self):
        r = py("probe_cache.py", "conformance", ok=False)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("refusing to call the API without --yes", r.stdout + r.stderr)


# ------------------------------------------------------------------ E. verification

class Verification(unittest.TestCase):
    def test_uc41_fewer_than_three_repeats_prints_no_verdict(self):
        import synth
        root = os.path.join(FX, "uc41")                           # its own store: replays add transcripts
        sid = fx.build(root)["fix-rounding"]
        e = fx.env(root)
        py("rerun.py", "plan", sid, "--goal", "cost", "--repeats", "1", "--from-dir", "--run-id", "uc41", env=e)
        synth.simulate(os.path.join(root, "reruns", "uc41", "plan.json"), e["OPTHUB_PROJECTS"])
        r = py("rerun.py", "report", "uc41", env=e)
        self.assertRegex(r.stdout.lower(), r"no verdict|n\s*=\s*1|fewer than 3|needs? (three|3) repeats")


class CompareTasks(unittest.TestCase):
    """UC-43: every task the `opt claude -p --compare` evals run is well-posed before anyone pays for it."""

    def test_uc43_each_check_fails_untouched_and_passes_the_solution(self):
        import claude_p
        for name in claude_p.cases():
            with self.subTest(name):
                self.assertTrue(os.path.isdir(os.path.join(claude_p.EXAMPLES, name, "solution")), "no reference solution/")
                self.assertNotEqual(claude_p.check_case(name)[0], 0, "the hidden check passes on the untouched project")
                code, last = claude_p.check_case(name, "solution")
                self.assertEqual(code, 0, f"the hidden check fails on the reference solution: {last}")

    def test_uc43_the_check_and_solution_are_out_of_the_agents_view(self):
        import claude_p
        for name in claude_p.cases():
            listed = os.listdir(os.path.join(claude_p.EXAMPLES, name, "project"))
            self.assertFalse({"check.py", "solution"} & set(listed), name)

    def test_uc43_the_eval_runner_refuses_to_spend_without_yes(self):
        r = run("python3", os.path.join("evals", "claude_p.py"), "run", "fix-invoice", ok=False)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("add --yes", r.stdout + r.stderr)

    def test_uc43_dry_run_shows_both_sides_and_spends_nothing(self):
        r = opt("claude", "example", "add-slugify", "--dry-run", "--level", "balanced")
        out = r.stdout + r.stderr
        self.assertIn("ANTHROPIC_BASE_URL", out)
        self.assertIn("plain side", out)


# ------------------------------------------------------------------ F. trust

class Trust(unittest.TestCase):
    def test_uc51_the_egress_trap_is_armed(self):
        r = run("python3", "-c", "import urllib.request as u; u.urlopen('https://example.com', timeout=5)", ok=False)
        self.assertNotEqual(r.returncode, 0, "the trap let a request out: every 'free' check below proves nothing")

    def test_uc50_nothing_that_leaves_carries_text(self):
        dry = py("scan.py", "--since", fx.SINCE, "--dry").stdout + py("onboard.py", "--since", fx.SINCE, "--dry", ok=False).stdout
        for needle in (fx.PLANTED, fx.PLANTED_PATH, "planted-zx81", "someone"):
            self.assertNotIn(needle, dry, needle)

    def test_uc50_scan_files_carry_no_text(self):
        out = os.path.join(FX, "privacy")
        py("scan.py", "--since", fx.SINCE, "--out", out)
        written = tree_text(out)
        self.assertGreater(len(written), 1000)
        for needle in (fx.PLANTED, "planted-zx81"):
            self.assertNotIn(needle, written, needle)

    def test_uc53_every_lever_carries_a_label(self):
        out = py("dynconfig.py", "--since", fx.SINCE).stdout
        rows = [ln for ln in out.splitlines() if re.match(r"\s+(\d+|X\d) \w", ln)]
        self.assertTrue(rows)
        for ln in rows:
            self.assertRegex(ln, r"\b(measured|priced|guess|detector)\b", ln)


# ------------------------------------------------------------------ helpers

def walk_jsonl():
    for base, _, files in os.walk(os.path.join(FX, "projects")):
        for f in files:
            if f.endswith(".jsonl") and "subagents" not in base:
                yield os.path.join(base, f)


_ROWS = {}


def csv_row(sid):
    if not _ROWS:
        path = os.path.join(FX, "inv.csv")
        py("sessions.py", "--since", fx.SINCE, "--csv", path)
        with open(path) as fh:
            _ROWS.update({r["sid"]: r for r in csv.DictReader(fh)})
    return _ROWS[sid]


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def no_proxy():
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


if __name__ == "__main__":
    unittest.main()
