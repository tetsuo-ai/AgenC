/**
 * On-chain skill registry client implementation.
 *
 * Bridges the on-chain skill registry (Phase 6.2) with the local skill system.
 * Since the Solana program does not exist yet, on-chain operations use
 * `Connection.getProgramAccounts()` directly. Some operations (publish, rate)
 * are stub implementations that will be completed in Phase 6.2.
 *
 * @module
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';
import type { Logger } from '../../utils/logger.js';
import { silentLogger } from '../../utils/logger.js';
import { derivePda } from '../../utils/pda.js';
import { ValidationError } from '../../types/errors.js';
import type { Wallet } from '../../types/wallet.js';
import { parseSkillContent, validateSkillMetadata } from '../markdown/parser.js';
import type {
  SkillListing,
  SkillListingEntry,
  SkillRegistryClient,
  SkillRegistryClientConfig,
  SearchOptions,
} from './types.js';
import {
  SkillRegistryNotFoundError,
  SkillDownloadError,
  SkillVerificationError,
  SkillPublishError,
} from './errors.js';

// ============================================================================
// Constants
// ============================================================================

/**
 * Placeholder program ID for the skill registry Solana program.
 * Will be replaced with the real program ID in Phase 6.2.
 */
export const SKILL_REGISTRY_PROGRAM_ID = new PublicKey(
  '6cdqQ8wxWLnHAEJrdw89wJe6ZRdSnTuHfRgDp3r5tZ8K',
);

/** PDA seed prefix for skill accounts. */
const SKILL_SEED = Buffer.from('skill');

/** Default IPFS content gateway URL. */
const DEFAULT_CONTENT_GATEWAY = 'https://gateway.ipfs.io';

/** Default search result limit. */
const DEFAULT_SEARCH_LIMIT = 10;

/** Maximum allowed search result limit. */
const MAX_SEARCH_LIMIT = 100;

/** Download timeout in milliseconds. */
const DOWNLOAD_TIMEOUT_MS = 30_000;

// ============================================================================
// Account Deserialization (preliminary — updated in Phase 6.2)
// ============================================================================

/**
 * Deserialize a skill account's raw data into a SkillListing.
 *
 * This layout is preliminary and will be updated when the Solana program
 * is implemented in Phase 6.2. Fields are read sequentially from the buffer.
 *
 * Layout (byte offsets):
 * - 0..8:     discriminator (8 bytes)
 * - 8..40:    author pubkey (32 bytes)
 * - 40..48:   rating (f64, 8 bytes)
 * - 48..52:   ratingCount (u32, 4 bytes)
 * - 52..56:   downloads (u32, 4 bytes)
 * - 56..64:   priceLamports (u64, 8 bytes)
 * - 64..72:   registeredAt (i64 unix timestamp, 8 bytes)
 * - 72..80:   updatedAt (i64 unix timestamp, 8 bytes)
 * - 80..:     variable-length strings (each prefixed with u32 length)
 *             id, name, description, version, contentHash, tags (u32 count + strings)
 */
function deserializeSkillAccount(data: Buffer): SkillListing {
  let offset = 8; // skip discriminator

  const author = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
  offset += 32;

  const rating = data.readDoubleLE(offset);
  offset += 8;

  const ratingCount = data.readUInt32LE(offset);
  offset += 4;

  const downloads = data.readUInt32LE(offset);
  offset += 4;

  const priceLamports = data.readBigUInt64LE(offset);
  offset += 8;

  const registeredAtUnix = Number(data.readBigInt64LE(offset));
  offset += 8;

  const updatedAtUnix = Number(data.readBigInt64LE(offset));
  offset += 8;

  // Variable-length string reader
  function readString(): string {
    const len = data.readUInt32LE(offset);
    offset += 4;
    const str = data.subarray(offset, offset + len).toString('utf-8');
    offset += len;
    return str;
  }

  const id = readString();
  const name = readString();
  const description = readString();
  const version = readString();
  const contentHash = readString();

  // Tags: u32 count followed by that many strings
  const tagCount = data.readUInt32LE(offset);
  offset += 4;
  const tags: string[] = [];
  for (let i = 0; i < tagCount; i++) {
    tags.push(readString());
  }

  return {
    id,
    name,
    description,
    version,
    author,
    downloads,
    rating,
    ratingCount,
    tags,
    contentHash,
    priceLamports,
    registeredAt: new Date(registeredAtUnix * 1000),
    updatedAt: new Date(updatedAtUnix * 1000),
  };
}

