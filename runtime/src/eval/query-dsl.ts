/**
 * Analyst query DSL parsing + deterministic normalization helpers.
 *
 * @module
 */

import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { stableStringifyJson, type JsonValue } from './types.js';
import type { ProjectedTimelineEvent } from './projector.js';
import type { ReplayAnomaly, ReplayAnomalyCode } from './replay-comparison.js';

/** Structured query for incident investigation slicing. */
export interface QueryDSL {
  taskPda?: string;
  disputePda?: string;
  actorPubkey?: string;
  eventType?: string; // e.g. 'discovered', 'dispute:initiated'
  severity?: 'error' | 'warning';
  slotRange?: {
    from?: number;
    to?: number;
  };
  walletSet?: string[]; // base58 pubkeys to filter by actor involvement
  anomalyCodes?: ReplayAnomalyCode[];
}

/** Canonical (normalized) query for deterministic hashing. */
export interface CanonicalQuery {
  /** Stable JSON representation for hash computation. */
  canonical: string;
  /** SHA-256 of the canonical string. */
  hash: string;
  /** The normalized DSL fields. */
  dsl: Required<{
    taskPda: string | null;
    disputePda: string | null;
    actorPubkey: string | null;
    eventType: string | null;
    severity: string | null;
    slotRange: { from: number | null; to: number | null };
    walletSet: string[];
    anomalyCodes: string[];
  }>;
}

/** Validation error for malformed DSL input. */
export interface QueryDSLValidationError {
  field: string;
  message: string;
  value?: unknown;
}

export class QueryDSLParseError extends Error {
  readonly errors: QueryDSLValidationError[];
  constructor(errors: QueryDSLValidationError[]) {
    super(`Query DSL validation failed: ${errors.map((error) => error.message).join('; ')}`);
    this.name = 'QueryDSLParseError';
    this.errors = errors;
  }
}

const ACTOR_FIELDS = [
  'creator',
  'worker',
  'authority',
  'voter',
  'initiator',
  'defendant',
  'recipient',
  'updater',
  'agent',
] as const;

