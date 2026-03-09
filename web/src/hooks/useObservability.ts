import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  WS_OBSERVABILITY_ARTIFACT,
  WS_OBSERVABILITY_LOGS,
  WS_OBSERVABILITY_SUMMARY,
  WS_OBSERVABILITY_TRACE,
  WS_OBSERVABILITY_TRACES,
} from '../constants';
import type {
  TraceArtifact,
  TraceDetail,
  TraceEvent,
  TraceLogTail,
  TraceStatus,
  TraceSummary,
  TraceSummaryMetrics,
  WSMessage,
} from '../types';

const POLL_INTERVAL_MS = 8_000;

interface UseObservabilityOptions {
  send: (msg: Record<string, unknown>) => void;
  connected: boolean;
}

type PendingKind =
  | 'summary'
  | 'traces'
  | 'trace'
  | 'artifact'
  | 'logs';

export interface UseObservabilityReturn {
  summary: TraceSummaryMetrics | null;
  traces: TraceSummary[];
  selectedTraceId: string | null;
  selectedTrace: TraceDetail | null;
  selectedEventId: string | null;
  selectedEvent: TraceEvent | null;
  artifact: TraceArtifact | null;
  logs: TraceLogTail | null;
  loading: boolean;
  error: string | null;
  search: string;
  status: TraceStatus;
  setSearch: (value: string) => void;
  setStatus: (value: TraceStatus) => void;
  setSelectedTraceId: (traceId: string | null) => void;
  setSelectedEventId: (eventId: string | null) => void;
  refresh: () => void;
  handleMessage: (msg: WSMessage) => void;
}

export function useObservability({
  send,
  connected,
}: UseObservabilityOptions): UseObservabilityReturn {
  const [summary, setSummary] = useState<TraceSummaryMetrics | null>(null);
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [selectedTrace, setSelectedTrace] = useState<TraceDetail | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [artifact, setArtifact] = useState<TraceArtifact | null>(null);
  const [logs, setLogs] = useState<TraceLogTail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<TraceStatus>('all');
  const nextRequestIdRef = useRef(1);
  const pendingRequestsRef = useRef<Map<string, PendingKind>>(new Map());

  const issueRequest = useCallback(
    (kind: PendingKind, type: string, payload?: Record<string, unknown>) => {
      const id = `obs-${nextRequestIdRef.current++}`;
      pendingRequestsRef.current.set(id, kind);
      setLoading(true);
      send(payload ? { type, id, payload } : { type, id });
      return id;
    },
    [send],
  );

  const resolvePendingRequest = useCallback((id?: string) => {
    if (id) {
      pendingRequestsRef.current.delete(id);
    }
    setLoading(pendingRequestsRef.current.size > 0);
  }, []);

  const refreshList = useCallback(() => {
    setError(null);
    issueRequest('summary', WS_OBSERVABILITY_SUMMARY);
    issueRequest('traces', WS_OBSERVABILITY_TRACES, {
      limit: 100,
      ...(search.trim().length > 0 ? { search: search.trim() } : {}),
      ...(status !== 'all' ? { status } : {}),
    });
  }, [issueRequest, search, status]);

  const refreshSelectedTrace = useCallback((traceId: string) => {
    setError(null);
    issueRequest('trace', WS_OBSERVABILITY_TRACE, { traceId });
    issueRequest('logs', WS_OBSERVABILITY_LOGS, {
      traceId,
      lines: 200,
    });
  }, [issueRequest]);

  const refresh = useCallback(() => {
    refreshList();
    if (selectedTraceId) {
      refreshSelectedTrace(selectedTraceId);
    }
  }, [refreshList, refreshSelectedTrace, selectedTraceId]);

  useEffect(() => {
    if (!connected) {
      return;
    }
    refreshList();
    const timer = setInterval(refreshList, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [connected, refreshList]);

  useEffect(() => {
    if (!connected || !selectedTraceId) {
      setSelectedTrace(null);
      setSelectedEventId(null);
      setArtifact(null);
      setLogs(null);
      return;
    }
    setLoading(true);
    setError(null);
    refreshSelectedTrace(selectedTraceId);
  }, [connected, refreshSelectedTrace, selectedTraceId]);

  const selectedEvent = useMemo(() => {
    if (!selectedTrace || !selectedEventId) {
      return null;
    }
    return selectedTrace.events.find((event) => event.id === selectedEventId) ?? null;
  }, [selectedEventId, selectedTrace]);

  useEffect(() => {
    if (!selectedTrace) {
      setSelectedEventId(null);
      setArtifact(null);
      return;
    }
    if (
      !selectedEventId ||
      !selectedTrace.events.some((event) => event.id === selectedEventId)
    ) {
      setSelectedEventId(selectedTrace.events[0]?.id ?? null);
    }
  }, [selectedEventId, selectedTrace]);

  useEffect(() => {
    if (!connected || !selectedTraceId || !selectedEvent?.artifact?.path) {
      setArtifact(null);
      return;
    }
    setLoading(true);
    issueRequest('artifact', WS_OBSERVABILITY_ARTIFACT, {
      traceId: selectedTraceId,
      path: selectedEvent.artifact.path,
    });
  }, [connected, issueRequest, selectedEvent, selectedTraceId]);

  const handleMessage = useCallback((msg: WSMessage) => {
    const pendingKind = msg.id ? pendingRequestsRef.current.get(msg.id) : undefined;

    if (msg.type === WS_OBSERVABILITY_SUMMARY) {
      resolvePendingRequest(msg.id);
      setSummary((msg.payload as TraceSummaryMetrics | undefined) ?? null);
      setError(null);
      return;
    }

    if (msg.type === WS_OBSERVABILITY_TRACES) {
      resolvePendingRequest(msg.id);
      const nextTraces = ((msg.payload as TraceSummary[] | undefined) ?? []).slice();
      setTraces(nextTraces);
      setSelectedTraceId((current) => {
        if (current && nextTraces.some((trace) => trace.traceId === current)) {
          return current;
        }
        return nextTraces[0]?.traceId ?? null;
      });
      setError(null);
      return;
    }

    if (msg.type === WS_OBSERVABILITY_TRACE) {
      resolvePendingRequest(msg.id);
      setSelectedTrace((msg.payload as TraceDetail | undefined) ?? null);
      setError(null);
      return;
    }

    if (msg.type === WS_OBSERVABILITY_ARTIFACT) {
      resolvePendingRequest(msg.id);
      setArtifact((msg.payload as TraceArtifact | undefined) ?? null);
      setError(null);
      return;
    }

    if (msg.type === WS_OBSERVABILITY_LOGS) {
      resolvePendingRequest(msg.id);
      setLogs((msg.payload as TraceLogTail | undefined) ?? null);
      setError(null);
      return;
    }

    if (msg.type === 'error' && msg.id && pendingKind) {
      resolvePendingRequest(msg.id);
      if (pendingKind === 'artifact') {
        setArtifact(null);
      }
      setError(msg.error ?? 'Observability request failed');
    }
  }, [resolvePendingRequest]);

  return {
    summary,
    traces,
    selectedTraceId,
    selectedTrace,
    selectedEventId,
    selectedEvent,
    artifact,
    logs,
    loading,
    error,
    search,
    status,
    setSearch,
    setStatus,
    setSelectedTraceId,
    setSelectedEventId,
    refresh,
    handleMessage,
  };
}
