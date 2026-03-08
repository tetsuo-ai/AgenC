import type { ReactNode } from 'react';
import type { RunControlAction, RunDetail, RunSummary } from '../../types';

export interface RunEditorState {
  objective: string;
  successCriteria: string;
  completionCriteria: string;
  blockedCriteria: string;
  nextCheckMs: string;
  heartbeatMs: string;
  requiresUserStop: boolean;
  maxRuntimeMs: string;
  maxCycles: string;
  maxIdleMs: string;
  preferredWorkerId: string;
  workerAffinityKey: string;
  overrideReason: string;
}

export const EMPTY_RUN_EDITOR_STATE: RunEditorState = {
  objective: '',
  successCriteria: '',
  completionCriteria: '',
  blockedCriteria: '',
  nextCheckMs: '',
  heartbeatMs: '',
  requiresUserStop: false,
  maxRuntimeMs: '',
  maxCycles: '',
  maxIdleMs: '',
  preferredWorkerId: '',
  workerAffinityKey: '',
  overrideReason: '',
};

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

function toOptionalNumber(value: string): number | undefined {
  return value ? Number(value) : undefined;
}

export function buildRunEditorState(run: RunDetail | null): RunEditorState {
  if (!run) {
    return { ...EMPTY_RUN_EDITOR_STATE };
  }
  return {
    objective: run.objective,
    successCriteria: formatList(run.contract.successCriteria),
    completionCriteria: formatList(run.contract.completionCriteria),
    blockedCriteria: formatList(run.contract.blockedCriteria),
    nextCheckMs: String(run.contract.nextCheckMs),
    heartbeatMs:
      run.contract.heartbeatMs !== undefined
        ? String(run.contract.heartbeatMs)
        : '',
    requiresUserStop: run.contract.requiresUserStop,
    maxRuntimeMs: String(run.budget.maxRuntimeMs),
    maxCycles: String(run.budget.maxCycles),
    maxIdleMs:
      run.budget.maxIdleMs !== undefined ? String(run.budget.maxIdleMs) : '',
    preferredWorkerId: run.preferredWorkerId ?? '',
    workerAffinityKey: run.workerAffinityKey ?? '',
    overrideReason: '',
  };
}

function SurfaceCard(props: {
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-2xl border border-tetsuo-200 bg-white p-5 ${
        props.className ?? ''
      }`.trim()}
    >
      {props.title ? (
        <h3 className="text-sm font-semibold text-tetsuo-800 mb-3">
          {props.title}
        </h3>
      ) : null}
      {props.children}
    </div>
  );
}

function SectionLabel(props: { children: ReactNode }) {
  return (
    <div className="text-xs font-semibold uppercase tracking-[0.12em] text-tetsuo-400">
      {props.children}
    </div>
  );
}

function ControlButton(props: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      className="rounded-lg border border-tetsuo-200 px-3 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-50"
      onClick={props.onClick}
      disabled={props.disabled}
    >
      {props.label}
    </button>
  );
}

export function RunDashboardHeader(props: {
  browserNotificationsEnabled: boolean;
  notificationPermission: NotificationPermission | 'unsupported';
  onRefresh: () => void;
  onEnableBrowserNotifications: () => Promise<void>;
}) {
  return (
    <div className="flex items-center justify-between px-6 py-4 border-b border-tetsuo-200">
      <div>
        <h2 className="text-base font-bold text-tetsuo-800 tracking-tight">
          Run Dashboard
        </h2>
        <div className="text-xs text-tetsuo-400 mt-1">
          Durable runs are tracked separately from foreground chat turns.
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            void props.onEnableBrowserNotifications();
          }}
          className="rounded-lg border border-tetsuo-200 px-3 py-2 text-xs text-tetsuo-600 hover:border-tetsuo-300 hover:text-tetsuo-800"
        >
          {props.browserNotificationsEnabled
            ? 'Browser Notifications On'
            : `Enable Notifications (${props.notificationPermission})`}
        </button>
        <button
          onClick={props.onRefresh}
          className="rounded-lg border border-tetsuo-200 px-3 py-2 text-xs text-tetsuo-600 hover:border-tetsuo-300 hover:text-tetsuo-800"
        >
          Refresh
        </button>
      </div>
    </div>
  );
}

export function RunSidebar(props: {
  runs: RunSummary[];
  selectedSessionId: string | null;
  onSelectRun: (sessionId: string) => void;
  onInspect: (sessionId?: string) => void;
}) {
  if (props.runs.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-tetsuo-200 p-4 text-sm text-tetsuo-400">
        No durable runs recorded for this operator.
      </div>
    );
  }

  return (
    <>
      {props.runs.map((run) => (
        <button
          key={run.sessionId}
          onClick={() => {
            props.onSelectRun(run.sessionId);
            props.onInspect(run.sessionId);
          }}
          className={`w-full text-left rounded-xl border px-4 py-3 transition-colors ${
            run.sessionId === props.selectedSessionId
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
      ))}
    </>
  );
}

