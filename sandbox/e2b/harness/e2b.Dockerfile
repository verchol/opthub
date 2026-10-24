# Bigger box for scenarios that run a sidecar (Headroom needs ~400MB once traffic
# flows; Claude Code another ~220MB. The stock 478MB template OOMs).
# Everything the runs need is baked in, so no per-run install cost.
FROM e2bdev/code-interpreter:latest

# pinned so both arms run byte-identical tooling; bump deliberately
RUN npm install -g @anthropic-ai/claude-code@2.1.261 \
 && pip install --no-cache-dir --disable-pip-version-check \
      "headroom-ai[proxy]" "litellm[proxy]" boto3 \
 && claude --version && headroom --version && litellm --version
