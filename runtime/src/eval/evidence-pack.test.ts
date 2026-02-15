/**
 * Tests for Evidence Pack Export
 *
 * @module
 */

import { describe, it, expect } from 'vitest';
import {
  buildEvidencePack,
  serializeEvidencePack,
  verifyEvidencePackIntegrity,
  parseEvidencePack,
  applyRedaction,
  computeToolFingerprint,
  EVIDENCE_PACK_SCHEMA_VERSION,
} from './evidence-pack.js';
import { buildIncidentCase } from './incident-case.js';
import { normalizeQuery } from './query-dsl.js';
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
      signature: 'Sig111111111111111111111111111111111111111111111111111111111111111111111111111111111111',
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
      signature: 'Sig222222222222222222222222222222222222222222222222222222222222222222222222222222222222',
      sourceEventName: 'TaskClaimed',
      sourceEventSequence: 2,
    },
  ];
}

// ============================================================================
// Tests
// ============================================================================

describe('Evidence Pack', () => {
  describe('buildEvidencePack', () => {
    it('builds pack with all required fields', () => {
      const events = createTestEvents();
      const caseData = buildIncidentCase({ events });
      const query = normalizeQuery({ taskPda: 'TaskPda111111111111111111111111111111111111' });

      const pack = buildEvidencePack({
        caseData,
        events,
        query,
      });

      expect(pack.manifest.schemaVersion).toBe(EVIDENCE_PACK_SCHEMA_VERSION);
      expect(pack.manifest.queryHash).toBe(query.hash);
      expect(pack.manifest.sealed).toBe(false);
      expect(pack.manifest.caseHash).toHaveLength(64);
      expect(pack.manifest.eventsHash).toHaveLength(64);
      expect(pack.events).toHaveLength(2);
    });

    it('computes correct slot cursor', () => {
      const events = createTestEvents();
      const caseData = buildIncidentCase({ events });
      const query = normalizeQuery({});

      const pack = buildEvidencePack({ caseData, events, query });

      expect(pack.manifest.slotCursor.start).toBe(100);
      expect(pack.manifest.slotCursor.end).toBe(101);
    });

    it('uses provided seed', () => {
      const events = createTestEvents();
      const caseData = buildIncidentCase({ events });
      const query = normalizeQuery({});

      const pack = buildEvidencePack({ caseData, events, query, seed: 12345 });

      expect(pack.manifest.seed).toBe(12345);
    });

    it('applies redaction when sealed', () => {
      const events = createTestEvents();
      const caseData = buildIncidentCase({ events });
      const query = normalizeQuery({});

      const pack = buildEvidencePack({ caseData, events, query, sealed: true });

      expect(pack.manifest.sealed).toBe(true);
      // Check that signatures are redacted
      for (const event of pack.events) {
        expect(event.signature).toContain('[REDACTED:');
      }
    });
  });

  describe('serializeEvidencePack', () => {
    it('produces three-file format', () => {
      const events = createTestEvents();
      const caseData = buildIncidentCase({ events });
      const query = normalizeQuery({});
      const pack = buildEvidencePack({ caseData, events, query });

      const serialized = serializeEvidencePack(pack);

      expect(serialized.manifestJson).toBeTruthy();
      expect(serialized.caseJson).toBeTruthy();
      expect(serialized.eventsJsonl).toBeTruthy();

      // Verify manifest is valid JSON
      const parsedManifest = JSON.parse(serialized.manifestJson);
      expect(parsedManifest.schemaVersion).toBe(EVIDENCE_PACK_SCHEMA_VERSION);

      // Verify events are JSONL format
      const eventLines = serialized.eventsJsonl.split('\n').filter(l => l.length > 0);
      expect(eventLines).toHaveLength(2);
    });
  });

  describe('verifyEvidencePackIntegrity', () => {
    it('validates unmodified pack', () => {
      const events = createTestEvents();
      const caseData = buildIncidentCase({ events });
      const query = normalizeQuery({});
      const pack = buildEvidencePack({ caseData, events, query });

      const result = verifyEvidencePackIntegrity(pack);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('detects tampered case data', () => {
      const events = createTestEvents();
      const caseData = buildIncidentCase({ events });
      const query = normalizeQuery({});
      const pack = buildEvidencePack({ caseData, events, query });

      // Tamper with case data
      pack.caseData.caseStatus = 'resolved';

      const result = verifyEvidencePackIntegrity(pack);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Case hash mismatch'))).toBe(true);
    });

    it('detects tampered events', () => {
      const events = createTestEvents();
      const caseData = buildIncidentCase({ events });
      const query = normalizeQuery({});
      const pack = buildEvidencePack({ caseData, events, query });

      // Tamper with events
      pack.events[0].slot = 999;

      const result = verifyEvidencePackIntegrity(pack);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Events hash mismatch'))).toBe(true);
    });
  });

  describe('parseEvidencePack', () => {
    it('round-trips through serialization', () => {
      const events = createTestEvents();
      const caseData = buildIncidentCase({ events });
      const query = normalizeQuery({});
      const original = buildEvidencePack({ caseData, events, query });

      const serialized = serializeEvidencePack(original);
      const parsed = parseEvidencePack(serialized);

      expect(parsed.manifest.schemaVersion).toBe(original.manifest.schemaVersion);
      expect(parsed.manifest.queryHash).toBe(original.manifest.queryHash);
      expect(parsed.events).toHaveLength(original.events.length);
    });
  });

  describe('applyRedaction', () => {
    it('removes specified fields', () => {
      const payload = {
        creator: 'Creator1111111111111111111111111111111111111',
        privateKey: 'secret_key',
        data: 'public',
      };

      const redacted = applyRedaction(payload, { removeFields: ['privateKey'] });

      expect(redacted.creator).toBeDefined();
      expect(redacted.data).toBe('public');
      expect(redacted.privateKey).toBeUndefined();
    });

    it('masks specified fields', () => {
      const payload = {
        signature: 'some_signature_value',
        data: 'public',
      };

      const redacted = applyRedaction(payload, { maskFields: ['signature'] });

      expect(redacted.signature).toBe('[REDACTED]');
      expect(redacted.data).toBe('public');
    });

    it('truncates actor keys', () => {
      const payload = {
        creator: 'Creator1111111111111111111111111111111111111',
        worker: 'Worker1111111111111111111111111111111111111',
      };

      const redacted = applyRedaction(payload, { truncateActorKeys: 8 });

      expect(redacted.creator).toBe('Creator1...');
      expect(redacted.worker).toBe('Worker11...');
    });

    it('hashes signatures when configured', () => {
      const payload = {
        signature: 'test_signature',
      };

      const redacted = applyRedaction(payload, { maskFields: ['signature'], hashSignatures: true });

      expect(redacted.signature).toContain('[REDACTED:');
      expect(redacted.signature).not.toBe('[REDACTED]');
    });

    it('recurses into arrays', () => {
      const payload = {
        participants: [
          { creator: 'Creator1111111111111111111111111111111111111', privateKey: 'secret1' },
          { worker: 'Worker1111111111111111111111111111111111111', privateKey: 'secret2' },
        ],
        data: 'public',
      };

      const redacted = applyRedaction(payload, {
        removeFields: ['privateKey'],
        truncateActorKeys: 8,
      });

      expect(redacted.data).toBe('public');
      expect(Array.isArray(redacted.participants)).toBe(true);
      const participants = redacted.participants as Array<Record<string, unknown>>;
      expect(participants).toHaveLength(2);
      expect(participants[0].privateKey).toBeUndefined();
      expect(participants[0].creator).toBe('Creator1...');
      expect(participants[1].privateKey).toBeUndefined();
      expect(participants[1].worker).toBe('Worker11...');
    });
  });

  describe('computeToolFingerprint', () => {
    it('produces deterministic fingerprint', () => {
      const fp1 = computeToolFingerprint('1.0.0');
      const fp2 = computeToolFingerprint('1.0.0');

      expect(fp1).toBe(fp2);
      expect(fp1).toHaveLength(64);
    });

    it('produces different fingerprints for different versions', () => {
      const fp1 = computeToolFingerprint('1.0.0');
      const fp2 = computeToolFingerprint('2.0.0');

      expect(fp1).not.toBe(fp2);
    });
  });

  describe('Determinism', () => {
    it('produces deterministic hashes for identical inputs', () => {
      const events = createTestEvents();
      const caseData = buildIncidentCase({ events });
      const query = normalizeQuery({});

      const pack1 = buildEvidencePack({ caseData, events, query, seed: 1 });
      const pack2 = buildEvidencePack({ caseData, events, query, seed: 1 });

      expect(pack1.manifest.caseHash).toBe(pack2.manifest.caseHash);
      expect(pack1.manifest.eventsHash).toBe(pack2.manifest.eventsHash);
    });
  });

  describe('Empty Events', () => {
    it('handles empty event list', () => {
      const caseData = buildIncidentCase({ events: [] });
      const query = normalizeQuery({});

      const pack = buildEvidencePack({ caseData, events: [], query });

      expect(pack.events).toHaveLength(0);
      expect(pack.manifest.slotCursor.start).toBe(0);
      expect(pack.manifest.slotCursor.end).toBe(0);
    });
  });
});
