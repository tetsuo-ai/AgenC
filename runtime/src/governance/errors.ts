/**
 * Governance-specific error classes for @agenc/runtime.
 *
 * @module
 */

import { RuntimeError, RuntimeErrorCodes } from "../types/errors.js";

/**
 * Error thrown when a governance proposal cannot be found by its PDA.
 */
export class GovernanceProposalNotFoundError extends RuntimeError {
  public readonly proposalPda: string;

  constructor(proposalPda: string) {
    super(
      `Governance proposal not found: ${proposalPda}`,
      RuntimeErrorCodes.GOVERNANCE_PROPOSAL_NOT_FOUND,
    );
    this.name = "GovernanceProposalNotFoundError";
    this.proposalPda = proposalPda;
  }
}

/**
 * Error thrown when a governance vote operation fails.
 */
export class GovernanceVoteError extends RuntimeError {
  public readonly proposalPda: string;
  public readonly reason: string;

  constructor(proposalPda: string, reason: string) {
    super(
      `Governance vote failed for ${proposalPda}: ${reason}`,
      RuntimeErrorCodes.GOVERNANCE_VOTE_ERROR,
    );
    this.name = "GovernanceVoteError";
    this.proposalPda = proposalPda;
    this.reason = reason;
  }
}

/**
 * Error thrown when a governance proposal execution fails.
 */
export class GovernanceExecutionError extends RuntimeError {
  public readonly proposalPda: string;
  public readonly reason: string;

  constructor(proposalPda: string, reason: string) {
    super(
      `Governance execution failed for ${proposalPda}: ${reason}`,
      RuntimeErrorCodes.GOVERNANCE_EXECUTION_ERROR,
    );
    this.name = "GovernanceExecutionError";
    this.proposalPda = proposalPda;
    this.reason = reason;
  }
}
