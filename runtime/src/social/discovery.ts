/**
 * AgentDiscovery - On-chain agent search by capability, reputation, and status.
 *
 * @module
 */

import type { PublicKey } from "@solana/web3.js";
import { hasCapability } from "../agent/capabilities.js";
import { AgentStatus, parseAgentState } from "../agent/types.js";
import { silentLogger, type Logger } from "../utils/logger.js";
import { queryWithFallback, encodeStatusByte } from "../utils/query.js";
import { ProfileCache } from "./cache.js";
import { AgentDiscoveryError } from "./errors.js";
import {
  AGENT_STATUS_OFFSET,
  agentStateToProfile,
  type AgentProfile,
  type AgentSearchFilters,
  type AgentSortField,
  type DiscoveryConfig,
  type SortOrder,
} from "./types.js";

// ============================================================================
// Comparator helpers
// ============================================================================

type Comparator = (a: AgentProfile, b: AgentProfile) => number;

function comparatorFor(field: AgentSortField, order: SortOrder): Comparator {
  const dir = order === "asc" ? 1 : -1;
  switch (field) {
    case "reputation":
      return (a, b) => (a.reputation - b.reputation) * dir;
    case "lastActive":
      return (a, b) => (a.lastActive - b.lastActive) * dir;
    case "tasksCompleted": {
      return (a, b) => {
        const diff = a.tasksCompleted - b.tasksCompleted;
        if (diff < 0n) return -1 * dir;
        if (diff > 0n) return 1 * dir;
        return 0;
      };
    }
    case "stake": {
      return (a, b) => {
        const diff = a.stake - b.stake;
        if (diff < 0n) return -1 * dir;
        if (diff > 0n) return 1 * dir;
        return 0;
      };
    }
  }
}

// ============================================================================
// AgentDiscovery class
// ============================================================================

/**
 * Read-only query module for discovering on-chain agents.
 *
 * Uses memcmp filters on `status` (offset 80) to reduce the RPC result set,
 * then applies client-side filtering for capabilities, reputation, endpoint,
 * and stake.
 */
export class AgentDiscovery {
  private readonly program: DiscoveryConfig["program"];
  private readonly programId: PublicKey;
  private readonly logger: Logger;
  private readonly cache: ProfileCache | null;

  constructor(config: DiscoveryConfig) {
    this.program = config.program;
    this.programId = config.programId ?? config.program.programId;
    this.logger = config.logger ?? silentLogger;
    this.cache = config.cache ? new ProfileCache(config.cache) : null;
    // programId stored for future use by downstream modules (e.g. #1101 Agent Profiles)
    void this.programId;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Fetch a single agent profile by PDA.
   * Returns null if the account does not exist.
   */
  async getProfile(agentPda: PublicKey): Promise<AgentProfile | null> {
    // Check cache first
    if (this.cache) {
      const cached = this.cache.get(agentPda);
      if (cached) return cached;
    }

    try {
      const raw =
        await this.program.account.agentRegistration.fetchNullable(agentPda);
      if (!raw) return null;

      const state = parseAgentState(raw);
      const profile = agentStateToProfile(agentPda, state);

      if (this.cache) {
        this.cache.set(agentPda, profile);
      }

      return profile;
    } catch (err) {
      throw new AgentDiscoveryError(
        `Failed to fetch agent profile ${agentPda.toBase58()}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * List agents matching a capability bitmask (AND match).
   * Optionally filter by minimum reputation. Results sorted by reputation desc.
   */
  async listByCapability(
    capabilities: bigint,
    minReputation?: number,
  ): Promise<AgentProfile[]> {
    const profiles = await this.fetchActiveProfiles();

    return profiles
      .filter((p) => {
        if (!hasCapability(p.capabilities, capabilities)) return false;
        if (minReputation !== undefined && p.reputation < minReputation)
          return false;
        return true;
      })
      .sort((a, b) => b.reputation - a.reputation);
  }

  /**
   * Search agents with flexible filters.
   */
  async search(filters: AgentSearchFilters = {}): Promise<AgentProfile[]> {
    const activeOnly = filters.activeOnly !== false;

    const raw = activeOnly
      ? await this.fetchActiveProfiles()
      : await this.fetchAllProfiles();

    let results = raw;

    // Client-side filter chain
    if (filters.capabilities !== undefined) {
      const caps = filters.capabilities;
      results = results.filter((p) => hasCapability(p.capabilities, caps));
    }

    if (filters.minReputation !== undefined) {
      const min = filters.minReputation;
      results = results.filter((p) => p.reputation >= min);
    }

    if (filters.onlineOnly) {
      results = results.filter(
        (p) => p.status === AgentStatus.Active && p.endpoint.length > 0,
      );
    }

    if (filters.minStake !== undefined) {
      const min = filters.minStake;
      results = results.filter((p) => p.stake >= min);
    }

    // Sort
    const sortBy = filters.sortBy ?? "reputation";
    const sortOrder = filters.sortOrder ?? "desc";
    results.sort(comparatorFor(sortBy, sortOrder));

    // Pagination
    if (filters.maxResults !== undefined && filters.maxResults > 0) {
      results = results.slice(0, filters.maxResults);
    }

    return results;
  }

  /**
   * List agents that are active with a non-empty endpoint.
   */
  async listOnlineAgents(limit?: number): Promise<AgentProfile[]> {
    return this.search({
      activeOnly: true,
      onlineOnly: true,
      maxResults: limit,
      sortBy: "lastActive",
      sortOrder: "desc",
    });
  }

  /**
   * Clear the profile cache (idempotent).
   */
  dispose(): void {
    this.cache?.clear();
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  /**
   * Fetch all agent profiles with memcmp filter on status=Active,
   * falling back to full scan on RPC error.
   */
  private async fetchActiveProfiles(): Promise<AgentProfile[]> {
    return queryWithFallback(
      () => this.fetchWithStatusFilter(AgentStatus.Active),
      () =>
        this.fetchAllProfiles().then((all) =>
          all.filter((p) => p.status === AgentStatus.Active),
        ),
      this.logger,
      "AgentDiscovery.fetchActiveProfiles",
    );
  }

  /**
   * Fetch agents with a memcmp status filter.
   */
  private async fetchWithStatusFilter(
    status: AgentStatus,
  ): Promise<AgentProfile[]> {
    const accounts = await this.program.account.agentRegistration.all([
      {
        memcmp: {
          offset: AGENT_STATUS_OFFSET,
          bytes: encodeStatusByte(status),
        },
      },
    ]);

    return this.parseAccountBatch(accounts);
  }

  /**
   * Fetch all agent registration accounts (no filter).
   */
  private async fetchAllProfiles(): Promise<AgentProfile[]> {
    const accounts = await this.program.account.agentRegistration.all();
    return this.parseAccountBatch(accounts);
  }

  /**
   * Parse a batch of raw Anchor accounts into AgentProfiles.
   * Corrupted accounts are skipped with a warning.
   */
  private parseAccountBatch(
    accounts: { publicKey: PublicKey; account: unknown }[],
  ): AgentProfile[] {
    const profiles: AgentProfile[] = [];

    for (const { publicKey, account } of accounts) {
      try {
        const state = parseAgentState(account);
        profiles.push(agentStateToProfile(publicKey, state));
      } catch (err) {
        this.logger.warn(
          `AgentDiscovery: skipping corrupted account ${publicKey.toBase58()}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return profiles;
  }
}
