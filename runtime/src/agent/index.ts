/**
 * Agent module exports
 */

export { AgentManager, type AgentManagerConfig, type AgentRegistrationConfig } from './manager';

// Re-export legacy Agent from parent for backwards compatibility
export { Agent } from '../agent';
