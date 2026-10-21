import { Agent, callable } from "agents";
import {
  CALLA_EVENTS,
  callaFrame,
  type AgentStatus,
  type AgentType,
} from "@calla/shared";
import type { Env } from "../env";

/** One row in the fleet roster. */
export interface FleetRosterEntry {
  id: string;
  name: string;
  type: AgentType | string;
  capabilities: string[];
  status: AgentStatus;
  registeredAt: number;
  lastHeartbeat: number;
  meta?: Record<string, unknown>;
}

/** Durable Object state for CallaOrchestrator. */
export interface FleetState {
  agents: Record<string, FleetRosterEntry>;
}

export const INITIAL_FLEET_STATE: FleetState = { agents: {} };

const HUB_NAME = "hub";

/**
 * CallaOrchestrator — the fleet registry.
 *
 * A single named Agent ("fleet") that tracks every registered agent across both
 * runtimes, their live status, and last heartbeat. Every mutation publishes a
 * `calla:agent:state` frame to the event hub so the Fleet Dashboard updates live.
 *
 * RPC surface:
 *  - registerAgent({id,name,type,capabilities?,status?,meta?}) → FleetRosterEntry
 *  - heartbeat({id,status?})                                  → FleetRosterEntry | null
 *  - listFleet()                                              → FleetRosterEntry[]
 */
export class CallaOrchestrator extends Agent<Env, FleetState> {
  initialState: FleetState = INITIAL_FLEET_STATE;

  @callable()
  async registerAgent(input: {
    id: string;
    name: string;
    type: AgentType | string;
    capabilities?: string[];
    status?: AgentStatus;
    meta?: Record<string, unknown>;
  }): Promise<FleetRosterEntry> {
    const now = Date.now();
    const existing = this.state.agents[input.id];
    const entry: FleetRosterEntry = {
      id: input.id,
      name: input.name,
      type: input.type,
      capabilities: input.capabilities ?? existing?.capabilities ?? [],
      status: input.status ?? existing?.status ?? "idle",
      registeredAt: existing?.registeredAt ?? now,
      lastHeartbeat: now,
      meta: input.meta ?? existing?.meta,
    };

    this.setState({
      ...this.state,
      agents: { ...this.state.agents, [entry.id]: entry },
    });
    await this.publishAgentState(entry);
    return entry;
  }

  @callable()
  async heartbeat(input: {
    id: string;
    status?: AgentStatus;
  }): Promise<FleetRosterEntry | null> {
    const existing = this.state.agents[input.id];
    if (!existing) return null;

    const entry: FleetRosterEntry = {
      ...existing,
      status: input.status ?? existing.status,
      lastHeartbeat: Date.now(),
    };
    this.setState({
      ...this.state,
      agents: { ...this.state.agents, [entry.id]: entry },
    });
    await this.publishAgentState(entry);
    return entry;
  }

  @callable()
  async listFleet(): Promise<FleetRosterEntry[]> {
    return Object.values(this.state.agents);
  }

  private async publishAgentState(entry: FleetRosterEntry): Promise<void> {
    try {
      const hub = this.env.CALLA_EVENTS.getByName(HUB_NAME);
      await hub.publish(
        callaFrame(CALLA_EVENTS.agentState, entry, { agentId: entry.id }),
      );
    } catch (err) {
      console.error("[calla] orchestrator hub publish failed:", err);
    }
  }
}
