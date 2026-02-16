/**
 * Pure-computation revenue sharing for skill monetization.
 *
 * Splits task reward between skill developer and protocol treasury
 * using basis-point allocation with remainder favoring the developer.
 *
 * @module
 */

import { SkillRevenueError } from './errors.js';
import {
  DEVELOPER_REVENUE_BPS,
  PROTOCOL_REVENUE_BPS,
  REVENUE_BPS_DENOMINATOR,
  type RevenueShareInput,
  type RevenueShareResult,
} from './types.js';

/**
 * Compute the revenue split between developer and protocol.
 *
 * - Default split: 80% developer / 20% protocol
 * - Integer division; remainder goes to developer (favor creator)
 * - Zero reward produces zero shares (no error)
 *
 * @throws {SkillRevenueError} On invalid BPS or negative reward
 */
export function computeRevenueShare(input: RevenueShareInput): RevenueShareResult {
  const developerBps = input.developerBps ?? DEVELOPER_REVENUE_BPS;
  const protocolBps = input.protocolBps ?? PROTOCOL_REVENUE_BPS;

  if (!Number.isInteger(developerBps) || developerBps < 0 || developerBps > REVENUE_BPS_DENOMINATOR) {
    throw new SkillRevenueError(
      input.skillAuthor,
      `developerBps must be an integer between 0 and ${REVENUE_BPS_DENOMINATOR} (received ${developerBps})`,
    );
  }

  if (!Number.isInteger(protocolBps) || protocolBps < 0 || protocolBps > REVENUE_BPS_DENOMINATOR) {
    throw new SkillRevenueError(
      input.skillAuthor,
      `protocolBps must be an integer between 0 and ${REVENUE_BPS_DENOMINATOR} (received ${protocolBps})`,
    );
  }

  if (developerBps + protocolBps !== REVENUE_BPS_DENOMINATOR) {
    throw new SkillRevenueError(
      input.skillAuthor,
      `developerBps + protocolBps must equal ${REVENUE_BPS_DENOMINATOR} (received ${developerBps} + ${protocolBps} = ${developerBps + protocolBps})`,
    );
  }

  if (input.taskRewardLamports < 0n) {
    throw new SkillRevenueError(
      input.skillAuthor,
      'taskRewardLamports must be non-negative',
    );
  }

  if (input.taskRewardLamports === 0n) {
    return {
      taskRewardLamports: 0n,
      developerShare: 0n,
      protocolShare: 0n,
      developerBps,
      protocolBps,
      skillAuthor: input.skillAuthor,
      protocolTreasury: input.protocolTreasury,
    };
  }

  // Protocol share via integer division; remainder goes to developer
  const protocolShare = (input.taskRewardLamports * BigInt(protocolBps)) / BigInt(REVENUE_BPS_DENOMINATOR);
  const developerShare = input.taskRewardLamports - protocolShare;

  return {
    taskRewardLamports: input.taskRewardLamports,
    developerShare,
    protocolShare,
    developerBps,
    protocolBps,
    skillAuthor: input.skillAuthor,
    protocolTreasury: input.protocolTreasury,
  };
}
