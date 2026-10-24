"""Merge bank-feed records that arrive more than once."""


def dedupe(records):
    """The records with repeats removed, in their original order.

    Two records are the same transaction when they share "id" and "date". The first one
    seen is kept, as it is; any later one with the same id and date is dropped, even if
    its other fields differ.
    """
    kept, seen = [], []
    for r in records:
        key = (r["id"], r["date"])
        if key not in seen:
            seen.append(key)
            kept.append(r)
    return kept
