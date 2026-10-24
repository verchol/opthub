#!/usr/bin/env bash
# Build the Kong AI Gateway template. Run `e2b auth login` first (browser).
set -euo pipefail
cd "$(dirname "$0")"

NAME="${1:-harness-kong}"
MEM="${MEMORY_MB:-4096}"
CPU="${CPU_COUNT:-2}"

echo "validating kong.yaml before shipping it"
if command -v deck >/dev/null 2>&1; then deck file validate -s kong.yaml
else echo "  (deck not installed locally — it validates inside the image at boot)"; fi

echo "building template '$NAME'  (${CPU} vCPU, ${MEM} MB)"
e2b template create "$NAME" \
  --dockerfile e2b.Dockerfile \
  --cpu-count "$CPU" \
  --memory-mb "$MEM"

echo
echo "Add the template id (or the name '$NAME') to .env:"
echo "    E2B_KONG_TEMPLATE=$NAME"
