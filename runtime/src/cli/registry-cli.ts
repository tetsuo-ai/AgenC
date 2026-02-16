import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Connection } from '@solana/web3.js';
import { OnChainSkillRegistryClient } from '../skills/registry/client.js';
import type { SkillRegistryClient } from '../skills/registry/types.js';
import {
  SkillRegistryNotFoundError,
  SkillDownloadError,
  SkillVerificationError,
  SkillPublishError,
} from '../skills/registry/errors.js';
import { parseSkillContent } from '../skills/markdown/parser.js';
import { importSkill } from '../skills/markdown/compat.js';
import {
  loadKeypairFromFile,
  keypairToWallet,
  getDefaultKeypairPath,
} from '../types/wallet.js';
import { getUserSkillsDir } from './skills-cli.js';
import type { CliRuntimeContext, CliStatusCode } from './types.js';
import type { Logger } from '../utils/logger.js';
import { silentLogger } from '../utils/logger.js';

// ============================================================================
// Helpers
// ============================================================================

function createRegistryClient(
  rpcUrl?: string,
  logger?: Logger,
): OnChainSkillRegistryClient | null {
  if (!rpcUrl) return null;
  return new OnChainSkillRegistryClient({
    connection: new Connection(rpcUrl),
    logger: logger ?? silentLogger,
  });
}

async function loadWallet(
  logger?: Logger,
): Promise<ReturnType<typeof keypairToWallet> | undefined> {
  const keypairPath = process.env.SOLANA_KEYPAIR_PATH ?? getDefaultKeypairPath();
  try {
    const keypair = await loadKeypairFromFile(keypairPath);
    return keypairToWallet(keypair);
  } catch {
    (logger ?? silentLogger).debug(`Failed to load wallet from ${keypairPath}`);
    return undefined;
  }
}

// ============================================================================
// Commands
// ============================================================================

