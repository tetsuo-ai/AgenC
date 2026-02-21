/**
 * Cross-channel identity linking for the AgenC gateway.
 *
 * Allows the same user across Telegram, Discord, Slack, etc. to be
 * recognized as a single identity. Supports manual linking via shared
 * codes, Solana ed25519 signature verification, and resolution from
 * channel-specific sender IDs to canonical identity IDs.
 *
 * @module
 */

import { randomUUID, randomBytes, verify, createPublicKey } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { RuntimeError, RuntimeErrorCodes } from "../types/errors.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";

// ============================================================================
// Error Classes
// ============================================================================

/** Error thrown when a link code has expired. */
export class IdentityLinkExpiredError extends RuntimeError {
  public readonly linkCode: string;

  constructor(linkCode: string) {
    super(
      `Identity link code expired: ${linkCode}`,
      RuntimeErrorCodes.IDENTITY_LINK_EXPIRED,
    );
    this.name = "IdentityLinkExpiredError";
    this.linkCode = linkCode;
  }
}

/** Error thrown when a link code is not found. */
export class IdentityLinkNotFoundError extends RuntimeError {
  public readonly linkCode: string;

  constructor(linkCode: string) {
    super(
      `Identity link code not found: ${linkCode}`,
      RuntimeErrorCodes.IDENTITY_LINK_NOT_FOUND,
    );
    this.name = "IdentityLinkNotFoundError";
    this.linkCode = linkCode;
  }
}

/** Error thrown when a user attempts to link an account to itself. */
export class IdentitySelfLinkError extends RuntimeError {
  public readonly channel: string;
  public readonly senderId: string;

  constructor(channel: string, senderId: string) {
    super(
      `Cannot link account to itself: ${channel}:${senderId}`,
      RuntimeErrorCodes.IDENTITY_SELF_LINK,
    );
    this.name = "IdentitySelfLinkError";
    this.channel = channel;
    this.senderId = senderId;
  }
}

/** Error thrown when ed25519 signature verification fails. */
export class IdentitySignatureError extends RuntimeError {
  public readonly publicKey: string;
  public readonly reason: string;

  constructor(publicKey: string, reason: string) {
    super(
      `Identity signature verification failed for ${publicKey}: ${reason}`,
      RuntimeErrorCodes.IDENTITY_SIGNATURE_INVALID,
    );
    this.name = "IdentitySignatureError";
    this.publicKey = publicKey;
    this.reason = reason;
  }
}

/** Error thrown when identity input validation fails. */
export class IdentityValidationError extends RuntimeError {
  public readonly field: string;
  public readonly reason: string;

  constructor(field: string, reason: string) {
    super(
      `Identity validation failed: ${field} — ${reason}`,
      RuntimeErrorCodes.IDENTITY_VALIDATION_ERROR,
    );
    this.name = "IdentityValidationError";
    this.field = field;
    this.reason = reason;
  }
}

// ============================================================================
// Types
// ============================================================================

/** A linked channel account within an identity. */
export interface IdentityAccount {
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
  readonly accounts: readonly IdentityAccount[];
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

// ============================================================================
// IdentityStore Interface
// ============================================================================

/** Pluggable storage backend for identity data. */
export interface IdentityStore {
  saveIdentity(identity: IdentityLink): Promise<void>;
  loadIdentity(identityId: string): Promise<IdentityLink | undefined>;
  findByAccount(channel: string, senderId: string): Promise<string | undefined>;
  listAll(): Promise<IdentityLink[]>;
  deleteIdentity(identityId: string): Promise<boolean>;
  countIdentities(): Promise<number>;
  savePendingLink(pending: PendingLink): Promise<void>;
  loadPendingLink(code: string): Promise<PendingLink | undefined>;
  deletePendingLink(code: string): Promise<boolean>;
  listExpiredPendingLinks(now: number): Promise<string[]>;
  countPendingLinksForIdentity(identityId: string): Promise<number>;
}

// ============================================================================
// InMemoryIdentityStore
// ============================================================================

/** Default in-memory implementation of IdentityStore. */
export class InMemoryIdentityStore implements IdentityStore {
  /** channel:senderId → identityId */
  private readonly accountIndex = new Map<string, string>();
  /** identityId → IdentityLink */
  private readonly identities = new Map<string, IdentityLink>();
  /** code → PendingLink */
  private readonly pendingLinks = new Map<string, PendingLink>();

