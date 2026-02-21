/**
 * Team contract audit event store interfaces and defaults.
 *
 * @module
 */

import type { TeamAuditEvent } from "./types.js";

export interface TeamAuditStore {
  append(event: TeamAuditEvent): void;
  list(contractId: string): TeamAuditEvent[];
  clear(contractId: string): void;
}

export interface InMemoryTeamAuditStoreConfig {
  /** Max retained events per contract (oldest evicted first). */
  maxEventsPerContract?: number;
}

export class InMemoryTeamAuditStore implements TeamAuditStore {
  private readonly events = new Map<string, TeamAuditEvent[]>();
  private readonly maxEventsPerContract: number;

  constructor(config: InMemoryTeamAuditStoreConfig = {}) {
    this.maxEventsPerContract = config.maxEventsPerContract ?? 5_000;
  }

  append(event: TeamAuditEvent): void {
    const bucket = this.events.get(event.contractId) ?? [];
    bucket.push({ ...event, payload: { ...event.payload } });

    while (bucket.length > this.maxEventsPerContract) {
      bucket.shift();
    }

    this.events.set(event.contractId, bucket);
  }

  list(contractId: string): TeamAuditEvent[] {
    const bucket = this.events.get(contractId) ?? [];
    return bucket.map((event) => ({
      ...event,
      payload: { ...event.payload },
    }));
  }

  clear(contractId: string): void {
    this.events.delete(contractId);
  }
}
