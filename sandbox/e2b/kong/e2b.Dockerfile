# Kong AI Gateway in front of Bedrock, with Claude Code talking to it.
#
# The point of this template is that every optimization lever lives in
# kong.yaml, not in the client. Claude Code is pointed at Kong with
# ANTHROPIC_BASE_URL and never knows which model answered, whether the answer
# came out of a semantic cache, or that its prompt was compressed on the way.
#
# Sized for four processes: Kong (~300MB), Redis (~40MB), the prompt
# compressor (~250MB), Claude Code (~220MB). The stock template OOMs.
FROM kong/kong-gateway:3.11

USER root

# Node for Claude Code, Redis as Kong's vector store and rate-limit counter,
# python for the compressor sidecar and for whatever the agent is asked to build.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates git jq redis-server python3 python3-pip python3-venv \
      build-essential \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# Pinned so every arm runs byte-identical tooling; bump deliberately.
RUN npm install -g @anthropic-ai/claude-code@2.1.261 \
 && npm install -g @kong/deck 2>/dev/null || true \
 && claude --version && node --version && redis-server --version

# decK renders and validates kong.yaml before Kong ever loads it, which is the
# difference between a typo caught in one second and a gateway that boots
# without the plugin you thought you configured.
RUN curl -sL https://github.com/Kong/deck/releases/latest/download/deck_Linux_amd64.tar.gz \
      -o /tmp/deck.tar.gz \
 && tar -xf /tmp/deck.tar.gz -C /tmp deck \
 && install -m 0755 /tmp/deck /usr/local/bin/deck \
 && rm -f /tmp/deck.tar.gz /tmp/deck \
 && deck version

COPY kong.yaml            /etc/kong/kong.yaml
COPY optimization-params.yaml /etc/kong/optimization-params.yaml
COPY start.sh             /usr/local/bin/kong-start
RUN chmod +x /usr/local/bin/kong-start && mkdir -p /home/user/work && chown -R kong:kong /home/user

# DB-less: the declarative file is the only source of truth, so an experiment is
# a diff of kong.yaml and nothing else.
ENV KONG_DATABASE=off \
    KONG_DECLARATIVE_CONFIG=/etc/kong/kong.yaml \
    KONG_PROXY_LISTEN=0.0.0.0:8000 \
    KONG_ADMIN_LISTEN=127.0.0.1:8001 \
    KONG_LOG_LEVEL=notice \
    KONG_PLUGINS=bundled \
    KONG_NGINX_WORKER_PROCESSES=2

EXPOSE 8000 8001
