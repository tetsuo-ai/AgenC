import type { ReactNode } from 'react';
import type {
  RunControlAction,
  RunDetail,
  RunOperatorAvailability,
  RunSummary,
} from '../../types';

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

const INPUT_CLASS = 'w-full border border-bbs-border bg-bbs-surface px-3 py-2 text-sm text-bbs-lightgray placeholder:text-bbs-gray focus:outline-none focus:border-bbs-purple-dim';
const TEXTAREA_CLASS = `${INPUT_CLASS} min-h-20 resize-y`;
const CHECKBOX_CLASS = 'h-3.5 w-3.5 border-bbs-border bg-bbs-surface text-bbs-purple focus:ring-0';

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

function formatStateTag(state: string | undefined): string {
  return `[${(state ?? 'unknown').toUpperCase()}]`;
}

function stateTextColor(state: string | undefined): string {
  switch (state) {
    case 'running':
    case 'completed':
      return 'text-bbs-green';
    case 'starting':
    case 'paused':
    case 'blocked':
    case 'suspended':
      return 'text-bbs-yellow';
    case 'failed':
    case 'cancelled':
    case 'stopped':
    case 'error':
      return 'text-bbs-red';
    default:
      return 'text-bbs-gray';
  }
}

function SurfaceCard(props: {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`border border-bbs-border bg-bbs-dark animate-panel-enter ${
        props.className ?? ''
      }`.trim()}
    >
      {props.title ? (
        <div className="border-b border-bbs-border px-4 py-3">
          <div className="text-[10px] uppercase tracking-[0.18em] text-bbs-gray">
            {props.title}
          </div>
          {props.subtitle ? (
            <div className="mt-1 text-xs text-bbs-gray">{props.subtitle}</div>
          ) : null}
        </div>
      ) : null}
      <div className="px-4 py-4">{props.children}</div>
    </div>
  );
}

function SectionLabel(props: { children: ReactNode }) {
  return (
    <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-bbs-gray">
      {props.children}
    </div>
  );
}

function ControlButton(props: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'default' | 'accent' | 'danger';
}) {
  const toneClass =
    props.tone === 'accent'
      ? 'border-bbs-purple-dim text-bbs-purple hover:text-bbs-white'
      : props.tone === 'danger'
        ? 'border-bbs-red/40 text-bbs-red hover:text-bbs-white'
        : 'border-bbs-border text-bbs-gray hover:text-bbs-white';

  return (
    <button
      className={`border bg-bbs-surface px-3 py-2 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${toneClass}`}
      onClick={props.onClick}
      disabled={props.disabled}
    >
      [{props.label.toUpperCase()}]
    </button>
  );
}

