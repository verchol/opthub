# rename-tax-api

**Activity:** change an API across files. **Artifact:** the rename of `shop.tax.calc_tax` to `compute_tax` in
`shop/tax.py`, its three callers and `README.md`, with `calc_tax` kept as a deprecated alias.

**Correct** when every item below passes. **Accuracy** is the share that pass (10 items):

- behaviour: the visible suite passes; `compute_tax` returns what `calc_tax` did on 60 random inputs; the alias
  warns `DeprecationWarning` and returns the same; the CLI and the invoice lines print the same with deprecation
  warnings turned into errors, so no caller still goes through the alias (5);
- the rename: `cart.py`, `invoice.py` and `cli.py` each call `compute_tax` (3);
- docs: the README names `compute_tax` and mentions `calc_tax` only as deprecated (2).

Editing `tests/test_shop.py` scores 0. The reference `solution/` scores 1.0; renaming only in `tax.py` and
`cart.py` scores 0.4.

    opt claude example rename-tax-api --repeats 3
