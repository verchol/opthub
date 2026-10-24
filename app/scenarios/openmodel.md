---
description: Swap the model entirely for an open-weights one - Qwen3-Coder-480B, served serverless by AWS Bedrock, fronted by LiteLLM so Claude Code can talk to it.
model: Qwen3-Coder-480B (Bedrock)
aws: true
priceIn: 0.22
priceOut: 1.80
budget: 3.00
files: litellm-bedrock.yaml
setup: set -e; command -v litellm >/dev/null || pip install --quiet --disable-pip-version-check "litellm[proxy]" boto3; python3 -c "import boto3,os;print('bedrock region', os.environ.get('AWS_REGION'))"
service: litellm --config /home/user/work/litellm-bedrock.yaml --port 4000 --host 127.0.0.1
ready: for i in $(seq 1 90); do curl -sf -o /dev/null http://127.0.0.1:4000/health/liveliness && break; sleep 2; done; CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4000/health/liveliness); echo "litellm health=$CODE"; [ "$CODE" = "200" ]
teardown: echo '=== litellm spend ==='; curl -s -H 'Authorization: Bearer sk-local' --max-time 10 http://127.0.0.1:4000/spend/logs | head -c 1500
env: ANTHROPIC_BASE_URL=http://127.0.0.1:4000 ANTHROPIC_API_KEY=sk-local
---
