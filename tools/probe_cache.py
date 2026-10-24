#!/usr/bin/env python3
"""probe_cache — P2 cache-conformance (docs/onboarding-spec.md): does the API bill caching the
way the defaults model assumes? It spends cents and refuses to call the API without --yes.

    python3 tools/probe_cache.py                                   # free: the plan and its estimated cost
    python3 tools/probe_cache.py conformance --model claude-opus-5-5 --yes   # (a) smart TTL, ~8 minutes
    python3 tools/probe_cache.py path --base-url "$ANTHROPIC_BASE_URL" --yes # (b) does the gateway keep cache markers
    python3 tools/probe_cache.py show                              # stored results and whether they are current

(a) Smart-TTL conformance, once per platform and model, on OptHub's key. Two sequences on one
synthetic prefix, each with its own nonce so they cannot share a cache entry:
  probe    R1 (5-minute write) -> R2 (reads R1's prefix) -> ping (max_tokens 0, a 1-hour
           breakpoint on R2's reply) -> wait 7 minutes -> R3 (must read >= 95% through R2's reply)
  control  the same without the ping; its R3 must write, or the probe proves nothing.
The result is stored in docs/data/conformance/<platform>/<model>/smart-ttl.json with every usage
block. It expires after 30 days or when the rate card version changes.

(b) Path check, per customer: two max_tokens 0 requests through the customer's base URL; it passes
if the second reads from cache. Catches gateways that strip cache_control. Stored under
data/private/onboard/ (it names the customer's endpoint).

Only the Anthropic Messages API format is spoken here (`x-api-key`, or `Authorization: Bearer`
with --bearer for gateways). Bedrock and Vertex need their own signers: not built.
Keys come from the shell or the repo .env (tools/envfile.py): ANTHROPIC_API_KEY.
"""
import argparse, datetime as dt, hashlib, json, os, sys, time, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ratecard  # noqa: E402

REPO = os.path.dirname(HERE)
STORE = os.path.join(REPO, "docs", "data", "conformance")
PRIVATE = os.path.join(REPO, "data", "private", "onboard")
API = "https://api.anthropic.com"
WAIT_S = 7 * 60
MAX_AGE_DAYS = 30
PREFIX_TOKENS = 5000        # above every model's cache minimum the repo knows (Haiku 4.5: 4096)
READ_PASS = 0.95
REPLY_SLACK = 16       # tokens the API adds around a reply block when it is re-sent as input


# ------------------------------------------------------------------ requests

