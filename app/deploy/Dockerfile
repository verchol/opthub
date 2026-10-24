# The read-only hub has no dependencies beyond node itself: no npm install, no
# node_modules. The page arrives prebuilt (deploy/build.sh runs build:web). Alpine
# and a copy is the whole image.
FROM node:22-alpine

WORKDIR /app
COPY hub-demo.mjs ./
COPY lib/ ./lib/
COPY web/dist/ ./web/dist/
COPY snapshot/ ./deploy/snapshot/
COPY docs/ ./docs/
COPY config/ ./config/

ENV PORT=8080 NODE_ENV=production
EXPOSE 8080

# Fly's health check hits this; it needs no auth so a 401 never reads as down.
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

USER node
CMD ["node", "hub-demo.mjs"]
