---
description: A downgraded reviewer subagent gates completion; no other scaffolding.
flags: --setting-sources project
files: agents.json
agents: agents.json
---

When you believe `sheet.py` is complete, do not stop. Delegate to the `reviewer`
subagent with the Task tool and ask it to review your implementation against
SPEC.md.

Address every real finding it reports, then re-run your tests. You are done only
once the reviewer has signed off and your tests pass — not when you think the
code looks right.
