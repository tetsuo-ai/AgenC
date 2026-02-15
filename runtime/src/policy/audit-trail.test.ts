import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { stableStringifyJson, type JsonValue } from '../eval/types.js';
import { computeInputHash, computeOutputHash, InMemoryAuditTrail } from './audit-trail.js';

describe('audit-trail', () => {
  it('appends entries and maintains a valid hash chain', () => {
    const trail = new InMemoryAuditTrail();

    trail.append({
      timestamp: '2026-02-15T00:00:00.000Z',
      actor: 'alice',
      role: 'investigate',
      action: 'replay.incident',
      inputHash: computeInputHash({ taskPda: 'Task_A' }),
      outputHash: computeOutputHash({ status: 'ok' }),
    });
    trail.append({
      timestamp: '2026-02-15T00:00:01.000Z',
      actor: 'alice',
      role: 'investigate',
      action: 'replay.compare',
      inputHash: computeInputHash({ taskPda: 'Task_A' }),
      outputHash: computeOutputHash({ status: 'clean' }),
    });
    trail.append({
      timestamp: '2026-02-15T00:00:02.000Z',
      actor: 'bob',
      role: 'execute',
      action: 'replay.backfill',
      inputHash: computeInputHash({ to_slot: 1 }),
      outputHash: computeOutputHash({ processed: 1 }),
    });

    expect(trail.verify()).toEqual({ valid: true, entries: 3 });
  });

  it('detects tampering via verify()', () => {
    const trail = new InMemoryAuditTrail();
    trail.append({
      timestamp: '2026-02-15T00:00:00.000Z',
      actor: 'alice',
      role: 'investigate',
      action: 'replay.incident',
      inputHash: computeInputHash({}),
      outputHash: computeOutputHash({}),
    });
    trail.append({
      timestamp: '2026-02-15T00:00:01.000Z',
      actor: 'alice',
      role: 'investigate',
      action: 'replay.compare',
      inputHash: computeInputHash({}),
      outputHash: computeOutputHash({ ok: true }),
    });
    trail.append({
      timestamp: '2026-02-15T00:00:02.000Z',
      actor: 'alice',
      role: 'investigate',
      action: 'replay.compare',
      inputHash: computeInputHash({}),
      outputHash: computeOutputHash({ ok: true }),
    });

    const entries = trail.getAll() as unknown as Array<{ seq: number; outputHash: string }>;
    entries[1]!.outputHash = 'tampered';

    const verification = trail.verify();
    expect(verification.valid).toBe(false);
    expect(verification.brokenAt).toBe(2);
  });

  it('sets prevEntryHash to empty string for the first entry and computes entryHash deterministically', () => {
    const trail = new InMemoryAuditTrail();

    const entry = trail.append({
      timestamp: '2026-02-15T00:00:00.000Z',
      actor: 'alice',
      role: 'read',
      action: 'replay.incident',
      inputHash: computeInputHash({ taskPda: 'Task_A' }),
      outputHash: computeOutputHash({ status: 'ok' }),
    });

    expect(entry.seq).toBe(1);
    expect(entry.prevEntryHash).toBe('');

    const expectedCanonical = stableStringifyJson({
      seq: entry.seq,
      timestamp: entry.timestamp,
      actor: entry.actor,
      role: entry.role,
      action: entry.action,
      inputHash: entry.inputHash,
      outputHash: entry.outputHash,
      prevEntryHash: entry.prevEntryHash,
    } as unknown as JsonValue);
    const expectedHash = createHash('sha256').update(expectedCanonical).digest('hex');
    expect(entry.entryHash).toBe(expectedHash);
  });

  it('produces deterministic input/output hashes across calls', () => {
    const inputHash1 = computeInputHash({ b: 2, a: 1 });
    const inputHash2 = computeInputHash({ a: 1, b: 2 });
    expect(inputHash1).toBe(inputHash2);

    const outputHash1 = computeOutputHash({ status: 'ok', value: 1 });
    const outputHash2 = computeOutputHash({ value: 1, status: 'ok' });
    expect(outputHash1).toBe(outputHash2);
  });

  it('verifies empty audit trail as valid', () => {
    const trail = new InMemoryAuditTrail();
    expect(trail.verify()).toEqual({ valid: true, entries: 0 });
  });
});

