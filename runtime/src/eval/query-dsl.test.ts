/**
 * Tests for Query DSL
 *
 * @module
 */

import { describe, it, expect } from 'vitest';
import {
  parseQueryDSL,
  normalizeQuery,
  applyQueryFilter,
  applyAnomalyFilter,
  serializeQueryDSL,
  type QueryDSL,
} from './query-dsl.js';
import type { ProjectedTimelineEvent } from './projector.js';
import type { IncidentAnomalyRef } from './incident-case.js';

// ============================================================================
// Test Fixtures
// ============================================================================

function createTestEvents(): ProjectedTimelineEvent[] {
  return [
    {
      seq: 1,
      type: 'task_created',
      taskPda: 'TaskPda111111111111111111111111111111111111',
      timestampMs: 1700000000000,
      payload: {
        creator: 'Creator1111111111111111111111111111111111111',
      },
      slot: 100,
      signature: 'Sig1',
      sourceEventName: 'TaskCreated',
      sourceEventSequence: 1,
    },
    {
      seq: 2,
      type: 'task_claimed',
      taskPda: 'TaskPda111111111111111111111111111111111111',
      timestampMs: 1700000001000,
      payload: {
        worker: 'Worker1111111111111111111111111111111111111',
      },
      slot: 150,
      signature: 'Sig2',
      sourceEventName: 'TaskClaimed',
      sourceEventSequence: 2,
    },
    {
      seq: 3,
      type: 'task_completed',
      taskPda: 'TaskPda222222222222222222222222222222222222',
      timestampMs: 1700000002000,
      payload: {
        worker: 'Worker2222222222222222222222222222222222222',
      },
      slot: 200,
      signature: 'Sig3',
      sourceEventName: 'TaskCompleted',
      sourceEventSequence: 3,
    },
  ];
}

function createTestAnomalies(): IncidentAnomalyRef[] {
  return [
    {
      code: 'hash_mismatch',
      severity: 'error',
      description: 'Hash mismatch',
      slot: 100,
    },
    {
      code: 'missing_sig',
      severity: 'warning',
      description: 'Missing signature',
      slot: 150,
    },
    {
      code: 'slot_regression',
      severity: 'warning',
      description: 'Slot regression',
      slot: 200,
    },
  ];
}

// ============================================================================
// Tests
// ============================================================================

