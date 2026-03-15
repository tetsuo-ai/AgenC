import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useRuns } from './useRuns';
import type {
  GatewayStatus,
  RunDetail,
  RunSummary,
  WSMessage,
} from '../types';

type UseRunsHook = ReturnType<typeof useRuns> & {
  handleMessage: (msg: WSMessage) => void;
};

function makeRunSummary(sessionId = 'session-run-1'): RunSummary {
  return {
    runId: `run-${sessionId}`,
    sessionId,
    objective: 'Watch the managed process.',
    state: 'working',
    currentPhase: 'active',
    explanation: 'Run is active and waiting for the next verification cycle.',
    unsafeToContinue: false,
    createdAt: 1,
    updatedAt: 2,
    lastVerifiedAt: 2,
    nextCheckAt: 4_000,
    nextHeartbeatAt: 12_000,
    cycleCount: 1,
    contractKind: 'finite',
    contractDomain: 'generic',
    requiresUserStop: false,
    pendingSignals: 0,
    watchCount: 1,
    fenceToken: 1,
    lastUserUpdate: 'Watching the process.',
    lastToolEvidence: 'system.processStatus -> running',
    lastWakeReason: 'tool_result',
    carryForwardSummary: 'Continue monitoring.',
    blockerSummary: undefined,
    approvalRequired: false,
    approvalState: 'none',
    checkpointAvailable: true,
    preferredWorkerId: 'worker-a',
    workerAffinityKey: sessionId,
  };
}

function makeRunDetail(sessionId = 'session-run-1'): RunDetail {
  return {
    ...makeRunSummary(sessionId),
    availability: {
      enabled: true,
      operatorAvailable: true,
      inspectAvailable: true,
      controlAvailable: true,
    },
    policyScope: {
      tenantId: 'tenant-a',
      projectId: 'project-x',
      runId: `run-${sessionId}`,
    },
    contract: {
      domain: 'generic',
      kind: 'finite',
      successCriteria: ['Observe completion.'],
      completionCriteria: ['Verify terminal evidence.'],
      blockedCriteria: ['Missing evidence.'],
      nextCheckMs: 4_000,
      heartbeatMs: 12_000,
      requiresUserStop: false,
      managedProcessPolicy: { mode: 'none' },
    },
    blocker: undefined,
    approval: { status: 'none', summary: undefined },
    budget: {
      runtimeStartedAt: 1,
      lastActivityAt: 2,
      lastProgressAt: 2,
      totalTokens: 4,
      lastCycleTokens: 2,
      managedProcessCount: 1,
      maxRuntimeMs: 60_000,
      maxCycles: 32,
      maxIdleMs: 10_000,
      nextCheckIntervalMs: 4_000,
      heartbeatIntervalMs: 12_000,
      firstAcknowledgedAt: 1,
      firstVerifiedUpdateAt: 2,
      stopRequestedAt: undefined,
    },
    compaction: {
      lastCompactedAt: undefined,
      lastCompactedCycle: 0,
      refreshCount: 0,
      lastHistoryLength: 2,
      lastMilestoneAt: undefined,
      lastCompactionReason: undefined,
      repairCount: 0,
      lastProviderAnchorAt: undefined,
    },
    artifacts: [],
    observedTargets: [],
    watchRegistrations: [],
    recentEvents: [],
  };
}

function makeBackgroundRunStatus(
  overrides: Partial<NonNullable<GatewayStatus['backgroundRuns']>> = {},
): NonNullable<GatewayStatus['backgroundRuns']> {
  return {
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
    ...overrides,
  };
}

describe('useRuns', () => {
  it('requests list and inspect flows and updates local state', () => {
    const send = vi.fn();
    const backgroundRunStatus = makeBackgroundRunStatus();
    const { result, unmount } = renderHook(() =>
      useRuns({ send, connected: false, backgroundRunStatus }),
    );

    act(() => {
      result.current.refresh();
    });

    const listRequest = send.mock.calls[0]?.[0] as { id: string; type: string };
    expect(listRequest.type).toBe('runs.list');
    expect(listRequest.id).toMatch(/^runs-\d+$/);

    act(() => {
      (result.current as UseRunsHook).handleMessage({
        type: 'runs.list',
        id: listRequest.id,
        payload: [makeRunSummary()],
      });
    });

    expect(result.current.runs).toHaveLength(1);
    expect(result.current.selectedSessionId).toBe('session-run-1');

    act(() => {
      result.current.inspect();
    });

    const inspectRequest = send.mock.calls[1]?.[0] as { id: string; type: string };
    expect(inspectRequest.type).toBe('run.inspect');

    act(() => {
      (result.current as UseRunsHook).handleMessage({
        type: 'run.inspect',
        id: inspectRequest.id,
        payload: makeRunDetail(),
      });
    });

    expect(result.current.selectedRun?.sessionId).toBe('session-run-1');
    expect(result.current.error).toBeNull();
    unmount();
  });

  it('ignores unrelated errors and only applies errors for matching run requests', () => {
    const send = vi.fn();
    const backgroundRunStatus = makeBackgroundRunStatus();
    const { result, unmount } = renderHook(() =>
      useRuns({ send, connected: false, backgroundRunStatus }),
    );

    act(() => {
      (result.current as UseRunsHook).handleMessage({
        type: 'error',
        id: 'foreign-request',
        error: 'not for runs',
      });
    });

    expect(result.current.error).toBeNull();

    act(() => {
      result.current.refresh();
    });

    const request = send.mock.calls[0]?.[0] as { id: string; type: string };
    act(() => {
      (result.current as UseRunsHook).handleMessage({
        type: 'error',
        id: request.id,
        error: 'run list failed',
      });
    });

    expect(result.current.error).toBe('run list failed');
    unmount();
  });

  it('exposes disabled operator availability from status and structured inspect errors', () => {
    const send = vi.fn();
    const { result, rerender, unmount } = renderHook(
      ({ backgroundRunStatus }) => useRuns({ send, connected: false, backgroundRunStatus }),
      {
        initialProps: {
          backgroundRunStatus: makeBackgroundRunStatus({
            enabled: false,
            operatorAvailable: false,
            inspectAvailable: false,
            controlAvailable: false,
            disabledCode: 'background_runs_feature_disabled',
            disabledReason: 'Durable background runs are disabled in autonomy feature flags.',
          }),
        },
      },
    );

    expect(result.current.operatorAvailability?.enabled).toBe(false);
    expect(result.current.runNotice).toContain('disabled');

    rerender({ backgroundRunStatus: makeBackgroundRunStatus() });

    act(() => {
      result.current.inspect('session-run-1');
    });

    const inspectRequest = send.mock.calls[0]?.[0] as { id: string };
    act(() => {
      (result.current as UseRunsHook).handleMessage({
        type: 'error',
        id: inspectRequest.id,
        error: 'No active durable background run for session "session-run-1"',
        payload: {
          code: 'background_run_missing',
          sessionId: 'session-run-1',
          backgroundRunAvailability: {
            enabled: true,
            operatorAvailable: true,
            inspectAvailable: true,
            controlAvailable: true,
          },
        },
      });
    });

    expect(result.current.error).toBeNull();
    expect(result.current.runNotice).toContain('No active durable background run');
    expect(result.current.operatorAvailability?.operatorAvailable).toBe(true);
    unmount();
  });
});