function RunOverview(props: { run: RunDetail }) {
  const { run } = props;
  return (
    <SurfaceCard className="space-y-4">
      <div className="flex items-start justify-between gap-6">
        <div className="space-y-2">
          <div className="text-[10px] uppercase tracking-[0.18em] text-tetsuo-400">
            Objective
          </div>
          <div className="text-lg font-semibold text-tetsuo-800">
            {run.objective}
          </div>
          <div className="text-sm text-tetsuo-500">{run.explanation}</div>
        </div>
        <div
          className={`rounded-full px-3 py-1 text-xs font-semibold ${
            run.unsafeToContinue
              ? 'bg-red-100 text-red-600'
              : 'bg-emerald-100 text-emerald-700'
          }`}
        >
          {run.state}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <DetailCard label="Run ID" value={run.runId} breakAll />
        <DetailCard label="Session" value={run.sessionId} breakAll />
        <DetailCard
          label="Last Verified"
          value={formatTimestamp(run.lastVerifiedAt)}
        />
        <DetailCard
          label="Next Check"
          value={formatTimestamp(run.nextCheckAt)}
        />
      </div>
    </SurfaceCard>
  );
}

function DetailCard(props: {
  label: string;
  value: string;
  breakAll?: boolean;
}) {
  return (
    <div className="rounded-xl bg-tetsuo-50 p-3">
      <div className="text-[10px] uppercase tracking-[0.14em] text-tetsuo-400">
        {props.label}
      </div>
      <div
        className={`mt-1 text-tetsuo-700 ${
          props.breakAll ? 'break-all' : ''
        }`.trim()}
      >
        {props.value}
      </div>
    </div>
  );
}

function RunEvidencePanels(props: { run: RunDetail }) {
  const { run } = props;
  return (
    <div className="grid grid-cols-2 gap-6">
      <SurfaceCard title="Live Evidence" className="space-y-3">
        <div className="rounded-xl bg-tetsuo-50 p-3 text-sm text-tetsuo-600 whitespace-pre-wrap">
          {run.lastToolEvidence ?? 'No verified evidence recorded yet.'}
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-[0.14em] text-tetsuo-400">
            Carry-Forward Summary
          </div>
          <div className="mt-2 rounded-xl bg-tetsuo-50 p-3 text-sm text-tetsuo-600 whitespace-pre-wrap">
            {run.carryForwardSummary ?? 'No carry-forward summary recorded yet.'}
          </div>
        </div>
        <div className="text-xs text-tetsuo-500">
          Wake reason: {run.lastWakeReason ?? 'n/a'} • approvals:{' '}
          {run.approval.status}
        </div>
      </SurfaceCard>

      <SurfaceCard title="Blockers" className="space-y-3">
        <div className="rounded-xl bg-tetsuo-50 p-3 text-sm text-tetsuo-600 whitespace-pre-wrap">
          {run.blocker?.summary ?? 'No blocker recorded.'}
        </div>
        <div className="text-xs text-tetsuo-500">
          Approval: {run.approval.status}
          {run.blocker?.requiresOperatorAction
            ? ' • operator action required'
            : ''}
          {run.blocker?.retryable === false
            ? ' • unsafe to continue automatically'
            : ''}
        </div>
      </SurfaceCard>
    </div>
  );
}

