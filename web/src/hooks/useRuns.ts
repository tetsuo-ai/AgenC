import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  WS_RUNS_LIST,
  WS_RUN_INSPECT,
  WS_RUN_CONTROL,
  WS_RUN_UPDATED,
} from '../constants';
import type { RunControlAction, RunDetail, RunSummary, WSMessage } from '../types';

const POLL_INTERVAL_MS = 8_000;
const NOTIFICATION_PREF_KEY = 'agenc-run-browser-notifications';

interface UseRunsOptions {
  send: (msg: Record<string, unknown>) => void;
  connected: boolean;
}

export interface UseRunsReturn {
  runs: RunSummary[];
  selectedRun: RunDetail | null;
  selectedSessionId: string | null;
  loading: boolean;
  error: string | null;
  browserNotificationsEnabled: boolean;
  notificationPermission: NotificationPermission | 'unsupported';
  setSelectedSessionId: (sessionId: string | null) => void;
  refresh: () => void;
  inspect: (sessionId?: string) => void;
  control: (action: RunControlAction) => void;
  enableBrowserNotifications: () => Promise<void>;
  handleMessage: (msg: WSMessage) => void;
}

function supportsNotifications(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function useRuns({ send, connected }: UseRunsOptions): UseRunsReturn {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browserNotificationsEnabled, setBrowserNotificationsEnabled] = useState(() => {
    try {
      return localStorage.getItem(NOTIFICATION_PREF_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | 'unsupported'>(
    supportsNotifications() ? Notification.permission : 'unsupported',
  );
  const previousRunsRef = useRef<Map<string, { state: string; explanation: string }>>(new Map());
  const nextRequestIdRef = useRef(1);
  const pendingRequestIdsRef = useRef<Set<string>>(new Set());

  const issueRequest = useCallback((type: string, payload?: Record<string, unknown>) => {
    const id = `runs-${nextRequestIdRef.current++}`;
    pendingRequestIdsRef.current.add(id);
    send(payload ? { type, id, payload } : { type, id });
  }, [send]);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    issueRequest(WS_RUNS_LIST);
  }, [issueRequest]);

  const inspect = useCallback((sessionId?: string) => {
    const targetSessionId = sessionId ?? selectedSessionId;
    if (!targetSessionId) return;
    setLoading(true);
    setError(null);
    issueRequest(WS_RUN_INSPECT, { sessionId: targetSessionId });
  }, [issueRequest, selectedSessionId]);

  const control = useCallback((action: RunControlAction) => {
    setLoading(true);
    setError(null);
    issueRequest(WS_RUN_CONTROL, action as unknown as Record<string, unknown>);
  }, [issueRequest]);

  const enableBrowserNotifications = useCallback(async () => {
    if (!supportsNotifications()) {
      setNotificationPermission('unsupported');
      return;
    }
    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);
    if (permission === 'granted') {
      setBrowserNotificationsEnabled(true);
      localStorage.setItem(NOTIFICATION_PREF_KEY, 'true');
    }
  }, []);

  useEffect(() => {
    if (!connected) return;
    refresh();
    const timer = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [connected, refresh]);

  useEffect(() => {
    if (!supportsNotifications()) return;
    setNotificationPermission(Notification.permission);
  }, []);

  useEffect(() => {
    if (!browserNotificationsEnabled || notificationPermission !== 'granted') {
      previousRunsRef.current = new Map(
        runs.map((run) => [run.sessionId, { state: run.state, explanation: run.explanation }]),
      );
      return;
    }
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      previousRunsRef.current = new Map(
        runs.map((run) => [run.sessionId, { state: run.state, explanation: run.explanation }]),
      );
      return;
    }
    for (const run of runs) {
      const previous = previousRunsRef.current.get(run.sessionId);
      if (!previous) continue;
      if (previous.state === run.state && previous.explanation === run.explanation) {
        continue;
      }
      void new Notification(`Run ${run.state}: ${run.objective}`, {
        body: run.explanation,
        tag: `run:${run.sessionId}`,
      });
    }
    previousRunsRef.current = new Map(
      runs.map((run) => [run.sessionId, { state: run.state, explanation: run.explanation }]),
    );
  }, [browserNotificationsEnabled, notificationPermission, runs]);

  const handleMessage = useCallback((msg: WSMessage) => {
    if (msg.type === WS_RUNS_LIST) {
      if (msg.id) pendingRequestIdsRef.current.delete(msg.id);
      const nextRuns = (msg.payload as RunSummary[]) ?? [];
      setRuns(nextRuns);
      setLoading(false);
      setError(null);
      setSelectedSessionId((current) => {
        if (current && nextRuns.some((run) => run.sessionId === current)) {
          return current;
        }
        return nextRuns[0]?.sessionId ?? null;
      });
      return;
    }
    if (msg.type === WS_RUN_INSPECT || msg.type === WS_RUN_UPDATED) {
      if (msg.id) pendingRequestIdsRef.current.delete(msg.id);
      const detail = (msg.payload as RunDetail | undefined) ?? null;
      setSelectedRun(detail);
      if (detail?.sessionId) {
        setSelectedSessionId(detail.sessionId);
        setRuns((current) => {
          const summary = detail as RunSummary;
          const next = current.filter((run) => run.sessionId !== detail.sessionId);
          return [summary, ...next].sort((left, right) => right.updatedAt - left.updatedAt);
        });
      }
      setLoading(false);
      setError(null);
      return;
    }
    if (msg.type === 'error') {
      if (!msg.id || !pendingRequestIdsRef.current.has(msg.id)) {
        return;
      }
      pendingRequestIdsRef.current.delete(msg.id);
      setLoading(false);
      setError(msg.error ?? 'Run operation failed');
    }
  }, []);

  useEffect(() => {
    if (!connected || !selectedSessionId) return;
    inspect(selectedSessionId);
  }, [connected, inspect, selectedSessionId]);

  const stableRuns = useMemo(
    () => [...runs].sort((left, right) => right.updatedAt - left.updatedAt),
    [runs],
  );

  return {
    runs: stableRuns,
    selectedRun,
    selectedSessionId,
    loading,
    error,
    browserNotificationsEnabled,
    notificationPermission,
    setSelectedSessionId,
    refresh,
    inspect,
    control,
    enableBrowserNotifications,
    handleMessage,
  };
}
