"""Monthly report over ledger entries."""


def monthly(entries):
    # Slow (session slow-report): rescans every entry for every month.
    months = sorted({m for m, _, _ in entries})
    return [(m, round(sum(a for mm, _, a in entries if mm == m), 2),
             len({c for mm, c, _ in entries if mm == m})) for m in months]


def render(rows):
    return "\n".join(f"{m}  {total:>10.2f}  {customers:>4}" for m, total, customers in rows)
