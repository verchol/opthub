---
description: Restart this work interactively in opthub optimization mode — Claude Code in the sandbox, every request through LLM Ultra Light
argument-hint: "[--mode route] [--local-model <tag>] [--jev] …"
allowed-tools: Bash(opt claude optimize status), Bash(opt claude optimize --dry-run:*)
---

!`opt claude optimize status`

The user wants optimization mode for this project. A running Claude Code session cannot be moved into
the sandbox, so optimization mode starts a new session. Tell them, in three short lines:

1. Exit this session (`/exit`), then run, in the same directory:
   `opt claude optimize $ARGUMENTS`
   Their prompts then go to Claude Code inside the opthub sandbox. Every request passes through
   LLM Ultra Light, which classifies it, routes it (keep / cheaper model / local Ollama) and records
   each decision in a hash-chained audit log.
2. The default is shadow mode: decisions are recorded and nothing changes. `--mode route` acts on them.
3. `opt claude optimize audit` shows the decisions afterwards; `opt claude optimize --help` lists every flag.

If the status output above shows a session already running, say so first. Do not start anything yourself.