  async saveIdentity(identity: IdentityLink): Promise<void> {
    // Clear old account index entries if identity already exists
    const existing = this.identities.get(identity.identityId);
    if (existing) {
      for (const account of existing.accounts) {
        this.accountIndex.delete(accountKey(account.channel, account.senderId));
      }
    }
    this.identities.set(identity.identityId, identity);
    for (const account of identity.accounts) {
      this.accountIndex.set(
        accountKey(account.channel, account.senderId),
        identity.identityId,
      );
    }
  }

  async loadIdentity(identityId: string): Promise<IdentityLink | undefined> {
    return this.identities.get(identityId);
  }

  async findByAccount(
    channel: string,
    senderId: string,
  ): Promise<string | undefined> {
    return this.accountIndex.get(accountKey(channel, senderId));
  }

  async listAll(): Promise<IdentityLink[]> {
    return [...this.identities.values()];
  }

  async deleteIdentity(identityId: string): Promise<boolean> {
    const identity = this.identities.get(identityId);
    if (!identity) return false;
    for (const account of identity.accounts) {
      this.accountIndex.delete(accountKey(account.channel, account.senderId));
    }
    this.identities.delete(identityId);
    return true;
  }

  async countIdentities(): Promise<number> {
    return this.identities.size;
  }

  async savePendingLink(pending: PendingLink): Promise<void> {
    this.pendingLinks.set(pending.code, pending);
  }

  async loadPendingLink(code: string): Promise<PendingLink | undefined> {
    return this.pendingLinks.get(code);
  }

  async deletePendingLink(code: string): Promise<boolean> {
    return this.pendingLinks.delete(code);
  }

  async listExpiredPendingLinks(now: number): Promise<string[]> {
    const expired: string[] = [];
    for (const [code, pending] of this.pendingLinks) {
      if (now > pending.expiresAt) {
        expired.push(code);
      }
    }
    return expired;
  }

  async countPendingLinksForIdentity(identityId: string): Promise<number> {
    let count = 0;
    const identity = this.identities.get(identityId);
    if (!identity) return 0;
    for (const pending of this.pendingLinks.values()) {
      const key = accountKey(pending.fromChannel, pending.fromSenderId);
      if (this.accountIndex.get(key) === identityId) {
        count++;
      }
    }
    return count;
  }
}

// ============================================================================
// Configuration
// ============================================================================

/** Configuration for the IdentityResolver. */
export interface IdentityResolverConfig {
  /** TTL for pending link codes in ms (default: 300_000 = 5 minutes) */
  readonly pendingLinkTtlMs?: number;
  /** Pluggable identity store (default: InMemoryIdentityStore) */
  readonly store?: IdentityStore;
  /** Logger instance */
  readonly logger?: Logger;
  /** Max failed confirmLink attempts per account before lockout (default: 10) */
  readonly maxConfirmLinkAttempts?: number;
  /** Max pending links per identity (default: 5) */
  readonly maxPendingLinksPerIdentity?: number;
  /** Max total identities (default: 10_000) */
  readonly maxIdentities?: number;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_PENDING_LINK_TTL_MS = 300_000; // 5 minutes
const LINK_CODE_LENGTH = 6;
const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const MAX_CHANNEL_LENGTH = 64;
const MAX_SENDER_ID_LENGTH = 256;
const MAX_DISPLAY_NAME_LENGTH = 256;
const DEFAULT_MAX_CONFIRM_LINK_ATTEMPTS = 10;
const DEFAULT_MAX_PENDING_LINKS_PER_IDENTITY = 5;
const DEFAULT_MAX_IDENTITIES = 10_000;

// Ed25519 DER prefix for raw 32-byte public key
const ED25519_DER_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

// ============================================================================
// IdentityResolver
// ============================================================================

/**
 * Manages cross-channel identity linking with pluggable storage.
 */
export class IdentityResolver {
  private readonly store: IdentityStore;
  private readonly logger: Logger;
  private readonly pendingLinkTtlMs: number;
  private readonly maxConfirmLinkAttempts: number;
  private readonly maxPendingLinksPerIdentity: number;
  private readonly maxIdentities: number;

  /** Tracks failed confirmLink attempts per channel:senderId */
  private readonly failedAttempts = new Map<string, number>();

