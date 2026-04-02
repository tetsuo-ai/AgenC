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
 * Session ID derivation for Concordia agents.
 * The same world/agent tuple always produces the same sessionId so runs can
 * resume against stable memory threads.
 */
export function deriveSessionId(
  worldId: string,
  agentId: string,
): string {
  const input = `concordia:${worldId}:${agentId}`;
  const hash = createHash("sha256").update(input).digest("hex");
  return `concordia:${hash}`;
}

export class SessionManager {
  private readonly sessions = new Map<string, AgentSession>();

  private keyFor(params: {
    agentId: string;
    worldId: string;
    workspaceId: string;
  }): string {
    return `${params.workspaceId}:${params.worldId}:${params.agentId}`;
  }

  /**
   * Get or create a session for an agent.
   */
  getOrCreate(params: {
    agentId: string;
    agentName: string;
    worldId: string;
    workspaceId: string;
  }): AgentSession {
    const key = this.keyFor(params);
    const existing = this.sessions.get(key);
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
