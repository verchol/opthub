#!/usr/bin/env python3
"""Fixtures with known answers for the onboarding probes (docs/onboarding-spec.md, acceptance).
Stdlib only, no network, no spend: synthetic transcripts in a temp dir, a simulated Messages API.

    python3 -m unittest tools/test_onboard.py -v
"""
import datetime as dt, hashlib, json, os, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import cachestatus, gapscan, onboardlib as ob, probe_cache, ratecard, savings  # noqa: E402

PLANTED = "PLANTED-PROMPT-zx81"                     # must never appear in any output
PLANTED_PATH = "/Users/planted-user/secret/file.py"
T0 = dt.datetime(2026, 9, 1, 9, 0, tzinfo=dt.timezone.utc)


def req(gap=30, model="claude-opus-5-5", cr=0, w5=0, w1=0, raw=10, out=100, think=0, stop="tool_use", tools=("Read",)):
    return dict(gap=gap, model=model, cr=cr, w5=w5, w1=w1, raw=raw, out=out, think=think, stop=stop, tools=tools)


def write_session(root, sid, start, reqs, project="-Users-planted-user-proj", dup=2, subs=(), entry="cli"):
    """A Claude Code transcript: a planted prompt, then each request as `dup` records (one per
    content block) repeating its usage, as Claude Code writes them. subs: [(agentType, reqs)]."""
    def records(rs, t, side):
        out, n = [], 0
        for q in rs:
            t += dt.timedelta(seconds=q["gap"])
            n += 1
            mid = f"msg_{sid}_{side}_{n}"
            usage = dict(input_tokens=q["raw"], cache_read_input_tokens=q["cr"], output_tokens=q["out"],
                         cache_creation_input_tokens=q["w5"] + q["w1"],
                         cache_creation=dict(ephemeral_5m_input_tokens=q["w5"], ephemeral_1h_input_tokens=q["w1"]),
                         output_tokens_details=dict(thinking_tokens=q["think"]))
            blocks = [dict(type="text", text=f"{PLANTED} reply")] + [
                dict(type="tool_use", id=f"tu_{mid}_{k}", name=name, input=dict(file_path=PLANTED_PATH))
                for k, name in enumerate(q["tools"])]
            for b in (blocks * dup)[:max(dup, len(blocks))]:
                out.append(dict(type="assistant", sessionId=sid, timestamp=t.isoformat().replace("+00:00", "Z"),
                                entrypoint=entry, cwd=PLANTED_PATH, isSidechain=side != "main", requestId=f"req_{mid}",
                                message=dict(id=mid, model=q["model"], role="assistant", stop_reason=q["stop"],
                                             content=[b], usage=usage)))
        return out
    d = os.path.join(root, project)
    os.makedirs(d, exist_ok=True)
    lines = [dict(type="user", sessionId=sid, timestamp=start.isoformat().replace("+00:00", "Z"), entrypoint=entry,
                  cwd=PLANTED_PATH, message=dict(role="user", content=f"{PLANTED} please edit {PLANTED_PATH}"))]
    lines += records(reqs, start, "main")
    with open(os.path.join(d, sid + ".jsonl"), "w") as fh:
        fh.writelines(json.dumps(x) + "\n" for x in lines)
    for k, (agent, rs) in enumerate(subs):
        sd = os.path.join(d, sid, "subagents")
        os.makedirs(sd, exist_ok=True)
        with open(os.path.join(sd, f"agent-{k}.jsonl"), "w") as fh:
            fh.writelines(json.dumps(x) + "\n" for x in records(rs, start, f"sub{k}"))
        write_json(os.path.join(sd, f"agent-{k}.meta.json"), dict(agentType=agent, description=PLANTED))


# ------------------------------------------------------------------ a simulated Messages API

class FakeAPI:
    """Prompt caching as documented: entries at breakpoints, a read is the longest live entry at or
    before the last breakpoint (and refreshes it), each later breakpoint writes up to itself at its
    TTL. strip=True is a gateway that drops cache_control."""

    def __init__(self, strip=False):
        self.now, self.cache, self.strip = 0.0, {}, strip

    def sleep(self, s):
        self.now += s

    def send(self, b):
        blocks = [("system", x) for x in b["system"]] + [(m["role"], x) for m in b["messages"] for x in m["content"]]
        h, cum, keys, total = hashlib.sha256(), [], [], 0
        for role, x in blocks:
            h.update((role + "\0" + x["text"]).encode())
            total += len(x["text"]) // 4 + 3
            cum.append(total)
            keys.append(h.hexdigest())
        bps = [] if self.strip else [(i, x["cache_control"].get("ttl", "5m")) for i, (_, x) in enumerate(blocks) if x.get("cache_control")]
        read = 0
        if bps:
            for i in range(bps[-1][0], -1, -1):
                e = self.cache.get(keys[i])
                if e and e[0] > self.now:
                    read = cum[i]
                    self.cache[keys[i]] = (self.now + e[1], e[1])
                    break
        w5 = w1 = 0
        upto = read
        for i, ttl in bps:
            if cum[i] > upto:
                n = cum[i] - upto
                w5, w1 = (w5 + n, w1) if ttl == "5m" else (w5, w1 + n)
                life = 300 if ttl == "5m" else 3600
                self.cache[keys[i]] = (self.now + life, life)
                upto = cum[i]
        out = min(b["max_tokens"], 2)
        return 200, dict(content=[{"type": "text", "text": "OK"}] if out else [],
                         usage=dict(input_tokens=total - upto, cache_read_input_tokens=read,
                                    cache_creation_input_tokens=w5 + w1, output_tokens=out,
                                    cache_creation=dict(ephemeral_5m_input_tokens=w5, ephemeral_1h_input_tokens=w1)))