function RunArtifactsPanel(props: { run: RunDetail }) {
  return (
    <SurfaceCard title="Artifacts" className="space-y-3">
      {props.run.artifacts.length === 0 ? (
        <div className="text-sm text-tetsuo-400">No artifacts recorded.</div>
      ) : (
        <div className="space-y-2">
          {props.run.artifacts.map((artifact) => (
            <div
              key={`${artifact.kind}:${artifact.locator}`}
              className="rounded-xl bg-tetsuo-50 p-3 text-sm"
            >
              <div className="font-medium text-tetsuo-700">
                {artifact.label ?? artifact.kind}
              </div>
              <div className="mt-1 break-all text-tetsuo-500">
                {artifact.locator}
              </div>
            </div>
          ))}
        </div>
      )}
    </SurfaceCard>
  );
}

function RunEventsPanel(props: { run: RunDetail }) {
  return (
    <SurfaceCard title="Recent Wake Events" className="space-y-3">
      {props.run.recentEvents.length === 0 ? (
        <div className="text-sm text-tetsuo-400">No events recorded.</div>
      ) : (
        <div className="space-y-2 max-h-72 overflow-y-auto">
          {props.run.recentEvents.map((event, index) => (
            <div
              key={`${event.timestamp}-${index}`}
              className="rounded-xl bg-tetsuo-50 p-3 text-sm"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium text-tetsuo-700">
                  {event.eventType ?? 'event'}
                </span>
                <span className="text-[11px] text-tetsuo-400">
                  {new Date(event.timestamp).toLocaleTimeString()}
                </span>
              </div>
              <div className="mt-1 text-tetsuo-600">{event.summary}</div>
            </div>
          ))}
        </div>
      )}
    </SurfaceCard>
  );
}

interface RunOperatorControlsProps {
  sessionId?: string;
  editor: RunEditorState;
  onEditorChange: <K extends keyof RunEditorState>(
    key: K,
    value: RunEditorState[K],
  ) => void;
  onControl: (action: RunControlAction) => void;
}

interface RunControlSectionProps extends RunOperatorControlsProps {
  runControl: (action: RunControlAction | undefined) => void;
}

function RunQuickActions(props: RunControlSectionProps) {
  const { sessionId, runControl } = props;
  const actions = [
    {
      label: 'Pause',
      action: sessionId
        ? ({ action: 'pause', sessionId } as const)
        : undefined,
    },
    {
      label: 'Resume',
      action: sessionId
        ? ({ action: 'resume', sessionId } as const)
        : undefined,
    },
    {
      label: 'Stop',
      action: sessionId
        ? ({
            action: 'cancel',
            sessionId,
            reason: 'Stopped from the run dashboard.',
          } as const)
        : undefined,
    },
    {
      label: 'Retry Checkpoint',
      action: sessionId
        ? ({ action: 'retry_from_checkpoint', sessionId } as const)
        : undefined,
    },
    {
      label: 'Force Compact',
      action: sessionId
        ? ({ action: 'force_compact', sessionId } as const)
        : undefined,
    },
  ];

  return (
    <div className="flex flex-wrap gap-2">
      {actions.map((entry) => (
        <ControlButton
          key={entry.label}
          label={entry.label}
          disabled={!entry.action}
          onClick={() => runControl(entry.action)}
        />
      ))}
    </div>
  );
}

