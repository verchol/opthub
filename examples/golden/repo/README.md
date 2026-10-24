# ledgerkit (golden fixture)

A tiny invoicing package that the synthetic sessions in `examples/golden` "worked on".
It has three deliberate problems, one per session:

1. `invoice.total()` rounds each line instead of the sum — a cent off on some carts.
2. `report.py` has no CSV export.
3. `report.monthly()` is quadratic in the number of entries.

`python3 -m unittest -q` from this directory runs the tests. The rounding test fails on purpose.
