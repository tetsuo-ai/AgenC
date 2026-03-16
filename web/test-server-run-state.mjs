export function createContract(overrides = {}) {
  return {
    domain: 'generic',
    kind: 'finite',
    successCriteria: ['Observe the managed process reach a terminal state.'],
    completionCriteria: ['Verify runtime evidence before completing the run.'],
    blockedCriteria: ['Pause if operator approval becomes required.'],
    nextCheckMs: 4000,
    heartbeatMs: 12000,
    requiresUserStop: false,
    managedProcessPolicy: { mode: 'none' },
    ...overrides,
  };
}

function createRunDetail(overrides = {}) {
  return {
    runId: 'run_demo_1',
    sessionId: 'session_run_demo_1',
    objective: 'Watch the demo process until it exits cleanly.',
    state: 'working',
    currentPhase: 'active',
    explanation: 'Run is active and waiting for the next verification cycle. Next verification in ~4s.',
    unsafeToContinue: false,
    createdAt: Date.now() - 90_000,
    updatedAt: Date.now() - 2_000,
    lastVerifiedAt: Date.now() - 5_000,
    nextCheckAt: Date.now() + 4_000,
    nextHeartbeatAt: Date.now() + 12_000,
    cycleCount: 4,
    contractKind: 'finite',
    contractDomain: 'generic',
    requiresUserStop: false,
    pendingSignals: 1,
    watchCount: 1,
    fenceToken: 3,
    lastUserUpdate: 'Operator asked the runtime to keep watching until completion.',
    lastToolEvidence: 'system.processStatus -> running (pid=12345)',
    lastWakeReason: 'tool_result',
    carryForwardSummary: 'Process is stable and the verifier is waiting for the next check.',
    blockerSummary: undefined,
    approvalRequired: false,
    approvalState: 'none',
    checkpointAvailable: true,
    preferredWorkerId: 'worker-local-1',
    workerAffinityKey: 'session_run_demo_1',
    policyScope: {
      tenantId: 'tenant-demo',
      projectId: 'project-demo',
      runId: 'run_demo_1',
    },
    contract: createContract(),
    blocker: undefined,
    approval: {
      status: 'none',
      requestId: undefined,
      summary: undefined,
      since: undefined,
    },
    budget: {
      runtimeStartedAt: Date.now() - 90_000,
      lastActivityAt: Date.now() - 2_000,
      lastProgressAt: Date.now() - 5_000,
      totalTokens: 240,
      lastCycleTokens: 38,
      managedProcessCount: 1,
      maxRuntimeMs: 600_000,
      maxCycles: 64,
      maxIdleMs: 60_000,
      nextCheckIntervalMs: 4_000,
      heartbeatIntervalMs: 12_000,
      firstAcknowledgedAt: Date.now() - 88_000,
      firstVerifiedUpdateAt: Date.now() - 85_000,
      stopRequestedAt: undefined,
    },
    compaction: {
      lastCompactedAt: undefined,
      lastCompactedCycle: 0,
      refreshCount: 0,
      lastHistoryLength: 6,
      lastMilestoneAt: Date.now() - 6_000,
      lastCompactionReason: undefined,
      repairCount: 0,
      lastProviderAnchorAt: undefined,
    },
    artifacts: [
      {
        kind: 'process_handle',
        locator: 'proc_demo_1',
        label: 'Managed process handle',
      },
    ],
    observedTargets: [],
    watchRegistrations: [
      {
        watchId: 'watch_demo_1',
        kind: 'managed_process',
        target: 'proc_demo_1',
        createdAt: Date.now() - 60_000,
      },
    ],
    recentEvents: [
      {
        summary: 'Run accepted a tool_result wake for the managed process.',
        timestamp: Date.now() - 7_000,
        eventType: 'signal_received',
        data: { reason: 'tool_result' },
      },
      {
        summary: 'Verifier observed the process still running.',
        timestamp: Date.now() - 5_000,
        eventType: 'run_verified',
        data: { state: 'running' },
      },
    ],
    ...overrides,
  };
}

function summarizeRun(detail) {
  return {
    runId: detail.runId,
    sessionId: detail.sessionId,
    objective: detail.objective,
    state: detail.state,
    currentPhase: detail.currentPhase,
    explanation: detail.explanation,
    unsafeToContinue: detail.unsafeToContinue,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    lastVerifiedAt: detail.lastVerifiedAt,
    nextCheckAt: detail.nextCheckAt,
    nextHeartbeatAt: detail.nextHeartbeatAt,
    cycleCount: detail.cycleCount,
    contractKind: detail.contractKind,
    contractDomain: detail.contractDomain,
    requiresUserStop: detail.requiresUserStop,
    pendingSignals: detail.pendingSignals,
    watchCount: detail.watchCount,
    fenceToken: detail.fenceToken,
    lastUserUpdate: detail.lastUserUpdate,
    lastToolEvidence: detail.lastToolEvidence,
    lastWakeReason: detail.lastWakeReason,
    carryForwardSummary: detail.carryForwardSummary,
    blockerSummary: detail.blocker?.summary,
    approvalRequired: detail.approvalRequired,
    approvalState: detail.approvalState,
    preferredWorkerId: detail.preferredWorkerId,
    workerAffinityKey: detail.workerAffinityKey,
    checkpointAvailable: detail.checkpointAvailable,
  };
}

