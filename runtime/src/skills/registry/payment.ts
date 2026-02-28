/**
 * Skill purchase manager — wraps the on-chain purchase_skill instruction.
 *
 * Handles SOL and SPL token payment splitting, purchase record tracking,
 * and content download after successful purchase.
 *
 * @module
 */

import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";
import type { Program } from "@coral-xyz/anchor";

const { BN } = anchor;
import type { AgencCoordination } from "../../types/agenc_coordination.js";
import type { Logger } from "../../utils/logger.js";
import { silentLogger } from "../../utils/logger.js";
import { findAgentPda, findProtocolPda } from "../../agent/pda.js";
import { fetchTreasury } from "../../utils/treasury.js";
import { isAnchorError, AnchorErrorCodes } from "../../types/errors.js";
import { SkillPurchaseError } from "./errors.js";
import type { SkillRegistryClient } from "./types.js";

// ============================================================================
// Types
// ============================================================================

export interface SkillPurchaseConfig {
  readonly program: Program<AgencCoordination>;
  readonly agentId: Uint8Array;
  readonly registryClient: SkillRegistryClient;
  readonly logger?: Logger;
}

export interface PurchaseResult {
  readonly skillId: string;
  readonly paid: boolean;
  readonly pricePaid: bigint;
  readonly protocolFee: bigint;
  readonly transactionSignature?: string;
  readonly contentPath: string;
}

export interface OnChainPurchaseRecord {
  readonly skill: PublicKey;
  readonly buyer: PublicKey;
  readonly pricePaid: bigint;
  readonly timestamp: number;
  readonly bump: number;
}

// ============================================================================
// Helpers
// ============================================================================

/** Buyer field offset: 8 (discriminator) + 32 (skill pubkey) = 40 */
const PURCHASE_RECORD_BUYER_OFFSET = 40;

function parseOnChainPurchaseRecord(
  raw: Record<string, any>,
): OnChainPurchaseRecord {
  return {
    skill: raw.skill as PublicKey,
    buyer: raw.buyer as PublicKey,
    pricePaid: BigInt(raw.pricePaid.toString()),
    timestamp:
      typeof raw.timestamp === "number"
        ? raw.timestamp
        : raw.timestamp.toNumber(),
    bump: raw.bump,
  };
}

// ============================================================================
// SkillPurchaseManager
// ============================================================================

export class SkillPurchaseManager {
  private readonly program: Program<AgencCoordination>;
  private readonly registryClient: SkillRegistryClient;
  private readonly logger: Logger;
  private readonly buyerAgentPda: PublicKey;
  private readonly protocolPda: PublicKey;
  private cachedTreasury: PublicKey | null = null;

  constructor(config: SkillPurchaseConfig) {
    this.program = config.program;
    this.registryClient = config.registryClient;
    this.logger = config.logger ?? silentLogger;
    this.buyerAgentPda = findAgentPda(config.agentId, config.program.programId);
    this.protocolPda = findProtocolPda(config.program.programId);
  }

