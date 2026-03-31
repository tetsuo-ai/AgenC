/**
 * Session manager for the Concordia bridge.
 *
 * Maps agent_id -> session_id and tracks per-agent state (turn count,
 * last action, observations buffer).
 *
 * @module
 */

import { createHash } from "node:crypto";

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
 * Deterministic session ID derivation for Concordia agents.
 * Same worldId + agentId always produces the same sessionId,
 * enabling session resumption across daemon restarts.
 */
export function deriveSessionId(worldId: string, agentId: string): string {
  const input = `concordia:${worldId}:${agentId}`;
  const hash = createHash("sha256").update(input).digest("hex");
  return `concordia:${hash}`;
}

export class SessionManager {
  private readonly sessions = new Map<string, AgentSession>();

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
      sessionId: deriveSessionId(params.worldId, params.agentId),
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

  get size(): number {
    return this.sessions.size;
  }
}
