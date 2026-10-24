# speed-dedupe

A quadratic `ledger.merge.dedupe` (a list used as a seen-set) that must become fast without changing
what it returns. The large-feed test fails on time; the other two pass. The task asks for speed with the
behaviour kept, without touching the tests.

The hidden check (`check.py`) passes only if the visible tests are unedited, the whole suite passes,
`dedupe` returns the same record objects in the same order as the original on four seeded feeds with
mixed id types, and a 200,000-record feed runs within 4x of a set-based dedupe timed in the same process. An absolute
limit failed a correct fix in the first live run, when six checks shared the machine. `solution/` is the reference fix (a set).

    opt claude example speed-dedupe --repeats 3 --level balanced
