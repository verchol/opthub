#!/usr/bin/env bash
# Boot the gateway inside the sandbox and prove it is actually serving before
# any arm is allowed to run. A run that starts against a half-up gateway
# measures the gateway, not the lever.
set -euo pipefail

: "${AWS_REGION:=eu-north-1}"
export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"

CONF="${KONG_DECLARATIVE_CONFIG:-/etc/kong/kong.yaml}"

echo "== validating $CONF"
deck file validate -s "$CONF"

echo "== redis"
redis-server --daemonize yes --save '' --appendonly no --maxmemory 128mb --maxmemory-policy allkeys-lru
for i in $(seq 1 30); do redis-cli ping >/dev/null 2>&1 && break; sleep 1; done
redis-cli ping

echo "== kong"
kong start -c /etc/kong/kong.conf 2>/dev/null || kong start
for i in $(seq 1 60); do
  curl -sf -o /dev/null http://127.0.0.1:8001/status && break
  sleep 2
done
CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8001/status)
echo "kong admin status=$CODE"
[ "$CODE" = "200" ]

# Which AI plugins actually loaded. A plugin that is in kong.yaml but missing
# from this list is not enabled, and every number the run produces for it is a
# number for the unmodified path.
echo "== ai plugins live"
curl -s http://127.0.0.1:8001/plugins | jq -r '.data[] | select(.name|startswith("ai-")) | "\(.name)\tenabled=\(.enabled)"'

echo
echo "point the client at the gateway:"
echo "  export ANTHROPIC_BASE_URL=http://127.0.0.1:8000"
echo "  export ANTHROPIC_API_KEY=sk-kong"
