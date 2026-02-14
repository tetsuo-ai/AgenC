/**
 * Immutable Audit Trail - Append-only, hash-chained audit log.
 *
 * Implements #993 P2-504: Role-aware incident workflow + immutable audit trail
 *
 * @module
 */

import { createHash } from 'crypto';
import type { OperatorRole, IncidentPermission } from './incident-roles.js';

/**
 * Audit entry representing a single action.
 */
export interface AuditEntry {
  /** Monotonic sequence number */
  seq: number;
  /** ISO-8601 timestamp */
  timestamp: string;
  /** Actor identity (public key or user ID) */
  actor: string;
  /** Actor's role at time of action */
  role: OperatorRole;
  /** Action performed */
  action: string;
  /** Permission used */
  permission: IncidentPermission;
  /** SHA-256 hash of input data */
  inputHash: string;
  /** SHA-256 hash of output data */
  outputHash: string;
  /** Hash of previous entry (for chain integrity) */
  prevHash: string;
  /** Hash of this entry */
  entryHash: string;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Audit trail store interface.
 */
export interface AuditTrailStore {
  /** Append a new entry */
  append(entry: Omit<AuditEntry, 'seq' | 'prevHash' | 'entryHash'>): AuditEntry;
  /** Get entry by sequence number */
  get(seq: number): AuditEntry | undefined;
  /** Get all entries */
  getAll(): AuditEntry[];
  /** Get entries in range */
  getRange(startSeq: number, endSeq: number): AuditEntry[];
  /** Get latest entry */
  getLatest(): AuditEntry | undefined;
  /** Verify chain integrity */
  verify(): AuditVerificationResult;
  /** Get entry count */
  count(): number;
}

/**
 * Audit verification result.
 */
export interface AuditVerificationResult {
  valid: boolean;
  errors: AuditVerificationError[];
  entriesVerified: number;
}

/**
 * Audit verification error.
 */
export interface AuditVerificationError {
  seq: number;
  type: 'hash_mismatch' | 'chain_break' | 'sequence_gap';
  expected: string;
  actual: string;
  message: string;
}

/**
 * Compute SHA-256 hash of a string.
 */
function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Compute entry hash from entry fields.
 */
function computeEntryHash(entry: Omit<AuditEntry, 'entryHash'>): string {
  const canonical = {
    seq: entry.seq,
    timestamp: entry.timestamp,
    actor: entry.actor,
    role: entry.role,
    action: entry.action,
    permission: entry.permission,
    inputHash: entry.inputHash,
    outputHash: entry.outputHash,
    prevHash: entry.prevHash,
    metadata: entry.metadata,
  };
  return sha256(JSON.stringify(canonical));
}

/**
 * Genesis hash for the first entry.
 */
export const GENESIS_HASH = sha256('agenc-audit-trail-genesis');

/**
 * In-memory audit trail store implementation.
 */
export class InMemoryAuditTrail implements AuditTrailStore {
  private entries: AuditEntry[] = [];

  append(input: Omit<AuditEntry, 'seq' | 'prevHash' | 'entryHash'>): AuditEntry {
    const seq = this.entries.length + 1;
    const prevHash = this.entries.length > 0
      ? this.entries[this.entries.length - 1].entryHash
      : GENESIS_HASH;

    const entryWithoutHash: Omit<AuditEntry, 'entryHash'> = {
      ...input,
      seq,
      prevHash,
    };

    const entry: AuditEntry = {
      ...entryWithoutHash,
      entryHash: computeEntryHash(entryWithoutHash),
    };

    this.entries.push(entry);
    return entry;
  }

  get(seq: number): AuditEntry | undefined {
    return this.entries.find((e) => e.seq === seq);
  }

  getAll(): AuditEntry[] {
    return [...this.entries];
  }

  getRange(startSeq: number, endSeq: number): AuditEntry[] {
    return this.entries.filter((e) => e.seq >= startSeq && e.seq <= endSeq);
  }

  getLatest(): AuditEntry | undefined {
    return this.entries.length > 0 ? this.entries[this.entries.length - 1] : undefined;
  }

  verify(): AuditVerificationResult {
    const errors: AuditVerificationError[] = [];

    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      const expectedSeq = i + 1;

      // Check sequence continuity
      if (entry.seq !== expectedSeq) {
        errors.push({
          seq: entry.seq,
          type: 'sequence_gap',
          expected: String(expectedSeq),
          actual: String(entry.seq),
          message: `Sequence gap: expected ${expectedSeq}, got ${entry.seq}`,
        });
      }

      // Check prev hash chain
      const expectedPrevHash = i === 0 ? GENESIS_HASH : this.entries[i - 1].entryHash;
      if (entry.prevHash !== expectedPrevHash) {
        errors.push({
          seq: entry.seq,
          type: 'chain_break',
          expected: expectedPrevHash,
          actual: entry.prevHash,
          message: `Chain break at seq ${entry.seq}: prevHash mismatch`,
        });
      }

      // Verify entry hash
      const entryWithoutHash: Omit<AuditEntry, 'entryHash'> = {
        seq: entry.seq,
        timestamp: entry.timestamp,
        actor: entry.actor,
        role: entry.role,
        action: entry.action,
        permission: entry.permission,
        inputHash: entry.inputHash,
        outputHash: entry.outputHash,
        prevHash: entry.prevHash,
        metadata: entry.metadata,
      };
      const computedHash = computeEntryHash(entryWithoutHash);
      if (entry.entryHash !== computedHash) {
        errors.push({
          seq: entry.seq,
          type: 'hash_mismatch',
          expected: computedHash,
          actual: entry.entryHash,
          message: `Hash mismatch at seq ${entry.seq}: entry has been tampered`,
        });
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      entriesVerified: this.entries.length,
    };
  }

  count(): number {
    return this.entries.length;
  }
}

/**
 * Create an audit entry for an action.
 */
export function createAuditInput(
  actor: string,
  role: OperatorRole,
  action: string,
  permission: IncidentPermission,
  inputData: unknown,
  outputData: unknown,
  metadata?: Record<string, unknown>,
): Omit<AuditEntry, 'seq' | 'prevHash' | 'entryHash'> {
  return {
    timestamp: new Date().toISOString(),
    actor,
    role,
    action,
    permission,
    inputHash: sha256(JSON.stringify(inputData)),
    outputHash: sha256(JSON.stringify(outputData)),
    metadata,
  };
}

/**
 * Helper to compute hash of arbitrary data for audit logging.
 */
export function computeAuditHash(data: unknown): string {
  return sha256(JSON.stringify(data));
}

/**
 * Serialize audit trail to JSON.
 */
export function serializeAuditTrail(store: AuditTrailStore): string {
  return JSON.stringify(store.getAll(), null, 2);
}

/**
 * Load audit trail from JSON.
 */
export function loadAuditTrail(json: string): InMemoryAuditTrail {
  const trail = new InMemoryAuditTrail();
  const entries = JSON.parse(json) as AuditEntry[];

  // Rebuild the trail entry by entry to verify integrity
  for (const entry of entries) {
    const input: Omit<AuditEntry, 'seq' | 'prevHash' | 'entryHash'> = {
      timestamp: entry.timestamp,
      actor: entry.actor,
      role: entry.role,
      action: entry.action,
      permission: entry.permission,
      inputHash: entry.inputHash,
      outputHash: entry.outputHash,
      metadata: entry.metadata,
    };
    trail.append(input);
  }

  return trail;
}
