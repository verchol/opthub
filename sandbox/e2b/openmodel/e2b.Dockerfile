FROM e2bdev/code-interpreter:latest

USER root
RUN apt-get update && apt-get install -y --no-install-recommends zstd \
 && rm -rf /var/lib/apt/lists/*

# Ollama + an open-weights coding model, baked in so runs don't pay the download.
RUN curl -fsSL https://ollama.com/install.sh | sh && ollama --version
RUN (ollama serve &) && sleep 8 \
 && ollama pull qwen2.5-coder:3b \
 && ollama list

# LiteLLM exposes an Anthropic-compatible endpoint in front of Ollama, which is
# what lets Claude Code talk to an open model via ANTHROPIC_BASE_URL.
RUN pip install --no-cache-dir --disable-pip-version-check "litellm[proxy]" \
 && npm install -g @anthropic-ai/claude-code@2.1.261 \
 && litellm --version && claude --version
