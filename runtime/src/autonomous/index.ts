/**
 * Autonomous Agent System
 *
 * Provides self-operating agents that automatically discover, claim,
 * execute, and complete tasks on the AgenC protocol.
 *
 * @module
 */

export { AutonomousAgent } from './agent.js';
export { TaskScanner, type TaskScannerConfig, type TaskEventSubscription, type TaskCreatedCallback } from './scanner.js';
export {
  // Types
  type Task,
  TaskStatus,
  type TaskFilter,
  type ClaimStrategy,
  type AutonomousTaskExecutor,
  type AutonomousAgentConfig,
  type AutonomousAgentStats,
  type DiscoveryMode,
  type SpeculationConfig,
  // Default strategy
  DefaultClaimStrategy,
} from './types.js';
