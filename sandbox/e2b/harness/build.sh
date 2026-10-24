#!/usr/bin/env bash
# Build the harness template. Run `e2b auth login` first (browser).
set -euo pipefail
cd "$(dirname "$0")"

NAME="${1:-harness-bench}"
MEM="${MEMORY_MB:-2048}"
CPU="${CPU_COUNT:-2}"

echo "building template '$NAME'  (${CPU} vCPU, ${MEM} MB)"
e2b template create "$NAME" \
  --dockerfile e2b.Dockerfile \
  --cpu-count "$CPU" \
  --memory-mb "$MEM"

echo
echo "Add the template id (or the name '$NAME') to .env:"
echo "    E2B_TEMPLATE=$NAME"
