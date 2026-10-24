"""Merge bank-feed records that arrive more than once."""


def dedupe(records):
    """Reference solution: see the project's docstring for the spec."""
    kept, seen = [], set()
    for r in records:
        key = (r["id"], r["date"])
        if key not in seen:
            seen.add(key)
            kept.append(r)
    return kept