def prefix_text(nonce, tokens=PREFIX_TOKENS):
    """Synthetic, deterministic, about `tokens` tokens (4 characters each). No customer content."""
    line = "Reference row {:05d}: alpha bravo charlie delta echo foxtrot golf hotel.\n"
    rows = max(1, tokens * 4 // len(line.format(0)))
    return f"Probe {nonce}. Answer with the single word OK.\n" + "".join(line.format(i) for i in range(rows))


def text(t, ttl=None):
    b = {"type": "text", "text": t}
    if ttl:
        b["cache_control"] = {"type": "ephemeral"} if ttl == "5m" else {"type": "ephemeral", "ttl": "1h"}
    return b


def body(model, nonce, turns, max_tokens=8):
    """turns: [(role, text, ttl or None)]; the system prompt is the synthetic prefix, uncached
    on its own so every breakpoint is explicit in the turns."""
    return dict(model=model, max_tokens=max_tokens, system=[text(prefix_text(nonce))],
                messages=[dict(role=r, content=[text(t, ttl)]) for r, t, ttl in turns])


TOOL_RESULT = "Tool output:\n" + "".join(f"line {i}: status ok\n" for i in range(60))
NEW_TURN = "Next question: answer OK again."
PLACEHOLDER = "."


def http_send(base_url, key, bearer=False):
    def send(b):
        req = urllib.request.Request(base_url.rstrip("/") + "/v1/messages", data=json.dumps(b).encode(),
                                     method="POST", headers={"content-type": "application/json",
                                                             "anthropic-version": "2023-06-01",
                                                             **({"authorization": f"Bearer {key}"} if bearer else {"x-api-key": key})})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, {"error": e.read().decode(errors="replace")[:500]}
    return send


def reply_text(res):
    return "".join(b.get("text", "") for b in (res.get("content") or []) if isinstance(b, dict)) or "OK"


def usage(res):
    u = res.get("usage") or {}
    cc = u.get("cache_creation") or {}
    return dict(input=u.get("input_tokens", 0), read=u.get("cache_read_input_tokens", 0),
                write=u.get("cache_creation_input_tokens", 0),
                w5=cc.get("ephemeral_5m_input_tokens", 0), w1h=cc.get("ephemeral_1h_input_tokens", 0),
                output=u.get("output_tokens", 0))


# ------------------------------------------------------------------ (a) smart TTL

def conformance(send, model, nonce, sleep=time.sleep, log=print):
    """Run both sequences, interleaved so one wait covers them. Returns the result record."""
    steps, seq = [], {}

    def call(arm, name, b):
        status, res = send(b)
        u = usage(res) if status == 200 else None
        steps.append(dict(arm=arm, step=name, status=status, usage=u, error=None if status == 200 else res.get("error")))
        log(f"  {arm:8} {name:5} {status}  {json.dumps(u) if u else res.get('error', '')[:120]}")
        if status != 200:
            raise RuntimeError(f"{arm} {name}: HTTP {status}")
        return res, u

    for arm in ("probe", "control"):
        n = f"{nonce}-{arm}"
        r1, _ = call(arm, "R1", body(model, n, [("user", "Hello.", "5m")]))
        a1 = reply_text(r1)
        t2 = [("user", "Hello.", None), ("assistant", a1, None), ("user", TOOL_RESULT, "5m")]
        r2, u2 = call(arm, "R2", body(model, n, t2))
        a2 = reply_text(r2)
        seq[arm] = dict(nonce=n, a1=a1, a2=a2, u2=u2)
        if arm == "probe":
            ping = [("user", "Hello.", None), ("assistant", a1, None), ("user", TOOL_RESULT, None),
                    ("assistant", a2, "1h"), ("user", PLACEHOLDER, None)]
            _, up = call(arm, "ping", body(model, n, ping, max_tokens=0))
            seq[arm]["ping"] = up
    log(f"  waiting {WAIT_S // 60} minutes for the 5-minute entries to expire")
    sleep(WAIT_S)
    for arm in ("probe", "control"):
        s = seq[arm]
        t3 = [("user", "Hello.", None), ("assistant", s["a1"], None), ("user", TOOL_RESULT, None),
              ("assistant", s["a2"], None), ("user", NEW_TURN, "5m")]
        _, s["u3"] = call(arm, "R3", body(model, s["nonce"], t3))
    return verdict(model, steps, seq)


def verdict(model, steps, seq):
    p, c = seq["probe"], seq["control"]
    ping = p["ping"]
    through_reply = ping["read"] + ping["write"]          # prompt tokens through R2's reply
    checks = {
        "R1 writes at 5 minutes": steps[0]["usage"]["w5"] > 0 and steps[0]["usage"]["read"] == 0,
        "R2 reads R1's prefix": p["u2"]["read"] > 0,
        "ping writes only R2's reply, at 1 hour": 0 < ping["w1h"] <= p["u2"]["output"] + REPLY_SLACK and ping["w5"] == 0,
        "ping reads R2's prefix": ping["read"] >= p["u2"]["read"] + p["u2"]["write"],
        f"R3 reads >= {READ_PASS:.0%} through R2's reply": p["u3"]["read"] >= READ_PASS * through_reply,
        "control R3 writes, not reads": c["u3"]["read"] < (1 - READ_PASS) * c["u2"]["read"] and c["u3"]["write"] > 0,
    }
    return dict(probe="cache-conformance", test="smart-ttl", model=model, ratecard=ratecard.VERSION,
                date=dt.date.today().isoformat(), wait_s=WAIT_S, checks=checks,
                status="pass" if all(checks.values()) else "fail", steps=steps)


# ------------------------------------------------------------------ (b) path check

def path_check(send, model, nonce, log=print):
    out = []
    for name in ("first", "second"):
        status, res = send(body(model, nonce, [("user", "Hello.", "5m")], max_tokens=0))
        u = usage(res) if status == 200 else None
        out.append(dict(step=name, status=status, usage=u, error=None if status == 200 else res.get("error")))
        log(f"  {name:6} {status}  {json.dumps(u) if u else res.get('error', '')[:120]}")
    ok = all(s["status"] == 200 for s in out) and out[1]["usage"]["read"] > 0
    why = ("the second request read from cache" if ok else
           "a request failed" if any(s["status"] != 200 for s in out) else
           "the second request read nothing from cache: the path drops cache_control, or caching is off")
    return dict(probe="cache-conformance", test="path", model=model, date=dt.date.today().isoformat(),
                status="pass" if ok else "fail", why=why, steps=out)


# ------------------------------------------------------------------ store

def platform_of(base_url):
    return "anthropic" if base_url.rstrip("/") == API else "gateway-" + hashlib.sha256(base_url.encode()).hexdigest()[:8]


def result_path(platform, model):
    return os.path.join(STORE, platform, ratecard.canonical(model), "smart-ttl.json")


def stored(platform, model, today=None):
    """The stored smart-TTL result when it is current: under 30 days old, same rate card. Else None."""
    try:
        with open(result_path(platform, model)) as fh:
            r = json.load(fh)
    except (OSError, ValueError):
        return None
    age = ((today or dt.date.today()) - dt.date.fromisoformat(r["date"])).days
    return r if age <= MAX_AGE_DAYS and r.get("ratecard") == ratecard.VERSION else None


def estimate(model):
    """List-price cost of both sequences, from token counts estimated at 4 characters a token."""
    p = len(prefix_text("x")) // 4
    tr, rep = len(TOOL_RESULT) // 4, 8
    reqs = [  # (raw input, read, 5m write, 1h write, output)
        (5, 0, p, 0, rep), (tr, p, tr, 0, rep), (5, p + tr, 0, rep, 0), (10, p + tr, 10, 0, rep),          # probe
        (5, 0, p, 0, rep), (tr, p, tr, 0, rep), (10, 0, p + tr + rep + 10, 0, rep)]                        # control
    usd = sum(ratecard.req_cost(model, dict(input_tokens=i, cache_read_input_tokens=r, output_tokens=o,
                                             cache_creation_input_tokens=w5 + w1,
                                             cache_creation=dict(ephemeral_5m_input_tokens=w5, ephemeral_1h_input_tokens=w1)))
              for i, r, w5, w1, o in reqs)
    return usd, len(reqs), p


def main():
    ap = argparse.ArgumentParser(description="P2 cache-conformance probe. Spends cents; refuses without --yes.")
    ap.add_argument("cmd", nargs="?", choices=["plan", "conformance", "path", "show"], default="plan")
    ap.add_argument("--model", default="claude-opus-5-5")
    ap.add_argument("--base-url", default=os.environ.get("ANTHROPIC_BASE_URL") or API)
    ap.add_argument("--bearer", action="store_true", help="send the key as Authorization: Bearer (gateways)")
    ap.add_argument("--yes", action="store_true", help="allow the paid API calls")
    a = ap.parse_args()

    if a.cmd == "show":
        for root, _, files in sorted(os.walk(STORE)):
            for f in files:
                with open(os.path.join(root, f)) as fh:
                    r = json.load(fh)
                cur = stored(os.path.relpath(root, STORE).split(os.sep)[0], r["model"])
                print(f"{os.path.relpath(os.path.join(root, f), REPO)}  {r['status']}  {r['date']}  "
                      f"rate card {r.get('ratecard')}  {'current' if cur else 'EXPIRED'}")
        return

    usd, n, p = estimate(a.model)
    platform = platform_of(a.base_url)
    print(f"P2 cache-conformance on {a.model} at {platform} ({a.base_url})")
    print(f"  (a) smart TTL: {n} requests on a ~{p:,}-token synthetic prefix, one {WAIT_S // 60}-minute wait; "
          f"estimated ${usd:.3f} at list price (rate card {ratecard.VERSION})")
    print(f"  (b) path check: 2 requests, max_tokens 0, about ${2 * p * ratecard.rates(a.model)[0] * ratecard.W5 / 1e6:.3f}")
    cur = stored(platform, a.model)
    print(f"  stored smart-TTL result: {cur['status'] + ' on ' + cur['date'] if cur else 'none current'}")
    if a.cmd == "plan":
        print("\nfree so far. Run with: conformance --yes, or path --yes")
        return
    if not a.yes:
        sys.exit("refusing to call the API without --yes")
    sys.path.insert(0, HERE)
    import envfile
    envfile.load()
    key = os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")
    if not key:
        sys.exit("no ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) in the shell or .env")
    send = http_send(a.base_url, key, a.bearer)
    nonce = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S")
    if a.cmd == "conformance":
        r = conformance(send, a.model, nonce)
        path = result_path(platform, a.model)
    else:
        r = path_check(send, a.model, nonce)
        path = os.path.join(PRIVATE, "path-check.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        json.dump(r, fh, indent=1)
    for k, v in (r.get("checks") or {}).items():
        print(f"  {'pass' if v else 'FAIL'}  {k}")
    print(f"{r['status'].upper()}  -> {os.path.relpath(path, REPO)}")


if __name__ == "__main__":
    main()
