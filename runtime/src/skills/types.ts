/**
 * Core skill system types for @agenc/runtime
 *
 * Provides the foundational interfaces for the skill library system,
 * including skill lifecycle, actions, metadata, and registry configuration.
 *
 * @module
 */

import type { Connection } from "@solana/web3.js";
import type { Logger } from "../utils/logger.js";
import type { Wallet } from "../types/wallet.js";

/**
 * Semantic version string in major.minor.patch format
 */
export type SemanticVersion = `${number}.${number}.${number}`;

/**
 * Lifecycle state of a skill
 */
export enum SkillState {
  /** Skill created but not initialized */
  Created = 0,
  /** Skill is currently initializing */
  Initializing = 1,
  /** Skill is ready for use */
  Ready = 2,
  /** Skill is shutting down */
  ShuttingDown = 3,
  /** Skill has been shut down */
  Stopped = 4,
  /** Skill encountered an error */
  Error = 5,
}

/**
 * Context provided to skills during initialization.
 *
 * Contains the shared resources a skill needs to interact
 * with the Solana network.
 */
export interface SkillContext {
  /** Solana RPC connection */
  readonly connection: Connection;
  /** Wallet for signing transactions */
  readonly wallet: Wallet;
  /** Logger instance */
  readonly logger: Logger;
}

/**
 * Metadata describing a skill's identity and requirements.
 */
export interface SkillMetadata {
  /** Unique skill name (lowercase, kebab-case) */
  readonly name: string;
  /** Human-readable description */
  readonly description: string;
  /** Semantic version */
  readonly version: SemanticVersion;
  /** Required capability bitmask (maps to AgentCapabilities) */
  readonly requiredCapabilities: bigint;
  /** Optional tags for categorization */
  readonly tags?: readonly string[];
}

/**
 * Typed descriptor for a skill action.
 *
 * Each skill exposes a set of actions that can be invoked
 * programmatically or through the action registry.
 */
export interface SkillAction<TParams = unknown, TResult = unknown> {
  /** Action name */
  readonly name: string;
  /** Human-readable description */
  readonly description: string;
  /** Execute the action with typed parameters */
  execute(params: TParams): Promise<TResult>;
}

/**
 * Core Skill interface. All skills must implement this.
 *
 * Skills follow a lifecycle:
 * Created -> Initializing -> Ready -> ShuttingDown -> Stopped
 *
 * If initialization or operation fails, the skill enters the Error state.
 */
export interface Skill {
  /** Skill metadata */
  readonly metadata: SkillMetadata;

  /** Current lifecycle state */
  readonly state: SkillState;

  /**
   * Initialize the skill with runtime context.
   * Called once before any actions are invoked.
   */
  initialize(context: SkillContext): Promise<void>;

  /**
   * Graceful shutdown. Release resources.
   */
  shutdown(): Promise<void>;

  /**
   * List all actions this skill provides.
   * Available after initialization.
   */
  getActions(): ReadonlyArray<SkillAction>;

  /**
   * Get a specific action by name.
   * @returns The action, or undefined if not found
   */
  getAction(name: string): SkillAction | undefined;
}

/**
 * Configuration for SkillRegistry
 */
export interface SkillRegistryConfig {
  /** Logger for registry operations */
  logger?: Logger;
}
