#!/usr/bin/env bash
# A local agent sandbox on Docker: read-only source, one writable directory,
# no capabilities, and no route to the internet except an allowlisting proxy.
#
#   ./sandbox.sh build                     build both images
#   ./sandbox.sh up                        create the networks and start the proxy
#   ./sandbox.sh run <src-dir> [cmd…]      run a command against a read-only copy of src
#   ./sandbox.sh shell <src-dir>           interactive shell in the sandbox
#   ./sandbox.sh verify                    prove the four guarantees hold
#   ./sandbox.sh down                      stop the proxy, remove the networks
#
# The E2B path boots a microVM per arm; this is the same shape locally, for
# iterating on a task without spending sandbox time. It is NOT the same
# isolation: a container shares the host kernel, so treat it as "the agent
# cannot see my source tree or phone home", not as "the agent cannot escape".
set -euo pipefail
cd "$(dirname "$0")"

NET_INT=opthub-sbx-internal     # --internal: no route off the host
NET_OUT=opthub-sbx-egress       # the proxy's own way out
PROXY=opthub-egress
AGENT_IMG=opthub/agent:0.1
PROXY_IMG=opthub/egress:0.1
OUT_DIR="${OPT_SANDBOX_OUT:-$HOME/.opthub/sandbox-out}"

build() {
  docker build -f Dockerfile.agent -t "$AGENT_IMG" .
  docker build -f Dockerfile.egress -t "$PROXY_IMG" .
}

up() {
  docker network inspect "$NET_INT" >/dev/null 2>&1 || docker network create --internal "$NET_INT" >/dev/null
  docker network inspect "$NET_OUT" >/dev/null 2>&1 || docker network create "$NET_OUT" >/dev/null
  if ! docker ps --format '{{.Names}}' | grep -qx "$PROXY"; then
    docker rm -f "$PROXY" >/dev/null 2>&1 || true
    # On the internal network under a fixed alias, and on a second network that
    # does have a route out. Nothing is published to the host.
    # Order matters: start on the network that has a route out, then attach the
    # internal one under the alias the agent resolves. Doing it the other way
    # round fails with "network sandbox for container not found".
    docker run -d --name "$PROXY" --network "$NET_OUT" \
      --restart unless-stopped "$PROXY_IMG" >/dev/null
    docker network connect --alias egress "$NET_INT" "$PROXY" >/dev/null
    for _ in $(seq 1 20); do
      [[ "$(docker inspect -f '{{.State.Running}}' "$PROXY" 2>/dev/null)" == true ]] && break
      sleep 0.5
    done
    # A dead proxy must not read as a working sandbox: the agent would simply
    # have no egress and the failure would surface as a confusing timeout.
    if [[ "$(docker inspect -f '{{.State.Running}}' "$PROXY" 2>/dev/null)" != true ]]; then
      echo "egress proxy failed to start:" >&2
      docker logs "$PROXY" 2>&1 | tail -5 >&2
      return 1
    fi
  fi
  echo "sandbox up · proxy $PROXY · networks $NET_INT (internal) + $NET_OUT"
}

# Everything that makes it a sandbox rather than just a container.
agent_flags() {
  local src="$1"
  mkdir -p "$OUT_DIR"
  printf '%s\n' \
    --network "$NET_INT" \
    --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,size=256m \
    --tmpfs /home/agent:rw,nosuid,size=256m,uid=10001,gid=10001 \
    --mount "type=bind,source=$src,target=/work/src,readonly" \
    --mount "type=bind,source=$OUT_DIR,target=/work/out" \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --pids-limit 512 \
    --memory 4g --cpus 4 \
    --env "HTTP_PROXY=http://egress:8888" \
    --env "HTTPS_PROXY=http://egress:8888" \
    --env "http_proxy=http://egress:8888" \
    --env "https_proxy=http://egress:8888" \
    --env "NO_PROXY=localhost,127.0.0.1" \
    --env "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}" \
    --env "CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN:-}"
  # Extra docker arguments from the caller, one per word (no spaces inside a value): opt claude -p
  # adds the router's address (--add-host, ANTHROPIC_BASE_URL) for its optimized runs.
  # shellcheck disable=SC2086
  [[ -n "${SANDBOX_EXTRA_ARGS:-}" ]] && printf '%s\n' ${SANDBOX_EXTRA_ARGS}
  return 0
}

