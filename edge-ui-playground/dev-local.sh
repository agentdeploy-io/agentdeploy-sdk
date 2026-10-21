#!/usr/bin/env bash
# One-command local dev stack: Edge Console SPA + a local agent worker.
#
# Usage:
#   AGENT_DIR=~/.agentdev/bo-dev ./dev-local.sh
#
# AGENT_DIR must be a wrangler project (worker.mjs + .dev.vars). The worker's
# port must match the entry for its agent namespace in local-agents.json
# (e.g. "markie-agent": 8791). The SPA proxy picks it up automatically —
# add one JSON line per agent you run locally.
set -euo pipefail
cd "$(dirname "$0")"

AGENT_DIR="${AGENT_DIR:?set AGENT_DIR to a wrangler project dir (e.g. ~/.agentdev/bo-dev)}"
PORT=8791
[ -d "$AGENT_DIR" ] || { echo "AGENT_DIR not found: $AGENT_DIR" >&2; exit 1; }
[ -f "$AGENT_DIR/worker.mjs" ] || [ -f "$AGENT_DIR/src/server.ts" ] || { echo "no worker entry in $AGENT_DIR" >&2; exit 1; }

RELAY_PID=""
# LLM relay: only needed if the worker routes its gateway through localhost:8794
if grep -q "localhost:8794" "$AGENT_DIR/worker.mjs" 2>/dev/null && [ -f "$AGENT_DIR/relay.mjs" ]; then
  KEY="$(grep '^AD_GATEWAY_API_KEY=' "$AGENT_DIR/.dev.vars" 2>/dev/null | sed 's/^AD_GATEWAY_API_KEY=//')"
  RELAY_KEY="$KEY" node "$AGENT_DIR/relay.mjs" &
  RELAY_PID=$!
  sleep 1
fi

( cd "$AGENT_DIR" && exec npx wrangler dev --port "$PORT" ) &
WR_PID=$!
sleep 1
npm run dev &
SPA_PID=$!

trap 'kill $SPA_PID $WR_PID ${RELAY_PID:-$WR_PID} 2>/dev/null || true' EXIT
echo ""
echo "  SPA:    http://localhost:5173"
echo "  Agent:  http://localhost:$PORT/health"
[ -n "$RELAY_PID" ] && echo "  Relay:  http://localhost:8794 (LLM egress workaround)"
echo ""
echo "  Agent URL in the SPA: http://localhost:5173/agents/<id>/chat"
echo "  (id = the agent entry in src/constants/agents.ts)"
wait
