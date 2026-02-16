/**
 * Cross-channel identity linking for the AgenC gateway.
 *
 * Allows the same user across Telegram, Discord, Slack, etc. to be
 * recognized as a single identity. Supports manual linking via shared
 * codes and resolution from channel-specific sender IDs to canonical
 * identity IDs.
 *
 * @module
 */

import { randomUUID, createHash } from 'node:crypto';

// ============================================================================
// Types
// ============================================================================

/** A linked channel account within an identity. */
export interface LinkedAccount {
  /** Channel name (e.g. 'telegram', 'discord') */
  readonly channel: string;
  /** Platform-specific sender ID */
  readonly senderId: string;
  /** Human-readable display name */
  readonly displayName: string;
  /** Timestamp when this account was linked */
  readonly linkedAt: number;
}

/** A cross-channel identity linking multiple accounts. */
export interface IdentityLink {
  /** Internal identity ID (UUID) */
  readonly identityId: string;
  /** Linked channel accounts */
  readonly accounts: readonly LinkedAccount[];
  /** Optional on-chain agent pubkey */
  readonly agentPubkey?: string;
  /** User preferences */
  readonly preferences: Readonly<Record<string, unknown>>;
  /** Timestamp when identity was created */
  readonly createdAt: number;
}

/** A pending link request awaiting confirmation from the second channel. */
export interface PendingLink {
  /** Short code shared between channels */
  readonly code: string;
  /** Channel that initiated the link */
  readonly fromChannel: string;
  /** Sender ID that initiated the link */
  readonly fromSenderId: string;
  /** Display name of the initiating user */
  readonly fromDisplayName: string;
  /** Expiration timestamp (ms) */
  readonly expiresAt: number;
}

/** Configuration for the IdentityResolver. */
export interface IdentityResolverConfig {
  /** TTL for pending link codes in ms (default: 300_000 = 5 minutes) */
  readonly pendingLinkTtlMs?: number;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_PENDING_LINK_TTL_MS = 300_000; // 5 minutes
const LINK_CODE_LENGTH = 6;

// ============================================================================
// IdentityResolver
// ============================================================================

/**
 * Manages cross-channel identity linking.
 *
 * Uses in-memory Maps for storage. For durable storage, integrate
 * with MemoryBackend KV operations in a future phase.
 */
export class IdentityResolver {
  /** channel:senderId → identityId */
  private readonly accountIndex = new Map<string, string>();
  /** identityId → IdentityLink */
  private readonly identities = new Map<string, IdentityLink>();
  /** code → PendingLink */
  private readonly pendingLinks = new Map<string, PendingLink>();

  private readonly pendingLinkTtlMs: number;

  constructor(config?: IdentityResolverConfig) {
    this.pendingLinkTtlMs = config?.pendingLinkTtlMs ?? DEFAULT_PENDING_LINK_TTL_MS;
  }

  /** Number of registered identities. */
  get identityCount(): number {
    return this.identities.size;
  }

  /** Number of pending link requests. */
  get pendingCount(): number {
    return this.pendingLinks.size;
  }

  /**
   * Resolve a channel-specific sender to a canonical identity ID.
   * Returns undefined if no identity is linked.
   */
  resolve(channel: string, senderId: string): string | undefined {
    return this.accountIndex.get(accountKey(channel, senderId));
  }

  /**
   * Get the full identity link for an identity ID.
   */
  getIdentity(identityId: string): IdentityLink | undefined {
    return this.identities.get(identityId);
  }

  /**
   * Get the identity for a channel account, if linked.
   */
  getIdentityByAccount(channel: string, senderId: string): IdentityLink | undefined {
    const identityId = this.resolve(channel, senderId);
    if (!identityId) return undefined;
    return this.identities.get(identityId);
  }

  /**
   * Register a single account as a new identity (no cross-channel link yet).
   * If the account already has an identity, returns the existing one.
   */
  register(channel: string, senderId: string, displayName: string): IdentityLink {
    const existing = this.getIdentityByAccount(channel, senderId);
    if (existing) return existing;

    const identityId = randomUUID();
    const now = Date.now();
    const account: LinkedAccount = { channel, senderId, displayName, linkedAt: now };
    const identity: IdentityLink = {
      identityId,
      accounts: [account],
      preferences: {},
      createdAt: now,
    };

    this.identities.set(identityId, identity);
    this.accountIndex.set(accountKey(channel, senderId), identityId);
    return identity;
  }

  /**
   * Initiate a link request. Returns a short code the user provides
   * in the second channel to complete the link.
   */
  initLink(channel: string, senderId: string, displayName: string): string {
    // Ensure the initiating account has an identity
    this.register(channel, senderId, displayName);

    const code = generateLinkCode();
    const pending: PendingLink = {
      code,
      fromChannel: channel,
      fromSenderId: senderId,
      fromDisplayName: displayName,
      expiresAt: Date.now() + this.pendingLinkTtlMs,
    };

    this.pendingLinks.set(code, pending);
    return code;
  }

