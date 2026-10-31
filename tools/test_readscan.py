#!/usr/bin/env python3
"""Fixtures with known answers for tools/readscan.py (the bulk-read detector).
Stdlib only, no network: synthetic transcripts in a temp dir, in the record shapes Claude Code writes.

    python3 -m unittest tools/test_readscan.py -v
"""
import datetime as dt, io, json, os, sys, tempfile, unittest
from contextlib import redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ratecard, readscan  # noqa: E402

PLANTED = "PLANTED-PROMPT-rs42"                      # must never appear in any output
BIG, OTHER, HUGE, SMALL = "/w/proj/big.py", "/w/proj/other.py", "/w/proj/huge.md", "/w/proj/small.py"
T0 = dt.datetime(2026, 10, 1, 9, 0, tzinfo=dt.timezone.utc)
MODEL = "claude-opus-5-5"


def ts(s):
    return (T0 + dt.timedelta(seconds=s)).isoformat().replace("+00:00", "Z")


def numbered(n):
    return "".join(f"{i + 1:6d}→line {i + 1}\n" for i in range(n))


def asst(sid, n, s, tools=(), dup=1, side=False):
    usage = dict(input_tokens=10, cache_read_input_tokens=1000, output_tokens=50, cache_creation_input_tokens=0)
    content = [dict(type="text", text=f"{PLANTED} {n}")] + [dict(type="tool_use", id=i, name=name, input=inp) for i, name, inp in tools]
    rec = dict(type="assistant", sessionId=sid, timestamp=ts(s), isSidechain=side, cwd="/w/proj", requestId=f"req_{sid}_{n}",
               message=dict(id=f"msg_{sid}_{n}", model=MODEL, usage=usage, content=content))
    return [rec] * dup


def result(sid, s, tool_use_id, text, num_lines=None):
    rec = dict(type="user", sessionId=sid, timestamp=ts(s),
               message=dict(role="user", content=[dict(type="tool_result", tool_use_id=tool_use_id, content=[dict(type="text", text=text)])]))
    if num_lines is not None:
        rec["toolUseResult"] = dict(type="text", file=dict(filePath="x", content="", numLines=num_lines, startLine=1, totalLines=num_lines))
    return [rec]


def write(path, recs):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        for r in recs:
            fh.write(json.dumps(r) + "\n")


def fixture(root, sid="s-aaaaaaaa-1"):
    big, cat = numbered(500), numbered(400)
    main = (asst(sid, 1, 0, [("tu1", "Read", dict(file_path=BIG))])
            + result(sid, 5, "tu1", big, 500)                                        # large, whole: fires
            + asst(sid, 2, 30, [("tu2", "Read", dict(file_path=BIG, offset=10, limit=20))])
            + result(sid, 35, "tu2", numbered(20), 20)                               # targeted: no fire, a re-read
            + asst(sid, 3, 60, [("tu3", "Bash", dict(command="cat other.py"))])
            + result(sid, 65, "tu3", cat)                                            # shell read: fires
            + asst(sid, 4, 90, [("tu4", "Read", dict(file_path=SMALL))])
            + result(sid, 95, "tu4", numbered(20), 20)                               # small: no fire
            + asst(sid, 5, 120, dup=3)                                               # one request, three records
            + asst(sid, 6, 150) + asst(sid, 7, 180) + asst(sid, 8, 210)
            + [dict(type="system", subtype="compact_boundary", sessionId=sid, timestamp=ts(240))]
            + asst(sid, 9, 270) + asst(sid, 10, 300, [("tu5", "Edit", dict(file_path=OTHER, old_string="a", new_string="b"))]))
    write(os.path.join(root, "-w-proj", f"{sid}.jsonl"), main)
    sub = (asst(sid, 101, 40, [("tu9", "Read", dict(file_path=HUGE))], side=True)
           + result(sid, 45, "tu9", numbered(600), 600)
           + asst(sid, 102, 50, side=True) + asst(sid, 103, 55, side=True))
    write(os.path.join(root, "-w-proj", sid, "subagents", "agent-1.jsonl"), sub)
    return big, cat