  constructor(config?: IdentityResolverConfig) {
    this.pendingLinkTtlMs =
      config?.pendingLinkTtlMs ?? DEFAULT_PENDING_LINK_TTL_MS;
    this.store = config?.store ?? new InMemoryIdentityStore();
    this.logger = config?.logger ?? silentLogger;
    this.maxConfirmLinkAttempts =
      config?.maxConfirmLinkAttempts ?? DEFAULT_MAX_CONFIRM_LINK_ATTEMPTS;
    this.maxPendingLinksPerIdentity =
      config?.maxPendingLinksPerIdentity ??
      DEFAULT_MAX_PENDING_LINKS_PER_IDENTITY;
    this.maxIdentities = config?.maxIdentities ?? DEFAULT_MAX_IDENTITIES;
  }

  /**
   * Resolve a channel-specific sender to a canonical identity ID.
   * Returns undefined if no identity is linked.
   */
  async resolve(
    channel: string,
    senderId: string,
  ): Promise<string | undefined> {
    return this.store.findByAccount(channel, senderId);
  }

  /**
   * Get the full identity link for an identity ID.
   */
  async getIdentity(identityId: string): Promise<IdentityLink | undefined> {
    return this.store.loadIdentity(identityId);
  }

  /**
   * Get the identity for a channel account, if linked.
   */
  async getIdentityByAccount(
    channel: string,
    senderId: string,
  ): Promise<IdentityLink | undefined> {
    const identityId = await this.resolve(channel, senderId);
    if (!identityId) return undefined;
    return this.store.loadIdentity(identityId);
  }

  /**
   * Register a single account as a new identity (no cross-channel link yet).
   * If the account already has an identity, returns the existing one.
   */
  async register(
    channel: string,
    senderId: string,
    displayName: string,
  ): Promise<IdentityLink> {
    validateAccountInput(channel, senderId, displayName);

    const existing = await this.getIdentityByAccount(channel, senderId);
    if (existing) return existing;

    const count = await this.store.countIdentities();
    if (count >= this.maxIdentities) {
      throw new IdentityValidationError(
        "identities",
        `Maximum identity limit reached (${this.maxIdentities})`,
      );
    }

    const identityId = randomUUID();
    const now = Date.now();
    const account: IdentityAccount = {
      channel,
      senderId,
      displayName,
      linkedAt: now,
    };
    const identity: IdentityLink = {
      identityId,
      accounts: [account],
      preferences: {},
      createdAt: now,
    };

    await this.store.saveIdentity(identity);
    this.logger.info(
      `Identity registered: ${identityId} for ${channel}:${senderId}`,
    );
    return identity;
  }

  /**
   * Initiate a link request. Returns a short code the user provides
   * in the second channel to complete the link.
   */
  async requestLink(
    channel: string,
    senderId: string,
    displayName: string,
  ): Promise<string> {
    validateAccountInput(channel, senderId, displayName);

    // Ensure the initiating account has an identity
    const identity = await this.register(channel, senderId, displayName);

    // Check pending link limit
    const pendingCount = await this.store.countPendingLinksForIdentity(
      identity.identityId,
    );
    if (pendingCount >= this.maxPendingLinksPerIdentity) {
      throw new IdentityValidationError(
        "pendingLinks",
        `Maximum pending links per identity reached (${this.maxPendingLinksPerIdentity})`,
      );
    }

    const code = generateLinkCode();
    const pending: PendingLink = {
      code,
      fromChannel: channel,
      fromSenderId: senderId,
      fromDisplayName: displayName,
      expiresAt: Date.now() + this.pendingLinkTtlMs,
    };

    await this.store.savePendingLink(pending);
    this.logger.info(`Link initiated: ${code} by ${channel}:${senderId}`);
    return code;
  }

