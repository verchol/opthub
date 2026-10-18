# Local Docker sandbox for `tools/rerun.py`

Vendored from `sandbox/e2b/template/docker/` (unpublished), with the same image tags
(`opthub/agent:0.1`, `opthub/egress:0.1`) and the same network and proxy names. A box that
either side builds or starts is reused by the other. `rerun.py` builds the images on first use
and starts the proxy. You don't need to run anything by hand.

What each arm/repeat gets:

- **No route out** except the tinyproxy allowlist in `allowlist.txt`: `api.anthropic.com` and the
  Bedrock runtime hosts. Everything else is refused, including npm, PyPI and GitHub.
- **Read-only rootfs**, `--cap-drop ALL`, `no-new-privileges`, uid 10001, 4 GB / 4 CPU / 512 pids.
- **Two writable mounts**: the arm's repo copy at `/work/out`, and a per-cell `$HOME`. The `$HOME`
  mount keeps the session alive across `--resume` turns, and its transcript is copied back to
  `~/.claude/projects` afterwards.
- **One credential, passed by environment name only**: `CLAUDE_CODE_OAUTH_TOKEN` (from
  `claude setup-token`). The container cannot read the macOS keychain login. `ANTHROPIC_API_KEY`
  is never handed in: Claude Code prefers an API key over OAuth, so a stray key in your shell
  would quietly move the runs onto API billing.

This is not E2B. A container shares the host kernel, so read it as "the agent cannot touch my tree
or phone home", not as "the agent cannot escape". Claude Code inside the image is the version it was
built with. Rebuild with `docker build -f Dockerfile.agent -t opthub/agent:0.1 tools/sandbox`
to pick up a newer one; each run records the version it used.
