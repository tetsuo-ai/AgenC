import { describe, expect, it } from 'vitest';
import { ReplayComparisonService } from '../src/eval/replay-comparison.js';
import { REPLAY_CHAOS_TRANSITION_FIXTURE } from './fixtures/replay-chaos-transition-fixture.ts';

describe('transition chaos scenarios', () => {
  it('flags invalid open -> completed transition as transition_invalid', async () => {
    const fixture = REPLAY_CHAOS_TRANSITION_FIXTURE.scenarios.invalidOpenToCompleted;
    const result = await new ReplayComparisonService().compare({
      projected: fixture.projected,
      localTrace: fixture.localTrace,
      options: { strictness: 'lenient' },
    });

    expect(result.status).toBe('mismatched');
    expect(result.anomalies.some((entry) => entry.code === 'transition_invalid')).toBe(true);
  });

  it('flags duplicate completion sequences as duplicate_sequence', async () => {
    const fixture = REPLAY_CHAOS_TRANSITION_FIXTURE.scenarios.doubleCompletion;
    const result = await new ReplayComparisonService().compare({
      projected: fixture.projected,
      localTrace: fixture.localTrace,
      options: { strictness: 'lenient' },
    });

    expect(result.status).toBe('mismatched');
    const anomaly = result.anomalies.find((entry) => entry.code === 'duplicate_sequence');
    expect(anomaly?.severity).toBe('error');
  });

  it('flags dispute initiated on cancelled task as transition_invalid', async () => {
    const fixture = REPLAY_CHAOS_TRANSITION_FIXTURE.scenarios.disputeOnCancelled;
    const result = await new ReplayComparisonService().compare({
      projected: fixture.projected,
      localTrace: fixture.localTrace,
      options: { strictness: 'lenient' },
    });

    expect(result.status).toBe('mismatched');
    expect(result.anomalies.some((entry) => entry.code === 'transition_invalid')).toBe(true);
  });
});

