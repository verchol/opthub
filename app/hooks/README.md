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