function RunObjectiveEditor(props: RunControlSectionProps) {
  const { sessionId, editor, onEditorChange, runControl } = props;
  return (
    <div className="space-y-3">
      <SectionLabel>Edit Objective</SectionLabel>
      <textarea
        value={editor.objective}
        onChange={(event) => onEditorChange('objective', event.target.value)}
        aria-label="Run objective"
        className="w-full min-h-24 rounded-xl border border-tetsuo-200 px-3 py-2 text-sm"
      />
      <ControlButton
        label="Save Objective"
        disabled={!sessionId}
        onClick={() =>
          runControl(
            sessionId
              ? {
                  action: 'edit_objective',
                  sessionId,
                  objective: editor.objective,
                }
              : undefined,
          )
        }
      />
    </div>
  );
}

function RunWorkerAssignmentEditor(props: RunControlSectionProps) {
  const { sessionId, editor, onEditorChange, runControl } = props;
  return (
    <div className="space-y-3">
      <SectionLabel>Worker Assignment</SectionLabel>
      <input
        value={editor.preferredWorkerId}
        onChange={(event) =>
          onEditorChange('preferredWorkerId', event.target.value)
        }
        aria-label="Preferred worker id"
        className="w-full rounded-xl border border-tetsuo-200 px-3 py-2 text-sm"
        placeholder="preferred worker id"
      />
      <input
        value={editor.workerAffinityKey}
        onChange={(event) =>
          onEditorChange('workerAffinityKey', event.target.value)
        }
        aria-label="Worker affinity key"
        className="w-full rounded-xl border border-tetsuo-200 px-3 py-2 text-sm"
        placeholder="worker affinity key"
      />
      <ControlButton
        label="Reassign Worker"
        disabled={!sessionId}
        onClick={() =>
          runControl(
            sessionId
              ? {
                  action: 'reassign_worker',
                  sessionId,
                  worker: {
                    preferredWorkerId: editor.preferredWorkerId,
                    workerAffinityKey: editor.workerAffinityKey,
                  },
                }
              : undefined,
          )
        }
      />
    </div>
  );
}

function RunCriteriaEditorFields(props: {
  editor: RunEditorState;
  onEditorChange: <K extends keyof RunEditorState>(
    key: K,
    value: RunEditorState[K],
  ) => void;
}) {
  const fields = [
    {
      key: 'successCriteria' as const,
      label: 'Success criteria',
      placeholder: 'success criteria',
    },
    {
      key: 'completionCriteria' as const,
      label: 'Completion criteria',
      placeholder: 'completion criteria',
    },
    {
      key: 'blockedCriteria' as const,
      label: 'Blocked criteria',
      placeholder: 'blocked criteria',
    },
  ];

  return (
    <>
      {fields.map((field) => (
        <textarea
          key={field.key}
          value={props.editor[field.key]}
          onChange={(event) =>
            props.onEditorChange(field.key, event.target.value)
          }
          aria-label={field.label}
          className="w-full min-h-20 rounded-xl border border-tetsuo-200 px-3 py-2 text-sm"
          placeholder={field.placeholder}
        />
      ))}
    </>
  );
}

function RunConstraintScheduleFields(props: {
  editor: RunEditorState;
  onEditorChange: <K extends keyof RunEditorState>(
    key: K,
    value: RunEditorState[K],
  ) => void;
}) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <input
          value={props.editor.nextCheckMs}
          onChange={(event) =>
            props.onEditorChange('nextCheckMs', event.target.value)
          }
          aria-label="Next check interval"
          className="rounded-xl border border-tetsuo-200 px-3 py-2 text-sm"
          placeholder="nextCheckMs"
        />
        <input
          value={props.editor.heartbeatMs}
          onChange={(event) =>
            props.onEditorChange('heartbeatMs', event.target.value)
          }
          aria-label="Heartbeat interval"
          className="rounded-xl border border-tetsuo-200 px-3 py-2 text-sm"
          placeholder="heartbeatMs"
        />
      </div>
      <label className="flex items-center gap-2 text-sm text-tetsuo-600">
        <input
          type="checkbox"
          aria-label="Requires user stop"
          checked={props.editor.requiresUserStop}
          onChange={(event) =>
            props.onEditorChange('requiresUserStop', event.target.checked)
          }
        />
        Requires user stop
      </label>
    </>
  );
}

