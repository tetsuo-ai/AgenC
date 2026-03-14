import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentStatusView } from './AgentStatusView';
import type { GatewayStatus } from '../../types';

function makeStatus(
  overrides: Partial<GatewayStatus> = {},
): GatewayStatus {
  return {
    state: 'running',
    uptimeMs: 12_000,
    channels: ['webchat'],
    activeSessions: 2,
    controlPlanePort: 3100,
    agentName: 'alpha',
    backgroundRuns: {
      enabled: true,
      operatorAvailable: true,
      inspectAvailable: true,
      controlAvailable: true,
      multiAgentEnabled: true,
      activeTotal: 1,
      queuedSignalsTotal: 0,
      stateCounts: {
        pending: 0,
        running: 0,
        working: 1,
        blocked: 0,
        paused: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        suspended: 0,
      },
      recentAlerts: [],
      metrics: {
        startedTotal: 1,
        completedTotal: 0,
        failedTotal: 0,
        blockedTotal: 0,
        recoveredTotal: 0,
      },
    },
    ...overrides,
  };
}

describe('AgentStatusView', () => {
  it('shows durable-run disabled reason explicitly', () => {
    render(
      <AgentStatusView
        status={makeStatus({
          backgroundRuns: {
            ...makeStatus().backgroundRuns!,
            enabled: false,
            operatorAvailable: false,
            inspectAvailable: false,
            controlAvailable: false,
            disabledCode: 'background_runs_feature_disabled',
            disabledReason:
              'Durable background runs are disabled in autonomy feature flags.',
          },
        })}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByText('[DURABLE RUNS DISABLED]')).toBeTruthy();
    expect(
      screen.getByText('Durable background runs are disabled in autonomy feature flags.'),
    ).toBeTruthy();
    expect(screen.getByText('Durable Runs')).toBeTruthy();
    expect(screen.getByText('OFF')).toBeTruthy();
  });

  it('shows operator-ready state when durable supervision is online', () => {
    render(<AgentStatusView status={makeStatus()} onRefresh={vi.fn()} />);

    expect(screen.getByText('[OPERATOR READY]')).toBeTruthy();
    expect(screen.getByText('READY')).toBeTruthy();
  });
});
