# Docker agent sandbox

A local place to run a coding agent against a source tree it cannot modify and
a network it cannot leave. This is the `SPEC.md` §12 item *"Docker agent sandbox
with read-only mount + egress allowlist"*, built and verified.

```sh
./sandbox.sh build                  # both images
./sandbox.sh verify                 # prove the guarantees, don't trust this file
./sandbox.sh run  ~/some/project    # one command against a read-only copy
./sandbox.sh shell ~/some/project   # poke around inside
./sandbox.sh down                   # stop the proxy, remove the networks
```

## What it guarantees, and how each is enforced

| guarantee | mechanism | verified by |
|---|---|---|
| the source cannot be modified | bind mount with `readonly` at `/work/src` | write to `/work/src` returns `Read-only file system` |
| exactly one writable path | bind mount at `/work/out` → `~/.opthub/sandbox-out` | writes land, and are readable from the host |
| the image cannot be modified | `--read-only` rootfs, `tmpfs` for `/tmp` and `$HOME` | `touch /newfile` returns `Read-only file system` |
| no route to the internet | agent runs on a `--internal` network | `curl --noproxy '*'` cannot reach anything |
| only allowlisted hosts | tinyproxy with `FilterDefaultDeny On`, the only bridge out | `example.com` refused; `api.anthropic.com` reached |
| no root, no capabilities | `--cap-drop ALL`, `no-new-privileges`, uid 10001 | `whoami` → `agent`, `CapEff` → `0000000000000000` |
| bounded blast radius | `--memory 4g --cpus 4 --pids-limit 512` | — |

`./sandbox.sh verify` runs all eight and fails loudly. As of the last run: all
pass, with Claude Code 2.1.273 on node 22.23.2 inside.

## The allowlist

`allowlist.txt` is extended-regex, one host pattern per line, and it is the
sandbox's entire exfiltration surface — so it is short, and each line says why
it is there. Today: `api.anthropic.com` and the Bedrock runtime hosts.

Deliberately absent, so that adding one is a decision somebody makes on
purpose: `registry.npmjs.org` (dependencies belong in the image, not in the
run), `github.com` (a run that can push is a run that can exfiltrate), and
PyPI (same argument as npm).

## Where this fits

The E2B path boots a microVM per arm and is what `optimize.mjs` uses. This is
the same *shape* locally — for iterating on a task, or a prompt, without
spending sandbox time — and it is **not** equivalent isolation: a container
shares the host kernel. Read it as *"the agent cannot see my tree or phone
home"*, not *"the agent cannot escape"*. For an untrusted agent against
untrusted code, keep using the microVM.

## Two things that cost time to discover

1. **Network order matters.** Start the proxy on the network that has a route
   out, *then* `docker network connect --alias egress` the internal one. The
   other order fails with `network sandbox for container not found`.
2. **tinyproxy 1.11 is fussy**: the `Filter` path must be quoted, trailing
   comments on a directive are a syntax error, and `FilterExtended` is
   deprecated in favour of `FilterType ere`. A config error exits 70 before any
   listener exists, so `up` checks the container is actually running rather than
   assuming it.

## From Python: `tools/rerun.py`

`rerun.py` drives the same images, networks and proxy names from Python, so a box either side
builds or starts is reused by the other. It builds the images on first use and starts the proxy.
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
built with. Rebuild with `./sandbox.sh build` (or `docker build -f Dockerfile.agent -t opthub/agent:0.1 sandbox/docker`)
to pick up a newer one; each run records the version it used.
