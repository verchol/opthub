#!/usr/bin/env python3
"""
opthub cost model — supportbot/draft-reply

Computes marginal $/1k-request contribution of each optimizer, applied in order.
Every number quoted in docs/optimizers.md comes from this script. Run it before
changing a number in the docs.

Pricing: Anthropic first-party rates, $/MTok.
  cache read  = 0.10x base input
  cache write = 1.25x base input (5-minute TTL)
"""

PRICING = {
    # model: (input $/MTok, output $/MTok, min cacheable prefix tokens)
    "claude-opus-5":     (5.00, 25.00, 512),
    "claude-haiku-4-5":  (1.00,  5.00, 4096),
}

CACHE_READ_MULT = 0.10
CACHE_WRITE_MULT = 1.25   # 5-minute TTL


class Workload:
    """supportbot/draft-reply, as captured."""

    def __init__(self, prefix_tok, suffix_tok, output_tok, write_rate=0.01):
        # prefix_tok: tools + system, byte-stable across requests (cacheable)
        # suffix_tok: ticket + history, varies per request (never cacheable)
        # write_rate: fraction of requests that pay a cache write rather than read.
        #             ~1% models continuous traffic re-warming one 5-min TTL window
        #             roughly every 100 requests.
        self.prefix_tok = prefix_tok
        self.suffix_tok = suffix_tok
        self.output_tok = output_tok
        self.write_rate = write_rate

    def cost_per_1k(self, model, cached, share=1.0):
        """$/1k requests for `share` of traffic on `model`."""
        inp, out, min_prefix = PRICING[model]
        n = 1000 * share
        if cached and self.prefix_tok < min_prefix:
            # Silently does not cache. This is a real trap when routing to Haiku 4.5,
            # whose minimum is 4096 vs Opus 5's 512.
            cached = False

        if cached:
            writes = n * self.write_rate
            reads = n - writes
            prefix_cost = (
                self.prefix_tok * reads / 1e6 * inp * CACHE_READ_MULT
                + self.prefix_tok * writes / 1e6 * inp * CACHE_WRITE_MULT
            )
        else:
            prefix_cost = self.prefix_tok * n / 1e6 * inp

        suffix_cost = self.suffix_tok * n / 1e6 * inp
        output_cost = self.output_tok * n / 1e6 * out
        return prefix_cost + suffix_cost + output_cost


def blended(wl, cached, routes):
    """routes: list of (model, share)."""
    return sum(wl.cost_per_1k(m, cached, s) for m, s in routes)


OPUS = [("claude-opus-5", 1.0)]

steps = []

# --- baseline: no caching, 30 tools, full 8k preamble, unpruned history -------
wl = Workload(prefix_tok=9_200, suffix_tok=1_500, output_tok=400)
base = blended(wl, cached=False, routes=OPUS)
steps.append(("baseline (no caching)", base, "—"))

# --- T0: cache-priming -------------------------------------------------------
c1 = blended(wl, cached=True, routes=OPUS)
steps.append(("+ cache-priming  [T0]", c1, "token-identical"))

# --- T1: context-pruning — shrinks the UNCACHED suffix, 1500 -> 900 ----------
wl2 = Workload(prefix_tok=9_200, suffix_tok=900, output_tok=400)
c2 = blended(wl2, cached=True, routes=OPUS)
steps.append(("+ context-pruning  [T1]", c2, "uncached suffix 1500->900"))

# --- T1: tool-schema-slimming — shrinks the CACHED prefix, 30 tools -> 4 -----
wl3 = Workload(prefix_tok=8_260, suffix_tok=900, output_tok=400)
c3 = blended(wl3, cached=True, routes=OPUS)
steps.append(("+ tool-schema-slimming  [T1]", c3, "cached prefix 9200->8260"))

# --- T2: model-routing — 60% of traffic to Haiku 4.5 ------------------------
routes = [("claude-haiku-4-5", 0.60), ("claude-opus-5", 0.40)]
c4 = blended(wl3, cached=True, routes=routes)
steps.append(("+ model-routing 60% Haiku  [T2]", c4, "cache is model-scoped: 2 entries"))

# --- rejected: prompt-compaction, 8000 -> 4500 system preamble --------------
wl_pc = Workload(prefix_tok=4_760, suffix_tok=900, output_tok=400)
c_pc = blended(wl_pc, cached=True, routes=OPUS)


def pct(new, old):
    return (new - old) / old * 100


print(f"{'step':<34}{'$/1k':>9}{'marginal':>11}{'cumulative':>12}   note")
print("-" * 100)
prev = None
for name, cost, note in steps:
    marg = "—" if prev is None else f"{pct(cost, prev):+.1f}%"
    cum = "—" if prev is None else f"{pct(cost, base):+.1f}%"
    print(f"{name:<34}{cost:>9.2f}{marg:>11}{cum:>12}   {note}")
    prev = cost

print()
print("REJECTED CANDIDATE — evaluated against step 3 ($%.2f):" % c2)
print(f"  prompt-compaction (8000->4500 preamble): ${c_pc:.2f}/1k  "
      f"({pct(c_pc, c2):+.1f}% marginal)")

print()
print("ORDERING MATTERS — tool-schema-slimming standalone vs. after cache-priming:")
standalone_before = blended(Workload(8_260, 1_500, 400), cached=False, routes=OPUS)
print(f"  applied FIRST  (uncached):  ${standalone_before:.2f}/1k  ({pct(standalone_before, base):+.1f}%)")
print(f"  applied AFTER cache-priming: {pct(c3, c2):+.1f}%")
print("  -> the same change looks ~3x more valuable when measured standalone.")

print()
print("HAIKU CACHE-MINIMUM TRAP:")
small = Workload(prefix_tok=2_000, suffix_tok=900, output_tok=400)
o = small.cost_per_1k("claude-opus-5", cached=True)
h = small.cost_per_1k("claude-haiku-4-5", cached=True)
h_nc = small.cost_per_1k("claude-haiku-4-5", cached=False)
print(f"  2000-token prefix caches on Opus 5 (min 512):      ${o:.2f}/1k")
print(f"  same prefix on Haiku 4.5 (min 4096) silently won't: ${h:.2f}/1k "
      f"(== uncached ${h_nc:.2f})")
