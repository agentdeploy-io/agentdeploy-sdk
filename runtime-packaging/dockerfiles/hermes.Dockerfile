# Hermes runtime image — Supervisor Protocol v1 compliant.
# The official Hermes Agent CLI is installed per upstream docs; the generic
# shim wraps it with /health, /tasks, checkpoints, heartbeats, and budgeting.
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends tar ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Hermes per upstream documentation (npm package).
RUN npm install -g @nousresearch/hermes-agent || npm install -g hermes-agent || true

WORKDIR /workspace
RUN mkdir -p /root/.hermes /data/checkpoints

# Copy the shim (built ahead of docker build: npx tsc in packages/runtime-packaging)
COPY dist/shim.js dist/adapter-types.js dist/adapters ./shim/
COPY dist/platform-client.js dist/checkpoint-engine.js ./shim/

ENV PORT=8080 \
    RUNTIME_NAME=hermes \
    NODE_ENV=production

EXPOSE 8080
CMD ["node", "shim/shim.js"]
