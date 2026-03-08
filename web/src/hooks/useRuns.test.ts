import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useRuns } from './useRuns';
import type { RunDetail, RunSummary, WSMessage } from '../types';

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

describe('useRuns', () => {
  it('requests list and inspect flows and updates local state', () => {
    const send = vi.fn();
    const { result } = renderHook(() => useRuns({ send, connected: false }));

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
  });

  it('ignores unrelated errors and only applies errors for matching run requests', () => {
    const send = vi.fn();
    const { result } = renderHook(() => useRuns({ send, connected: false }));

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
  });
});