/**
 * Extract an abbreviated listing entry from a full listing.
 */
function toListingEntry(listing: SkillListing): SkillListingEntry {
  return {
    id: listing.id,
    name: listing.name,
    author: listing.author,
    rating: listing.rating,
    tags: listing.tags,
    priceLamports: listing.priceLamports,
  };
}

// ============================================================================
// Client Implementation
// ============================================================================

/**
 * On-chain skill registry client.
 *
 * Provides read/write access to the on-chain skill registry.
 * Write operations (publish, rate) are stub implementations pending Phase 6.2.
 *
 * @example
 * ```typescript
 * import { Connection } from '@solana/web3.js';
 * import { OnChainSkillRegistryClient } from '@agenc/runtime';
 *
 * const client = new OnChainSkillRegistryClient({
 *   connection: new Connection('https://api.mainnet-beta.solana.com'),
 * });
 *
 * const results = await client.search('swap', { tags: ['defi'], limit: 5 });
 * const skill = await client.get(results[0].id);
 * await client.install(skill.id, './skills/swap/SKILL.md');
 * ```
 */
export class OnChainSkillRegistryClient implements SkillRegistryClient {
  private readonly connection: Connection;
  private readonly wallet: Wallet | undefined;
  private readonly contentGateway: string;
  private readonly logger: Logger;
  private readonly fetchFn: typeof fetch;

  constructor(config: SkillRegistryClientConfig) {
    this.connection = config.connection;
    this.wallet = config.wallet;
    this.contentGateway = config.contentGateway ?? DEFAULT_CONTENT_GATEWAY;
    this.logger = config.logger ?? silentLogger;
    this.fetchFn = config.fetchFn ?? globalThis.fetch;
  }

  /**
   * Search for skills by query string and optional filters.
   */
  async search(query: string, options?: SearchOptions): Promise<readonly SkillListingEntry[]> {
    const limit = Math.max(1, Math.min(options?.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT));
    const offset = options?.offset ?? 0;
    const filterTags = options?.tags;

    this.logger.debug(`Searching registry for "${query}" (limit=${limit}, offset=${offset})`);

    const accounts = await this.connection.getProgramAccounts(SKILL_REGISTRY_PROGRAM_ID);

    const queryLower = query.toLowerCase();
    const matches: SkillListing[] = [];

    for (const { account } of accounts) {
      try {
        const listing = deserializeSkillAccount(account.data as Buffer);

        // Substring match on name or description
        if (
          !listing.name.toLowerCase().includes(queryLower)
          && !listing.description.toLowerCase().includes(queryLower)
        ) {
          continue;
        }

        // Tag filter: listing must contain all requested tags
        if (filterTags && filterTags.length > 0) {
          const listingTagsLower = listing.tags.map((t) => t.toLowerCase());
          const allTagsMatch = filterTags.every((t) => listingTagsLower.includes(t.toLowerCase()));
          if (!allTagsMatch) continue;
        }

        matches.push(listing);
      } catch {
        // Skip malformed accounts
        this.logger.debug('Skipping malformed skill account during search');
      }
    }

    // Sort: rating desc, then downloads desc
    matches.sort((a, b) => b.rating - a.rating || b.downloads - a.downloads);

    return matches.slice(offset, offset + limit).map(toListingEntry);
  }

  /**
   * Get the full listing for a specific skill.
   */
  async get(skillId: string): Promise<SkillListing> {
    this.logger.debug(`Getting skill listing: ${skillId}`);

    const { address } = derivePda(
      [SKILL_SEED, Buffer.from(skillId)],
      SKILL_REGISTRY_PROGRAM_ID,
    );

    const accountInfo = await this.connection.getAccountInfo(address);

    if (!accountInfo) {
      throw new SkillRegistryNotFoundError(skillId);
    }

    return deserializeSkillAccount(accountInfo.data as Buffer);
  }

  /**
   * Download and install a skill to the local filesystem.
   */
  async install(skillId: string, targetPath: string): Promise<SkillListing> {
    this.logger.info(`Installing skill "${skillId}" to ${targetPath}`);

    const listing = await this.get(skillId);
    const url = `${this.contentGateway}/ipfs/${listing.contentHash}`;

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
    } catch (err) {
      throw new SkillDownloadError(
        skillId,
        err instanceof Error ? err.message : 'Fetch failed',
      );
    }