  /**
   * Complete a link request. The second channel user provides the code
   * to merge their account into the initiator's identity.
   *
   * Returns the merged identity, or null if the code is invalid/expired.
   */
  completeLink(
    code: string,
    channel: string,
    senderId: string,
    displayName: string,
  ): IdentityLink | null {
    const pending = this.pendingLinks.get(code);
    if (!pending) return null;

    // Remove the pending link regardless of outcome
    this.pendingLinks.delete(code);

    // Check expiration
    if (Date.now() > pending.expiresAt) return null;

    // Prevent self-linking (same channel + sender)
    if (pending.fromChannel === channel && pending.fromSenderId === senderId) {
      return null;
    }

    // Get the initiator's identity
    const fromIdentityId = this.resolve(pending.fromChannel, pending.fromSenderId);
    if (!fromIdentityId) return null;

    const fromIdentity = this.identities.get(fromIdentityId);
    if (!fromIdentity) return null;

    // Check if the completing account already has an identity
    const toIdentityId = this.resolve(channel, senderId);
    const now = Date.now();

    if (toIdentityId && toIdentityId === fromIdentityId) {
      // Already linked to the same identity
      return fromIdentity;
    }

    const newAccount: LinkedAccount = { channel, senderId, displayName, linkedAt: now };

    if (toIdentityId && toIdentityId !== fromIdentityId) {
      // Merge: move all accounts from the completing identity into the initiator's
      const toIdentity = this.identities.get(toIdentityId);
      if (toIdentity) {
        const mergedAccounts = [...fromIdentity.accounts];
        for (const account of toIdentity.accounts) {
          // Re-index existing accounts to the initiator's identity
          this.accountIndex.set(accountKey(account.channel, account.senderId), fromIdentityId);
          if (!mergedAccounts.some((a) => a.channel === account.channel && a.senderId === account.senderId)) {
            mergedAccounts.push(account);
          }
        }
        // Remove the old identity
        this.identities.delete(toIdentityId);

        const merged: IdentityLink = {
          ...fromIdentity,
          accounts: mergedAccounts,
        };
        this.identities.set(fromIdentityId, merged);
        return merged;
      }
    }

    // Simple case: add the new account to the initiator's identity
    const updated: IdentityLink = {
      ...fromIdentity,
      accounts: [...fromIdentity.accounts, newAccount],
    };
    this.identities.set(fromIdentityId, updated);
    this.accountIndex.set(accountKey(channel, senderId), fromIdentityId);
    return updated;
  }

  /**
   * Unlink a specific account from its identity.
   * If it's the last account, the identity is removed entirely.
   * Returns true if the account was unlinked.
   */
  unlink(channel: string, senderId: string): boolean {
    const key = accountKey(channel, senderId);
    const identityId = this.accountIndex.get(key);
    if (!identityId) return false;

    const identity = this.identities.get(identityId);
    if (!identity) {
      this.accountIndex.delete(key);
      return false;
    }

    const remaining = identity.accounts.filter(
      (a) => !(a.channel === channel && a.senderId === senderId),
    );

    this.accountIndex.delete(key);

    if (remaining.length === 0) {
      this.identities.delete(identityId);
    } else {
      this.identities.set(identityId, { ...identity, accounts: remaining });
    }

    return true;
  }

  /**
   * Set the on-chain agent pubkey for an identity.
   */
  setAgentPubkey(identityId: string, agentPubkey: string): boolean {
    const identity = this.identities.get(identityId);
    if (!identity) return false;

    this.identities.set(identityId, { ...identity, agentPubkey });
    return true;
  }

  /**
   * Update preferences for an identity.
   */
  setPreferences(identityId: string, preferences: Record<string, unknown>): boolean {
    const identity = this.identities.get(identityId);
    if (!identity) return false;

    this.identities.set(identityId, {
      ...identity,
      preferences: { ...identity.preferences, ...preferences },
    });
    return true;
  }

  /**
   * Purge expired pending link requests.
   * Returns the number of purged entries.
   */
  purgeExpired(): number {
    const now = Date.now();
    let purged = 0;
    for (const [code, pending] of this.pendingLinks) {
      if (now > pending.expiresAt) {
        this.pendingLinks.delete(code);
        purged++;
      }
    }
    return purged;
  }

  /** List all registered identities. */
  listIdentities(): readonly IdentityLink[] {
    return [...this.identities.values()];
  }
}

// ============================================================================
// Helpers
// ============================================================================

function accountKey(channel: string, senderId: string): string {
  return `${channel}\x00${senderId}`;
}

function generateLinkCode(): string {
  const hash = createHash('sha256').update(randomUUID()).digest('hex');
  return hash.slice(0, LINK_CODE_LENGTH).toUpperCase();
}