quiet = lambda *a, **k: None


def write_json(p, obj):
    with open(p, "w") as fh:
        json.dump(obj, fh)


class P2CacheConformance(unittest.TestCase):
    def test_smart_ttl_passes_and_the_control_misses(self):
        api = FakeAPI()
        r = probe_cache.conformance(api.send, "claude-opus-5-5", "t", sleep=api.sleep, log=quiet)
        self.assertEqual(r["status"], "pass", r["checks"])
        r3 = [s for s in r["steps"] if s["step"] == "R3"]
        self.assertGreater(r3[0]["usage"]["read"], 0)                      # probe: read through R2's reply
        self.assertEqual(r3[1]["usage"]["read"], 0)                        # control: everything re-written

    def test_without_the_one_hour_entry_the_probe_fails(self):
        api = FakeAPI()
        real = api.send
        api.send = lambda b: real({**b, "messages": [dict(m, content=[{k: v for k, v in x.items() if not (k == "cache_control" and v.get("ttl"))} for x in m["content"]]) for m in b["messages"]]})
        r = probe_cache.conformance(api.send, "claude-opus-5-5", "t", sleep=api.sleep, log=quiet)
        self.assertEqual(r["status"], "fail")

    def test_path_check_catches_a_gateway_that_strips_cache_control(self):
        self.assertEqual(probe_cache.path_check(FakeAPI().send, "claude-opus-5-5", "t", log=quiet)["status"], "pass")
        r = probe_cache.path_check(FakeAPI(strip=True).send, "claude-opus-5-5", "t", log=quiet)
        self.assertEqual(r["status"], "fail")
        self.assertIn("drops cache_control", r["why"])

    def test_the_estimate_is_cents(self):
        usd, n, _ = probe_cache.estimate("claude-opus-5-5")
        self.assertEqual(n, 7)
        self.assertLess(usd, 0.50)

    def test_stored_results_expire(self):
        import datetime as dt
        saved = probe_cache.STORE
        with tempfile.TemporaryDirectory() as d:
            probe_cache.STORE = d
            p = probe_cache.result_path("anthropic", "claude-opus-5-5")
            os.makedirs(os.path.dirname(p))
            write_json(p, dict(model="claude-opus-5-5", date="2026-10-01", ratecard=ratecard.VERSION, status="pass"))
            self.assertIsNotNone(probe_cache.stored("anthropic", "claude-opus-5-5", today=dt.date(2026, 10, 20)))
            self.assertIsNone(probe_cache.stored("anthropic", "claude-opus-5-5", today=dt.date(2026, 11, 5)))
            write_json(p, dict(model="claude-opus-5-5", date="2026-10-01", ratecard="old", status="pass"))
            self.assertIsNone(probe_cache.stored("anthropic", "claude-opus-5-5", today=dt.date(2026, 10, 2)))
        probe_cache.STORE = saved


# dense 1-hour-TTL session with heavy writes against heavy reads (write:read 0.4): 5 minutes wins
def dense(n=6, start_cr=0):
    return [req(gap=0 if i == 0 else 30, cr=start_cr if i == 0 else 1_000_000, w1=400_000) for i in range(n)]


# requests 10 minutes apart on a big read (write:read 0.05): 5 minutes loses
def spaced(n=3):
    return [req(gap=0 if i == 0 else 600, cr=0 if i == 0 else 200_000, w1=10_000) for i in range(n)]


def fixture(kinds):
    d = tempfile.mkdtemp()
    for i, k in enumerate(kinds):
        write_session(d, f"s{i:02d}", T0 + dt.timedelta(hours=6 * i), dense() if k == "A" else spaced())
    return d


