# Mastra runtime image — Node base + mastra CLI + shim. Server-style (Tier 1).
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends tar ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY dist/shim.js dist/adapter-types.js dist/adapters ./shim/
COPY dist/platform-client.js dist/checkpoint-engine.js ./shim/

# Buyer project code arrives on the attached volume at /workspace.
RUN mkdir -p /workspace /data/checkpoints

ENV PORT=8080 \
    RUNTIME_NAME=mastra \
    NODE_ENV=production \
    MASTRA_TELEMETRY_DISABLED=true

EXPOSE 8080 4111
CMD ["node", "shim/shim.js"]