run() {
  local src; src="$(cd "$1" && pwd)"; shift
  up >/dev/null
  # shellcheck disable=SC2046
  # SANDBOX_NAME names the container so a running task shows up in `docker ps` under its task id
  docker run --rm ${SANDBOX_NAME:+--name "$SANDBOX_NAME"} $(agent_flags "$src") "$AGENT_IMG" "${@:-bash -lc 'echo sandbox ok'}"
}

shell() {
  local src; src="$(cd "$1" && pwd)"
  up >/dev/null
  # shellcheck disable=SC2046
  docker run --rm -it $(agent_flags "$src") "$AGENT_IMG" bash
}

# Each check asserts one of the four guarantees, and fails loudly rather than
# printing something reassuring.
verify() {
  up >/dev/null
  local src; src="$(mktemp -d)"; echo "secret-source" > "$src/file.txt"
  local fail=0
  local flags; flags="$(agent_flags "$src")"

  check() { # name, expectation, command…
    local name="$1" want="$2"; shift 2
    local got; got="$(docker run --rm $flags "$AGENT_IMG" bash -lc "$1" 2>&1 | tail -1 || true)"
    if [[ "$got" == *"$want"* ]]; then printf '  ok    %s\n' "$name"
    else printf '  FAIL  %s\n        wanted %q, got %q\n' "$name" "$want" "$got"; fail=1; fi
  }

  echo "verifying the sandbox:"
  check "source mount is read-only"      "Read-only file system" 'echo x > /work/src/file.txt 2>&1 | tail -1'
  check "output mount is writable"       "written"               'echo written > /work/out/.probe && cat /work/out/.probe'
  check "rootfs is read-only"            "Read-only file system" 'touch /newfile 2>&1 | tail -1'
  check "no direct egress"               "unreachable"           'curl -s --max-time 6 --noproxy "*" https://example.com >/dev/null 2>&1 && echo reachable || echo unreachable'
  # These two assert reachability, not a status code. An https request through a
  # forward proxy goes out as CONNECT: when the filter refuses it there is no
  # HTTP response at all, so curl reports 000 rather than 403. And a GET to the
  # messages endpoint answers 405 — which is the proof we want, since only a
  # request that arrived at Anthropic could be rejected for its method.
  check "blocked domain refused"         "blocked"               'curl -s --max-time 15 -o /dev/null https://example.com && echo reachable || echo blocked'
  check "allowed domain reached"         "reached"               'c=$(curl -s -o /dev/null -w "%{http_code}" --max-time 25 https://api.anthropic.com/v1/messages); if [ "$c" = "000" ]; then echo unreachable; else echo "reached ($c)"; fi'
  check "runs as an unprivileged user"   "agent"                 'whoami'
  check "capabilities dropped"           "0000000000000000"      'grep CapEff /proc/self/status | awk "{print \$2}"'

  rm -rf "$src"
  [[ $fail -eq 0 ]] && echo "all guarantees hold" || { echo "SOME CHECKS FAILED"; return 1; }
}

down() {
  docker rm -f "$PROXY" >/dev/null 2>&1 || true
  docker network rm "$NET_INT" "$NET_OUT" >/dev/null 2>&1 || true
  echo "sandbox down"
}

case "${1:-}" in
  build) build ;;
  up) up ;;
  run) shift; run "$@" ;;
  shell) shift; shell "$@" ;;
  verify) verify ;;
  down) down ;;
  *) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
