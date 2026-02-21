/**
 * Error types for skill monetization.
 *
 * @module
 */

import { RuntimeError, RuntimeErrorCodes } from "../../types/errors.js";

/**
 * Error thrown when a skill subscription operation fails.
 */
export class SkillSubscriptionError extends RuntimeError {
  public readonly skillId: string;
  public readonly reason: string;

  constructor(skillId: string, reason: string) {
    super(
      `Skill subscription error for "${skillId}": ${reason}`,
      RuntimeErrorCodes.SKILL_SUBSCRIPTION_ERROR,
    );
    this.name = "SkillSubscriptionError";
    this.skillId = skillId;
    this.reason = reason;
  }
}

/**
 * Error thrown when a revenue share computation fails.
 */
export class SkillRevenueError extends RuntimeError {
  public readonly skillId: string;
  public readonly reason: string;

  constructor(skillId: string, reason: string) {
    super(
      `Skill revenue error for "${skillId}": ${reason}`,
      RuntimeErrorCodes.SKILL_REVENUE_ERROR,
    );
    this.name = "SkillRevenueError";
    this.skillId = skillId;
    this.reason = reason;
  }
}