  /**
   * Confirm a link request. The second channel user provides the code
   * to merge their account into the initiator's identity.
   *
   * @throws IdentityLinkNotFoundError if code not found
   * @throws IdentityLinkExpiredError if code expired
   * @throws IdentitySelfLinkError if same channel + sender
   * @throws IdentityValidationError if attempt limit exceeded
   */
  async confirmLink(
    code: string,
    channel: string,
    senderId: string,
    displayName: string,
  ): Promise<IdentityLink> {
    validateAccountInput(channel, senderId, displayName);

    // Check attempt limit
    const attemptKey = accountKey(channel, senderId);
    const attempts = this.failedAttempts.get(attemptKey) ?? 0;
    if (attempts >= this.maxConfirmLinkAttempts) {
      this.logger.warn(
        `Link attempt limit exceeded for ${channel}:${senderId}`,
      );
      throw new IdentityValidationError(
        "attempts",
        "Maximum link attempts exceeded",
      );
    }

    const pending = await this.store.loadPendingLink(code);
    if (!pending) {
      this.failedAttempts.set(attemptKey, attempts + 1);
      throw new IdentityLinkNotFoundError(code);
    }

    // Remove the pending link regardless of outcome
    await this.store.deletePendingLink(code);

    // Check expiration
    if (Date.now() > pending.expiresAt) {
      this.failedAttempts.set(attemptKey, attempts + 1);
      this.logger.warn(`Link code expired: ${code}`);
      throw new IdentityLinkExpiredError(code);
    }

    // Prevent self-linking (same channel + sender)
    if (pending.fromChannel === channel && pending.fromSenderId === senderId) {
      this.logger.warn(`Self-link attempt: ${channel}:${senderId}`);
      throw new IdentitySelfLinkError(channel, senderId);
    }

    // Get the initiator's identity
    const fromIdentityId = await this.store.findByAccount(
      pending.fromChannel,
      pending.fromSenderId,
    );
    if (!fromIdentityId) {
      this.failedAttempts.set(attemptKey, attempts + 1);
      throw new IdentityLinkNotFoundError(code);
    }

    const fromIdentity = await this.store.loadIdentity(fromIdentityId);
    if (!fromIdentity) {
      this.failedAttempts.set(attemptKey, attempts + 1);
      throw new IdentityLinkNotFoundError(code);
    }

    // Check if the completing account already has an identity
    const toIdentityId = await this.store.findByAccount(channel, senderId);
    const now = Date.now();

    if (toIdentityId && toIdentityId === fromIdentityId) {
      // Already linked to the same identity — reset attempts, return existing
      this.failedAttempts.delete(attemptKey);
      return fromIdentity;
    }

    const newAccount: IdentityAccount = {
      channel,
      senderId,
      displayName,
      linkedAt: now,
    };

    if (toIdentityId && toIdentityId !== fromIdentityId) {
      // Merge: move all accounts from the completing identity into the initiator's
      const toIdentity = await this.store.loadIdentity(toIdentityId);
      if (toIdentity) {
        const mergedAccounts = [...fromIdentity.accounts];
        for (const account of toIdentity.accounts) {
          // Use new displayName for the completing account
          const isCompletingAccount =
            account.channel === channel && account.senderId === senderId;
          const merged = isCompletingAccount
            ? { ...account, displayName, linkedAt: now }
            : account;

          const existingIndex = mergedAccounts.findIndex(
            (a) =>
              a.channel === account.channel && a.senderId === account.senderId,
          );
          if (existingIndex >= 0) {
            mergedAccounts[existingIndex] = merged;
          } else {
            mergedAccounts.push(merged);
          }
        }

        const merged: IdentityLink = {
          ...fromIdentity,
          accounts: mergedAccounts,
        };

        await this.store.deleteIdentity(toIdentityId);
        await this.store.saveIdentity(merged);
        this.failedAttempts.delete(attemptKey);
        this.logger.info(
          `Identities merged: ${toIdentityId} → ${fromIdentityId}`,
        );
        return merged;
      }
    }

    // Simple case: add the new account to the initiator's identity
    const updated: IdentityLink = {
      ...fromIdentity,
      accounts: [...fromIdentity.accounts, newAccount],
    };
    await this.store.saveIdentity(updated);
    this.failedAttempts.delete(attemptKey);
    this.logger.info(
      `Link completed: ${channel}:${senderId} → ${fromIdentityId}`,
    );
    return updated;
  }

  /**
   * Unlink a specific account from its identity.
   * If it's the last account, the identity is removed entirely.
   * Returns true if the account was unlinked.
   */
  async unlink(channel: string, senderId: string): Promise<boolean> {
    validateAccountInput(channel, senderId, "");

    const identityId = await this.store.findByAccount(channel, senderId);
    if (!identityId) return false;

    const identity = await this.store.loadIdentity(identityId);
    if (!identity) return false;

    const remaining = identity.accounts.filter(
      (a) => !(a.channel === channel && a.senderId === senderId),
    );

    if (remaining.length === 0) {
      await this.store.deleteIdentity(identityId);
    } else {
      await this.store.saveIdentity({ ...identity, accounts: remaining });
    }

    this.logger.info(
      `Account unlinked: ${channel}:${senderId} from ${identityId}`,
    );
    return true;
  }

  /**
   * Set the on-chain agent pubkey for an identity.
   */
  async setAgentPubkey(
    identityId: string,
    agentPubkey: string,
  ): Promise<boolean> {
    const identity = await this.store.loadIdentity(identityId);
    if (!identity) return false;

    await this.store.saveIdentity({ ...identity, agentPubkey });
    return true;
  }