function RunConstraintEditor(props: RunControlSectionProps) {
  const { sessionId, editor, onEditorChange, runControl } = props;
  return (
    <div className="space-y-3">
      <SectionLabel>Constraints</SectionLabel>
      <RunCriteriaEditorFields
        editor={editor}
        onEditorChange={onEditorChange}
      />
      <RunConstraintScheduleFields
        editor={editor}
        onEditorChange={onEditorChange}
      />
      <ControlButton
        label="Apply Constraints"
        disabled={!sessionId}
        onClick={() =>
          runControl(
            sessionId
              ? {
                  action: 'amend_constraints',
                  sessionId,
                  constraints: {
                    successCriteria: parseList(editor.successCriteria),
                    completionCriteria: parseList(editor.completionCriteria),
                    blockedCriteria: parseList(editor.blockedCriteria),
                    nextCheckMs: toOptionalNumber(editor.nextCheckMs),
                    heartbeatMs: toOptionalNumber(editor.heartbeatMs),
                    requiresUserStop: editor.requiresUserStop,
                  },
                }
              : undefined,
          )
        }
      />
    </div>
  );
}

function RunVerificationOverrideEditor(props: RunControlSectionProps) {
  const { sessionId, editor, onEditorChange, runControl } = props;
  const overrides = [
    {
      label: 'Override Continue',
      action: sessionId
        ? ({
            action: 'verification_override',
            sessionId,
            override: {
              mode: 'continue',
              reason:
                editor.overrideReason || 'Operator override: continue execution.',
            },
          } as const)
        : undefined,
    },
    {
      label: 'Override Complete',
      action: sessionId
        ? ({
            action: 'verification_override',
            sessionId,
            override: {
              mode: 'complete',
              reason:
                editor.overrideReason || 'Operator override: accept completion.',
            },
          } as const)
        : undefined,
    },
    {
      label: 'Override Fail',
      action: sessionId
        ? ({
            action: 'verification_override',
            sessionId,
            override: {
              mode: 'fail',
              reason: editor.overrideReason || 'Operator override: mark failed.',
            },
          } as const)
        : undefined,
    },
  ];

  return (
    <div className="pt-4 border-t border-tetsuo-200 space-y-2">
      <SectionLabel>Verification Override</SectionLabel>
      <textarea
        value={editor.overrideReason}
        onChange={(event) =>
          onEditorChange('overrideReason', event.target.value)
        }
        aria-label="Verification override reason"
        className="w-full min-h-20 rounded-xl border border-tetsuo-200 px-3 py-2 text-sm"
        placeholder="operator reason required for override"
      />
      <div className="flex flex-wrap gap-2">
        {overrides.map((entry) => (
          <ControlButton
            key={entry.label}
            label={entry.label}
            disabled={!entry.action}
            onClick={() => runControl(entry.action)}
          />
        ))}
      </div>
    </div>
  );
}

