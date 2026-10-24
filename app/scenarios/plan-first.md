---
description: Prompt only — force an explicit behaviour checklist before any code is written.
---

Before you write a single line of `sheet.py`, write `PLAN.md` containing a
numbered checklist of every distinct behaviour SPEC.md requires — every value
rule, every error type and the exact condition that triggers it, every edge case
the spec calls out.

Then implement against that checklist, and before you finish, walk it item by
item and confirm each one is both implemented and covered by one of your tests.
