import { useEffect, useState } from 'react';
import type { RunControlAction, RunDetail, RunSummary } from '../../types';

interface RunDashboardViewProps {
  runs: RunSummary[];
  selectedRun: RunDetail | null;
  selectedSessionId: string | null;
  loading: boolean;
  error: string | null;
  browserNotificationsEnabled: boolean;
  notificationPermission: NotificationPermission | 'unsupported';
  onSelectRun: (sessionId: string) => void;
  onRefresh: () => void;
  onInspect: (sessionId?: string) => void;
  onControl: (action: RunControlAction) => void;
  onEnableBrowserNotifications: () => Promise<void>;
}

function formatTimestamp(value: number | undefined): string {
  if (!value) return 'n/a';
  return new Date(value).toLocaleString();
}

function formatList(value: readonly string[] | undefined): string {
  return (value ?? []).join('\n');
}

function parseList(value: string): string[] | undefined {
  const lines = value
    .split(/\n|,/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return lines.length > 0 ? lines : undefined;
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function RunDashboardView(props: RunDashboardViewProps) {
  const {
    runs,
    selectedRun,
    selectedSessionId,
    loading,
    error,
    browserNotificationsEnabled,
    notificationPermission,
    onSelectRun,
    onRefresh,
    onInspect,
    onControl,
    onEnableBrowserNotifications,
  } = props;

  const [objective, setObjective] = useState('');
  const [successCriteria, setSuccessCriteria] = useState('');
  const [completionCriteria, setCompletionCriteria] = useState('');
  const [blockedCriteria, setBlockedCriteria] = useState('');
  const [nextCheckMs, setNextCheckMs] = useState('');
  const [heartbeatMs, setHeartbeatMs] = useState('');
  const [requiresUserStop, setRequiresUserStop] = useState(false);
  const [maxRuntimeMs, setMaxRuntimeMs] = useState('');
  const [maxCycles, setMaxCycles] = useState('');
  const [maxIdleMs, setMaxIdleMs] = useState('');
  const [preferredWorkerId, setPreferredWorkerId] = useState('');
  const [workerAffinityKey, setWorkerAffinityKey] = useState('');
  const [overrideReason, setOverrideReason] = useState('');

  useEffect(() => {
    if (!selectedRun) {
      setObjective('');
      setSuccessCriteria('');
      setCompletionCriteria('');
      setBlockedCriteria('');
      setNextCheckMs('');
      setHeartbeatMs('');
      setRequiresUserStop(false);
      setMaxRuntimeMs('');
      setMaxCycles('');
      setMaxIdleMs('');
      setPreferredWorkerId('');
      setWorkerAffinityKey('');
      setOverrideReason('');
      return;
    }
    setObjective(selectedRun.objective);
    setSuccessCriteria(formatList(selectedRun.contract.successCriteria));
    setCompletionCriteria(formatList(selectedRun.contract.completionCriteria));
    setBlockedCriteria(formatList(selectedRun.contract.blockedCriteria));
    setNextCheckMs(String(selectedRun.contract.nextCheckMs));
    setHeartbeatMs(
      selectedRun.contract.heartbeatMs !== undefined
        ? String(selectedRun.contract.heartbeatMs)
        : '',
    );
    setRequiresUserStop(selectedRun.contract.requiresUserStop);
    setMaxRuntimeMs(String(selectedRun.budget.maxRuntimeMs));
    setMaxCycles(String(selectedRun.budget.maxCycles));
    setMaxIdleMs(
      selectedRun.budget.maxIdleMs !== undefined
        ? String(selectedRun.budget.maxIdleMs)
        : '',
    );
    setPreferredWorkerId(selectedRun.preferredWorkerId ?? '');
    setWorkerAffinityKey(selectedRun.workerAffinityKey ?? '');
    setOverrideReason('');
  }, [selectedRun]);

  const sessionId = selectedRun?.sessionId ?? selectedSessionId ?? undefined;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b border-tetsuo-200">
        <div>
          <h2 className="text-base font-bold text-tetsuo-800 tracking-tight">Run Dashboard</h2>
          <div className="text-xs text-tetsuo-400 mt-1">
            Durable runs are tracked separately from foreground chat turns.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { void onEnableBrowserNotifications(); }}
            className="rounded-lg border border-tetsuo-200 px-3 py-2 text-xs text-tetsuo-600 hover:border-tetsuo-300 hover:text-tetsuo-800"
          >
            {browserNotificationsEnabled ? 'Browser Notifications On' : `Enable Notifications (${notificationPermission})`}
          </button>
          <button
            onClick={onRefresh}
            className="rounded-lg border border-tetsuo-200 px-3 py-2 text-xs text-tetsuo-600 hover:border-tetsuo-300 hover:text-tetsuo-800"
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-[20rem,1fr]">
        <aside className="border-r border-tetsuo-200 overflow-y-auto p-4 space-y-3">
          {runs.length === 0 ? (
            <div className="rounded-xl border border-dashed border-tetsuo-200 p-4 text-sm text-tetsuo-400">
              No durable runs recorded for this operator.
            </div>
          ) : (
            runs.map((run) => (
              <button
                key={run.sessionId}
                onClick={() => {
                  onSelectRun(run.sessionId);
                  onInspect(run.sessionId);
                }}
                className={`w-full text-left rounded-xl border px-4 py-3 transition-colors ${
                  run.sessionId === selectedSessionId
                    ? 'border-accent bg-accent-bg'
                    : 'border-tetsuo-200 bg-white hover:border-tetsuo-300'
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs font-semibold uppercase tracking-[0.12em] text-tetsuo-400">
                    {run.currentPhase}
                  </div>
                  <div className="text-[11px] text-tetsuo-400">{run.state}</div>
                </div>
                <div className="mt-2 text-sm font-semibold text-tetsuo-800 line-clamp-2">
                  {run.objective}
                </div>
                <div className="mt-2 text-xs text-tetsuo-500 line-clamp-3">
                  {run.explanation}
                </div>
                <div className="mt-3 flex items-center justify-between text-[11px] text-tetsuo-400">
                  <span>Signals {run.pendingSignals}</span>
                  <span>{new Date(run.updatedAt).toLocaleTimeString()}</span>
                </div>
              </button>
            ))
          )}
        </aside>

        <section className="min-h-0 overflow-y-auto p-6 space-y-6">
          {!selectedRun ? (
            <div className="rounded-xl border border-dashed border-tetsuo-200 p-6 text-sm text-tetsuo-400">
              Select a run to inspect its contract, evidence, blockers, and controls.
            </div>
          ) : (
            <>
              {error ? (
                <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
                  {error}
                </div>
              ) : null}
              {loading ? (
                <div className="rounded-xl border border-tetsuo-200 bg-tetsuo-50 px-4 py-3 text-sm text-tetsuo-500">
                  Loading run details…
                </div>
              ) : null}

              <div className="rounded-2xl border border-tetsuo-200 bg-white p-5 space-y-4">
                <div className="flex items-start justify-between gap-6">
                  <div className="space-y-2">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-tetsuo-400">Objective</div>
                    <div className="text-lg font-semibold text-tetsuo-800">{selectedRun.objective}</div>
                    <div className="text-sm text-tetsuo-500">{selectedRun.explanation}</div>
                  </div>
                  <div className={`rounded-full px-3 py-1 text-xs font-semibold ${
                    selectedRun.unsafeToContinue
                      ? 'bg-red-100 text-red-600'
                      : 'bg-emerald-100 text-emerald-700'
                  }`}>
                    {selectedRun.state}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="rounded-xl bg-tetsuo-50 p-3">
                    <div className="text-[10px] uppercase tracking-[0.14em] text-tetsuo-400">Run ID</div>
                    <div className="mt-1 break-all text-tetsuo-700">{selectedRun.runId}</div>
                  </div>
                  <div className="rounded-xl bg-tetsuo-50 p-3">
                    <div className="text-[10px] uppercase tracking-[0.14em] text-tetsuo-400">Session</div>
                    <div className="mt-1 break-all text-tetsuo-700">{selectedRun.sessionId}</div>
                  </div>
                  <div className="rounded-xl bg-tetsuo-50 p-3">
                    <div className="text-[10px] uppercase tracking-[0.14em] text-tetsuo-400">Last Verified</div>
                    <div className="mt-1 text-tetsuo-700">{formatTimestamp(selectedRun.lastVerifiedAt)}</div>
                  </div>
                  <div className="rounded-xl bg-tetsuo-50 p-3">
                    <div className="text-[10px] uppercase tracking-[0.14em] text-tetsuo-400">Next Check</div>
                    <div className="mt-1 text-tetsuo-700">{formatTimestamp(selectedRun.nextCheckAt)}</div>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-6">
                <div className="rounded-2xl border border-tetsuo-200 bg-white p-5 space-y-3">
                  <h3 className="text-sm font-semibold text-tetsuo-800">Live Evidence</h3>
                  <div className="rounded-xl bg-tetsuo-50 p-3 text-sm text-tetsuo-600 whitespace-pre-wrap">
                    {selectedRun.lastToolEvidence ?? 'No verified evidence recorded yet.'}
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.14em] text-tetsuo-400">Carry-Forward Summary</div>
                    <div className="mt-2 rounded-xl bg-tetsuo-50 p-3 text-sm text-tetsuo-600 whitespace-pre-wrap">
                      {selectedRun.carryForwardSummary ?? 'No carry-forward summary recorded yet.'}
                    </div>
                  </div>
                  <div className="text-xs text-tetsuo-500">
                    Wake reason: {selectedRun.lastWakeReason ?? 'n/a'} • approvals: {selectedRun.approval.status}
                  </div>
                </div>
                <div className="rounded-2xl border border-tetsuo-200 bg-white p-5 space-y-3">
                  <h3 className="text-sm font-semibold text-tetsuo-800">Blockers</h3>
                  <div className="rounded-xl bg-tetsuo-50 p-3 text-sm text-tetsuo-600 whitespace-pre-wrap">
                    {selectedRun.blocker?.summary ?? 'No blocker recorded.'}
                  </div>
                  <div className="text-xs text-tetsuo-500">
                    Approval: {selectedRun.approval.status}
                    {selectedRun.blocker?.requiresOperatorAction ? ' • operator action required' : ''}
                    {selectedRun.blocker?.retryable === false ? ' • unsafe to continue automatically' : ''}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-6">
                <div className="rounded-2xl border border-tetsuo-200 bg-white p-5 space-y-3">
                  <h3 className="text-sm font-semibold text-tetsuo-800">Artifacts</h3>
                  {selectedRun.artifacts.length === 0 ? (
                    <div className="text-sm text-tetsuo-400">No artifacts recorded.</div>
                  ) : (
                    <div className="space-y-2">
                      {selectedRun.artifacts.map((artifact) => (
                        <div key={`${artifact.kind}:${artifact.locator}`} className="rounded-xl bg-tetsuo-50 p-3 text-sm">
                          <div className="font-medium text-tetsuo-700">{artifact.label ?? artifact.kind}</div>
                          <div className="mt-1 break-all text-tetsuo-500">{artifact.locator}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="rounded-2xl border border-tetsuo-200 bg-white p-5 space-y-3">
                  <h3 className="text-sm font-semibold text-tetsuo-800">Recent Wake Events</h3>
                  {selectedRun.recentEvents.length === 0 ? (
                    <div className="text-sm text-tetsuo-400">No events recorded.</div>
                  ) : (
                    <div className="space-y-2 max-h-72 overflow-y-auto">
                      {selectedRun.recentEvents.map((event, index) => (
                        <div key={`${event.timestamp}-${index}`} className="rounded-xl bg-tetsuo-50 p-3 text-sm">
                          <div className="flex items-center justify-between gap-3">
                            <span className="font-medium text-tetsuo-700">{event.eventType ?? 'event'}</span>
                            <span className="text-[11px] text-tetsuo-400">{new Date(event.timestamp).toLocaleTimeString()}</span>
                          </div>
                          <div className="mt-1 text-tetsuo-600">{event.summary}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="rounded-2xl border border-tetsuo-200 bg-white p-5 space-y-4">
                <h3 className="text-sm font-semibold text-tetsuo-800">Operator Controls</h3>
                <div className="flex flex-wrap gap-2">
                  <button className="rounded-lg border border-tetsuo-200 px-3 py-2 text-xs" onClick={() => sessionId && onControl({ action: 'pause', sessionId })}>Pause</button>
                  <button className="rounded-lg border border-tetsuo-200 px-3 py-2 text-xs" onClick={() => sessionId && onControl({ action: 'resume', sessionId })}>Resume</button>
                  <button className="rounded-lg border border-tetsuo-200 px-3 py-2 text-xs" onClick={() => sessionId && onControl({ action: 'cancel', sessionId, reason: 'Stopped from the run dashboard.' })}>Stop</button>
                  <button className="rounded-lg border border-tetsuo-200 px-3 py-2 text-xs" onClick={() => sessionId && onControl({ action: 'retry_from_checkpoint', sessionId })}>Retry Checkpoint</button>
                  <button className="rounded-lg border border-tetsuo-200 px-3 py-2 text-xs" onClick={() => sessionId && onControl({ action: 'force_compact', sessionId })}>Force Compact</button>
                </div>

                <div className="grid grid-cols-2 gap-6">
                  <div className="space-y-3">
                    <div className="text-xs font-semibold uppercase tracking-[0.12em] text-tetsuo-400">Edit Objective</div>
                    <textarea
                      value={objective}
                      onChange={(event) => setObjective(event.target.value)}
                      aria-label="Run objective"
                      className="w-full min-h-24 rounded-xl border border-tetsuo-200 px-3 py-2 text-sm"
                    />
                    <button
                      className="rounded-lg border border-tetsuo-200 px-3 py-2 text-xs"
                      onClick={() => sessionId && onControl({ action: 'edit_objective', sessionId, objective })}
                    >
                      Save Objective
                    </button>
                  </div>

                  <div className="space-y-3">
                    <div className="text-xs font-semibold uppercase tracking-[0.12em] text-tetsuo-400">Worker Assignment</div>
                    <input
                      value={preferredWorkerId}
                      onChange={(event) => setPreferredWorkerId(event.target.value)}
                      aria-label="Preferred worker id"
                      className="w-full rounded-xl border border-tetsuo-200 px-3 py-2 text-sm"
                      placeholder="preferred worker id"
                    />
                    <input
                      value={workerAffinityKey}
                      onChange={(event) => setWorkerAffinityKey(event.target.value)}
                      aria-label="Worker affinity key"
                      className="w-full rounded-xl border border-tetsuo-200 px-3 py-2 text-sm"
                      placeholder="worker affinity key"
                    />
                    <button
                      className="rounded-lg border border-tetsuo-200 px-3 py-2 text-xs"
                      onClick={() => sessionId && onControl({
                        action: 'reassign_worker',
                        sessionId,
                        worker: { preferredWorkerId, workerAffinityKey },
                      })}
                    >
                      Reassign Worker
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-6">
                  <div className="space-y-3">
                    <div className="text-xs font-semibold uppercase tracking-[0.12em] text-tetsuo-400">Constraints</div>
                    <textarea value={successCriteria} onChange={(event) => setSuccessCriteria(event.target.value)} aria-label="Success criteria" className="w-full min-h-20 rounded-xl border border-tetsuo-200 px-3 py-2 text-sm" placeholder="success criteria" />
                    <textarea value={completionCriteria} onChange={(event) => setCompletionCriteria(event.target.value)} aria-label="Completion criteria" className="w-full min-h-20 rounded-xl border border-tetsuo-200 px-3 py-2 text-sm" placeholder="completion criteria" />
                    <textarea value={blockedCriteria} onChange={(event) => setBlockedCriteria(event.target.value)} aria-label="Blocked criteria" className="w-full min-h-20 rounded-xl border border-tetsuo-200 px-3 py-2 text-sm" placeholder="blocked criteria" />
                    <div className="grid grid-cols-2 gap-3">
                      <input value={nextCheckMs} onChange={(event) => setNextCheckMs(event.target.value)} aria-label="Next check interval" className="rounded-xl border border-tetsuo-200 px-3 py-2 text-sm" placeholder="nextCheckMs" />
                      <input value={heartbeatMs} onChange={(event) => setHeartbeatMs(event.target.value)} aria-label="Heartbeat interval" className="rounded-xl border border-tetsuo-200 px-3 py-2 text-sm" placeholder="heartbeatMs" />
                    </div>
                    <label className="flex items-center gap-2 text-sm text-tetsuo-600">
                      <input type="checkbox" aria-label="Requires user stop" checked={requiresUserStop} onChange={(event) => setRequiresUserStop(event.target.checked)} />
                      Requires user stop
                    </label>
                    <button
                      className="rounded-lg border border-tetsuo-200 px-3 py-2 text-xs"
                      onClick={() => sessionId && onControl({
                        action: 'amend_constraints',
                        sessionId,
                        constraints: {
                          successCriteria: parseList(successCriteria),
                          completionCriteria: parseList(completionCriteria),
                          blockedCriteria: parseList(blockedCriteria),
                          nextCheckMs: nextCheckMs ? Number(nextCheckMs) : undefined,
                          heartbeatMs: heartbeatMs ? Number(heartbeatMs) : undefined,
                          requiresUserStop,
                        },
                      })}
                    >
                      Apply Constraints
                    </button>
                  </div>

                  <div className="space-y-3">
                    <div className="text-xs font-semibold uppercase tracking-[0.12em] text-tetsuo-400">Budget</div>
                    <input value={maxRuntimeMs} onChange={(event) => setMaxRuntimeMs(event.target.value)} aria-label="Maximum runtime" className="w-full rounded-xl border border-tetsuo-200 px-3 py-2 text-sm" placeholder="maxRuntimeMs" />
                    <input value={maxCycles} onChange={(event) => setMaxCycles(event.target.value)} aria-label="Maximum cycles" className="w-full rounded-xl border border-tetsuo-200 px-3 py-2 text-sm" placeholder="maxCycles" />
                    <input value={maxIdleMs} onChange={(event) => setMaxIdleMs(event.target.value)} aria-label="Maximum idle time" className="w-full rounded-xl border border-tetsuo-200 px-3 py-2 text-sm" placeholder="maxIdleMs" />
                    <button
                      className="rounded-lg border border-tetsuo-200 px-3 py-2 text-xs"
                      onClick={() => sessionId && onControl({
                        action: 'adjust_budget',
                        sessionId,
                        budget: {
                          maxRuntimeMs: maxRuntimeMs ? Number(maxRuntimeMs) : undefined,
                          maxCycles: maxCycles ? Number(maxCycles) : undefined,
                          maxIdleMs: maxIdleMs ? Number(maxIdleMs) : undefined,
                        },
                      })}
                    >
                      Apply Budget
                    </button>

                    <div className="pt-4 border-t border-tetsuo-200 space-y-2">
                      <div className="text-xs font-semibold uppercase tracking-[0.12em] text-tetsuo-400">Verification Override</div>
                      <textarea
                        value={overrideReason}
                        onChange={(event) => setOverrideReason(event.target.value)}
                        aria-label="Verification override reason"
                        className="w-full min-h-20 rounded-xl border border-tetsuo-200 px-3 py-2 text-sm"
                        placeholder="operator reason required for override"
                      />
                      <div className="flex flex-wrap gap-2">
                        <button className="rounded-lg border border-tetsuo-200 px-3 py-2 text-xs" onClick={() => sessionId && onControl({ action: 'verification_override', sessionId, override: { mode: 'continue', reason: overrideReason || 'Operator override: continue execution.' } })}>Override Continue</button>
                        <button className="rounded-lg border border-tetsuo-200 px-3 py-2 text-xs" onClick={() => sessionId && onControl({ action: 'verification_override', sessionId, override: { mode: 'complete', reason: overrideReason || 'Operator override: accept completion.' } })}>Override Complete</button>
                        <button className="rounded-lg border border-tetsuo-200 px-3 py-2 text-xs" onClick={() => sessionId && onControl({ action: 'verification_override', sessionId, override: { mode: 'fail', reason: overrideReason || 'Operator override: mark failed.' } })}>Override Fail</button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-tetsuo-200 bg-white p-5">
                <h3 className="text-sm font-semibold text-tetsuo-800 mb-3">Contract Snapshot</h3>
                <pre className="overflow-x-auto rounded-xl bg-tetsuo-50 p-4 text-xs text-tetsuo-600">
                  {formatJson(selectedRun.contract)}
                </pre>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
