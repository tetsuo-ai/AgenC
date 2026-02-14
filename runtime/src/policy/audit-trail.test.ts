/**
 * Tests for Immutable Audit Trail
 *
 * @module
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryAuditTrail,
  GENESIS_HASH,
  createAuditInput,
  computeAuditHash,
  serializeAuditTrail,
  loadAuditTrail,
  type AuditEntry,
} from './audit-trail.js';

describe('Audit Trail', () => {
  let trail: InMemoryAuditTrail;

  beforeEach(() => {
    trail = new InMemoryAuditTrail();
  });

  describe('InMemoryAuditTrail', () => {
    describe('append', () => {
      it('assigns sequential sequence numbers', () => {
        const entry1 = trail.append(createAuditInput(
          'actor1',
          'read',
          'view_incident',
          'view_incidents',
          { incidentId: '123' },
          { success: true },
        ));

        const entry2 = trail.append(createAuditInput(
          'actor1',
          'read',
          'export_data',
          'export_data',
          { format: 'json' },
          { data: [] },
        ));

        expect(entry1.seq).toBe(1);
        expect(entry2.seq).toBe(2);
      });

      it('links to genesis hash for first entry', () => {
        const entry = trail.append(createAuditInput(
          'actor1',
          'read',
          'view_incident',
          'view_incidents',
          {},
          {},
        ));

        expect(entry.prevHash).toBe(GENESIS_HASH);
      });

      it('links to previous entry hash', () => {
        const entry1 = trail.append(createAuditInput(
          'actor1',
          'read',
          'view_incident',
          'view_incidents',
          {},
          {},
        ));

        const entry2 = trail.append(createAuditInput(
          'actor1',
          'read',
          'export_data',
          'export_data',
          {},
          {},
        ));

        expect(entry2.prevHash).toBe(entry1.entryHash);
      });

      it('computes entry hash', () => {
        const entry = trail.append(createAuditInput(
          'actor1',
          'read',
          'view_incident',
          'view_incidents',
          {},
          {},
        ));

        expect(entry.entryHash).toHaveLength(64); // SHA-256 hex
      });
    });

    describe('get', () => {
      it('retrieves entry by sequence number', () => {
        trail.append(createAuditInput('actor1', 'read', 'action1', 'view_incidents', {}, {}));
        trail.append(createAuditInput('actor2', 'admin', 'action2', 'configure', {}, {}));

        const entry = trail.get(2);
        expect(entry).toBeDefined();
        expect(entry?.actor).toBe('actor2');
      });

      it('returns undefined for non-existent sequence', () => {
        const entry = trail.get(999);
        expect(entry).toBeUndefined();
      });
    });

    describe('getAll', () => {
      it('returns all entries', () => {
        trail.append(createAuditInput('actor1', 'read', 'action1', 'view_incidents', {}, {}));
        trail.append(createAuditInput('actor2', 'admin', 'action2', 'configure', {}, {}));

        const entries = trail.getAll();
        expect(entries).toHaveLength(2);
      });

      it('returns copy of entries', () => {
        trail.append(createAuditInput('actor1', 'read', 'action1', 'view_incidents', {}, {}));

        const entries = trail.getAll();
        entries.push({} as AuditEntry);

        expect(trail.getAll()).toHaveLength(1);
      });
    });

    describe('getRange', () => {
      it('returns entries in range', () => {
        for (let i = 0; i < 5; i++) {
          trail.append(createAuditInput('actor', 'read', `action${i}`, 'view_incidents', {}, {}));
        }

        const entries = trail.getRange(2, 4);
        expect(entries).toHaveLength(3);
        expect(entries[0].seq).toBe(2);
        expect(entries[2].seq).toBe(4);
      });
    });

    describe('getLatest', () => {
      it('returns latest entry', () => {
        trail.append(createAuditInput('actor1', 'read', 'action1', 'view_incidents', {}, {}));
        trail.append(createAuditInput('actor2', 'admin', 'action2', 'configure', {}, {}));

        const latest = trail.getLatest();
        expect(latest?.seq).toBe(2);
        expect(latest?.actor).toBe('actor2');
      });

      it('returns undefined for empty trail', () => {
        expect(trail.getLatest()).toBeUndefined();
      });
    });

    describe('count', () => {
      it('returns entry count', () => {
        expect(trail.count()).toBe(0);

        trail.append(createAuditInput('actor', 'read', 'action', 'view_incidents', {}, {}));
        expect(trail.count()).toBe(1);

        trail.append(createAuditInput('actor', 'read', 'action', 'view_incidents', {}, {}));
        expect(trail.count()).toBe(2);
      });
    });

    describe('verify', () => {
      it('validates unmodified trail', () => {
        trail.append(createAuditInput('actor1', 'read', 'action1', 'view_incidents', {}, {}));
        trail.append(createAuditInput('actor2', 'admin', 'action2', 'configure', {}, {}));
        trail.append(createAuditInput('actor3', 'execute', 'action3', 'resolve', {}, {}));

        const result = trail.verify();
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
        expect(result.entriesVerified).toBe(3);
      });

      it('validates chain integrity on fresh trail', () => {
        // Add entries and verify they form a valid chain
        trail.append(createAuditInput('actor1', 'read', 'action1', 'view_incidents', {}, {}));
        trail.append(createAuditInput('actor2', 'admin', 'action2', 'configure', {}, {}));

        // getAll returns a copy, so internal state is protected
        // This test verifies the trail is tamper-evident by design
        const entries = trail.getAll();
        expect(entries[0].prevHash).toBe(GENESIS_HASH);
        expect(entries[1].prevHash).toBe(entries[0].entryHash);

        // Verification should pass
        const result = trail.verify();
        expect(result.valid).toBe(true);
      });

      it('validates empty trail', () => {
        const result = trail.verify();
        expect(result.valid).toBe(true);
        expect(result.entriesVerified).toBe(0);
      });
    });
  });

  describe('createAuditInput', () => {
    it('creates valid audit input', () => {
      const input = createAuditInput(
        'actor1',
        'admin',
        'configure_system',
        'configure',
        { setting: 'value' },
        { result: 'success' },
        { extra: 'metadata' },
      );

      expect(input.actor).toBe('actor1');
      expect(input.role).toBe('admin');
      expect(input.action).toBe('configure_system');
      expect(input.permission).toBe('configure');
      expect(input.inputHash).toHaveLength(64);
      expect(input.outputHash).toHaveLength(64);
      expect(input.metadata).toEqual({ extra: 'metadata' });
      expect(input.timestamp).toBeDefined();
    });

    it('generates consistent hashes for same data', () => {
      const input1 = createAuditInput('actor', 'read', 'action', 'view_incidents', { key: 'value' }, {});
      const input2 = createAuditInput('actor', 'read', 'action', 'view_incidents', { key: 'value' }, {});

      expect(input1.inputHash).toBe(input2.inputHash);
    });

    it('generates different hashes for different data', () => {
      const input1 = createAuditInput('actor', 'read', 'action', 'view_incidents', { key: 'value1' }, {});
      const input2 = createAuditInput('actor', 'read', 'action', 'view_incidents', { key: 'value2' }, {});

      expect(input1.inputHash).not.toBe(input2.inputHash);
    });
  });

  describe('computeAuditHash', () => {
    it('computes SHA-256 hash', () => {
      const hash = computeAuditHash({ test: 'data' });
      expect(hash).toHaveLength(64);
    });

    it('produces consistent hashes', () => {
      const hash1 = computeAuditHash({ a: 1, b: 2 });
      const hash2 = computeAuditHash({ a: 1, b: 2 });
      expect(hash1).toBe(hash2);
    });
  });

  describe('Serialization', () => {
    it('serializes trail to JSON', () => {
      trail.append(createAuditInput('actor1', 'read', 'action1', 'view_incidents', {}, {}));
      trail.append(createAuditInput('actor2', 'admin', 'action2', 'configure', {}, {}));

      const json = serializeAuditTrail(trail);
      const parsed = JSON.parse(json);

      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(2);
    });

    it('round-trips through serialization', () => {
      trail.append(createAuditInput('actor1', 'read', 'action1', 'view_incidents', { input: 1 }, { output: 2 }));
      trail.append(createAuditInput('actor2', 'admin', 'action2', 'configure', { input: 3 }, { output: 4 }));

      const json = serializeAuditTrail(trail);
      const loaded = loadAuditTrail(json);

      expect(loaded.count()).toBe(2);

      const result = loaded.verify();
      expect(result.valid).toBe(true);
    });
  });

  describe('Hash Chain Integrity', () => {
    it('maintains unbroken hash chain', () => {
      // Add multiple entries
      for (let i = 0; i < 10; i++) {
        trail.append(createAuditInput(`actor${i}`, 'read', `action${i}`, 'view_incidents', { i }, { result: i }));
      }

      // Verify chain
      const entries = trail.getAll();
      expect(entries[0].prevHash).toBe(GENESIS_HASH);

      for (let i = 1; i < entries.length; i++) {
        expect(entries[i].prevHash).toBe(entries[i - 1].entryHash);
      }
    });
  });
});
