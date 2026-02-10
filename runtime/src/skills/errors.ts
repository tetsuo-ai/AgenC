/**
 * Skill-specific error types for @agenc/runtime
 *
 * @module
 */

import { RuntimeError, RuntimeErrorCodes } from '../types/errors.js';

/**
 * Error thrown when a skill cannot be found by name.
 */
export class SkillNotFoundError extends RuntimeError {
  /** The name of the skill that was not found */
  public readonly skillName: string;

  constructor(skillName: string) {
    super(`Skill not found: "${skillName}"`, RuntimeErrorCodes.VALIDATION_ERROR);
    this.name = 'SkillNotFoundError';
    this.skillName = skillName;
  }
}

/**
 * Error thrown when attempting to use a skill that is not in Ready state.
 */
export class SkillNotReadyError extends RuntimeError {
  /** The name of the skill that is not ready */
  public readonly skillName: string;

  constructor(skillName: string) {
    super(
      `Skill "${skillName}" is not ready. Call initialize() first.`,
      RuntimeErrorCodes.EXECUTOR_STATE_ERROR,
    );
    this.name = 'SkillNotReadyError';
    this.skillName = skillName;
  }
}

/**
 * Error thrown when a skill action cannot be found by name.
 */
export class SkillActionNotFoundError extends RuntimeError {
  /** The name of the skill */
  public readonly skillName: string;
  /** The name of the action that was not found */
  public readonly actionName: string;

  constructor(skillName: string, actionName: string) {
    super(
      `Action "${actionName}" not found on skill "${skillName}"`,
      RuntimeErrorCodes.VALIDATION_ERROR,
    );
    this.name = 'SkillActionNotFoundError';
    this.skillName = skillName;
    this.actionName = actionName;
  }
}

/**
 * Error thrown when skill initialization fails.
 */
export class SkillInitializationError extends RuntimeError {
  /** The name of the skill that failed to initialize */
  public readonly skillName: string;

  constructor(skillName: string, cause: string) {
    super(
      `Failed to initialize skill "${skillName}": ${cause}`,
      RuntimeErrorCodes.EXECUTOR_STATE_ERROR,
    );
    this.name = 'SkillInitializationError';
    this.skillName = skillName;
  }
}

/**
 * Error thrown when a skill with the same name is already registered.
 */
export class SkillAlreadyRegisteredError extends RuntimeError {
  /** The name of the duplicate skill */
  public readonly skillName: string;

  constructor(skillName: string) {
    super(
      `Skill "${skillName}" is already registered`,
      RuntimeErrorCodes.VALIDATION_ERROR,
    );
    this.name = 'SkillAlreadyRegisteredError';
    this.skillName = skillName;
  }
}
