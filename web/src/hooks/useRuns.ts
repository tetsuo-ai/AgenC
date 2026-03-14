import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  WS_RUNS_LIST,
  WS_RUN_INSPECT,
  WS_RUN_CONTROL,
  WS_RUN_UPDATED,
} from '../constants';
import type {
  GatewayStatus,
  RunControlAction,
  RunDetail,
  RunOperatorAvailability,
  RunOperatorErrorPayload,
  RunSummary,
  WSMessage,
} from '../types';

const POLL_INTERVAL_MS = 8_000;
const NOTIFICATION_PREF_KEY = 'agenc-run-browser-notifications';

interface UseRunsOptions {
  send: (msg: Record<string, unknown>) => void;
  connected: boolean;
  backgroundRunStatus?: GatewayStatus['backgroundRuns'] | null;
}

export interface UseRunsReturn {
  runs: RunSummary[];
  selectedRun: RunDetail | null;
  selectedSessionId: string | null;
  loading: boolean;
  error: string | null;
  runNotice: string | null;
  operatorAvailability: RunOperatorAvailability | null;
  browserNotificationsEnabled: boolean;
  notificationPermission: NotificationPermission | 'unsupported';
  setSelectedSessionId: (sessionId: string | null) => void;
  refresh: () => void;
  inspect: (sessionId?: string) => void;
  control: (action: RunControlAction) => void;
  enableBrowserNotifications: () => Promise<void>;
  handleMessage: (msg: WSMessage) => void;
}

function getBrowserStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function getNotificationApi(): typeof window.Notification | null {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return null;
  }
  return window.Notification;
}

function toOperatorAvailability(
  status: GatewayStatus['backgroundRuns'] | null | undefined,
): RunOperatorAvailability | null {
  if (!status) return null;
  return {
    enabled: status.enabled,
    operatorAvailable: status.operatorAvailable,
    inspectAvailable: status.inspectAvailable,
    controlAvailable: status.controlAvailable,
    disabledCode: status.disabledCode,
    disabledReason: status.disabledReason,
  };
}

function operatorAvailabilityEquals(
  left: RunOperatorAvailability | null,
  right: RunOperatorAvailability | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.enabled === right.enabled
    && left.operatorAvailable === right.operatorAvailable
    && left.inspectAvailable === right.inspectAvailable
    && left.controlAvailable === right.controlAvailable
    && left.disabledCode === right.disabledCode
    && left.disabledReason === right.disabledReason
  );
}

export function useRuns({
  send,
  connected,
  backgroundRunStatus = null,
}: UseRunsOptions): UseRunsReturn {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runNotice, setRunNotice] = useState<string | null>(null);
  const [operatorAvailability, setOperatorAvailability] = useState<RunOperatorAvailability | null>(
    () => toOperatorAvailability(backgroundRunStatus),
  );
  const [browserNotificationsEnabled, setBrowserNotificationsEnabled] = useState(() => {
    try {
      return getBrowserStorage()?.getItem(NOTIFICATION_PREF_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | 'unsupported'>(
    getNotificationApi()?.permission ?? 'unsupported',
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
    const notificationApi = getNotificationApi();
    if (!notificationApi) {
      setNotificationPermission('unsupported');
      return;
    }
    const permission = await notificationApi.requestPermission();
    setNotificationPermission(permission);
    if (permission === 'granted') {
      setBrowserNotificationsEnabled(true);
      getBrowserStorage()?.setItem(NOTIFICATION_PREF_KEY, 'true');
    }
  }, []);

  useEffect(() => {
    if (!connected) return;
    refresh();
    const timer = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [connected, refresh]);

  useEffect(() => {
    const nextAvailability = toOperatorAvailability(backgroundRunStatus);
    if (nextAvailability) {
      setOperatorAvailability((current) =>
        operatorAvailabilityEquals(current, nextAvailability) ? current : nextAvailability,
      );
      if (!nextAvailability.enabled || !nextAvailability.operatorAvailable) {
        setRunNotice(
          nextAvailability.disabledReason ??
            'Durable background runs are not available for this runtime.',
        );
      } else {
        setRunNotice(null);
      }
      return;
    }
    setOperatorAvailability((current) => (current === null ? current : null));
  }, [backgroundRunStatus]);

  useEffect(() => {
    const notificationApi = getNotificationApi();
    if (!notificationApi) return;
    setNotificationPermission(notificationApi.permission);
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
    const notificationApi = getNotificationApi();
    if (!notificationApi) {
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
      void new notificationApi(`Run ${run.state}: ${run.objective}`, {
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
      const nextAvailability = nextRuns[0]?.availability;
      if (nextAvailability) {
        setOperatorAvailability((current) =>
          operatorAvailabilityEquals(current, nextAvailability) ? current : nextAvailability,
        );
      }
      setRuns(nextRuns);
      setLoading(false);
      setError(null);
      if (nextRuns.length > 0) {
        setRunNotice(null);
      } else if (nextAvailability && (!nextAvailability.enabled || !nextAvailability.operatorAvailable)) {
        setRunNotice(
          nextAvailability.disabledReason ??
            'Durable background runs are not available for this runtime.',
        );
      } else {
        setRunNotice(null);
      }
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
      if (detail?.availability) {
        const detailAvailability = detail.availability;
        setOperatorAvailability((current) =>
          operatorAvailabilityEquals(current, detailAvailability) ? current : detailAvailability,
        );
      }
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
      setRunNotice(null);
      return;
    }
    if (msg.type === 'error') {
      if (!msg.id || !pendingRequestIdsRef.current.has(msg.id)) {
        return;
      }
      pendingRequestIdsRef.current.delete(msg.id);
      setLoading(false);
      const details = (msg.payload as RunOperatorErrorPayload | undefined) ?? undefined;
      if (details?.backgroundRunAvailability) {
        const backgroundRunAvailability = details.backgroundRunAvailability;
        setOperatorAvailability((current) =>
          operatorAvailabilityEquals(current, backgroundRunAvailability)
            ? current
            : backgroundRunAvailability,
        );
      }
      if (
        details?.code === 'background_run_missing' ||
        details?.code === 'background_run_unavailable'
      ) {
        setSelectedRun(null);
        setError(null);
        setRunNotice(msg.error ?? 'Run operation unavailable');
        return;
      }
      setRunNotice(null);
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
    runNotice,
    operatorAvailability,
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
