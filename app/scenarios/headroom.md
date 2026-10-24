---
description: Route the agent through Headroom, a local context-compaction proxy. Identical prompt; the difference is transport.
setup: set -e; MEM=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo); echo "box memory ${MEM} MB"; [ "$MEM" -ge 900 ] || { echo "NEEDS A BIGGER SANDBOX - headroom peaks near 400MB, Claude Code near 220MB. Set E2B_TEMPLATE."; exit 1; }; command -v headroom >/dev/null || pip install --quiet --disable-pip-version-check "headroom-ai[proxy]"; headroom --version
service: headroom proxy --port 8787 --host 127.0.0.1
ready: for i in $(seq 1 90); do curl -sf -o /dev/null http://127.0.0.1:8787/health && break; sleep 1; done; CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/health); echo "headroom health=$CODE"; [ "$CODE" = "200" ]
teardown: echo '=== stats ==='; curl -s --max-time 10 http://127.0.0.1:8787/stats; echo; echo '=== alive ==='; curl -s -o /dev/null -w 'health=%{http_code}\n' --max-time 5 http://127.0.0.1:8787/health; free -m | head -2
env: ANTHROPIC_BASE_URL=http://127.0.0.1:8787
---
