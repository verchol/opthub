#!/usr/bin/env python3
"""Fixtures with known answers for the onboarding probes (docs/onboarding-spec.md, acceptance).
Stdlib only, no network, no spend: synthetic transcripts in a temp dir, a simulated Messages API.

    python3 -m unittest tools/test_onboard.py -v
"""
import hashlib, json, os, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import probe_cache, ratecard  # noqa: E402


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


if __name__ == "__main__":
    unittest.main()