export function createRunStateController() {
  let detail = createRunDetail();

  function updateRunDetail(mutator) {
    detail = {
      ...mutator(detail),
      updatedAt: Date.now(),
    };
  }

  function appendRunEvent(eventType, summary, data = {}) {
    updateRunDetail((current) => ({
      ...current,
      recentEvents: [
        {
          summary,
          timestamp: Date.now(),
          eventType,
          data,
        },
        ...current.recentEvents,
      ].slice(0, 16),
    }));
  }

  function applyControl(payload = {}) {
    const action = payload.action;

    if (action === 'pause') {
      updateRunDetail((current) => ({
        ...current,
        state: 'paused',
        currentPhase: 'paused',
        explanation: 'Run is paused by an operator and will not make progress until resumed.',
        lastUserUpdate: 'Background run paused from the run dashboard.',
        lastWakeReason: 'user_input',
      }));
      appendRunEvent('run_paused', 'Operator paused the run from the dashboard.', { action });
      return;
    }

    if (action === 'resume') {
      updateRunDetail((current) => ({
        ...current,
        state: 'working',
        currentPhase: 'active',
        explanation: 'Run is active and waiting for the next verification cycle. Next verification in ~4s.',
        lastUserUpdate: 'Background run resumed from the run dashboard.',
        lastWakeReason: 'user_input',
      }));
      appendRunEvent('run_resumed', 'Operator resumed the run from the dashboard.', { action });
      return;
    }

    if (action === 'cancel' || action === 'stop') {
      updateRunDetail((current) => ({
        ...current,
        state: 'cancelled',
        currentPhase: 'cancelled',
        explanation: 'Run was cancelled and is no longer executing.',
        lastUserUpdate: payload.reason ?? 'Stopped from the run dashboard.',
        lastWakeReason: 'user_input',
      }));
      appendRunEvent('run_cancelled', 'Operator stopped the run from the dashboard.', { action });
      return;
    }

    if (action === 'edit_objective' && typeof payload.objective === 'string') {
      updateRunDetail((current) => ({
        ...current,
        objective: payload.objective,
        lastUserUpdate: `Objective updated to: ${payload.objective}`,
        lastWakeReason: 'user_input',
      }));
      appendRunEvent('run_objective_updated', `Objective changed to "${payload.objective}".`, { action });
      return;
    }

    if (action === 'amend_constraints' && payload.constraints) {
      updateRunDetail((current) => ({
        ...current,
        contract: {
          ...current.contract,
          ...payload.constraints,
        },
        lastUserUpdate: 'Operator amended the run constraints.',
        lastWakeReason: 'user_input',
      }));
      appendRunEvent('run_contract_amended', 'Operator amended the run constraints.', { action });
      return;
    }

    if (action === 'adjust_budget' && payload.budget) {
      updateRunDetail((current) => ({
        ...current,
        budget: {
          ...current.budget,
          ...payload.budget,
        },
        lastUserUpdate: 'Operator adjusted the run budget.',
        lastWakeReason: 'user_input',
      }));
      appendRunEvent('run_budget_adjusted', 'Operator adjusted the run budget.', { action });
      return;
    }

    if (action === 'force_compact') {
      updateRunDetail((current) => ({
        ...current,
        compaction: {
          ...current.compaction,
          lastCompactedAt: Date.now(),
          lastCompactedCycle: current.cycleCount,
          refreshCount: current.compaction.refreshCount + 1,
          lastCompactionReason: 'operator_forced',
        },
        carryForwardSummary: 'Carry-forward state was refreshed by an operator override.',
        lastUserUpdate: 'Operator forced compaction for this run.',
        lastWakeReason: 'user_input',
      }));
      appendRunEvent('run_compaction_forced', 'Operator forced carry-forward compaction.', { action });
      return;
    }

    if (action === 'reassign_worker' && payload.worker) {
      updateRunDetail((current) => ({
        ...current,
        preferredWorkerId: payload.worker.preferredWorkerId,
        workerAffinityKey: payload.worker.workerAffinityKey,
        lastUserUpdate: 'Operator reassigned the preferred worker.',
        lastWakeReason: 'user_input',
      }));
      appendRunEvent('run_worker_reassigned', 'Operator reassigned the preferred worker.', { action });
      return;
    }

    if (action === 'retry_from_checkpoint') {
      updateRunDetail((current) => ({
        ...current,
        state: 'working',
        currentPhase: 'active',
        explanation: 'Run resumed from the latest checkpoint and is active again.',
        checkpointAvailable: true,
        lastUserUpdate: 'Operator retried the run from its latest checkpoint.',
        lastWakeReason: 'recovery',
      }));
      appendRunEvent('run_retried', 'Operator retried the run from its checkpoint.', { action });
      return;
    }

    if (action === 'verification_override' && payload.override) {
      const mode = payload.override.mode;
      updateRunDetail((current) => ({
        ...current,
        state: mode === 'fail' ? 'failed' : mode === 'complete' ? 'completed' : 'working',
        currentPhase: mode === 'fail' ? 'failed' : mode === 'complete' ? 'completed' : 'active',
        explanation:
          mode === 'fail'
            ? 'Run failed and needs operator review before it is retried.'
            : mode === 'complete'
              ? 'Run completed and the runtime recorded a terminal result.'
              : 'Run is active and waiting for the next verification cycle. Next verification in ~4s.',
        lastUserUpdate: payload.override.reason,
        lastWakeReason: 'user_input',
      }));
      appendRunEvent(
        'run_verification_overridden',
        `Operator verification override recorded: ${payload.override.reason}`,
        { action, mode },
      );
    }
  }

  return {
    getDetail: () => detail,
    summarize: () => summarizeRun(detail),
    applyControl,
  };
}
