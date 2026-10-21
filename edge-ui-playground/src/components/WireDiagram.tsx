import React from "react";
import { COLORS, RADIUS, STATUS_COLORS, TRANSITIONS, SHADOWS } from "../constants/theme";

// ─── Types ─────────────────────────────────────────────────────────

export type AgentHealth = "healthy" | "degraded" | "down";
export type AgentState = "idle" | "working" | "error";
export type AgentRuntime = "edge" | "core" | "cf-worker";

export interface WireAgent {
  id: string;
  name: string;
  icon: string;
  runtime: AgentRuntime;
  health: AgentHealth;
  state: AgentState;
  lastHeartbeat: number;
  costToday: number;
  group: "orchestrator" | "core" | "classifier";
}

export interface WireConnection {
  from: string;
  to: string;
  label: string;
  active: boolean;
}

export interface WireDiagramProps {
  agents: WireAgent[];
  connections: WireConnection[];
}

// ─── Constants ─────────────────────────────────────────────────────

const HEALTH_COLORS: Record<AgentHealth, string> = {
  healthy: STATUS_COLORS.success,
  degraded: STATUS_COLORS.warning,
  down: STATUS_COLORS.error,
};

const STATE_LABELS: Record<AgentState, string> = {
  idle: "Idle",
  working: "Working",
  error: "Error",
};

const RUNTIME_LABELS: Record<AgentRuntime, string> = {
  edge: "Edge",
  core: "Fly VM",
  "cf-worker": "CF Worker",
};

const RUNTIME_COLORS: Record<AgentRuntime, string> = {
  edge: STATUS_COLORS.info,
  core: STATUS_COLORS.warning,
  "cf-worker": "hsl(280 60% 50%)",
};

// ─── Layout Positions ──────────────────────────────────────────────

const CARD_W = 160;
const CARD_H = 120;

interface NodePos {
  x: number;
  y: number;
}

function computePositions(agents: WireAgent[]): Map<string, NodePos> {
  const map = new Map<string, NodePos>();
  const orch = agents.filter((a) => a.group === "orchestrator");
  const core = agents.filter((a) => a.group === "core");
  const cls = agents.filter((a) => a.group === "classifier");

  const orchStartX = 120;
  const orchY = 60;
  orch.forEach((a, i) => {
    map.set(a.id, { x: orchStartX + i * (CARD_W + 24), y: orchY });
  });

  const coreY = 280;
  core.forEach((a, i) => {
    map.set(a.id, { x: 120 + i * (CARD_W + 24), y: coreY });
  });

  const clsY = 280;
  cls.forEach((a, i) => {
    map.set(a.id, { x: 600 + i * (CARD_W + 24), y: clsY });
  });

  return map;
}

// ─── Agent Card ────────────────────────────────────────────────────

const AgentCard: React.FC<{ agent: WireAgent; x: number; y: number }> = ({ agent, x, y }) => {
  const healthColor = HEALTH_COLORS[agent.health];
  const runtimeColor = RUNTIME_COLORS[agent.runtime];
  const isWorking = agent.state === "working";

  return (
    <g transform={`translate(${x}, ${y})`}>
      <rect
        width={CARD_W}
        height={CARD_H}
        rx={12}
        fill={COLORS.card}
        stroke={isWorking ? STATUS_COLORS.info : COLORS.border}
        strokeWidth={isWorking ? 2 : 1}
        style={{ filter: isWorking ? `drop-shadow(0 0 8px ${STATUS_COLORS.info})` : undefined }}
      />

      {/* Header row: icon + name */}
      <text x={12} y={24} fontSize="16" fill={COLORS.foreground}>
        {agent.icon}
      </text>
      <text x={32} y={24} fontSize="11" fontWeight={600} fill={COLORS.foreground}>
        {agent.name}
      </text>

      {/* Runtime badge */}
      <rect x={12} y={34} width={64} height={18} rx={9} fill={runtimeColor} opacity={0.15} />
      <text x={44} y={47} fontSize="9" fontWeight={500} fill={runtimeColor} textAnchor="middle">
        {RUNTIME_LABELS[agent.runtime]}
      </text>

      {/* Health indicator */}
      <circle cx={CARD_W - 16} cy={18} r={5} fill={healthColor}>
        {agent.health === "healthy" && (
          <animate attributeName="opacity" values="1;0.4;1" dur="2s" repeatCount="indefinite" />
        )}
      </circle>

      {/* State */}
      <text x={12} y={72} fontSize="10" fill={COLORS.mutedForeground}>
        {STATE_LABELS[agent.state]}
      </text>

      {/* Cost */}
      <text x={12} y={90} fontSize="10" fontFamily="var(--font-mono)" fill={COLORS.mutedForeground}>
        ${agent.costToday.toFixed(4)}
      </text>

      {/* Heartbeat */}
      <text x={12} y={106} fontSize="9" fill={COLORS.mutedForeground} opacity={0.7}>
        {Math.round((Date.now() - agent.lastHeartbeat) / 1000)}s ago
      </text>
    </g>
  );
};