    if (!response.ok) {
      throw new SkillDownloadError(
        skillId,
        `HTTP ${response.status}: ${response.statusText}`,
      );
    }

    const content = Buffer.from(await response.arrayBuffer());

    // Verify content hash
    const actualHash = createHash('sha256').update(content).digest('hex');
    if (actualHash !== listing.contentHash) {
      throw new SkillVerificationError(skillId, listing.contentHash, actualHash);
    }

    // Write to filesystem
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content);

    this.logger.info(`Skill "${skillId}" installed to ${targetPath}`);
    return listing;
  }

  /**
   * Publish a local SKILL.md to the registry.
   *
   * Note: IPFS upload and on-chain instruction are deferred to Phase 6.2.
   * Currently reads the file, validates it, computes the content hash, and
   * returns the hash as the skillId.
   */
  async publish(
    skillPath: string,
    metadata: { name: string; description: string; tags?: readonly string[]; priceLamports?: bigint },
  ): Promise<string> {
    this.logger.info(`Publishing skill from ${skillPath}`);

    let content: Buffer;
    try {
      content = await readFile(skillPath);
    } catch (err) {
      throw new SkillPublishError(
        skillPath,
        err instanceof Error ? err.message : 'Failed to read file',
      );
    }

    // Validate SKILL.md format
    const parsed = parseSkillContent(content.toString('utf-8'), skillPath);
    const errors = validateSkillMetadata(parsed);
    if (errors.length > 0) {
      throw new SkillPublishError(
        skillPath,
        `Invalid SKILL.md: ${errors.map((e) => e.message).join('; ')}`,
      );
    }

    const hash = createHash('sha256').update(content).digest('hex');

    this.logger.info(`Skill content hash: ${hash}`);
    this.logger.debug(
      'IPFS upload deferred to Phase 6.2. '
      + `Metadata: name="${metadata.name}", tags=[${(metadata.tags ?? []).join(', ')}]`,
    );

    return hash;
  }

  /**
   * Rate a skill in the registry.
   *
   * Note: On-chain instruction is deferred to Phase 6.2.
   */
  async rate(skillId: string, rating: number, review?: string): Promise<void> {
    if (rating < 1 || rating > 5 || !Number.isInteger(rating)) {
      throw new ValidationError('Rating must be an integer between 1 and 5');
    }

    if (!this.wallet) {
      throw new ValidationError('Wallet required to rate skills');
    }

    this.logger.info(`Rating skill "${skillId}": ${rating}/5${review ? ` — "${review}"` : ''}`);
    this.logger.debug('On-chain rating instruction deferred to Phase 6.2');
  }

  /**
   * List skills published by a specific author.
   */
  async listByAuthor(authorPubkey: string): Promise<readonly SkillListingEntry[]> {
    // Validate base58 pubkey
    let authorKey: PublicKey;
    try {
      authorKey = new PublicKey(authorPubkey);
    } catch {
      throw new ValidationError(`Invalid public key: "${authorPubkey}"`);
    }

    this.logger.debug(`Listing skills by author: ${authorKey.toBase58()}`);

    // memcmp filter: author pubkey starts at offset 8 (after discriminator)
    const accounts = await this.connection.getProgramAccounts(SKILL_REGISTRY_PROGRAM_ID, {
      filters: [
        {
          memcmp: {
            offset: 8,
            bytes: authorKey.toBase58(),
          },
        },
      ],
    });

    const listings: SkillListing[] = [];
    for (const { account } of accounts) {
      try {
        listings.push(deserializeSkillAccount(account.data as Buffer));
      } catch {
        this.logger.debug('Skipping malformed skill account in listByAuthor');
      }
    }

    // Sort by updatedAt desc
    listings.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

    return listings.map(toListingEntry);
  }

  /**
   * Verify a skill's content hash against the on-chain record.
   */
  async verify(skillId: string, contentHash: string): Promise<boolean> {
    this.logger.debug(`Verifying skill "${skillId}" hash: ${contentHash}`);

    const listing = await this.get(skillId);
    return listing.contentHash === contentHash;
  }
}
