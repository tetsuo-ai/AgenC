/**
 * Append-only audit trail with deterministic SHA-256 hash chaining.
 *
 * @module
 */

import { createHash } from "node:crypto";
import { stableStringifyJson, type JsonValue } from "../eval/types.js";
import type {
  IncidentCommandCategory,
  OperatorRole,
} from "./incident-roles.js";

/** Single entry in the append-only audit trail. */
export interface AuditTrailEntry {
  /** Monotonic sequence number. */
  seq: number;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Operator identity (pubkey or username). */
  actor: string;
  /** Operator role at time of action. */
  role: OperatorRole;
  /** Action performed (command category). */
  action: IncidentCommandCategory;
  /** SHA-256 of the action input parameters. */
  inputHash: string;
  /** SHA-256 of the action output. */
  outputHash: string;
  /** SHA-256 of the previous entry (empty string for first entry). */
  prevEntryHash: string;
  /** SHA-256 of this entry (computed from all fields above). */
  entryHash: string;
}

/** Persistence interface for audit trail. */
export interface AuditTrailStore {
  append(
    entry: Omit<AuditTrailEntry, "seq" | "entryHash" | "prevEntryHash">,
  ): AuditTrailEntry;
  getAll(): ReadonlyArray<AuditTrailEntry>;
  getLast(): AuditTrailEntry | null;
  verify(): AuditTrailVerification;
  clear(): void;
}

export interface AuditTrailVerification {
  valid: boolean;
  entries: number;
  brokenAt?: number; // seq of first broken link
  message?: string;
}

function computeEntryHash(entry: Omit<AuditTrailEntry, "entryHash">): string {
  const canonical = stableStringifyJson({
    seq: entry.seq,
    timestamp: entry.timestamp,
    actor: entry.actor,
    role: entry.role,
    action: entry.action,
    inputHash: entry.inputHash,
    outputHash: entry.outputHash,
    prevEntryHash: entry.prevEntryHash,
  } as unknown as JsonValue);

  return createHash("sha256").update(canonical).digest("hex");
}

export class InMemoryAuditTrail implements AuditTrailStore {
  private entries: AuditTrailEntry[] = [];

  append(
    input: Omit<AuditTrailEntry, "seq" | "entryHash" | "prevEntryHash">,
  ): AuditTrailEntry {
    const seq = this.entries.length + 1;
    const prevEntry = this.entries[this.entries.length - 1];
    const prevEntryHash = prevEntry?.entryHash ?? "";

    const entry: Omit<AuditTrailEntry, "entryHash"> = {
      seq,
      timestamp: input.timestamp,
      actor: input.actor,
      role: input.role,
      action: input.action,
      inputHash: input.inputHash,
      outputHash: input.outputHash,
      prevEntryHash,
    };

    const entryHash = computeEntryHash(entry);
    const resolved: AuditTrailEntry = {
      ...entry,
      entryHash,
    };

    this.entries.push(resolved);
    return resolved;
  }

  getAll(): ReadonlyArray<AuditTrailEntry> {
    return this.entries;
  }

  getLast(): AuditTrailEntry | null {
    return this.entries.length === 0
      ? null
      : (this.entries[this.entries.length - 1] ?? null);
  }

  verify(): AuditTrailVerification {
    if (this.entries.length === 0) {
      return { valid: true, entries: 0 };
    }

    for (let index = 0; index < this.entries.length; index += 1) {
      const entry = this.entries[index]!;

      const expectedPrev =
        index === 0 ? "" : this.entries[index - 1]!.entryHash;
      if (entry.prevEntryHash !== expectedPrev) {
        return {
          valid: false,
          entries: this.entries.length,
          brokenAt: entry.seq,
          message: "chain link broken",
        };
      }

      const recomputed = computeEntryHash({
        seq: entry.seq,
        timestamp: entry.timestamp,
        actor: entry.actor,
        role: entry.role,
        action: entry.action,
        inputHash: entry.inputHash,
        outputHash: entry.outputHash,
        prevEntryHash: entry.prevEntryHash,
      });
      if (entry.entryHash !== recomputed) {
        return {
          valid: false,
          entries: this.entries.length,
          brokenAt: entry.seq,
          message: "entry hash mismatch",
        };
      }
    }

    return { valid: true, entries: this.entries.length };
  }

  clear(): void {
    this.entries = [];
  }
}

export function computeInputHash(input: unknown): string {
  return createHash("sha256")
    .update(stableStringifyJson(input as JsonValue))
    .digest("hex");
}

export function computeOutputHash(output: unknown): string {
  return createHash("sha256")
    .update(stableStringifyJson(output as JsonValue))
    .digest("hex");
}
