// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useObservability } from './useObservability';
import type {
  TraceArtifact,
  TraceDetail,
  TraceLogTail,
  TraceSummary,
  TraceSummaryMetrics,
  WSMessage,
} from '../types';

type UseObservabilityHook = ReturnType<typeof useObservability> & {
  handleMessage: (msg: WSMessage) => void;
};

function makeTraceSummary(): TraceSummary {
  return {
    traceId: 'trace-1',
    sessionId: 'session-1',
    startedAt: 1,
    updatedAt: 2,
    eventCount: 2,
    errorCount: 0,
    status: 'completed',
    lastEventName: 'webchat.chat.response',
    stopReason: 'completed',
  };
}

function makeTraceDetail(): TraceDetail {
  return {
    summary: makeTraceSummary(),
    completeness: {
      complete: true,
      issues: [],
    },
    events: [
      {
        id: 'event-1',
        eventName: 'webchat.provider.request',
        level: 'info',
        traceId: 'trace-1',
        sessionId: 'session-1',
        timestampMs: 1,
        routingMiss: false,
        payloadPreview: { toolChoice: 'required' },
      },
      {
        id: 'event-2',
        eventName: 'webchat.provider.response',
        level: 'info',
        traceId: 'trace-1',
        sessionId: 'session-1',
        timestampMs: 2,
        routingMiss: false,
        payloadPreview: { finishReason: 'tool_calls' },
        artifact: {
          path: '/home/tetsuo/.agenc/trace-payloads/trace-1/provider.json',
          sha256: 'abc',
          bytes: 64,
        },
      },
    ],
  };
}

describe('useObservability', () => {
  it('requests summary and traces, then loads selected trace and artifact', () => {
    const send = vi.fn();
    const { result } = renderHook(() => useObservability({ send, connected: true }));

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).toMatchObject({ type: 'observability.summary' });
    expect(send.mock.calls[1]?.[0]).toMatchObject({ type: 'observability.traces' });

    const summaryRequestId = send.mock.calls[0]?.[0].id as string;
    const tracesRequestId = send.mock.calls[1]?.[0].id as string;

    act(() => {
      (result.current as UseObservabilityHook).handleMessage({
        type: 'observability.summary',
        id: summaryRequestId,
        payload: {
          windowMs: 60_000,
          traces: {
            total: 1,
            completed: 1,
            errors: 0,
            open: 0,
            completenessRate: 1,
          },
          events: {
            providerErrors: 0,
            toolRejections: 0,
            routeMisses: 0,
            completionGateFailures: 0,
          },
          topTools: [{ name: 'mcp.doom.start_game', count: 1 }],
          topStopReasons: [{ name: 'completed', count: 1 }],
        } satisfies TraceSummaryMetrics,
      });
      (result.current as UseObservabilityHook).handleMessage({
        type: 'observability.traces',
        id: tracesRequestId,
        payload: [makeTraceSummary()],
      });
    });

    expect(result.current.summary?.traces.total).toBe(1);
    expect(result.current.traces).toHaveLength(1);
    expect(result.current.selectedTraceId).toBe('trace-1');

    act(() => {
      result.current.setSelectedTraceId('trace-1');
    });

    const traceRequest = send.mock.calls.find(
      ([message]) => (message as Record<string, unknown>).type === 'observability.trace',
    )?.[0] as { id: string } | undefined;
    expect(traceRequest?.id).toBeTruthy();

    act(() => {
      (result.current as UseObservabilityHook).handleMessage({
        type: 'observability.trace',
        id: traceRequest?.id,
        payload: makeTraceDetail(),
      });
    });

    expect(result.current.selectedTrace?.summary.traceId).toBe('trace-1');
    expect(result.current.selectedEventId).toBe('event-1');

    act(() => {
      result.current.setSelectedEventId('event-2');
    });

    const artifactRequest = send.mock.calls.find(
      ([message]) => (message as Record<string, unknown>).type === 'observability.artifact',
    )?.[0] as { id: string } | undefined;
    expect(artifactRequest?.id).toBeTruthy();

    act(() => {
      (result.current as UseObservabilityHook).handleMessage({
        type: 'observability.artifact',
        id: artifactRequest?.id,
        payload: {
          path: '/home/tetsuo/.agenc/trace-payloads/trace-1/provider.json',
          body: { payload: { ok: true } },
        } satisfies TraceArtifact,
      });
    });

    expect(result.current.artifact?.path).toContain('trace-1/provider.json');
  });

  it('tracks log responses and surfaces request-scoped errors', () => {
    const send = vi.fn();
    const { result } = renderHook(() => useObservability({ send, connected: true }));

    act(() => {
      result.current.setSelectedTraceId('trace-1');
    });

    const logsRequest = send.mock.calls.find(
      ([message]) => (message as Record<string, unknown>).type === 'observability.logs',
    )?.[0] as { id: string } | undefined;

    act(() => {
      (result.current as UseObservabilityHook).handleMessage({
        type: 'observability.logs',
        id: logsRequest?.id,
        payload: {
          path: '/home/tetsuo/.agenc/daemon.log',
          lines: ['trace-1 line'],
        } satisfies TraceLogTail,
      });
    });

    expect(result.current.logs?.lines).toEqual(['trace-1 line']);

    act(() => {
      result.current.refresh();
    });

    const latestSummaryRequest = [...send.mock.calls]
      .reverse()
      .find(
        ([message]: unknown[]) =>
          ((message as Record<string, unknown>)?.type as string | undefined) ===
          'observability.summary',
      )?.[0] as { id: string } | undefined;

    act(() => {
      (result.current as UseObservabilityHook).handleMessage({
        type: 'error',
        id: latestSummaryRequest?.id,
        error: 'summary failed',
      });
    });

    expect(result.current.error).toBe('summary failed');
  });
});