describe('Query DSL', () => {
  describe('parseQueryDSL', () => {
    it('parses valid taskPda', () => {
      const result = parseQueryDSL('taskPda=TaskPda111111111111111111111111111111111111');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.query.taskPda).toBe('TaskPda111111111111111111111111111111111111');
      }
    });

    it('parses valid severity', () => {
      const result = parseQueryDSL('severity=error');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.query.severity).toBe('error');
      }
    });

    it('parses valid slotRange', () => {
      const result = parseQueryDSL('slotRange=100-200');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.query.slotRange?.from).toBe(100);
        expect(result.query.slotRange?.to).toBe(200);
      }
    });

    it('parses multiple parameters', () => {
      const result = parseQueryDSL('taskPda=TaskPda111111111111111111111111111111111111 severity=error slotRange=100-200');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.query.taskPda).toBeDefined();
        expect(result.query.severity).toBe('error');
        expect(result.query.slotRange?.from).toBe(100);
      }
    });

    it('parses ampersand-separated parameters', () => {
      const result = parseQueryDSL('eventType=TaskCreated&severity=warning');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.query.eventType).toBe('TaskCreated');
        expect(result.query.severity).toBe('warning');
      }
    });

    it('parses anomalyCodes', () => {
      const result = parseQueryDSL('anomalyCodes=hash_mismatch,slot_regression');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.query.anomalyCodes).toEqual(['hash_mismatch', 'slot_regression']);
      }
    });

    it('returns errors for invalid base58 keys', () => {
      const result = parseQueryDSL('taskPda=invalid!key');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors[0].field).toBe('taskPda');
      }
    });

    it('returns errors for invalid severity', () => {
      const result = parseQueryDSL('severity=invalid');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors[0].field).toBe('severity');
      }
    });

    it('returns errors for invalid slotRange format', () => {
      const result = parseQueryDSL('slotRange=invalid');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors[0].field).toBe('slotRange');
      }
    });
  });

  describe('normalizeQuery', () => {
    it('produces deterministic hash', () => {
      const query: QueryDSL = { taskPda: 'TaskPda111111111111111111111111111111111111', severity: 'error' };
      const norm1 = normalizeQuery(query);
      const norm2 = normalizeQuery(query);

      expect(norm1.hash).toBe(norm2.hash);
      expect(norm1.hash).toHaveLength(64);
    });

    it('produces same hash regardless of property order', () => {
      const query1: QueryDSL = { taskPda: 'TaskPda111111111111111111111111111111111111', severity: 'error' };
      const query2: QueryDSL = { severity: 'error', taskPda: 'TaskPda111111111111111111111111111111111111' };

      const norm1 = normalizeQuery(query1);
      const norm2 = normalizeQuery(query2);

      expect(norm1.hash).toBe(norm2.hash);
    });

    it('sorts walletSet for determinism', () => {
      const query: QueryDSL = {
        walletSet: ['Wallet2222222222222222222222222222222222222', 'Wallet1111111111111111111111111111111111111']
      };
      const norm = normalizeQuery(query);
      const parsed = JSON.parse(norm.canonicalJson);

      expect(parsed.walletSet[0]).toBe('Wallet1111111111111111111111111111111111111');
    });
  });

  describe('applyQueryFilter', () => {
    it('filters by taskPda', () => {
      const events = createTestEvents();
      const filtered = applyQueryFilter(events, { taskPda: 'TaskPda111111111111111111111111111111111111' });

      expect(filtered).toHaveLength(2);
      expect(filtered.every(e => e.taskPda === 'TaskPda111111111111111111111111111111111111')).toBe(true);
    });

    it('filters by eventType', () => {
      const events = createTestEvents();
      const filtered = applyQueryFilter(events, { eventType: 'TaskCreated' });

      expect(filtered).toHaveLength(1);
      expect(filtered[0].sourceEventName).toBe('TaskCreated');
    });

    it('filters by slotRange', () => {
      const events = createTestEvents();
      const filtered = applyQueryFilter(events, { slotRange: { from: 100, to: 150 } });

      expect(filtered).toHaveLength(2);
      expect(filtered.every(e => e.slot >= 100 && e.slot <= 150)).toBe(true);
    });

    it('filters by actorPubkey', () => {
      const events = createTestEvents();
      const filtered = applyQueryFilter(events, { actorPubkey: 'Worker1111111111111111111111111111111111111' });

      expect(filtered).toHaveLength(1);
    });

    it('combines multiple filters', () => {
      const events = createTestEvents();
      const filtered = applyQueryFilter(events, {
        taskPda: 'TaskPda111111111111111111111111111111111111',
        slotRange: { from: 140, to: 160 },
      });

      expect(filtered).toHaveLength(1);
      expect(filtered[0].slot).toBe(150);
    });
  });

  describe('applyAnomalyFilter', () => {
    it('filters by severity', () => {
      const anomalies = createTestAnomalies();
      const filtered = applyAnomalyFilter(anomalies, { severity: 'error' });

      expect(filtered).toHaveLength(1);
      expect(filtered[0].code).toBe('hash_mismatch');
    });

    it('filters by anomalyCodes', () => {
      const anomalies = createTestAnomalies();
      const filtered = applyAnomalyFilter(anomalies, { anomalyCodes: ['hash_mismatch', 'missing_sig'] });

      expect(filtered).toHaveLength(2);
    });

    it('filters by slotRange', () => {
      const anomalies = createTestAnomalies();
      const filtered = applyAnomalyFilter(anomalies, { slotRange: { from: 100, to: 150 } });

      expect(filtered).toHaveLength(2);
    });
  });

  describe('serializeQueryDSL', () => {
    it('serializes query to string format', () => {
      const query: QueryDSL = {
        taskPda: 'TaskPda111111111111111111111111111111111111',
        severity: 'error',
        slotRange: { from: 100, to: 200 },
      };

      const serialized = serializeQueryDSL(query);

      expect(serialized).toContain('taskPda=TaskPda111111111111111111111111111111111111');
      expect(serialized).toContain('severity=error');
      expect(serialized).toContain('slotRange=100-200');
    });
  });
});
