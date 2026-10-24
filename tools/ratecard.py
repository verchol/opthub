#!/usr/bin/env python3
"""ratecard — the one price table every tool prices with.

    python3 tools/ratecard.py          # print the card
    python3 tools/ratecard.py check    # compare it with Claude Code's own cost records

Cost is *API list-price equivalent*, $/MTok: the unit for sizing an optimizer, not a
bill (most of this traffic ran on a subscription). Every finding records VERSION, so
change it whenever a number below changes.

Sources (docs/onboarding-spec.md, build step 1):
  * list rates: app/config/ult.default.json `prices`, the table the app prices with.
  * cache reads: 0.05x input on Opus 5.5 and Sonnet 5.5, 0.025x on Fable 5.1 and
    Mythos 5.1, 0.1x on everything else. `check` reproduces Opus 5.5's 0.05x and the
    older models' 0.1x from the `cost-state` records Claude Code writes into its
    transcripts (exact on every session that ran one model).
  * cache writes: 1.25x input at the 5-minute TTL, 2x at 1 hour.
  * Haiku 5.5: $0.10 / $0.50, from those same cost-state records (`check`). A request
    above 100K prompt tokens is priced at 5x (the spec's long-prompt tier; no request
    on the development machine has reached it).
  * Bedrock regional endpoints (`us.`, `eu.`, ... model ids) cost 1.1x; `global.` does not.
"""
import collections, glob, json, os, re, sys

VERSION = "2026-10-24"

PRICE = {                                   # $/MTok (input, output)
    "claude-opus-5-5":   (4.0, 20.0),
    "claude-opus-5":     (5.0, 25.0),
    "claude-opus-4-8":   (5.0, 25.0),
    "claude-fable-5-1":  (10.0, 50.0),
    "claude-fable-5":    (10.0, 50.0),
    "claude-sonnet-5-5": (2.0, 10.0),
    "claude-sonnet-5":   (2.0, 10.0),
    "claude-haiku-5-5":  (0.10, 0.50),
    "claude-haiku-4-5":  (1.0, 5.0),
}
READ = {"claude-opus-5-5": 0.05, "claude-sonnet-5-5": 0.05,
        "claude-fable-5-1": 0.025, "claude-mythos-5-1": 0.025}
READ_DEFAULT = 0.1
W5, W1H = 1.25, 2.0
LONG = {"claude-haiku-5-5": (100_000, 5.0)}  # model: (prompt tokens above which, multiplier)
GEO = 1.1
DEFAULT_MODEL = "claude-opus-5"

_REGION = re.compile(r"^(global|us|eu|apac|jp|au|ca|us-gov)\.")


def canonical(model):
    """`us.anthropic.claude-opus-5-5-v1:0`, `claude-opus-5[1m]`, `claude-haiku-4-5-20251001`,
    `claude-opus-5@20260101` -> the PRICE key."""
    m = _REGION.sub("", model or "")
    m = m.removeprefix("anthropic.")
    m = re.sub(r"\[1m\]$", "", m)
    m = re.sub(r"-v\d+(:\d+)?$", "", m)
    m = re.sub(r"[-@]\d{8}$", "", m)
    return m


def geo(model):
    """1.1 on a Bedrock regional endpoint, 1.0 everywhere else."""
    r = _REGION.match(model or "")
    return GEO if r and r.group(1) != "global" else 1.0


def rates(model):
    """(input $/MTok, output $/MTok, cache-read multiplier), or None for a model the card lacks."""
    m = canonical(model)
    p = PRICE.get(m)
    return (p[0], p[1], READ.get(m, READ_DEFAULT)) if p else None


def split_write(u):
    """(5-minute, 1-hour) cache-write tokens. Records older than the TTL breakdown count as 1 hour."""
    cc = u.get("cache_creation") or {}
    w5, w1 = cc.get("ephemeral_5m_input_tokens", 0), cc.get("ephemeral_1h_input_tokens", 0)
    if not (w5 or w1):
        w1 = u.get("cache_creation_input_tokens", 0)
    return w5, w1


def prompt_tokens(u):
    return u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0) + u.get("cache_creation_input_tokens", 0)


def parts(model, u, default=DEFAULT_MODEL):
    """Dollar cost of one request by side: input, read, write, output. None when the model is
    unknown and default is None."""
    r = rates(model) or (default and rates(default))
    if not r:
        return None
    inp, out, rd = r
    w5, w1 = split_write(u)
    k = geo(model)
    tier = LONG.get(canonical(model))
    if tier and prompt_tokens(u) > tier[0]:
        k *= tier[1]
    return dict(input=u.get("input_tokens", 0) * inp * k / 1e6,
                read=u.get("cache_read_input_tokens", 0) * inp * rd * k / 1e6,
                write=(w5 * W5 + w1 * W1H) * inp * k / 1e6,
                output=u.get("output_tokens", 0) * out * k / 1e6)


def req_cost(model, u, default=DEFAULT_MODEL):
    """List-price-equivalent cost of one request; 0.0 when the model is unknown and default is None."""
    p = parts(model, u, default)
    return sum(p.values()) if p else 0.0


def check(root):
    """Price each session's per-model token totals from its last cost-state record and compare
    with the costUSD Claude Code recorded. Writes are counted at 1 hour (cost-state does not
    split them), so a model whose sessions used 5-minute writes reads high."""
    last = {}
    for f in glob.glob(os.path.join(root, "*", "*.jsonl")):
        for line in open(f, errors="replace"):
            if '"cost-state"' not in line:
                continue
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if r.get("type") == "cost-state":
                last[f] = r
    agg = collections.defaultdict(lambda: [0, 0.0, 0.0, 0])
    for r in last.values():
        for m, x in (r.get("modelUsage") or {}).items():
            u = dict(input_tokens=x.get("inputTokens", 0), output_tokens=x.get("outputTokens", 0),
                     cache_read_input_tokens=x.get("cacheReadInputTokens", 0),
                     cache_creation_input_tokens=x.get("cacheCreationInputTokens", 0))
            a = agg[m]
            a[0] += 1
            a[1] += x.get("costUSD", 0.0)
            a[2] += req_cost(m, u, default=None)
            a[3] += rates(m) is None
    print(f"rate card {VERSION} vs Claude Code's cost-state, {len(last)} sessions\n")
    print(f"  {'model':28} {'sessions':>8} {'Claude Code':>12} {'rate card':>10} {'ratio':>6}")
    for m, (n, cc, mine, unknown) in sorted(agg.items(), key=lambda kv: -kv[1][1]):
        ratio = f"{mine / cc:6.3f}" if cc and not unknown else "     -"
        print(f"  {m:28} {n:8d} {cc:12.4f} {mine:10.4f} {ratio}" + ("  not on the card" if unknown else ""))


def main():
    if sys.argv[1:2] == ["check"]:
        check(os.environ.get("OPTHUB_PROJECTS") or os.path.expanduser("~/.claude/projects"))
        return
    print(f"rate card {VERSION}, $/MTok list\n")
    print(f"  {'model':20} {'input':>6} {'output':>7} {'read':>6} {'write 5m':>9} {'write 1h':>9}")
    for m, (i, o) in PRICE.items():
        rd = READ.get(m, READ_DEFAULT)
        tier = f"   x{LONG[m][1]:g} above {LONG[m][0] // 1000}K prompt tokens" if m in LONG else ""
        print(f"  {m:20} {i:6.2f} {o:7.2f} {i * rd:6.3f} {i * W5:9.3f} {i * W1H:9.3f}{tier}")
    print(f"\n  Bedrock regional endpoints x{GEO}; global. x1.0")


if __name__ == "__main__":
    main()
