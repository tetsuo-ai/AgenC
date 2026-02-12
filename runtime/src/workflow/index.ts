/**
 * Workflow DAG Orchestrator module.
 *
 * Provides multi-step task workflow submission and monitoring on the AgenC
 * protocol. Workflows are tree-structured (single parent per task) to match
 * the on-chain `depends_on: Option<Pubkey>` constraint.
 *
 * @module
 */

// Types
export {
  OnChainDependencyType,
  WorkflowNodeStatus,
  WorkflowStatus,
  type TaskTemplate,
  type WorkflowEdge,
  type WorkflowDefinition,
  type WorkflowConfig,
  type WorkflowNode,
  type WorkflowState,
  type WorkflowStats,
  type WorkflowCallbacks,
  type DAGOrchestratorConfig,
} from './types.js';

// Errors
export {
  WorkflowValidationError,
  WorkflowSubmissionError,
  WorkflowMonitoringError,
  WorkflowStateError,
} from './errors.js';

// Validation
export { validateWorkflow, topologicalSort } from './validation.js';

// Goal compiler
export {
  GoalCompiler,
  estimateWorkflow,
  type GoalPlannerInput,
  type PlannerTaskDraft,
  type PlannerWorkflowDraft,
  type GoalPlanner,
  type GoalCompileRequest,
  type GoalCompileWarning,
  type WorkflowDryRunEstimate,
  type GoalCompileResult,
  type GoalCompilerDefaults,
  type GoalCompilerConfig,
} from './compiler.js';

// Submitter
export { DAGSubmitter } from './submitter.js';

// Monitor
export { DAGMonitor } from './monitor.js';

// Orchestrator
export { DAGOrchestrator } from './orchestrator.js';