function DetailCard(props: {
  label: string;
  value: string;
  breakAll?: boolean;
}) {
  return (
    <div className="border border-bbs-border bg-bbs-surface px-3 py-3">
      <div className="text-[10px] uppercase tracking-[0.16em] text-bbs-gray">
        {props.label}
      </div>
      <div
        className={`mt-2 text-sm text-bbs-lightgray ${
          props.breakAll ? 'break-all' : ''
        }`.trim()}
      >
        {props.value}
      </div>
    </div>
  );
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

export function RunDashboardHeader(props: {
  browserNotificationsEnabled: boolean;
  notificationPermission: NotificationPermission | 'unsupported';
  onRefresh: () => void;
  onEnableBrowserNotifications: () => Promise<void>;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 md:px-6 py-3 border-b border-bbs-border bg-bbs-surface font-mono">
      <div className="min-w-0">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-bbs-purple text-xs shrink-0">RUN&gt;</span>
          <div className="min-w-0">
            <h2 className="text-xs font-bold tracking-[0.18em] text-bbs-white uppercase">
              Run Dashboard
            </h2>
            <div className="mt-1 text-xs text-bbs-gray truncate">
              durable runs are tracked separately from foreground chat turns
            </div>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={() => {
            void props.onEnableBrowserNotifications();
          }}
          className="border border-bbs-border bg-bbs-dark px-3 py-2 text-xs text-bbs-gray hover:text-bbs-white hover:border-bbs-purple-dim transition-colors"
        >
          {props.browserNotificationsEnabled
            ? '[NOTIFY ON]'
            : `[NOTIFY ${String(props.notificationPermission).toUpperCase()}]`}
        </button>
        <button
          onClick={props.onRefresh}
          className="border border-bbs-border bg-bbs-dark px-3 py-2 text-xs text-bbs-gray hover:text-bbs-white hover:border-bbs-purple-dim transition-colors"
        >
          [REFRESH]
        </button>
      </div>
    </div>
  );
}

export function RunSidebar(props: {
  runs: RunSummary[];
  selectedSessionId: string | null;
  operatorAvailability: RunOperatorAvailability | null;
  onSelectRun: (sessionId: string) => void;
  onInspect: (sessionId?: string) => void;
}) {
  if (props.runs.length === 0) {
    if (props.operatorAvailability && !props.operatorAvailability.enabled) {
      return (
        <div className="border border-bbs-yellow/40 bg-bbs-dark px-4 py-4 text-xs text-bbs-yellow font-mono space-y-2">
          <div className="font-bold">[DISABLED] durable background runs are off</div>
          <div className="text-bbs-gray leading-relaxed">
            {props.operatorAvailability.disabledReason ?? 'Enable autonomy durable runs to inspect or control supervised work.'}
          </div>
        </div>
      );
    }
    if (props.operatorAvailability && !props.operatorAvailability.operatorAvailable) {
      return (
        <div className="border border-bbs-red/40 bg-bbs-dark px-4 py-4 text-xs text-bbs-red font-mono space-y-2">
          <div className="font-bold">[UNAVAILABLE] durable run operator offline</div>
          <div className="text-bbs-gray leading-relaxed">
            {props.operatorAvailability.disabledReason ?? 'The durable-run supervisor is not attached to this runtime.'}
          </div>
        </div>
      );
    }
    return (
      <div className="border border-dashed border-bbs-border px-4 py-4 text-xs text-bbs-gray font-mono">
        no durable runs recorded for this operator
      </div>
    );
  }

  return (
    <div className="space-y-2 font-mono">
      {props.runs.map((run, index) => {
        const selected = run.sessionId === props.selectedSessionId;
        return (
          <button
            key={run.sessionId}
            onClick={() => {
              props.onSelectRun(run.sessionId);
              props.onInspect(run.sessionId);
            }}
            className={`w-full text-left border px-4 py-3 transition-colors animate-list-item ${
              selected
                ? 'border-bbs-purple-dim bg-bbs-surface'
                : 'border-bbs-border bg-bbs-dark hover:bg-bbs-surface'
            }`}
            style={{ animationDelay: `${index * 35}ms` }}
          >
            <div className="flex items-center justify-between gap-3 text-[10px] uppercase tracking-[0.16em]">
              <span className={selected ? 'text-bbs-purple' : 'text-bbs-gray'}>
                {run.currentPhase}
              </span>
              <span className={stateTextColor(run.state)}>{formatStateTag(run.state)}</span>
            </div>
            <div className={`mt-2 text-sm font-semibold break-words ${selected ? 'text-bbs-white' : 'text-bbs-lightgray'} line-clamp-2`}>
              {run.objective}
            </div>
            <div className="mt-2 text-xs text-bbs-gray line-clamp-3 break-words">
              {run.explanation}
            </div>
            <div className="mt-3 flex items-center justify-between gap-3 text-[11px] text-bbs-gray">
              <span>{`signals ${run.pendingSignals}`}</span>
              <span>{new Date(run.updatedAt).toLocaleTimeString()}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function RunOverview(props: { run: RunDetail }) {
  const { run } = props;
  return (
    <SurfaceCard title="Run Overview" subtitle="objective, state, timing, and session identifiers">
      <div className="space-y-4 font-mono">
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
          <div className="space-y-2 min-w-0">
            <SectionLabel>Objective</SectionLabel>
            <div className="text-lg font-bold text-bbs-white break-words">
              {run.objective}
            </div>
            <div className="text-sm text-bbs-gray break-words">{run.explanation}</div>
          </div>
          <div className={`text-xs font-bold shrink-0 ${stateTextColor(run.state)}`}>
            {formatStateTag(run.state)}
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
          <DetailCard label="Run ID" value={run.runId} breakAll />
          <DetailCard label="Session" value={run.sessionId} breakAll />
          <DetailCard label="Last Verified" value={formatTimestamp(run.lastVerifiedAt)} />
          <DetailCard label="Next Check" value={formatTimestamp(run.nextCheckAt)} />
        </div>
      </div>
    </SurfaceCard>
  );
}

function RunEvidencePanels(props: { run: RunDetail }) {
  const { run } = props;
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
      <SurfaceCard title="Live Evidence" subtitle="latest verified tool evidence and carry-forward context" className="h-full">
        <div className="space-y-4 font-mono">
          <div className="border border-bbs-border bg-bbs-surface px-3 py-3 text-sm text-bbs-lightgray whitespace-pre-wrap break-words">
            {run.lastToolEvidence ?? 'No verified evidence recorded yet.'}
          </div>
          <div>
            <SectionLabel>Carry-Forward Summary</SectionLabel>
            <div className="mt-2 border border-bbs-border bg-bbs-surface px-3 py-3 text-sm text-bbs-lightgray whitespace-pre-wrap break-words">
              {run.carryForwardSummary ?? 'No carry-forward summary recorded yet.'}
            </div>
          </div>
          <div className="text-xs text-bbs-gray break-words">
            {`wake reason: ${run.lastWakeReason ?? 'n/a'} • approvals: ${run.approval.status}`}
          </div>
        </div>
      </SurfaceCard>

      <SurfaceCard title="Blockers" subtitle="operator intervention and retry posture" className="h-full">
        <div className="space-y-4 font-mono">
          <div className="border border-bbs-border bg-bbs-surface px-3 py-3 text-sm text-bbs-lightgray whitespace-pre-wrap break-words">
            {run.blocker?.summary ?? 'No blocker recorded.'}
          </div>
          <div className="text-xs text-bbs-gray break-words">
            {`approval: ${run.approval.status}`}
            {run.blocker?.requiresOperatorAction ? ' • operator action required' : ''}
            {run.blocker?.retryable === false ? ' • unsafe to continue automatically' : ''}
          </div>
        </div>
      </SurfaceCard>
    </div>
  );
}

function RunArtifactsPanel(props: { run: RunDetail }) {
  return (
    <SurfaceCard title="Artifacts" subtitle="recorded outputs and locators from the durable run">
      {props.run.artifacts.length === 0 ? (
        <div className="text-sm text-bbs-gray font-mono">No artifacts recorded.</div>
      ) : (
        <div className="space-y-2 font-mono">
          {props.run.artifacts.map((artifact, index) => (
            <div
              key={`${artifact.kind}:${artifact.locator}`}
              className="border border-bbs-border bg-bbs-surface px-3 py-3 text-sm animate-list-item"
              style={{ animationDelay: `${index * 35}ms` }}
            >
              <div className="text-bbs-white font-medium break-words">
                {artifact.label ?? artifact.kind}
              </div>
              <div className="mt-1 break-all text-bbs-gray">{artifact.locator}</div>
            </div>
          ))}
        </div>
      )}
    </SurfaceCard>
  );
}

function RunEventsPanel(props: { run: RunDetail }) {
  return (
    <SurfaceCard title="Recent Wake Events" subtitle="latest lifecycle and wake events on this run">
      {props.run.recentEvents.length === 0 ? (
        <div className="text-sm text-bbs-gray font-mono">No events recorded.</div>
      ) : (
        <div className="space-y-2 max-h-72 overflow-y-auto font-mono">
          {props.run.recentEvents.map((event, index) => (
            <div
              key={`${event.timestamp}-${index}`}
              className="border border-bbs-border bg-bbs-surface px-3 py-3 text-sm animate-list-item"
              style={{ animationDelay: `${index * 35}ms` }}
            >
              <div className="flex items-start justify-between gap-3">
                <span className="font-medium text-bbs-lightgray break-words">
                  {event.eventType ?? 'event'}
                </span>
                <span className="text-[11px] text-bbs-gray shrink-0">
                  {new Date(event.timestamp).toLocaleTimeString()}
                </span>
              </div>
              <div className="mt-2 text-bbs-gray break-words">{event.summary}</div>
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
      tone: 'default' as const,
    },
    {
      label: 'Resume',
      action: sessionId
        ? ({ action: 'resume', sessionId } as const)
        : undefined,
      tone: 'accent' as const,
    },
    {
      label: 'Stop',
      action: sessionId
        ? ({
            action: 'stop',
            sessionId,
            reason: 'Stopped from the run dashboard.',
          } as const)
        : undefined,
      tone: 'danger' as const,
    },
    {
      label: 'Retry Checkpoint',
      action: sessionId
        ? ({ action: 'retry_from_checkpoint', sessionId } as const)
        : undefined,
      tone: 'default' as const,
    },
    {
      label: 'Force Compact',
      action: sessionId
        ? ({ action: 'force_compact', sessionId } as const)
        : undefined,
      tone: 'default' as const,
    },
  ];

  return (
    <div className="flex flex-wrap gap-2">
      {actions.map((entry) => (
        <ControlButton
          key={entry.label}
          label={entry.label}
          tone={entry.tone}
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
        className={`${TEXTAREA_CLASS} min-h-24`}
      />
      <ControlButton
        label="Save Objective"
        tone="accent"
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
        className={INPUT_CLASS}
        placeholder="preferred worker id"
      />
      <input
        value={editor.workerAffinityKey}
        onChange={(event) =>
          onEditorChange('workerAffinityKey', event.target.value)
        }
        aria-label="Worker affinity key"
        className={INPUT_CLASS}
        placeholder="worker affinity key"
      />
      <ControlButton
        label="Reassign Worker"
        tone="accent"
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
          className={TEXTAREA_CLASS}
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
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <input
          value={props.editor.nextCheckMs}
          onChange={(event) =>
            props.onEditorChange('nextCheckMs', event.target.value)
          }
          aria-label="Next check interval"
          className={INPUT_CLASS}
          placeholder="nextCheckMs"
        />
        <input
          value={props.editor.heartbeatMs}
          onChange={(event) =>
            props.onEditorChange('heartbeatMs', event.target.value)
          }
          aria-label="Heartbeat interval"
          className={INPUT_CLASS}
          placeholder="heartbeatMs"
        />
      </div>
      <label className="flex items-center gap-2 text-sm text-bbs-lightgray">
        <input
          type="checkbox"
          aria-label="Requires user stop"
          checked={props.editor.requiresUserStop}
          onChange={(event) =>
            props.onEditorChange('requiresUserStop', event.target.checked)
          }
          className={CHECKBOX_CLASS}
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
        tone="accent"
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
      tone: 'accent' as const,
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
      tone: 'accent' as const,
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
      tone: 'danger' as const,
    },
  ];

  return (
    <div className="pt-4 border-t border-bbs-border space-y-2">
      <SectionLabel>Verification Override</SectionLabel>
      <textarea
        value={editor.overrideReason}
        onChange={(event) =>
          onEditorChange('overrideReason', event.target.value)
        }
        aria-label="Verification override reason"
        className={TEXTAREA_CLASS}
        placeholder="operator reason required for override"
      />
      <div className="flex flex-wrap gap-2">
        {overrides.map((entry) => (
          <ControlButton
            key={entry.label}
            label={entry.label}
            tone={entry.tone}
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
        className={INPUT_CLASS}
        placeholder="maxRuntimeMs"
      />
      <input
        value={editor.maxCycles}
        onChange={(event) => onEditorChange('maxCycles', event.target.value)}
        aria-label="Maximum cycles"
        className={INPUT_CLASS}
        placeholder="maxCycles"
      />
      <input
        value={editor.maxIdleMs}
        onChange={(event) => onEditorChange('maxIdleMs', event.target.value)}
        aria-label="Maximum idle time"
        className={INPUT_CLASS}
        placeholder="maxIdleMs"
      />
      <ControlButton
        label="Apply Budget"
        tone="accent"
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
    <SurfaceCard title="Operator Controls" subtitle="pause, edit, reassign, re-budget, and override verification">
      <div className="space-y-5 font-mono">
        <RunQuickActions {...props} runControl={runControl} />

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
          <RunObjectiveEditor {...props} runControl={runControl} />
          <RunWorkerAssignmentEditor {...props} runControl={runControl} />
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
          <RunConstraintEditor {...props} runControl={runControl} />
          <RunBudgetEditor {...props} runControl={runControl} />
        </div>
      </div>
    </SurfaceCard>
  );
}

function RunContractSnapshot(props: { contract: RunDetail['contract'] }) {
  return (
    <SurfaceCard title="Contract Snapshot" subtitle="raw contract payload for durable run verification">
      <pre className="overflow-x-auto border border-bbs-border bg-bbs-surface p-4 text-xs text-bbs-lightgray font-mono whitespace-pre-wrap break-words">
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
  runNotice: string | null;
  operatorAvailability: RunOperatorAvailability | null;
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
    if (props.error) {
      return (
        <div className="border border-bbs-red/40 bg-bbs-dark px-5 py-6 text-sm text-bbs-red font-mono">
          [ERROR] {props.error}
        </div>
      );
    }
    if (props.operatorAvailability && !props.operatorAvailability.enabled) {
      return (
        <div className="border border-bbs-yellow/40 bg-bbs-dark px-5 py-6 text-sm text-bbs-yellow font-mono space-y-2">
          <div className="font-bold">[DISABLED] durable background runs are disabled</div>
          <div className="text-bbs-gray leading-relaxed">
            {props.operatorAvailability.disabledReason ?? 'Enable durable background runs to inspect supervised work here.'}
          </div>
        </div>
      );
    }
    if (props.operatorAvailability && !props.operatorAvailability.operatorAvailable) {
      return (
        <div className="border border-bbs-red/40 bg-bbs-dark px-5 py-6 text-sm text-bbs-red font-mono space-y-2">
          <div className="font-bold">[UNAVAILABLE] durable run operator offline</div>
          <div className="text-bbs-gray leading-relaxed">
            {props.operatorAvailability.disabledReason ?? 'The durable-run supervisor is not attached to this runtime.'}
          </div>
        </div>
      );
    }
    if (props.runNotice) {
      return (
        <div className="border border-bbs-yellow/40 bg-bbs-dark px-5 py-6 text-sm text-bbs-yellow font-mono">
          [INFO] {props.runNotice}
        </div>
      );
    }
    return (
      <div className="border border-dashed border-bbs-border px-5 py-6 text-sm text-bbs-gray font-mono">
        Select a run to inspect its contract, evidence, blockers, and controls.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {props.error ? (
        <div className="border border-bbs-red/40 bg-bbs-dark px-4 py-3 text-sm text-bbs-red font-mono">
          [ERROR] {props.error}
        </div>
      ) : null}
      {props.loading ? (
        <div className="border border-bbs-yellow/40 bg-bbs-dark px-4 py-3 text-sm text-bbs-yellow font-mono animate-pulse">
          [LOADING] fetching run details...
        </div>
      ) : null}

      <RunOverview run={props.selectedRun} />
      <RunEvidencePanels run={props.selectedRun} />

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
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
    </div>
  );
}
