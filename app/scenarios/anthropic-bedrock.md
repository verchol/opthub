---
description: Claude Opus 4.5 served by AWS Bedrock, so the frontier baseline bills AWS credits rather than the Anthropic API.
model: Claude Opus 4.5 (Bedrock)
aws: true
priceIn: 5.00
priceOut: 25.00
budget: 8.00
files: litellm-bedrock-claude.yaml
setup: set -e; command -v litellm >/dev/null || pip install --quiet --disable-pip-version-check "litellm[proxy]" boto3; echo "bedrock region ${AWS_REGION}"
service: litellm --config /home/user/work/litellm-bedrock-claude.yaml --port 4000 --host 127.0.0.1
ready: for i in $(seq 1 90); do curl -sf -o /dev/null http://127.0.0.1:4000/health/liveliness && break; sleep 2; done; CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4000/health/liveliness); echo "litellm health=$CODE"; [ "$CODE" = "200" ]
env: ANTHROPIC_BASE_URL=http://127.0.0.1:4000 ANTHROPIC_API_KEY=sk-local
---
