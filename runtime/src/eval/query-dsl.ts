/**
 * Analyst Query DSL - Structured query language for searching replay timelines.
 *
 * Implements #992 P2-503: Analyst query DSL and deterministic slicing
 *
 * @module
 */

import { createHash } from 'crypto';
import type { ProjectedTimelineEvent } from './projector.js';
import type { IncidentAnomalyRef } from './incident-case.js';

/**
 * Severity levels for filtering.
 */
export type QuerySeverity = 'error' | 'warning';

/**
 * Slot range specification.
 */
export interface SlotRange {
  from: number;
  to: number;
}

/**
 * Query DSL interface supporting all filter types.
 */
export interface QueryDSL {
  /** Filter by task PDA (base58) */
  taskPda?: string;
  /** Filter by dispute PDA (base58) */
  disputePda?: string;
  /** Filter by actor public key (base58) */
  actorPubkey?: string;
  /** Filter by event type */
  eventType?: string;
  /** Filter by severity level */
  severity?: QuerySeverity;
  /** Filter by slot range */
  slotRange?: SlotRange;
  /** Filter by wallet set (comma-separated base58 keys) */
  walletSet?: string[];
  /** Filter by anomaly codes (comma-separated) */
  anomalyCodes?: string[];
}

/**
 * Parsed and validated query with canonical form.
 */
export interface NormalizedQuery {
  /** Original query */
  query: QueryDSL;
  /** Deterministic SHA-256 hash of canonical form */
  hash: string;
  /** Canonical JSON representation */
  canonicalJson: string;
}

/**
 * Query validation error.
 */
export interface QueryValidationError {
  field: string;
  message: string;
  value?: unknown;
}

/**
 * Result of query parsing.
 */
export type QueryParseResult =
  | { success: true; query: QueryDSL }
  | { success: false; errors: QueryValidationError[] };

/**
 * Validate base58 format for Solana public keys.
 * Valid Solana public keys are 43-44 base58 characters.
 */
function isValidBase58(value: string): boolean {
  const base58Regex = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;
  return base58Regex.test(value) && value.length >= 43 && value.length <= 44;
}

/**
 * Parse slot range string (format: "from-to").
 * Uses regex for robustness.
 */
function parseSlotRange(value: string): SlotRange | null {
  const match = value.match(/^(\d+)-(\d+)$/);
  if (!match) return null;

  const from = parseInt(match[1], 10);
  const to = parseInt(match[2], 10);

  if (isNaN(from) || isNaN(to) || from < 0 || to < 0 || from > to) {
    return null;
  }

  return { from, to };
}

/**
 * Parse query DSL from string input.
 * Accepts space or ampersand-separated key=value pairs.
 *
 * @example
 * parseQueryDSL("taskPda=ABC123 severity=error slotRange=100-200")
 * parseQueryDSL("actorPubkey=XYZ&eventType=TaskCreated")
 */
export function parseQueryDSL(input: string): QueryParseResult {
  const errors: QueryValidationError[] = [];
  const query: QueryDSL = {};

  // Split by space or ampersand
  const pairs = input.split(/[\s&]+/).filter((p) => p.length > 0);

  for (const pair of pairs) {
    const eqIndex = pair.indexOf('=');
    if (eqIndex === -1) {
      errors.push({ field: 'syntax', message: `Invalid key=value pair: ${pair}` });
      continue;
    }

    const key = pair.substring(0, eqIndex).trim();
    const value = pair.substring(eqIndex + 1).trim();

    switch (key) {
      case 'taskPda':
        if (!isValidBase58(value)) {
          errors.push({ field: 'taskPda', message: 'Invalid base58 public key', value });
        } else {
          query.taskPda = value;
        }
        break;

      case 'disputePda':
        if (!isValidBase58(value)) {
          errors.push({ field: 'disputePda', message: 'Invalid base58 public key', value });
        } else {
          query.disputePda = value;
        }
        break;

      case 'actorPubkey':
        if (!isValidBase58(value)) {
          errors.push({ field: 'actorPubkey', message: 'Invalid base58 public key', value });
        } else {
          query.actorPubkey = value;
        }
        break;

      case 'eventType':
        query.eventType = value;
        break;

      case 'severity':
        if (value !== 'error' && value !== 'warning') {
          errors.push({ field: 'severity', message: 'Severity must be "error" or "warning"', value });
        } else {
          query.severity = value;
        }
        break;

      case 'slotRange': {
        const range = parseSlotRange(value);
        if (!range) {
          errors.push({ field: 'slotRange', message: 'Invalid slot range format (expected "from-to")', value });
        } else {
          query.slotRange = range;
        }
        break;
      }

      case 'walletSet': {
        const wallets = value.split(',').map((w) => w.trim()).filter((w) => w.length > 0);
        const invalidWallets = wallets.filter((w) => !isValidBase58(w));
        if (invalidWallets.length > 0) {
          errors.push({ field: 'walletSet', message: `Invalid base58 keys: ${invalidWallets.join(', ')}`, value });
        } else {
          query.walletSet = wallets;
        }
        break;
      }

      case 'anomalyCodes':
        query.anomalyCodes = value.split(',').map((c) => c.trim()).filter((c) => c.length > 0);
        break;

      default:
        errors.push({ field: key, message: `Unknown query field: ${key}` });
    }
  }

  if (errors.length > 0) {
    return { success: false, errors };
  }

  return { success: true, query };
}