function isValidBase58PublicKey(value: string): boolean {
  if (value.length === 0) {
    return false;
  }

  try {
    // PublicKey validates base58 decoding + 32-byte length.
    // Use it as the source of truth for "pubkey-like" fields.
    // eslint-disable-next-line no-new
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseNonNegativeInt(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

function parseCsv(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Parse a query DSL string into a structured QueryDSL object.
 * String format: key=value pairs separated by spaces or '&'.
 */
export function parseQueryDSL(input: string): QueryDSL {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return {};
  }

  const errors: QueryDSLValidationError[] = [];
  const dsl: QueryDSL = {};

  const tokens = trimmed.split(/[\s&]+/).filter((token) => token.length > 0);

  for (const token of tokens) {
    const eqIndex = token.indexOf('=');
    if (eqIndex === -1) {
      errors.push({
        field: token,
        message: `Missing '=' in token: "${token}"`,
      });
      continue;
    }

    const key = token.slice(0, eqIndex);
    const value = token.slice(eqIndex + 1);

    switch (key) {
      case 'taskPda': {
        if (!isValidBase58PublicKey(value)) {
          errors.push({ field: 'taskPda', message: 'Invalid base58 public key', value });
        } else {
          dsl.taskPda = value;
        }
        break;
      }
      case 'disputePda': {
        if (!isValidBase58PublicKey(value)) {
          errors.push({ field: 'disputePda', message: 'Invalid base58 public key', value });
        } else {
          dsl.disputePda = value;
        }
        break;
      }
      case 'actorPubkey': {
        if (!isValidBase58PublicKey(value)) {
          errors.push({ field: 'actorPubkey', message: 'Invalid base58 public key', value });
        } else {
          dsl.actorPubkey = value;
        }
        break;
      }
      case 'eventType': {
        if (value.length === 0) {
          errors.push({ field: 'eventType', message: 'Must be a non-empty string', value });
        } else {
          dsl.eventType = value;
        }
        break;
      }
      case 'severity': {
        if (value !== 'error' && value !== 'warning') {
          errors.push({ field: 'severity', message: 'Must be "error" or "warning"', value });
        } else {
          dsl.severity = value;
        }
        break;
      }
      case 'slotRange': {
        const parts = value.split('-');
        if (parts.length !== 2) {
          errors.push({ field: 'slotRange', message: 'slotRange must be in form "from-to"', value });
          break;
        }

        const fromRaw = parts[0] ?? '';
        const toRaw = parts[1] ?? '';

        const from = fromRaw.length === 0 ? undefined : parseNonNegativeInt(fromRaw);
        const to = toRaw.length === 0 ? undefined : parseNonNegativeInt(toRaw);

        if (fromRaw.length > 0 && from === null) {
          errors.push({ field: 'slotRange.from', message: 'Must be non-negative integer', value: fromRaw });
        }
        if (toRaw.length > 0 && to === null) {
          errors.push({ field: 'slotRange.to', message: 'Must be non-negative integer', value: toRaw });
        }

        if (from !== null && to !== null && from !== undefined && to !== undefined && to < from) {
          errors.push({ field: 'slotRange', message: 'to must be >= from', value });
        }

        if (from !== null && to !== null) {
          dsl.slotRange = {
            from: from === null ? undefined : from,
            to: to === null ? undefined : to,
          };
        }
        break;
      }
      case 'walletSet': {
        const wallets = parseCsv(value);
        const invalid = wallets.filter((wallet) => !isValidBase58PublicKey(wallet));
        for (const wallet of invalid) {
          errors.push({
            field: 'walletSet',
            message: `Invalid base58 in walletSet: "${wallet}"`,
            value: wallet,
          });
        }

        if (invalid.length === 0) {
          dsl.walletSet = [...wallets].sort();
        } else {
          dsl.walletSet = wallets;
        }
        break;
      }
      case 'anomalyCodes': {
        dsl.anomalyCodes = parseCsv(value) as ReplayAnomalyCode[];
        break;
      }
      default: {
        errors.push({ field: key, message: `Unknown query field: "${key}"` });
      }
    }
  }

  if (errors.length > 0) {
    throw new QueryDSLParseError(errors);
  }

  return dsl;
}

export function normalizeQuery(dsl: QueryDSL): CanonicalQuery {
  const normalized = {
    taskPda: dsl.taskPda ?? null,
    disputePda: dsl.disputePda ?? null,
    actorPubkey: dsl.actorPubkey ?? null,
    eventType: dsl.eventType ?? null,
    severity: dsl.severity ?? null,
    slotRange: {
      from: dsl.slotRange?.from ?? null,
      to: dsl.slotRange?.to ?? null,
    },
    walletSet: [...(dsl.walletSet ?? [])].sort(),
    anomalyCodes: [...(dsl.anomalyCodes ?? [])].sort(),
  };

  const canonical = stableStringifyJson(normalized as unknown as JsonValue);
  const hash = createHash('sha256').update(canonical).digest('hex');

  return {
    canonical,
    hash,
    dsl: normalized,
  };
}

function payloadHasActor(payload: Record<string, unknown>, actor: string): boolean {
  return ACTOR_FIELDS.some((field) => payload[field] === actor);
}

function payloadHasWallet(payload: Record<string, unknown>, wallets: ReadonlySet<string>): boolean {
  return ACTOR_FIELDS.some((field) => {
    const value = payload[field];
    return typeof value === 'string' && wallets.has(value);
  });
}

/** Apply a QueryDSL to filter projected timeline events. */
export function applyQueryFilter<TEvent extends Pick<ProjectedTimelineEvent, 'slot' | 'type' | 'taskPda' | 'payload'>>(
  events: readonly TEvent[],
  dsl: QueryDSL,
): TEvent[] {
  const walletSet = dsl.walletSet && dsl.walletSet.length > 0 ? new Set(dsl.walletSet) : null;

  return events.filter((event) => {
    if (dsl.taskPda && event.taskPda !== dsl.taskPda) return false;
    if (dsl.eventType && event.type !== dsl.eventType) return false;
    if (dsl.slotRange?.from !== undefined && event.slot < dsl.slotRange.from) return false;
    if (dsl.slotRange?.to !== undefined && event.slot > dsl.slotRange.to) return false;

    const payload = asRecord(event.payload);
    if (!payload) {
      return dsl.actorPubkey === undefined && walletSet === null;
    }

    if (dsl.actorPubkey && !payloadHasActor(payload, dsl.actorPubkey)) return false;
    if (walletSet && !payloadHasWallet(payload, walletSet)) return false;

    return true;
  });
}

/** Apply a QueryDSL to filter anomalies. */
export function applyAnomalyFilter(
  anomalies: readonly ReplayAnomaly[],
  dsl: QueryDSL,
): ReplayAnomaly[] {
  return anomalies.filter((anomaly) => {
    if (dsl.severity && anomaly.severity !== dsl.severity) return false;
    if (dsl.anomalyCodes && dsl.anomalyCodes.length > 0 && !dsl.anomalyCodes.includes(anomaly.code)) return false;
    if (dsl.taskPda && anomaly.context.taskPda !== dsl.taskPda) return false;
    if (dsl.disputePda && anomaly.context.disputePda !== dsl.disputePda) return false;

    return true;
  });
}

