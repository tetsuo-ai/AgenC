/**
 * Team contract error types.
 *
 * @module
 */

import { RuntimeError, RuntimeErrorCodes } from '../types/errors.js';

export class TeamContractValidationError extends RuntimeError {
  constructor(message: string) {
    super(message, RuntimeErrorCodes.TEAM_CONTRACT_VALIDATION_ERROR);
    this.name = 'TeamContractValidationError';
  }
}

export class TeamContractStateError extends RuntimeError {
  constructor(message: string) {
    super(message, RuntimeErrorCodes.TEAM_CONTRACT_STATE_ERROR);
    this.name = 'TeamContractStateError';
  }
}

export class TeamPayoutError extends RuntimeError {
  constructor(message: string) {
    super(message, RuntimeErrorCodes.TEAM_PAYOUT_ERROR);
    this.name = 'TeamPayoutError';
  }
}

export class TeamWorkflowTopologyError extends RuntimeError {
  constructor(message: string) {
    super(message, RuntimeErrorCodes.TEAM_WORKFLOW_TOPOLOGY_ERROR);
    this.name = 'TeamWorkflowTopologyError';
  }
}
