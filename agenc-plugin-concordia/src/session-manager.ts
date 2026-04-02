/**
 * Session manager for the Concordia bridge.
 *
 * Maps simulation-scoped agent identities to deterministic session IDs and
 * tracks per-agent state (turn count, last action, observations buffer).
 *
 * @module
 */

import { createHash } from "node:crypto";

export interface AgentSession {
  readonly agentId: string;
  readonly agentName: string;
  readonly worldId: string;
  readonly workspaceId: string;
  readonly simulationId: string;
  readonly lineageId?: string | null;
  readonly parentSimulationId?: string | null;
  readonly sessionId: string;
  turnCount: number;
  lastAction: string | null;
  observations: string[];
}

/**
 * Session ID derivation for Concordia agents.
 * The same simulation/agent tuple always produces the same sessionId while
 * same-world concurrent runs stay isolated from each other.
 */
export function deriveSessionId(
  simulationId: string,
  agentId: string,
): string {
  const input = `concordia:${simulationId}:${agentId}`;
  const hash = createHash("sha256").update(input).digest("hex");
  return `concordia:${hash}`;
}

export class SessionManager {
  private readonly sessions = new Map<string, AgentSession>();

  private keyFor(params: {
    agentId: string;
    simulationId: string;
    workspaceId: string;
  }): string {
    return `${params.workspaceId}:${params.simulationId}:${params.agentId}`;
  }

  /**
   * Get or create a session for an agent.
   */
  getOrCreate(params: {
    agentId: string;
    agentName: string;
    worldId: string;
    workspaceId: string;
    simulationId: string;
    lineageId?: string | null;
    parentSimulationId?: string | null;
  }): AgentSession {
    const key = this.keyFor(params);
    const existing = this.sessions.get(key);
    if (existing) return existing;

    const session: AgentSession = {
      agentId: params.agentId,
      agentName: params.agentName,
      worldId: params.worldId,
      workspaceId: params.workspaceId,
      simulationId: params.simulationId,
      lineageId: params.lineageId ?? null,
      parentSimulationId: params.parentSimulationId ?? null,
      sessionId: deriveSessionId(params.simulationId, params.agentId),
      turnCount: 0,
      lastAction: null,
      observations: [],
    };
    this.sessions.set(key, session);
    return session;
  }

  get(agentId: string): AgentSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.agentId === agentId) {
        return session;
      }
    }
    return undefined;
  }

  getForWorld(params: {
    agentId: string;
    worldId: string;
    workspaceId?: string;
    simulationId?: string;
  }): AgentSession | undefined;
  getForWorld(agentId: string, worldId: string): AgentSession | undefined;
  getForWorld(
    paramsOrAgentId:
      | {
          agentId: string;
          worldId: string;
          workspaceId?: string;
          simulationId?: string;
        }
      | string,
    worldIdArg?: string,
  ): AgentSession | undefined {
    const params =
      typeof paramsOrAgentId === "string"
        ? { agentId: paramsOrAgentId, worldId: worldIdArg ?? "" }
        : paramsOrAgentId;
    for (const session of this.sessions.values()) {
      if (session.agentId !== params.agentId) {
        continue;
      }
      if (session.worldId !== params.worldId) {
        continue;
      }
      if (
        params.workspaceId !== undefined &&
        session.workspaceId !== params.workspaceId
      ) {
        continue;
      }
      if (
        params.simulationId !== undefined &&
        session.simulationId !== params.simulationId
      ) {
        continue;
      }
      return session;
    }
    return undefined;
  }

  findBySessionId(sessionId: string): AgentSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.sessionId === sessionId) return session;
    }
    return undefined;
  }

  listAgentIds(): string[] {
    return Array.from(
      new Set(Array.from(this.sessions.values(), (session) => session.agentId)),
    );
  }

  getAll(): AgentSession[] {
    return Array.from(this.sessions.values());
  }

  getAllForWorld(
    worldId: string,
    workspaceId?: string,
    simulationId?: string,
  ): AgentSession[] {
    return Array.from(this.sessions.values()).filter(
      (session) =>
        session.worldId === worldId &&
        (workspaceId === undefined || session.workspaceId === workspaceId) &&
        (simulationId === undefined || session.simulationId === simulationId),
    );
  }

  clear(): void {
    this.sessions.clear();
  }

  resetSimulation(): void {
    this.clear();
  }

  get size(): number {
    return this.sessions.size;
  }
}
