---
name: verify
description: Run the full repo verification gate in one batched command. Use before claiming any work is done, and after every fix.
---

# verify

Run exactly this, once:

    ./factory verify

It executes, in a single process: syntax check, import-purity check, public API
check, the spec smoke matrix, and `unittest discover -s tests`. It prints one
`=== FACTORY SUMMARY ===` block with a per-check PASS/FAIL line and exits non-zero
if anything failed.

Rules:
- Never substitute individual commands (`python3 -m unittest`, `python3 -c`) for
  this. One call replaces six.
- The summary block is the whole answer. Do not re-run checks to inspect a result
  it already reported.
- If a check fails, fix the cause and run `./factory verify` again. Do not run a
  narrower command to "confirm" the fix.