function RunBudgetEditor(props: RunControlSectionProps) {
  const { sessionId, editor, onEditorChange, runControl } = props;
  return (
    <div className="space-y-3">
      <SectionLabel>Budget</SectionLabel>
      <input
        value={editor.maxRuntimeMs}
        onChange={(event) => onEditorChange('maxRuntimeMs', event.target.value)}
        aria-label="Maximum runtime"
        className="w-full rounded-xl border border-tetsuo-200 px-3 py-2 text-sm"
        placeholder="maxRuntimeMs"
      />
      <input
        value={editor.maxCycles}
        onChange={(event) => onEditorChange('maxCycles', event.target.value)}
        aria-label="Maximum cycles"
        className="w-full rounded-xl border border-tetsuo-200 px-3 py-2 text-sm"
        placeholder="maxCycles"
      />
      <input
        value={editor.maxIdleMs}
        onChange={(event) => onEditorChange('maxIdleMs', event.target.value)}
        aria-label="Maximum idle time"
        className="w-full rounded-xl border border-tetsuo-200 px-3 py-2 text-sm"
        placeholder="maxIdleMs"
      />
      <ControlButton
        label="Apply Budget"
        disabled={!sessionId}
        onClick={() =>
          runControl(
            sessionId
              ? {
                  action: 'adjust_budget',
                  sessionId,
                  budget: {
                    maxRuntimeMs: toOptionalNumber(editor.maxRuntimeMs),
                    maxCycles: toOptionalNumber(editor.maxCycles),
                    maxIdleMs: toOptionalNumber(editor.maxIdleMs),
                  },
                }
              : undefined,
          )
        }
      />
      <RunVerificationOverrideEditor {...props} />
    </div>
  );
}

function RunOperatorControls(props: RunOperatorControlsProps) {
  const runControl = (action: RunControlAction | undefined) => {
    if (action) {
      props.onControl(action);
    }
  };

  return (
    <SurfaceCard title="Operator Controls" className="space-y-4">
      <RunQuickActions {...props} runControl={runControl} />

      <div className="grid grid-cols-2 gap-6">
        <RunObjectiveEditor {...props} runControl={runControl} />
        <RunWorkerAssignmentEditor {...props} runControl={runControl} />
      </div>

      <div className="grid grid-cols-2 gap-6">
        <RunConstraintEditor {...props} runControl={runControl} />
        <RunBudgetEditor {...props} runControl={runControl} />
      </div>
    </SurfaceCard>
  );
}

function RunContractSnapshot(props: { contract: RunDetail['contract'] }) {
  return (
    <SurfaceCard title="Contract Snapshot">
      <pre className="overflow-x-auto rounded-xl bg-tetsuo-50 p-4 text-xs text-tetsuo-600">
        {formatJson(props.contract)}
      </pre>
    </SurfaceCard>
  );
}

export function RunDashboardContent(props: {
  selectedRun: RunDetail | null;
  selectedSessionId: string | null;
  loading: boolean;
  error: string | null;
  editor: RunEditorState;
  onEditorChange: <K extends keyof RunEditorState>(
    key: K,
    value: RunEditorState[K],
  ) => void;
  onControl: (action: RunControlAction) => void;
}) {
  const sessionId =
    props.selectedRun?.sessionId ?? props.selectedSessionId ?? undefined;

  if (!props.selectedRun) {
    return (
      <div className="rounded-xl border border-dashed border-tetsuo-200 p-6 text-sm text-tetsuo-400">
        Select a run to inspect its contract, evidence, blockers, and controls.
      </div>
    );
  }

  return (
    <>
      {props.error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
          {props.error}
        </div>
      ) : null}
      {props.loading ? (
        <div className="rounded-xl border border-tetsuo-200 bg-tetsuo-50 px-4 py-3 text-sm text-tetsuo-500">
          Loading run details…
        </div>
      ) : null}

      <RunOverview run={props.selectedRun} />
      <RunEvidencePanels run={props.selectedRun} />

      <div className="grid grid-cols-2 gap-6">
        <RunArtifactsPanel run={props.selectedRun} />
        <RunEventsPanel run={props.selectedRun} />
      </div>

      <RunOperatorControls
        sessionId={sessionId}
        editor={props.editor}
        onEditorChange={props.onEditorChange}
        onControl={props.onControl}
      />

      <RunContractSnapshot contract={props.selectedRun.contract} />
    </>
  );
}
