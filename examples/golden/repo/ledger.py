"""Ledger entries: (month, customer, amount)."""
import random


def sample(n, seed=7):
    rng = random.Random(seed)
    return [(f"2026-{rng.randint(1, 12):02d}", f"c{rng.randint(1, 200)}", round(rng.uniform(5, 500), 2))
            for _ in range(n)]
