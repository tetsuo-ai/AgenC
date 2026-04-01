/**
 * Session manager for the Concordia bridge.
 *
 * Maps agent_id -> session_id and tracks per-agent state (turn count,
 * last action, observations buffer).
 *
 * @module
 */

import { createHash, randomUUID } from "node:crypto";

export interface AgentSession {
  readonly agentId: string;
  readonly agentName: string;
  readonly worldId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  turnCount: number;
  lastAction: string | null;
  observations: string[];
}

/**
 * Session ID derivation for Concordia agents within one simulation launch.
 * The same launch/world/agent tuple produces the same sessionId, while a new
 * launch gets a fresh namespace so provider response anchors are never reused
 * across separate simulations.
 */
export function deriveSessionId(
  worldId: string,
  agentId: string,
  launchId = "stable",
): string {
  const input = `concordia:${launchId}:${worldId}:${agentId}`;
  const hash = createHash("sha256").update(input).digest("hex");
  return `concordia:${hash}`;
}

export class SessionManager {
  private readonly sessions = new Map<string, AgentSession>();
  private launchId = randomUUID();

  /**
   * Get or create a session for an agent.
   */
  getOrCreate(params: {
    agentId: string;
    agentName: string;
    worldId: string;
    workspaceId: string;
  }): AgentSession {
    const existing = this.sessions.get(params.agentId);
    if (existing) return existing;

    const session: AgentSession = {
      agentId: params.agentId,
      agentName: params.agentName,
      worldId: params.worldId,
      workspaceId: params.workspaceId,
      sessionId: deriveSessionId(params.worldId, params.agentId, this.launchId),
      turnCount: 0,
      lastAction: null,
      observations: [],
    };
    this.sessions.set(params.agentId, session);
    return session;
  }

  get(agentId: string): AgentSession | undefined {
    return this.sessions.get(agentId);
  }

  findBySessionId(sessionId: string): AgentSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.sessionId === sessionId) return session;
    }
    return undefined;
  }

  listAgentIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  getAll(): AgentSession[] {
    return Array.from(this.sessions.values());
  }

  clear(): void {
    this.sessions.clear();
  }

  resetSimulation(): void {
    this.clear();
    this.launchId = randomUUID();
  }

  get size(): number {
    return this.sessions.size;
  }
}
