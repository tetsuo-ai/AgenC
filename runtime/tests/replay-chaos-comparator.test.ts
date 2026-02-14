import { describe, expect, it } from 'vitest';
import { ReplayComparisonService } from '../src/eval/replay-comparison.js';
import { REPLAY_CHAOS_COMPARATOR_FIXTURE } from './fixtures/replay-chaos-comparator-fixture.ts';

describe('replay comparator chaos scenarios', () => {
  it('detects hash mismatch when projected payload differs', async () => {
    const fixture = REPLAY_CHAOS_COMPARATOR_FIXTURE.scenarios.hashMismatch;
    const result = await new ReplayComparisonService().compare({
      projected: fixture.projected,
      localTrace: fixture.localTrace,
      options: { strictness: 'lenient' },
    });

    expect(result.status).toBe('mismatched');
    const anomaly = result.anomalies.find((entry) => entry.code === 'hash_mismatch');
    expect(anomaly?.severity).toBe('error');
  });

  it('detects missing event when local trace drops a projected event', async () => {
    const fixture = REPLAY_CHAOS_COMPARATOR_FIXTURE.scenarios.missingEvent;
    const result = await new ReplayComparisonService().compare({
      projected: fixture.projected,
      localTrace: fixture.localTrace,
      options: { strictness: 'lenient' },
    });

    expect(result.status).toBe('mismatched');
    expect(result.anomalies.some((entry) => entry.code === 'missing_event')).toBe(true);
  });

  it('detects unexpected event when local trace includes an extra event', async () => {
    const fixture = REPLAY_CHAOS_COMPARATOR_FIXTURE.scenarios.unexpectedEvent;
    const result = await new ReplayComparisonService().compare({
      projected: fixture.projected,
      localTrace: fixture.localTrace,
      options: { strictness: 'lenient' },
    });

    expect(result.status).toBe('mismatched');
    expect(result.anomalies.some((entry) => entry.code === 'unexpected_event')).toBe(true);
  });

  it('detects type mismatch when local event type changes', async () => {
    const fixture = REPLAY_CHAOS_COMPARATOR_FIXTURE.scenarios.typeMismatch;
    const result = await new ReplayComparisonService().compare({
      projected: fixture.projected,
      localTrace: fixture.localTrace,
      options: { strictness: 'lenient' },
    });

    expect(result.status).toBe('mismatched');
    const anomaly = result.anomalies.find((entry) => entry.code === 'type_mismatch');
    expect(anomaly?.severity).toBe('error');
  });
});

