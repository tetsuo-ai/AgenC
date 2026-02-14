/**
 * Tests for Incident Case Object Model
 *
 * @module
 */

import { describe, it, expect } from 'vitest';
import {
  buildIncidentCase,
  computeTraceWindow,
  computeEvidenceHash,
  computeCaseId,
  resolveActors,
  serializeIncidentCase,
  deserializeIncidentCase,
  INCIDENT_CASE_SCHEMA_VERSION,
  type IncidentCase,
} from './incident-case.js';
import type { ProjectedTimelineEvent } from './projector.js';

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
        reward: 1000000,
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
      slot: 101,
      signature: 'Sig2',
      sourceEventName: 'TaskClaimed',
      sourceEventSequence: 2,
    },
    {
      seq: 3,
      type: 'task_completed',
      taskPda: 'TaskPda111111111111111111111111111111111111',
      timestampMs: 1700000002000,
      payload: {
        worker: 'Worker1111111111111111111111111111111111111',
        proofHash: 'hash123',
      },
      slot: 102,
      signature: 'Sig3',
      sourceEventName: 'TaskCompleted',
      sourceEventSequence: 3,
    },
  ];
}

// ============================================================================
// Tests
// ============================================================================

describe('Incident Case Model', () => {
  describe('computeTraceWindow', () => {
    it('computes window from events', () => {
      const events = createTestEvents();
      const window = computeTraceWindow(events);

      expect(window.startSlot).toBe(100);
      expect(window.endSlot).toBe(102);
      expect(window.startTimestampMs).toBe(1700000000000);
      expect(window.endTimestampMs).toBe(1700000002000);
    });

    it('uses override values when provided', () => {
      const events = createTestEvents();
      const window = computeTraceWindow(events, {
        startSlot: 50,
        endSlot: 200,
      });

      expect(window.startSlot).toBe(50);
      expect(window.endSlot).toBe(200);
    });

    it('handles empty events', () => {
      const window = computeTraceWindow([]);
      expect(window.startSlot).toBe(0);
      expect(window.endSlot).toBe(0);
    });
  });

  describe('resolveActors', () => {
    it('extracts actors from events', () => {
      const events = createTestEvents();
      const actors = resolveActors(events);

      expect(actors.size).toBe(2);
      expect(actors.has('Creator1111111111111111111111111111111111111')).toBe(true);
      expect(actors.has('Worker1111111111111111111111111111111111111')).toBe(true);
    });

    it('assigns correct roles', () => {
      const events = createTestEvents();
      const actors = resolveActors(events);

      const creator = actors.get('Creator1111111111111111111111111111111111111');
      expect(creator?.role).toBe('creator');

      const worker = actors.get('Worker1111111111111111111111111111111111111');
      expect(worker?.role).toBe('worker');
    });

    it('tracks first and last seen slots', () => {
      const events = createTestEvents();
      const actors = resolveActors(events);

      const worker = actors.get('Worker1111111111111111111111111111111111111');
      expect(worker?.firstSeenSlot).toBe(101);
      expect(worker?.lastSeenSlot).toBe(102);
    });
  });

  describe('computeEvidenceHash', () => {
    it('produces consistent SHA-256 hash', () => {
      const data = 'test data';
      const hash1 = computeEvidenceHash(data);
      const hash2 = computeEvidenceHash(data);

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 hex
    });

    it('produces different hashes for different data', () => {
      const hash1 = computeEvidenceHash('data1');
      const hash2 = computeEvidenceHash('data2');

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('computeCaseId', () => {
    it('produces deterministic case ID', () => {
      const window = { startSlot: 100, endSlot: 200, startTimestampMs: 0, endTimestampMs: 0 };
      const id1 = computeCaseId(window, 'task1');
      const id2 = computeCaseId(window, 'task1');

      expect(id1).toBe(id2);
      expect(id1).toHaveLength(64);
    });

    it('produces different IDs for different inputs', () => {
      const window = { startSlot: 100, endSlot: 200, startTimestampMs: 0, endTimestampMs: 0 };
      const id1 = computeCaseId(window, 'task1');
      const id2 = computeCaseId(window, 'task2');

      expect(id1).not.toBe(id2);
    });
  });

  describe('buildIncidentCase', () => {
    it('builds case with all required fields', () => {
      const events = createTestEvents();
      const caseData = buildIncidentCase({ events });

      expect(caseData.schemaVersion).toBe(INCIDENT_CASE_SCHEMA_VERSION);
      expect(caseData.caseId).toHaveLength(64);
      expect(caseData.traceWindow.startSlot).toBe(100);
      expect(caseData.traceWindow.endSlot).toBe(102);
      expect(caseData.transitions.length).toBeGreaterThan(0);
      expect(caseData.actorMap.size).toBe(2);
      expect(caseData.caseStatus).toBe('open');
    });

    it('builds transitions in order', () => {
      const events = createTestEvents();
      const caseData = buildIncidentCase({ events });

      expect(caseData.transitions[0].toState).toBe('created');
      expect(caseData.transitions[1].toState).toBe('claimed');
      expect(caseData.transitions[2].toState).toBe('completed');
    });

    it('filters by taskPda when provided', () => {
      const events = createTestEvents();
      const caseData = buildIncidentCase({
        events,
        taskPda: 'TaskPda111111111111111111111111111111111111',
      });

      expect(caseData.taskPda).toBe('TaskPda111111111111111111111111111111111111');
    });

    it('includes anomalies when provided', () => {
      const events = createTestEvents();
      const anomalies = [
        { code: 'test_anomaly', severity: 'warning' as const, description: 'Test', slot: 100 },
      ];
      const caseData = buildIncidentCase({ events, anomalies });

      expect(caseData.anomalyRefs).toHaveLength(1);
      expect(caseData.anomalyRefs[0].code).toBe('test_anomaly');
    });

    it('produces deterministic output for identical inputs', () => {
      const events = createTestEvents();
      const case1 = buildIncidentCase({ events });
      const case2 = buildIncidentCase({ events });

      expect(case1.caseId).toBe(case2.caseId);
      expect(case1.transitions.length).toBe(case2.transitions.length);
    });
  });

  describe('Serialization', () => {
    it('round-trips through serialization', () => {
      const events = createTestEvents();
      const original = buildIncidentCase({ events });

      const serialized = serializeIncidentCase(original);
      const deserialized = deserializeIncidentCase(serialized);

      expect(deserialized.caseId).toBe(original.caseId);
      expect(deserialized.schemaVersion).toBe(original.schemaVersion);
      expect(deserialized.caseStatus).toBe(original.caseStatus);
      expect(deserialized.actorMap.size).toBe(original.actorMap.size);
    });
  });
});
