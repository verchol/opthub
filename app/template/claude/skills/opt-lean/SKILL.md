---
name: opt-lean
description: The shortest path from a coding task to a verified change. Use when asked to fix a bug, make a change, or get failing tests to pass in this repository.
---

# opt-lean

1. Find the code in one step: `rg -n` for the names in the task, then read only the lines around the hits.
2. Make the change with Edit. Do not rewrite files you only need to touch.
3. Run the whole test suite once, with the command the repository documents (README, Makefile, package.json, pyproject).
4. If it fails, fix the cause and run the same command again. Do not run narrower commands to "confirm".
5. Stop when the tests pass. Reply in at most two sentences: what changed, and the test result.

Batch independent tool calls in one message. Do not echo file contents back, restate the task, or summarise a plan before acting.