class ReadScan(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        self.big, self.cat = fixture(self.root)
        self.rows = readscan.scan(self.root, None, 350, 600)
        self.by = {r["files"][0]: r for r in self.rows}

    def tearDown(self):
        self.tmp.cleanup()

    def test_finds_whole_reads_over_the_threshold_only(self):
        self.assertEqual(sorted(self.by), sorted([BIG, OTHER, HUGE]))
        self.assertEqual(self.by[BIG]["tool"], "Read")
        self.assertEqual(self.by[OTHER]["tool"], "Bash")

    def test_lines_come_from_the_read_metadata_or_the_text(self):
        self.assertEqual(self.by[BIG]["lines"], 500)
        self.assertEqual(self.by[OTHER]["lines"], 400)

    def test_carry_counts_distinct_requests_until_the_compaction(self):
        # requests 2..8 follow the big read before the boundary; request 5's three records count once
        self.assertEqual(self.by[BIG]["carry"], 7)
        self.assertEqual(self.by[OTHER]["carry"], 5)

    def test_subagent_reads_carry_on_their_own_thread_and_are_not_delegable(self):
        self.assertEqual(self.by[HUGE]["side"], "sub")
        self.assertEqual(self.by[HUGE]["carry"], 2)
        self.assertFalse(self.by[HUGE]["delegable"])

    def test_a_file_edited_afterwards_is_not_delegable(self):
        self.assertTrue(self.by[OTHER]["edited"])
        self.assertFalse(self.by[OTHER]["delegable"])
        self.assertTrue(self.by[BIG]["delegable"])

    def test_a_later_targeted_read_counts_as_a_re_read(self):
        self.assertTrue(self.by[BIG]["reread"])
        self.assertFalse(self.by[OTHER]["reread"])

    def test_prices_match_a_hand_calculation(self):
        inp, _, rd = ratecard.rates(MODEL)
        tok = len(self.big) // 4
        in_ctx = tok * inp * (ratecard.W1H + 7 * rd) / 1e6
        w_in, w_out, _ = ratecard.rates(readscan.WORKER)
        delegated = 600 * inp * (ratecard.W1H + 7 * rd) / 1e6 + (tok * w_in + 600 * w_out) / 1e6
        self.assertAlmostEqual(self.by[BIG]["in_context_usd"], in_ctx, places=12)
        self.assertAlmostEqual(self.by[BIG]["saving_usd"], in_ctx - delegated, places=12)
        self.assertGreater(self.by[BIG]["saving_usd"], 0)

    def test_the_window_excludes_older_reads(self):
        rows = readscan.scan(self.root, T0 + dt.timedelta(seconds=50), 350, 600)
        self.assertEqual([r["files"][0] for r in rows], [OTHER])

    def test_summary_counts_and_hides_paths_and_prompts(self):
        s = readscan.summarize(self.rows, [dict(cost=10.0)], 350)
        self.assertEqual((s["large_reads"], s["main"], s["sub"], s["edited"], s["delegable"]), (3, 2, 1, 1, 1))
        text = json.dumps(s) + readscan.render(s, 30)
        for secret in (PLANTED, BIG, OTHER, HUGE, "proj"):
            self.assertNotIn(secret, text)
        self.assertEqual(s["label"], "priced")

    def test_show_paths_prints_them(self):
        s = readscan.summarize(self.rows, [dict(cost=10.0)], 350, show_paths=True)
        self.assertIn(BIG, json.dumps(s))

    def test_the_cli_runs_over_a_root_and_prints_json(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            readscan.main(["--root", self.root, "--days", "100000", "--json", "-"])
        s = json.loads(buf.getvalue())
        self.assertEqual(s["schema"], "opthub.readscan/1")
        self.assertEqual(s["delegable"], 1)
        self.assertNotIn(PLANTED, buf.getvalue())

    def test_shell_targets_follow_the_gate(self):
        self.assertEqual(readscan.shell_targets("cat -n a.py", "/w"), ["/w/a.py"])
        self.assertEqual(readscan.shell_targets("cat a.py | grep x", "/w"), [])
        self.assertEqual(readscan.shell_targets("head -n 5 a.py", "/w"), [])


if __name__ == "__main__":
    unittest.main()
