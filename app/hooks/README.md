# Hooks

`on-session-end.mjs` is a Claude Code **Stop** hook. It records ended sessions to
`results/.session-log.jsonl` so the Optimization Hub can surface them promptly.

The hub also scans `~/.claude/projects` directly, so registering the hook is
optional. To enable it, add to `~/.claude/settings.json`:

```json
{ "hooks": { "Stop": [ { "hooks": [
  { "type": "command", "command": "node /path/to/opthub/app/hooks/on-session-end.mjs" }
] } ] } }
```

## bulk-read/ — the bulk-read delegation skill

Spotify's `shunt` pattern, as an experiment arm (`bulk-read-delegation` in `config/optimizations.json`;
design in `docs/optimization-agent.md`, "Skill in depth: bulk-read delegation").

- `gate.mjs` — a **PreToolUse** hook on `Read|Bash`. Blocks a whole read (no offset or limit) of a
  text file over `BULK_READ_THRESHOLD` lines (default 350), and a plain `cat|less|more|nl|bat` of one,
  with exit 2 and a message pointing the agent at the worker. Passes targeted reads, small files,
  binaries and PDFs, files this session already edited, files the worker failed on, and the second
  whole read of a blocked file (`BULK_READ_MAX_BLOCKS`, default 1). Any error exits 0: a broken gate
  never blocks work.
- `bulk-read.mjs` — the worker: `bulk-read --question "<q>" <file>…`. Sends the files with line
  numbers to a cheap model and prints cited bullets. `BULK_READ_VIA=api` posts to
  `$ANTHROPIC_BASE_URL/v1/messages` (the E2B arm, through its LiteLLM proxy and a route alias);
  `claude` runs `claude -p --model <worker>` (the local sandbox, which has no proxy and may run on a
  subscription token).

Both append to `BULK_READ_LOG` (JSONL: the gate's blocks and overrides, the worker's usage and cost).
The runners (`optimize.mjs`, `core.mjs`) add the worker's cost to the arm, because it is spent
outside Claude Code's own accounting. `lib/arm-config.mjs` turns an arm's `claude.bulkRead` into the
settings.json hook, the env and the files; `lib/local-run.mjs` and `optimize.mjs` put the scripts in
`~/.opthub/hooks/bulk-read/`, outside the workspace and its diff. Tests: `app/test/bulk-read.test.mjs`.
Not yet run against a live Claude Code session.

To try it by hand in your own Claude Code (it changes nothing else):

```json
{ "hooks": { "PreToolUse": [ { "matcher": "Read|Bash", "hooks": [
  { "type": "command", "command": "node /path/to/opthub/app/hooks/bulk-read/gate.mjs" }
] } ] } }
```
