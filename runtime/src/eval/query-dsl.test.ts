import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
  applyAnomalyFilter,
  applyQueryFilter,
  normalizeQuery,
  parseQueryDSL,
  QueryDSLParseError,
} from './query-dsl.js';
import type { ProjectedTimelineEvent } from './projector.js';
import type { ReplayAnomaly } from './replay-comparison.js';

function pubkey(seed: number): string {
  const bytes = new Uint8Array(32);
  bytes.fill(seed);
  return new PublicKey(bytes).toBase58();
}

function makeEvent(input: Partial<ProjectedTimelineEvent> & Pick<ProjectedTimelineEvent, 'seq' | 'slot' | 'type'>): ProjectedTimelineEvent {
  return {
    seq: input.seq,
    slot: input.slot,
    type: input.type,
    taskPda: input.taskPda,
    timestampMs: input.timestampMs ?? 0,
    signature: input.signature ?? `SIG_${input.seq}`,
    sourceEventName: input.sourceEventName ?? `event_${input.seq}`,
    sourceEventSequence: input.sourceEventSequence ?? 0,
    payload: (input.payload ?? {}) as ProjectedTimelineEvent['payload'],
  };
}

describe('query-dsl', () => {
  it('parses valid DSL string', () => {
    const taskPda = pubkey(1);
    const parsed = parseQueryDSL(`taskPda=${taskPda} severity=error slotRange=100-200`);

    expect(parsed).toEqual({
      taskPda,
      severity: 'error',
      slotRange: { from: 100, to: 200 },
    });
  });

  it('parses anomaly codes list', () => {
    const parsed = parseQueryDSL('anomalyCodes=hash_mismatch,missing_event');
    expect(parsed.anomalyCodes).toEqual(['hash_mismatch', 'missing_event']);
  });

  it('parses wallet set and sorts entries', () => {
    const key1 = pubkey(3);
    const key2 = pubkey(2);
    const key3 = pubkey(4);

    const parsed = parseQueryDSL(`walletSet=${key1},${key2},${key3}`);
    expect(parsed.walletSet).toEqual([key2, key1, key3].sort());
  });

  it('throws validation error when missing equals', () => {
    expect(() => parseQueryDSL('taskPda')).toThrow(QueryDSLParseError);

    try {
      parseQueryDSL('taskPda');
    } catch (error) {
      const parsed = error as QueryDSLParseError;
      expect(parsed.errors.some((entry) => entry.field === 'taskPda')).toBe(true);
    }
  });

  it('throws validation error for invalid severity', () => {
    expect(() => parseQueryDSL('severity=critical')).toThrow(QueryDSLParseError);
  });

  it('throws validation error for inverted slot range', () => {
    expect(() => parseQueryDSL('slotRange=200-100')).toThrow(QueryDSLParseError);
  });

  it('throws validation error for unknown fields', () => {
    expect(() => parseQueryDSL('fooBar=123')).toThrow(QueryDSLParseError);
  });

  it('normalizes to identical hashes regardless of token ordering', () => {
    const taskPda = pubkey(9);
    const first = normalizeQuery(parseQueryDSL(`taskPda=${taskPda} severity=warning slotRange=5-10`));
    const second = normalizeQuery(parseQueryDSL(`slotRange=5-10 taskPda=${taskPda} severity=warning`));

    expect(first.hash).toBe(second.hash);
    expect(first.canonical).toBe(second.canonical);
  });

  it('normalizes empty DSL to stable defaults', () => {
    const normalized = normalizeQuery({});
    expect(normalized.dsl).toEqual({
      taskPda: null,
      disputePda: null,
      actorPubkey: null,
      eventType: null,
      severity: null,
      slotRange: { from: null, to: null },
      walletSet: [],
      anomalyCodes: [],
    });
  });

  it('produces identical hashes across repeated parse+normalize calls', () => {
    const taskPda = pubkey(7);
    const input = `taskPda=${taskPda} severity=error slotRange=0-0`;
    const first = normalizeQuery(parseQueryDSL(input));
    const second = normalizeQuery(parseQueryDSL(input));
    expect(first.hash).toBe(second.hash);
  });

  it('applyQueryFilter filters events by taskPda', () => {
    const taskA = pubkey(1);
    const taskB = pubkey(2);
    const events = Array.from({ length: 10 }, (_, index) => makeEvent({
      seq: index + 1,
      slot: index,
      type: 'discovered',
      taskPda: index % 2 === 0 ? taskA : taskB,
    }));

    const filtered = applyQueryFilter(events, { taskPda: taskA });
    expect(filtered).toHaveLength(5);
    expect(filtered.every((event) => event.taskPda === taskA)).toBe(true);
  });

  it('applyAnomalyFilter filters anomalies by severity', () => {
    const anomalies: ReplayAnomaly[] = [
      { code: 'hash_mismatch', severity: 'error', message: 'a', context: {} },
      { code: 'missing_event', severity: 'warning', message: 'b', context: {} },
      { code: 'type_mismatch', severity: 'error', message: 'c', context: {} },
    ];

    const filtered = applyAnomalyFilter(anomalies, { severity: 'error' });
    expect(filtered.map((entry) => entry.code).sort()).toEqual(['hash_mismatch', 'type_mismatch']);
  });

  it('returns empty QueryDSL for empty input', () => {
    expect(parseQueryDSL('')).toEqual({});
    expect(parseQueryDSL('   ')).toEqual({});
  });
});