  /**
   * Purchase a skill and download its content.
   *
   * If the skill has already been purchased, skips the on-chain transaction
   * and re-downloads the content.
   */
  async purchase(
    skillPda: PublicKey,
    skillId: string,
    targetPath: string,
  ): Promise<PurchaseResult> {
    // Check if already purchased — skip tx, just re-download
    if (await this.isPurchased(skillPda)) {
      this.logger.info(`Skill "${skillId}" already purchased, re-downloading`);
      let contentPath = targetPath;
      try {
        await this.registryClient.install(skillId, targetPath);
      } catch {
        contentPath = "";
      }
      return {
        skillId,
        paid: false,
        pricePaid: 0n,
        protocolFee: 0n,
        contentPath,
      };
    }

    // Fetch on-chain accounts needed for the instruction
    const skill = await this.program.account.skillRegistration.fetch(skillPda);
    const authorAgent = await this.program.account.agentRegistration.fetch(
      skill.author as PublicKey,
    );
    const treasury = await this.getTreasury();
    const protocolConfig = await this.program.account.protocolConfig.fetch(
      this.protocolPda,
    );
    const feeBps = BigInt(protocolConfig.protocolFeeBps.toString());
    const price = BigInt(skill.price.toString());

    // Derive purchase record PDA
    const authorWallet = authorAgent.authority as PublicKey;
    const priceMint = skill.priceMint as PublicKey | null;

    // Build optional SPL token accounts
    const tokenAccounts = this.buildTokenAccounts(
      priceMint,
      authorWallet,
      treasury,
    );

    try {
      const sig = await this.program.methods
        .purchaseSkill(new BN(price.toString()))
        .accountsPartial({
          skill: skillPda,
          buyer: this.buyerAgentPda,
          authorAgent: skill.author,
          authorWallet,
          protocolConfig: this.protocolPda,
          treasury,
          authority: this.program.provider.publicKey!,
          systemProgram: SystemProgram.programId,
          priceMint: tokenAccounts.priceMint,
          buyerTokenAccount: tokenAccounts.buyerTokenAccount,
          authorTokenAccount: tokenAccounts.authorTokenAccount,
          treasuryTokenAccount: tokenAccounts.treasuryTokenAccount,
          tokenProgram: tokenAccounts.tokenProgram,
        })
        .rpc();

      const protocolFee = price > 0n ? (price * feeBps) / 10000n : 0n;

      // Download content after successful purchase
      let contentPath = targetPath;
      try {
        await this.registryClient.install(skillId, targetPath);
      } catch (err) {
        this.logger.warn(
          `Purchase tx succeeded but content download failed for "${skillId}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        contentPath = "";
      }

      return {
        skillId,
        paid: price > 0n,
        pricePaid: price,
        protocolFee,
        transactionSignature: sig,
        contentPath,
      };
    } catch (err) {
      throw this.mapPurchaseError(err, skillId);
    }
  }

  /**
   * Check if the current agent has already purchased a skill.
   */
  async isPurchased(skillPda: PublicKey): Promise<boolean> {
    const record = await this.fetchPurchaseRecord(skillPda);
    return record !== null;
  }

  /**
   * Fetch the purchase record for a skill, or null if not purchased.
   */
  async fetchPurchaseRecord(
    skillPda: PublicKey,
  ): Promise<OnChainPurchaseRecord | null> {
    const [purchaseRecordPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("skill_purchase"),
        skillPda.toBuffer(),
        this.buyerAgentPda.toBuffer(),
      ],
      this.program.programId,
    );
    const raw =
      await this.program.account.purchaseRecord.fetchNullable(
        purchaseRecordPda,
      );
    if (!raw) return null;
    return parseOnChainPurchaseRecord(raw as Record<string, any>);
  }

  /**
   * Get all purchase records for the current agent, sorted by timestamp desc.
   */
  async getPurchaseHistory(): Promise<readonly OnChainPurchaseRecord[]> {
    const accounts = await this.program.account.purchaseRecord.all([
      {
        memcmp: {
          offset: PURCHASE_RECORD_BUYER_OFFSET,
          bytes: this.buyerAgentPda.toBase58(),
        },
      },
    ]);

    const records = accounts.map((a) =>
      parseOnChainPurchaseRecord(a.account as unknown as Record<string, any>),
    );

    // Sort by timestamp descending
    records.sort((a, b) => b.timestamp - a.timestamp);
    return records;
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private async getTreasury(): Promise<PublicKey> {
    if (!this.cachedTreasury) {
      this.cachedTreasury = await fetchTreasury(
        this.program,
        this.program.programId,
      );
    }
    return this.cachedTreasury;
  }

  private buildTokenAccounts(
    priceMint: PublicKey | null,
    authorWallet: PublicKey,
    treasury: PublicKey,
  ): Record<string, PublicKey | null> {
    if (!priceMint) {
      return {
        priceMint: null,
        buyerTokenAccount: null,
        authorTokenAccount: null,
        treasuryTokenAccount: null,
        tokenProgram: null,
      };
    }
    return {
      priceMint,
      buyerTokenAccount: getAssociatedTokenAddressSync(
        priceMint,
        this.program.provider.publicKey!,
      ),
      authorTokenAccount: getAssociatedTokenAddressSync(
        priceMint,
        authorWallet,
      ),
      treasuryTokenAccount: getAssociatedTokenAddressSync(priceMint, treasury),
      tokenProgram: TOKEN_PROGRAM_ID,
    };
  }

  private mapPurchaseError(err: unknown, skillId: string): Error {
    if (isAnchorError(err, AnchorErrorCodes.SkillNotActive)) {
      return new SkillPurchaseError(skillId, "Skill is not active");
    }
    if (isAnchorError(err, AnchorErrorCodes.SkillSelfPurchase)) {
      return new SkillPurchaseError(skillId, "Cannot purchase own skill");
    }
    if (isAnchorError(err, AnchorErrorCodes.AgentNotActive)) {
      return new SkillPurchaseError(skillId, "Buyer agent is not active");
    }
    if (isAnchorError(err, AnchorErrorCodes.InsufficientFunds)) {
      return new SkillPurchaseError(skillId, "Insufficient balance");
    }
    if (isAnchorError(err, AnchorErrorCodes.MissingTokenAccounts)) {
      return new SkillPurchaseError(
        skillId,
        "Missing token accounts for SPL payment",
      );
    }
    if (isAnchorError(err, AnchorErrorCodes.InvalidTokenMint)) {
      return new SkillPurchaseError(skillId, "Token mint mismatch");
    }
    // Re-throw unmapped errors
    if (err instanceof Error) return err;
    return new Error(String(err));
  }
}
