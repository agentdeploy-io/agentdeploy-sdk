# OpenHands runtime image — official base + shim. Server-style (Tier 1).
FROM docker.all-hands.dev/all-hands-ai/openhands:0.9

USER root
RUN apt-get update && apt-get install -y --no-install-recommends tar nodejs npm \
    && rm -rf /var/lib/apt/lists/* || true

WORKDIR /workspace
COPY dist/shim.js dist/adapter-types.js dist/adapters ./shim/
COPY dist/platform-client.js dist/checkpoint-engine.js ./shim/

RUN mkdir -p /opt/openhands/workspace /data/checkpoints

ENV PORT=8080 \
    RUNTIME_NAME=openhands

EXPOSE 8080 3000
CMD ["node", "shim/shim.js"]
