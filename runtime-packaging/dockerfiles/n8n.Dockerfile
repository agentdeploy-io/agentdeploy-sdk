# n8n runtime image — official base + shim. Server-style (Tier 1).
FROM n8nio/n8n:latest

USER root
RUN apk add --no-cache tar nodejs npm || true

WORKDIR /workspace
RUN mkdir -p /home/node/.n8n /data/checkpoints

COPY dist/shim.js dist/adapter-types.js dist/adapters ./shim/
COPY dist/platform-client.js dist/checkpoint-engine.js ./shim/

# n8n serves on 5678 internally; the shim serves the contract on 8080.
ENV PORT=8080 \
    RUNTIME_NAME=n8n \
    N8N_PORT=5678 \
    N8N_DIAGNOSTICS_ENABLED=false

EXPOSE 8080 5678
CMD ["node", "shim/shim.js"]
