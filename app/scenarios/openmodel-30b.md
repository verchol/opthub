---
description: Qwen3-Coder-30B on Bedrock - the 16x smaller sibling, to ask whether the big model is worth its price.
model: Qwen3-Coder-30B (Bedrock)
aws: true
priceIn: 0.07
priceOut: 0.28
budget: 2.00
files: litellm-bedrock-30b.yaml
setup: set -e; command -v litellm >/dev/null || pip install --quiet --disable-pip-version-check "litellm[proxy]" boto3; echo "bedrock region ${AWS_REGION}"
service: litellm --config /home/user/work/litellm-bedrock-30b.yaml --port 4000 --host 127.0.0.1
ready: for i in $(seq 1 90); do curl -sf -o /dev/null http://127.0.0.1:4000/health/liveliness && break; sleep 2; done; CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4000/health/liveliness); echo "litellm health=$CODE"; [ "$CODE" = "200" ]
env: ANTHROPIC_BASE_URL=http://127.0.0.1:4000 ANTHROPIC_API_KEY=sk-local
---