// ─── Connection Line ───────────────────────────────────────────────

const ConnectionLine: React.FC<{
  from: NodePos;
  to: NodePos;
  label: string;
  active: boolean;
}> = ({ from, to, label, active }) => {
  const fromX = from.x + CARD_W / 2;
  const fromY = from.y + CARD_H;
  const toX = to.x + CARD_W / 2;
  const toY = to.y;

  const midY = (fromY + toY) / 2;
  const path = `M ${fromX} ${fromY} C ${fromX} ${midY}, ${toX} ${midY}, ${toX} ${toY}`;

  const labelX = (fromX + toX) / 2;
  const labelY = midY;

  return (
    <g>
      {/* Background line */}
      <path
        d={path}
        fill="none"
        stroke={COLORS.border}
        strokeWidth={2}
        strokeDasharray={active ? "6 4" : "none"}
      >
        {active && (
          <animate attributeName="stroke-dashoffset" values="0;-20" dur="0.8s" repeatCount="indefinite" />
        )}
      </path>

      {/* Active glow line */}
      {active && (
        <path
          d={path}
          fill="none"
          stroke={STATUS_COLORS.info}
          strokeWidth={2}
          opacity={0.6}
          strokeDasharray="6 4"
        >
          <animate attributeName="stroke-dashoffset" values="0;-20" dur="0.8s" repeatCount="indefinite" />
        </path>
      )}

      {/* Arrow head */}
      <polygon
        points={`${toX - 5},${toY - 8} ${toX + 5},${toY - 8} ${toX},${toY}`}
        fill={active ? STATUS_COLORS.info : COLORS.border}
      />

      {/* Label */}
      <rect
        x={labelX - 30}
        y={labelY - 10}
        width={60}
        height={20}
        rx={4}
        fill={COLORS.card}
        stroke={COLORS.border}
        strokeWidth={1}
      />
      <text
        x={labelX}
        y={labelY + 4}
        fontSize="9"
        fontWeight={500}
        fill={active ? STATUS_COLORS.info : COLORS.mutedForeground}
        textAnchor="middle"
      >
        {label}
      </text>

      {/* Animated dot when active */}
      {active && (
        <circle r={3} fill={STATUS_COLORS.info}>
          <animateMotion dur="1.5s" repeatCount="indefinite" path={path} />
        </circle>
      )}
    </g>
  );
};

// ─── Component ─────────────────────────────────────────────────────

export const WireDiagram: React.FC<WireDiagramProps> = ({ agents, connections }) => {
  const positions = computePositions(agents);

  const orchAgents = agents.filter((a) => a.group === "orchestrator");
  const orchWidth = orchAgents.length * (CARD_W + 24) + 80;

  const svgWidth = Math.max(800, orchWidth + 200);
  const svgHeight = 440;

  return (
    <div
      style={{
        width: "100%",
        overflowX: "auto",
        borderRadius: RADIUS.lg,
        border: `1px solid ${COLORS.border}`,
        backgroundColor: COLORS.card,
        padding: "16px",
      }}
    >
      {/* Orchestrator bounding box label */}
      <svg width={svgWidth} height={svgHeight} viewBox={`0 0 ${svgWidth} ${svgHeight}`}>
        {/* Orchestrator group box */}
        <rect
          x={80}
          y={20}
          width={orchWidth}
          height={CARD_H + 80}
          rx={16}
          fill="none"
          stroke={COLORS.border}
          strokeWidth={1}
          strokeDasharray="4 4"
        />
        <text x={96} y={40} fontSize="10" fontWeight={600} fill={COLORS.mutedForeground} letterSpacing="0.08em">
          EDGE ORCHESTRATOR
        </text>

        {/* Connection lines (render behind cards) */}
        {connections.map((conn) => {
          const fromPos = positions.get(conn.from);
          const toPos = positions.get(conn.to);
          if (!fromPos || !toPos) return null;
          return (
            <ConnectionLine
              key={`${conn.from}-${conn.to}`}
              from={fromPos}
              to={toPos}
              label={conn.label}
              active={conn.active}
            />
          );
        })}

        {/* Agent cards */}
        {agents.map((agent) => {
          const pos = positions.get(agent.id);
          if (!pos) return null;
          return <AgentCard key={agent.id} agent={agent} x={pos.x} y={pos.y} />;
        })}
      </svg>
    </div>
  );
};