/**
 * Normalize query to canonical form for deterministic hashing.
 * Identical queries produce identical hashes.
 */
export function normalizeQuery(dsl: QueryDSL): NormalizedQuery {
  // Build canonical object with sorted keys and values
  const canonical: Record<string, unknown> = {};

  if (dsl.taskPda) canonical.taskPda = dsl.taskPda;
  if (dsl.disputePda) canonical.disputePda = dsl.disputePda;
  if (dsl.actorPubkey) canonical.actorPubkey = dsl.actorPubkey;
  if (dsl.eventType) canonical.eventType = dsl.eventType;
  if (dsl.severity) canonical.severity = dsl.severity;
  if (dsl.slotRange) canonical.slotRange = { from: dsl.slotRange.from, to: dsl.slotRange.to };
  if (dsl.walletSet && dsl.walletSet.length > 0) {
    canonical.walletSet = [...dsl.walletSet].sort();
  }
  if (dsl.anomalyCodes && dsl.anomalyCodes.length > 0) {
    canonical.anomalyCodes = [...dsl.anomalyCodes].sort();
  }

  // Sort keys for deterministic JSON
  const sortedKeys = Object.keys(canonical).sort();
  const sortedCanonical: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    sortedCanonical[key] = canonical[key];
  }

  const canonicalJson = JSON.stringify(sortedCanonical);
  const hash = createHash('sha256').update(canonicalJson).digest('hex');

  return {
    query: dsl,
    hash,
    canonicalJson,
  };
}

/**
 * Apply query filter to projected timeline events.
 */
export function applyQueryFilter(
  events: ProjectedTimelineEvent[],
  query: QueryDSL,
): ProjectedTimelineEvent[] {
  return events.filter((event) => {
    // Task PDA filter
    if (query.taskPda && event.taskPda !== query.taskPda) {
      return false;
    }

    // Dispute PDA filter
    if (query.disputePda) {
      const payload = event.payload as Record<string, unknown>;
      if (payload.disputePda !== query.disputePda) {
        return false;
      }
    }

    // Actor pubkey filter
    if (query.actorPubkey) {
      const payload = event.payload as Record<string, unknown>;
      const actorFields = ['creator', 'worker', 'agent', 'claimant', 'arbiter', 'voter', 'authority'];
      const hasActor = actorFields.some((field) => payload[field] === query.actorPubkey);
      if (!hasActor) {
        return false;
      }
    }

    // Event type filter
    if (query.eventType && event.sourceEventName !== query.eventType) {
      return false;
    }

    // Slot range filter
    if (query.slotRange) {
      if (event.slot < query.slotRange.from || event.slot > query.slotRange.to) {
        return false;
      }
    }

    // Wallet set filter
    if (query.walletSet && query.walletSet.length > 0) {
      const payload = event.payload as Record<string, unknown>;
      const walletFields = ['creator', 'worker', 'agent', 'claimant', 'arbiter', 'voter', 'authority', 'owner'];
      const eventWallets = walletFields
        .map((field) => payload[field])
        .filter((v): v is string => typeof v === 'string');
      const hasMatchingWallet = eventWallets.some((w) => query.walletSet!.includes(w));
      if (!hasMatchingWallet) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Apply anomaly filter based on query criteria.
 */
export function applyAnomalyFilter(
  anomalies: IncidentAnomalyRef[],
  query: QueryDSL,
): IncidentAnomalyRef[] {
  return anomalies.filter((anomaly) => {
    // Severity filter
    if (query.severity && anomaly.severity !== query.severity) {
      return false;
    }

    // Anomaly codes filter
    if (query.anomalyCodes && query.anomalyCodes.length > 0) {
      if (!query.anomalyCodes.includes(anomaly.code)) {
        return false;
      }
    }

    // Slot range filter
    if (query.slotRange) {
      if (anomaly.slot < query.slotRange.from || anomaly.slot > query.slotRange.to) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Serialize query to DSL string format.
 */
export function serializeQueryDSL(query: QueryDSL): string {
  const parts: string[] = [];

  if (query.taskPda) parts.push(`taskPda=${query.taskPda}`);
  if (query.disputePda) parts.push(`disputePda=${query.disputePda}`);
  if (query.actorPubkey) parts.push(`actorPubkey=${query.actorPubkey}`);
  if (query.eventType) parts.push(`eventType=${query.eventType}`);
  if (query.severity) parts.push(`severity=${query.severity}`);
  if (query.slotRange) parts.push(`slotRange=${query.slotRange.from}-${query.slotRange.to}`);
  if (query.walletSet && query.walletSet.length > 0) {
    parts.push(`walletSet=${query.walletSet.join(',')}`);
  }
  if (query.anomalyCodes && query.anomalyCodes.length > 0) {
    parts.push(`anomalyCodes=${query.anomalyCodes.join(',')}`);
  }

  return parts.join(' ');
}