  /**
   * Link an identity to a Solana public key via ed25519 signature verification.
   *
   * The user signs a challenge message with their Solana keypair.
   * This verifies ownership of the private key and links the pubkey.
   *
   * @throws IdentitySignatureError if the signature is invalid
   * @throws IdentityValidationError if identityId not found
   */
  async linkViaSolana(
    identityId: string,
    publicKeyBase58: string,
    message: Uint8Array,
    signature: Uint8Array,
  ): Promise<IdentityLink> {
    const identity = await this.store.loadIdentity(identityId);
    if (!identity) {
      throw new IdentityValidationError("identityId", "Identity not found");
    }

    // Validate the public key
    let pubkey: PublicKey;
    try {
      pubkey = new PublicKey(publicKeyBase58);
    } catch {
      throw new IdentitySignatureError(
        publicKeyBase58,
        "Invalid Solana public key",
      );
    }

    // Build DER-encoded ed25519 public key for node:crypto
    const rawKey = pubkey.toBytes();
    const derKey = createPublicKey({
      key: Buffer.concat([ED25519_DER_PREFIX, rawKey]),
      format: "der",
      type: "spki",
    });

    // Verify the ed25519 signature
    const valid = verify(null, message, derKey, signature);
    if (!valid) {
      this.logger.warn(`Signature verification failed for ${publicKeyBase58}`);
      throw new IdentitySignatureError(
        publicKeyBase58,
        "Signature does not match public key",
      );
    }

    // Store the verified pubkey
    const updated = { ...identity, agentPubkey: publicKeyBase58 };
    await this.store.saveIdentity(updated);
    this.logger.info(
      `Solana pubkey linked: ${publicKeyBase58} → ${identityId}`,
    );
    return updated;
  }

  /**
   * Update preferences for an identity.
   */
  async setPreferences(
    identityId: string,
    preferences: Record<string, unknown>,
  ): Promise<boolean> {
    const identity = await this.store.loadIdentity(identityId);
    if (!identity) return false;

    await this.store.saveIdentity({
      ...identity,
      preferences: { ...identity.preferences, ...preferences },
    });
    return true;
  }

  /**
   * Purge expired pending link requests.
   * Returns the number of purged entries.
   */
  async purgeExpired(): Promise<number> {
    const now = Date.now();
    const expired = await this.store.listExpiredPendingLinks(now);
    for (const code of expired) {
      await this.store.deletePendingLink(code);
    }
    return expired.length;
  }

  /** List all registered identities. */
  async listIdentities(): Promise<readonly IdentityLink[]> {
    return this.store.listAll();
  }
}

// ============================================================================
// Helpers
// ============================================================================

function accountKey(channel: string, senderId: string): string {
  return `${channel}\x00${senderId}`;
}

function generateLinkCode(): string {
  const bytes = randomBytes(LINK_CODE_LENGTH);
  return Array.from(bytes, (b) => ALPHANUMERIC[b % 36]).join("");
}

/**
 * Validate channel/senderId/displayName inputs.
 * displayName validation is skipped when empty (for unlink).
 */
function validateAccountInput(
  channel: string,
  senderId: string,
  displayName: string,
): void {
  if (typeof channel !== "string" || channel.length === 0) {
    throw new IdentityValidationError("channel", "must be a non-empty string");
  }
  if (channel.length > MAX_CHANNEL_LENGTH) {
    throw new IdentityValidationError(
      "channel",
      `must be at most ${MAX_CHANNEL_LENGTH} characters`,
    );
  }
  if (channel.includes("\x00")) {
    throw new IdentityValidationError("channel", "must not contain null bytes");
  }

  if (typeof senderId !== "string" || senderId.length === 0) {
    throw new IdentityValidationError("senderId", "must be a non-empty string");
  }
  if (senderId.length > MAX_SENDER_ID_LENGTH) {
    throw new IdentityValidationError(
      "senderId",
      `must be at most ${MAX_SENDER_ID_LENGTH} characters`,
    );
  }
  if (senderId.includes("\x00")) {
    throw new IdentityValidationError(
      "senderId",
      "must not contain null bytes",
    );
  }

  // displayName is optional for unlink
  if (displayName.length > 0) {
    if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
      throw new IdentityValidationError(
        "displayName",
        `must be at most ${MAX_DISPLAY_NAME_LENGTH} characters`,
      );
    }
    if (displayName.includes("\x00")) {
      throw new IdentityValidationError(
        "displayName",
        "must not contain null bytes",
      );
    }
  }
}