class P3GapScan(unittest.TestCase):
    def scan(self, root):
        S, _ = ob.load(root)
        return S, gapscan.probe(S, ob.window(S), sum(s["cost"] for s in S))

    def test_the_policy_a_session_ran_prices_it_as_run(self):
        S, _ = self.scan(fixture("AB"))
        for s in S:
            self.assertAlmostEqual(gapscan.cost(s["reqs"], "1h"), gapscan.cost(s["reqs"], "current"), places=9)

    def test_5m_is_lever_c_of_savings_py(self):
        root = fixture("ABAB")
        S, _ = ob.load(root)
        V = savings.walk(root, T0 - dt.timedelta(days=1))
        for s in S:
            c = savings.levers(V[s["sid"]])[2]
            self.assertAlmostEqual(gapscan.cost(s["reqs"], "current") - gapscan.cost(s["reqs"], "5m"), c, places=9)

    def test_a_stable_win_is_emitted_against_its_population(self):
        _, F = self.scan(fixture("A" * 10))
        f = next(x for x in F if x["population"]["predicate"] == "write:read < 0.5" and x["counterfactual"]["policy"] == "5m")
        self.assertEqual((f["status"], f["population"]["sessions"]), ("emit", 10))
        self.assertEqual(f["stability"]["sign_flips"], 0)
        self.assertGreater(f["delta"]["usd"], 0)
        smart = next(x for x in F if x["population"]["predicate"] == "write:read < 0.5" and x["counterfactual"]["policy"].startswith("smart"))
        self.assertEqual((smart["status"], smart["next"]), ("unconfirmed", "run-probe"))   # no P2 result stored

    def test_a_win_that_flips_sign_across_sub_windows_is_not_emitted(self):
        _, F = self.scan(fixture("AABBAABBAA"))
        f = next(x for x in F if x["population"]["predicate"] == "write:read < 0.5" and x["counterfactual"]["policy"] == "5m")
        self.assertGreater(f["delta"]["usd"], 0)
        self.assertEqual(f["status"], "silent")
        self.assertGreater(f["stability"]["sign_flips"], 0)


class P1CacheStatus(unittest.TestCase):
    def test_shares_are_exact(self):
        d = tempfile.mkdtemp()
        write_session(d, "s", T0, [req(raw=1000, cr=0, w5=3000), req(raw=500, cr=3000, w1=1500)])
        S, _ = ob.load(d)
        sh = cachestatus.shares(cachestatus.tokens(S[0]["reqs"]))
        self.assertEqual((sh["uncached"], sh["hit"], sh["ttl_1h"]), (1500 / 9000, 3000 / 7500, 1500 / 4500))

    def test_uncached_sessions_emit_cache_enable_at_the_hand_calculated_saving(self):
        d = tempfile.mkdtemp()
        for i in range(10):     # 100k, 110k, 120k prompts 30 s apart, nothing cached, Opus 5.5 at $4
            write_session(d, f"s{i}", T0 + dt.timedelta(hours=i), [req(gap=0, raw=100_000, out=0), req(raw=110_000, out=0), req(raw=120_000, out=0)])
        S, _ = ob.load(d)
        f = cachestatus.probe(S, ob.window(S), sum(s["cost"] for s in S))[0]
        self.assertEqual(f["status"], "emit")
        # as run 330k x $4/M; cached: 100k x 1.25, then 100k read + 10k write, then 110k read + 10k write
        per = (330_000 - (125_000 + 5_000 + 12_500 + 5_500 + 12_500)) * 4 / 1e6
        self.assertAlmostEqual(f["delta"]["usd"], round(10 * per, 4), places=4)

    def test_a_97_percent_hit_rate_emits_nothing(self):
        d = tempfile.mkdtemp()
        write_session(d, "s", T0, [req(gap=0, cr=0, w1=3_000)] + [req(cr=97_000, w1=3_000) for _ in range(30)])
        S, _ = ob.load(d)
        f = cachestatus.probe(S, ob.window(S), sum(s["cost"] for s in S))[0]
        self.assertEqual(f["status"], "silent")
        self.assertIn("nothing to win", f["note"])

    def test_admin_report_ceiling_matches_a_hand_calculation(self):
        doc = dict(data=[dict(results=[
            dict(api_key_id="k1", model="claude-opus-5-5", uncached_input_tokens=1_000_000, cache_read_input_tokens=0, output_tokens=0, speed="fast"),
            dict(api_key_id="k2", model="claude-opus-5-5", uncached_input_tokens=0, cache_read_input_tokens=5_000_000,
                 cache_creation=dict(ephemeral_5m_input_tokens=100_000), output_tokens=0)])])
        (f,), side = cachestatus.admin_probe(doc, {})
        self.assertEqual((f["status"], f["population"]["keys"]), ("emit", 1))   # k2's hits don't hide k1
        self.assertAlmostEqual(f["delta"]["usd"], 1_000_000 * 4 * (1 - 0.05) / 1e6)
        self.assertEqual(side["fast mode"], 4.0)
        self.assertNotIn("batch", side)


if __name__ == "__main__":
    unittest.main()
