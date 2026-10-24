---
description: Prompt only — collapse verification into a single scripted call instead of probing.
---

Do not verify your work with a series of one-off shell commands. Each probe costs
a full round trip and its output re-enters the conversation.

Instead, write `check.py` once — a single script that runs every check you care
about (syntax, import, public API, your own tests, any behaviour you want to spot
check) and prints one compact PASS/FAIL summary. Run `python3 check.py` as your
only verification command, and read its summary rather than re-running individual
checks to inspect a result it already reported.
