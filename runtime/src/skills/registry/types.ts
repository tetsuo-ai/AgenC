/**
 * Data types and interfaces for the on-chain skill registry client.
 *
 * @module
 */

import type { Connection } from "@solana/web3.js";
import type { Wallet } from "../../types/wallet.js";
import type { Logger } from "../../utils/logger.js";

// ============================================================================
// Data Types
// ============================================================================

/**
 * Full skill listing as stored in the on-chain registry.
 */
export interface SkillListing {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly author: string;
  readonly authorAgent?: string;
  readonly authorReputation?: number;
  readonly downloads: number;
  readonly rating: number;
  readonly ratingCount: number;
  readonly tags: readonly string[];
  readonly contentHash: string;
  readonly priceLamports: bigint;
  readonly priceToken?: { readonly mint: string; readonly amount: bigint };
  readonly registeredAt: Date;
  readonly updatedAt: Date;
}

/**
 * Abbreviated skill entry returned by search and list operations.
 */
export interface SkillListingEntry {
  readonly id: string;
  readonly name: string;
  readonly author: string;
  readonly rating: number;
  readonly tags: readonly string[];
  readonly priceLamports: bigint;
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration for {@link SkillRegistryClient} implementations.
 */
export interface SkillRegistryClientConfig {
  /** Solana RPC connection */
  readonly connection: Connection;
  /** Wallet for signing publish/rate transactions (optional for read-only) */
  readonly wallet?: Wallet;
  /** IPFS content gateway base URL */
  readonly contentGateway?: string;
  /** Logger instance */
  readonly logger?: Logger;
  /** Injectable fetch function for testability */
  readonly fetchFn?: typeof fetch;
}

// ============================================================================
// Client Interface
// ============================================================================

/** Options for search queries. */
export interface SearchOptions {
  readonly tags?: readonly string[];
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * Client interface for interacting with the on-chain skill registry.
 */
export interface SkillRegistryClient {
  /**
   * Search for skills by query string and optional filters.
   *
   * @param query - Substring match against skill name and description
   * @param options - Optional search filters (tags, limit, offset)
   * @returns Array of matching skill listing entries
   */
  search(
    query: string,
    options?: SearchOptions,
  ): Promise<readonly SkillListingEntry[]>;

  /**
   * Get the full listing for a specific skill.
   *
   * @param skillId - The skill identifier
   * @returns Full skill listing
   * @throws SkillRegistryNotFoundError if the skill does not exist
   */
  get(skillId: string): Promise<SkillListing>;

  /**
   * Download and install a skill to the local filesystem.
   *
   * @param skillId - The skill identifier
   * @param targetPath - Local filesystem path to write the skill file
   * @returns The installed skill listing
   * @throws SkillDownloadError if the download fails
   * @throws SkillVerificationError if the content hash does not match
   */
  install(skillId: string, targetPath: string): Promise<SkillListing>;

  /**
   * Publish a local SKILL.md to the registry.
   *
   * @param skillPath - Path to the local SKILL.md file
   * @param metadata - Additional metadata (name, description, tags, priceLamports)
   * @returns The skillId (content hash) of the published skill
   * @throws SkillPublishError if validation or upload fails
   */
  publish(
    skillPath: string,
    metadata: {
      name: string;
      description: string;
      tags?: readonly string[];
      priceLamports?: bigint;
    },
  ): Promise<string>;

  /**
   * Rate a skill in the registry.
   *
   * @param skillId - The skill identifier
   * @param rating - Rating value (1-5)
   * @param review - Optional review text
   */
  rate(skillId: string, rating: number, review?: string): Promise<void>;

  /**
   * List skills published by a specific author.
   *
   * @param authorPubkey - The author's public key (base58)
   * @returns Array of skill listing entries
   */
  listByAuthor(authorPubkey: string): Promise<readonly SkillListingEntry[]>;

  /**
   * Verify a skill's content hash against the on-chain record.
   *
   * @param skillId - The skill identifier
   * @param contentHash - The expected content hash
   * @returns True if the hash matches
   */
  verify(skillId: string, contentHash: string): Promise<boolean>;
}
