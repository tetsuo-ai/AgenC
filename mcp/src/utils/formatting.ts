/**
 * Output Formatting Helpers
 *
 * Standardized formatting for MCP tool outputs.
 */

import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';

/**
 * Format lamports as a human-readable SOL string.
 */
export function formatSol(lamports: number | bigint): string {
  const n = typeof lamports === 'bigint' ? Number(lamports) : lamports;
  return `${(n / LAMPORTS_PER_SOL).toFixed(9)} SOL`;
}

/**
 * Format a Unix timestamp as ISO string.
 */
export function formatTimestamp(ts: number): string {
  if (ts === 0) return 'Not set';
  return new Date(ts * 1000).toISOString();
}

/**
 * Format a public key with optional truncation.
 */
export function formatPubkey(pubkey: PublicKey | string, truncate = false): string {
  const s = typeof pubkey === 'string' ? pubkey : pubkey.toBase58();
  if (truncate && s.length > 12) {
    return `${s.slice(0, 6)}...${s.slice(-6)}`;
  }
  return s;
}

/**
 * Format a byte array as hex string.
 */
export function formatBytes(bytes: number[] | Uint8Array | Buffer | null): string {
  if (!bytes) return 'null';
  return Buffer.from(bytes).toString('hex');
}

/**
 * Format an account status enum value.
 */
export function formatStatus(status: number | Record<string, unknown>): string {
  // Anchor returns enums as objects like { active: {} }
  if (typeof status === 'object' && status !== null) {
    const keys = Object.keys(status);
    if (keys.length > 0) {
      return keys[0].charAt(0).toUpperCase() + keys[0].slice(1);
    }
  }

  const statusNames: Record<number, string> = {
    0: 'Inactive',
    1: 'Active',
    2: 'Busy',
    3: 'Suspended',
  };
  return statusNames[status as number] ?? `Unknown(${status})`;
}

/**
 * Format a task status enum value.
 */
export function formatTaskStatus(status: number | Record<string, unknown>): string {
  if (typeof status === 'object' && status !== null) {
    const keys = Object.keys(status);
    if (keys.length > 0) {
      const key = keys[0];
      const names: Record<string, string> = {
        open: 'Open',
        inProgress: 'In Progress',
        pendingValidation: 'Pending Validation',
        completed: 'Completed',
        cancelled: 'Cancelled',
        disputed: 'Disputed',
      };
      return names[key] ?? key;
    }
  }

  const statusNames: Record<number, string> = {
    0: 'Open',
    1: 'In Progress',
    2: 'Pending Validation',
    3: 'Completed',
    4: 'Cancelled',
    5: 'Disputed',
  };
  return statusNames[status as number] ?? `Unknown(${status})`;
}

/**
 * Format a dispute status enum value.
 */
export function formatDisputeStatus(status: number | Record<string, unknown>): string {
  if (typeof status === 'object' && status !== null) {
    const keys = Object.keys(status);
    if (keys.length > 0) {
      return keys[0].charAt(0).toUpperCase() + keys[0].slice(1);
    }
  }

  const statusNames: Record<number, string> = {
    0: 'Active',
    1: 'Resolved',
    2: 'Expired',
  };
  return statusNames[status as number] ?? `Unknown(${status})`;
}

/**
 * Format a task type enum value.
 */
export function formatTaskType(taskType: number | Record<string, unknown>): string {
  if (typeof taskType === 'object' && taskType !== null) {
    const keys = Object.keys(taskType);
    if (keys.length > 0) {
      return keys[0].charAt(0).toUpperCase() + keys[0].slice(1);
    }
  }

  const typeNames: Record<number, string> = {
    0: 'Exclusive',
    1: 'Collaborative',
    2: 'Competitive',
  };
  return typeNames[taskType as number] ?? `Unknown(${taskType})`;
}

/**
 * Format a resolution type enum value.
 */
export function formatResolutionType(rt: number | Record<string, unknown>): string {
  if (typeof rt === 'object' && rt !== null) {
    const keys = Object.keys(rt);
    if (keys.length > 0) {
      return keys[0].charAt(0).toUpperCase() + keys[0].slice(1);
    }
  }

  const names: Record<number, string> = {
    0: 'Refund',
    1: 'Complete',
    2: 'Split',
  };
  return names[rt as number] ?? `Unknown(${rt})`;
}