export async function runRegistrySearchCommand(
  context: CliRuntimeContext,
  options: { query: string; tags?: string[]; limit?: number; rpcUrl?: string },
  overrides?: { client?: SkillRegistryClient },
): Promise<CliStatusCode> {
  const client = overrides?.client ?? createRegistryClient(options.rpcUrl);
  if (!client) {
    context.error({
      status: 'error',
      code: 'RPC_NOT_CONFIGURED',
      message: 'RPC URL is required for registry operations. Use --rpc <url>.',
    });
    return 1;
  }

  try {
    const results = await client.search(options.query, {
      tags: options.tags,
      limit: options.limit,
    });

    context.output({
      status: 'ok',
      command: 'skill.search',
      schema: 'skill.search.output.v1',
      query: options.query,
      count: results.length,
      results,
    });
    return 0;
  } catch (error) {
    context.error({
      status: 'error',
      code: 'REGISTRY_ERROR',
      message: `Registry search failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    return 1;
  }
}

export async function runRegistryInstallCommand(
  context: CliRuntimeContext,
  options: { skillId: string; rpcUrl?: string },
  overrides?: { client?: SkillRegistryClient; userSkillsDir?: string },
): Promise<CliStatusCode> {
  const client = overrides?.client ?? createRegistryClient(options.rpcUrl);
  if (!client) {
    context.error({
      status: 'error',
      code: 'RPC_NOT_CONFIGURED',
      message: 'RPC URL is required for registry operations. Use --rpc <url>.',
    });
    return 1;
  }

  const dir = overrides?.userSkillsDir ?? getUserSkillsDir();

  try {
    const listing = await client.install(options.skillId, join(dir, `${options.skillId}.md`));

    context.output({
      status: 'ok',
      command: 'skill.registry-install',
      schema: 'skill.registry-install.output.v1',
      skillId: listing.id,
      skillName: listing.name,
      filePath: join(dir, `${options.skillId}.md`),
    });
    return 0;
  } catch (error) {
    if (error instanceof SkillRegistryNotFoundError) {
      context.error({
        status: 'error',
        code: 'SKILL_NOT_FOUND',
        message: error.message,
      });
      return 1;
    }
    if (error instanceof SkillDownloadError) {
      context.error({
        status: 'error',
        code: 'DOWNLOAD_FAILED',
        message: error.message,
      });
      return 1;
    }
    if (error instanceof SkillVerificationError) {
      context.error({
        status: 'error',
        code: 'VERIFICATION_FAILED',
        message: error.message,
      });
      return 1;
    }
    context.error({
      status: 'error',
      code: 'REGISTRY_ERROR',
      message: `Registry install failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    return 1;
  }
}

export async function runRegistryPublishCommand(
  context: CliRuntimeContext,
  options: { skillPath: string; tags?: string[]; priceLamports?: string; rpcUrl?: string },
  overrides?: { client?: SkillRegistryClient; wallet?: unknown },
): Promise<CliStatusCode> {
  const client = overrides?.client ?? createRegistryClient(options.rpcUrl);
  if (!client) {
    context.error({
      status: 'error',
      code: 'RPC_NOT_CONFIGURED',
      message: 'RPC URL is required for registry operations. Use --rpc <url>.',
    });
    return 1;
  }

  const wallet = overrides && 'wallet' in overrides ? overrides.wallet : await loadWallet();
  if (!wallet) {
    context.error({
      status: 'error',
      code: 'WALLET_NOT_FOUND',
      message: 'Wallet is required for publishing. Set SOLANA_KEYPAIR_PATH or place a keypair at ~/.config/solana/id.json.',
    });
    return 1;
  }

  if (!existsSync(options.skillPath)) {
    context.error({
      status: 'error',
      code: 'SOURCE_NOT_FOUND',
      message: `Skill file not found: ${options.skillPath}`,
    });
    return 1;
  }

  try {
    const content = await readFile(options.skillPath, 'utf-8');
    const parsed = parseSkillContent(content, options.skillPath);

    const priceLamports = options.priceLamports
      ? BigInt(options.priceLamports)
      : undefined;

    const hash = await client.publish(options.skillPath, {
      name: parsed.name,
      description: parsed.description,
      tags: options.tags,
      priceLamports,
    });

    context.output({
      status: 'ok',
      command: 'skill.publish',
      schema: 'skill.publish.output.v1',
      skillPath: options.skillPath,
      contentHash: hash,
      name: parsed.name,
    });
    return 0;
  } catch (error) {
    if (error instanceof SkillPublishError) {
      context.error({
        status: 'error',
        code: 'PUBLISH_FAILED',
        message: error.message,
      });
      return 1;
    }
    context.error({
      status: 'error',
      code: 'REGISTRY_ERROR',
      message: `Publish failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    return 1;
  }
}

export async function runRegistryRateCommand(
  context: CliRuntimeContext,
  options: { skillId: string; rating: number; review?: string; rpcUrl?: string },
  overrides?: { client?: SkillRegistryClient; wallet?: unknown },
): Promise<CliStatusCode> {
  const client = overrides?.client ?? createRegistryClient(options.rpcUrl);
  if (!client) {
    context.error({
      status: 'error',
      code: 'RPC_NOT_CONFIGURED',
      message: 'RPC URL is required for registry operations. Use --rpc <url>.',
    });
    return 1;
  }

  const wallet = overrides && 'wallet' in overrides ? overrides.wallet : await loadWallet();
  if (!wallet) {
    context.error({
      status: 'error',
      code: 'WALLET_NOT_FOUND',
      message: 'Wallet is required for rating. Set SOLANA_KEYPAIR_PATH or place a keypair at ~/.config/solana/id.json.',
    });
    return 1;
  }

  if (!Number.isInteger(options.rating) || options.rating < 1 || options.rating > 5) {
    context.error({
      status: 'error',
      code: 'INVALID_VALUE',
      message: 'Rating must be an integer between 1 and 5.',
    });
    return 1;
  }

  try {
    await client.rate(options.skillId, options.rating, options.review);

    context.output({
      status: 'ok',
      command: 'skill.rate',
      schema: 'skill.rate.output.v1',
      skillId: options.skillId,
      rating: options.rating,
      ...(options.review ? { review: options.review } : {}),
    });
    return 0;
  } catch (error) {
    context.error({
      status: 'error',
      code: 'REGISTRY_ERROR',
      message: `Rating failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    return 1;
  }
}

export async function runRegistryVerifyCommand(
  context: CliRuntimeContext,
  options: { skillId: string; localPath?: string; rpcUrl?: string },
  overrides?: { client?: SkillRegistryClient; userSkillsDir?: string },
): Promise<CliStatusCode> {
  const client = overrides?.client ?? createRegistryClient(options.rpcUrl);
  if (!client) {
    context.error({
      status: 'error',
      code: 'RPC_NOT_CONFIGURED',
      message: 'RPC URL is required for registry operations. Use --rpc <url>.',
    });
    return 1;
  }

  try {
    const listing = await client.get(options.skillId);
    const dir = overrides?.userSkillsDir ?? getUserSkillsDir();

    // Determine local file path: explicit --path or auto-detect from skills dir
    const localFile = options.localPath ?? join(dir, `${options.skillId}.md`);
    const hasLocalFile = existsSync(localFile);

    if (!hasLocalFile) {
      context.output({
        status: 'ok',
        command: 'skill.verify',
        schema: 'skill.verify.output.v1',
        skillId: options.skillId,
        onChainHash: listing.contentHash,
        localFile: null,
        verified: null,
        message: 'No local file found. On-chain hash reported.',
      });
      return 0;
    }

    const content = await readFile(localFile);
    const localHash = createHash('sha256').update(content).digest('hex');
    const verified = localHash === listing.contentHash;

    context.output({
      status: 'ok',
      command: 'skill.verify',
      schema: 'skill.verify.output.v1',
      skillId: options.skillId,
      onChainHash: listing.contentHash,
      localHash,
      localFile,
      verified,
    });
    return 0;
  } catch (error) {
    if (error instanceof SkillRegistryNotFoundError) {
      context.error({
        status: 'error',
        code: 'SKILL_NOT_FOUND',
        message: error.message,
      });
      return 1;
    }
    context.error({
      status: 'error',
      code: 'REGISTRY_ERROR',
      message: `Verification failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    return 1;
  }
}

export async function runImportOpenclawCommand(
  context: CliRuntimeContext,
  options: { source: string },
  overrides?: { userSkillsDir?: string },
): Promise<CliStatusCode> {
  const dir = overrides?.userSkillsDir ?? getUserSkillsDir();

  try {
    const result = await importSkill(options.source, dir);

    context.output({
      status: 'ok',
      command: 'skill.import-openclaw',
      schema: 'skill.import-openclaw.output.v1',
      source: options.source,
      filePath: result.path,
      converted: result.converted,
    });
    return 0;
  } catch (error) {
    context.error({
      status: 'error',
      code: 'IMPORT_FAILED',
      message: `Import failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    return 1;
  }
}
