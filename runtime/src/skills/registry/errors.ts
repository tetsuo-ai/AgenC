/**
 * Error types for the on-chain skill registry client.
 *
 * @module
 */

import { RuntimeError, RuntimeErrorCodes } from '../../types/errors.js';

/**
 * Error thrown when a skill cannot be found in the on-chain registry.
 */
export class SkillRegistryNotFoundError extends RuntimeError {
  /** The ID of the skill that was not found */
  public readonly skillId: string;

  constructor(skillId: string) {
    super(
      `Skill not found in registry: "${skillId}"`,
      RuntimeErrorCodes.SKILL_REGISTRY_NOT_FOUND,
    );
    this.name = 'SkillRegistryNotFoundError';
    this.skillId = skillId;
  }
}

/**
 * Error thrown when downloading a skill from the content gateway fails.
 */
export class SkillDownloadError extends RuntimeError {
  /** The ID of the skill that failed to download */
  public readonly skillId: string;
  /** The reason the download failed */
  public readonly reason: string;

  constructor(skillId: string, reason: string) {
    super(
      `Failed to download skill "${skillId}": ${reason}`,
      RuntimeErrorCodes.SKILL_DOWNLOAD_ERROR,
    );
    this.name = 'SkillDownloadError';
    this.skillId = skillId;
    this.reason = reason;
  }
}

/**
 * Error thrown when a skill's content hash does not match the on-chain record.
 */
export class SkillVerificationError extends RuntimeError {
  /** The ID of the skill that failed verification */
  public readonly skillId: string;
  /** The expected content hash from the on-chain record */
  public readonly expectedHash: string;
  /** The actual hash computed from the downloaded content */
  public readonly actualHash: string;

  constructor(skillId: string, expectedHash: string, actualHash: string) {
    super(
      `Skill "${skillId}" content hash mismatch: expected ${expectedHash}, got ${actualHash}`,
      RuntimeErrorCodes.SKILL_VERIFICATION_ERROR,
    );
    this.name = 'SkillVerificationError';
    this.skillId = skillId;
    this.expectedHash = expectedHash;
    this.actualHash = actualHash;
  }
}

/**
 * Error thrown when publishing a skill to the registry fails.
 */
export class SkillPublishError extends RuntimeError {
  /** The path of the skill file that failed to publish */
  public readonly skillPath: string;
  /** The reason the publish failed */
  public readonly reason: string;

  constructor(skillPath: string, reason: string) {
    super(
      `Failed to publish skill "${skillPath}": ${reason}`,
      RuntimeErrorCodes.SKILL_PUBLISH_ERROR,
    );
    this.name = 'SkillPublishError';
    this.skillPath = skillPath;
    this.reason = reason;
  }
}

/**
 * Error thrown when purchasing a skill from the registry fails.
 */
export class SkillPurchaseError extends RuntimeError {
  /** The ID of the skill that failed to purchase */
  public readonly skillId: string;
  /** The reason the purchase failed */
  public readonly reason: string;

  constructor(skillId: string, reason: string) {
    super(
      `Failed to purchase skill "${skillId}": ${reason}`,
      RuntimeErrorCodes.SKILL_PURCHASE_ERROR,
    );
    this.name = 'SkillPurchaseError';
    this.skillId = skillId;
    this.reason = reason;
  }
}
