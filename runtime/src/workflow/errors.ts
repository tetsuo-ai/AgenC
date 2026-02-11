/**
 * Workflow DAG Orchestrator — Error Classes
 *
 * @module
 */

import { RuntimeError, RuntimeErrorCodes } from '../types/errors.js';

/**
 * Thrown when workflow definition fails validation.
 * Covers: cycles, multi-parent nodes, dangling edges, duplicate names, empty graph.
 */
export class WorkflowValidationError extends RuntimeError {
  constructor(message: string) {
    super(message, RuntimeErrorCodes.WORKFLOW_VALIDATION_ERROR);
    this.name = 'WorkflowValidationError';
  }
}

/**
 * Thrown when on-chain task creation fails during workflow submission.
 */
export class WorkflowSubmissionError extends RuntimeError {
  /** The workflow node name that failed submission */
  public readonly nodeName: string;

  constructor(nodeName: string, message: string) {
    super(`Submission failed for node "${nodeName}": ${message}`, RuntimeErrorCodes.WORKFLOW_SUBMISSION_ERROR);
    this.name = 'WorkflowSubmissionError';
    this.nodeName = nodeName;
  }
}

/**
 * Thrown when event subscription or polling fails during monitoring.
 */
export class WorkflowMonitoringError extends RuntimeError {
  constructor(message: string) {
    super(message, RuntimeErrorCodes.WORKFLOW_MONITORING_ERROR);
    this.name = 'WorkflowMonitoringError';
  }
}

/**
 * Thrown for invalid state transitions or missing workflow state.
 */
export class WorkflowStateError extends RuntimeError {
  constructor(message: string) {
    super(message, RuntimeErrorCodes.WORKFLOW_STATE_ERROR);
    this.name = 'WorkflowStateError';
  }
}
