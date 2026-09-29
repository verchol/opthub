#!/usr/bin/env bash
# Run the triage experiment in a container with the same shape as e2b/template/docker:
# read-only source, one writable directory, all capabilities dropped, egress only to
# the endpoints the chosen arms actually need.
set -euo pipefail
cd "$(dirname "$0")/.."

ARMS="${ARMS:-rules}"
IMAGE=email-triage:local

allow=""
[[ "$ARMS" == *jev*   ]] && allow+=" api.typesafe.ai"
[[ "$ARMS" == *llm*   ]] && allow+=" api.anthropic.com"
[[ "$ARMS" == *local* ]] && allow+=" host.docker.internal"

echo "arms:   $ARMS"
echo "egress:${allow:- none (fully offline)}"

docker build -q -t "$IMAGE" -f sandbox/Dockerfile . >/dev/null

docker run --rm \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --read-only \
  --network "${NET:-bridge}" \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  -v "$PWD/src:/work/src:ro" \
  -v "$PWD/taxonomy.json:/work/taxonomy.json:ro" \
  -v "$PWD/data:/work/data:rw" \
  -e JEV_API_KEY -e ANTHROPIC_API_KEY -e OLLAMA_HOST \
  -e JEV_TIMEOUT_MS -e JEV_MODEL \
  "$IMAGE" --arms "$ARMS" "$@"
