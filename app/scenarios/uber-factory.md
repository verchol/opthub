---
description: The full Efficient Software Factory stack — grounded context, batched verification, downgraded reviewer.
flags: --effort medium --autocompact 400000 --exclude-dynamic-system-prompt-sections --strict-mcp-config --setting-sources project
files: CLAUDE.md factory agents.json .claude/skills/verify/SKILL.md
agents: agents.json
---

CLAUDE.md is the grounded repo context. Read it first — it already gives you the
layout, the conventions and the known traps, so do not re-derive them by
exploring the workspace.

Run this loop, in order, and do not skip a step:

1. **PLAN** — write `PLAN.md`: the module's internal structure, and a numbered
   checklist of every distinct behaviour in SPEC.md. Keep it short.
2. **IMPLEMENT** — write `sheet.py` and tests under `tests/` covering that checklist.
3. **VERIFY** — run `./factory verify`. It batches every check into one call.
   Fix and re-run until clean. Read its summary block instead of re-probing.
4. **REVIEW** — delegate to the `reviewer` subagent. Give it the checklist from
   PLAN.md. It reviews against SPEC.md and reports findings.
5. **FIX** — address every real finding, then run `./factory verify` once more.

Budget discipline: prefer one batched command over several probing ones; do not
re-read files you have already read; do not paste large file bodies back into
the conversation.
