import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatExecutorResult } from "../llm/chat-executor.js";
import type { LLMProvider, ToolHandler } from "../llm/types.js";
import { InMemoryBackend } from "../memory/in-memory/backend.js";
import { SqliteBackend } from "../memory/sqlite/backend.js";
import {
  BackgroundRunSupervisor,
  type BackgroundRunStatusSnapshot,
} from "../gateway/background-run-supervisor.js";
import { BackgroundRunStore } from "../gateway/background-run-store.js";
import {
  buildBackgroundRunQualityArtifact,
  type BackgroundRunQualityArtifact,
  type BackgroundRunScenarioArtifact,
} from "./background-run-quality.js";
import { replayBackgroundRunFromStore } from "./background-run-replay.js";

export interface BackgroundRunQualityRunnerConfig {
  readonly now?: () => number;
  readonly runId?: string;
}

function makeActorResult(
  content: string,
  tokenCount: number,
): ChatExecutorResult {
  return {
    content,
    provider: "background-run-benchmark",
    model: "background-run-benchmark-model",
    usedFallback: false,
    toolCalls: [],
    tokenUsage: {
      promptTokens: Math.max(1, Math.floor(tokenCount / 2)),
      completionTokens: Math.max(1, tokenCount - Math.max(1, Math.floor(tokenCount / 2))),
      totalTokens: tokenCount,
    },
    callUsage: [],
    durationMs: 5,
    compacted: false,
    stopReason: "completed",
  };
}

function createScriptedSupervisorLlm(responses: readonly string[]): LLMProvider {
  const queue = [...responses];
  return {
    name: "background-run-supervisor-benchmark",
    chat: async () => {
      const content = queue.shift();
      if (content === undefined) {
        throw new Error("Exhausted scripted supervisor responses");
      }
      return {
        content,
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "background-run-supervisor-benchmark",
        finishReason: "stop" as const,
      };
    },
    chatStream: async () => {
      throw new Error("streaming not used in background-run-quality runner");
    },
    healthCheck: async () => true,
  };
}

function createScriptedChatExecutor(
  results: readonly ChatExecutorResult[],
): { execute: (input: unknown) => Promise<ChatExecutorResult> } {
  const queue = [...results];
  return {
    execute: async () => {
      const result = queue.shift();
      if (!result) {
        throw new Error("Exhausted scripted actor results");
      }
      return result;
    },
  };
}

async function flushBackgroundWork(iterations = 4): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function waitForTerminalSnapshot(
  supervisor: BackgroundRunSupervisor,
  sessionId: string,
  attempts = 40,
): Promise<BackgroundRunStatusSnapshot | undefined> {
  for (let index = 0; index < attempts; index += 1) {
    await flushBackgroundWork();
    const active = supervisor.getStatusSnapshot(sessionId);
    if (!active) {
      return undefined;
    }
    if (
      active.state === "completed" ||
      active.state === "failed" ||
      active.state === "cancelled"
    ) {
      return active;
    }
  }
  return supervisor.getStatusSnapshot(sessionId);
}

async function waitForSnapshot(
  supervisor: BackgroundRunSupervisor,
  sessionId: string,
  predicate: (snapshot: BackgroundRunStatusSnapshot) => boolean,
  attempts = 40,
): Promise<BackgroundRunStatusSnapshot | undefined> {
  for (let index = 0; index < attempts; index += 1) {
    await flushBackgroundWork();
    const snapshot = supervisor.getStatusSnapshot(sessionId);
    if (snapshot && predicate(snapshot)) {
      return snapshot;
    }
  }
  return supervisor.getStatusSnapshot(sessionId);
}

function scoreBoolean(value: boolean): number {
  return value ? 1 : 0;
}

async function buildScenarioArtifact(params: {
  scenarioId: string;
  category: BackgroundRunScenarioArtifact["category"];
  store: BackgroundRunStore;
  sessionId: string;
  expectedFinalState: string;
  tokenCount: number;
  operatorUxOk: boolean;
  notes?: string;
}): Promise<BackgroundRunScenarioArtifact> {
  const replay = await replayBackgroundRunFromStore({
    store: params.store,
    sessionId: params.sessionId,
  });
  const latencyMs =
    replay.terminalEventAt !== undefined && replay.startedAt !== undefined
      ? replay.terminalEventAt - replay.startedAt
      : 0;
  const endStateCorrect = replay.finalState === params.expectedFinalState;
  const verifierCorrect = replay.verifierAccurate;
  const recoveryCorrect = !replay.recoveryObserved || replay.finalState === "completed";

  return {
    scenarioId: params.scenarioId,
    category: params.category,
    ok: endStateCorrect && replay.replayConsistent,
    finalState: replay.finalState,
    latencyMs,
    timeToFirstAckMs: replay.timeToFirstAckMs,
    timeToFirstVerifiedUpdateMs: replay.timeToFirstVerifiedUpdateMs,
    stopLatencyMs: replay.stopLatencyMs,
    falseCompletion: replay.falseCompletion,
    blockedWithoutNotice: replay.blockedWithoutNotice,
    recoverySucceeded: recoveryCorrect,
    verifierAccurate: replay.verifierAccurate,
    replayConsistent: replay.replayConsistent,
    transcriptScore: scoreBoolean(!replay.blockedWithoutNotice),
    toolTrajectoryScore: 1,
    endStateCorrectnessScore: scoreBoolean(endStateCorrect),
    verifierCorrectnessScore: scoreBoolean(verifierCorrect),
    restartRecoveryCorrectnessScore: scoreBoolean(recoveryCorrect),
    operatorUxCorrectnessScore: scoreBoolean(params.operatorUxOk),
    tokenCount: params.tokenCount,
    eventCount: replay.eventCount,
    notes: params.notes,
  };
}

async function runCompletionScenario(
  now: () => number,
): Promise<BackgroundRunScenarioArtifact> {
  const store = new BackgroundRunStore({
    memoryBackend: new InMemoryBackend(),
  });
  const supervisor = new BackgroundRunSupervisor({
    chatExecutor: createScriptedChatExecutor([
      {
        ...makeActorResult("Watcher is running.", 12),
        toolCalls: [
          {
            name: "desktop.process_start",
            args: {
              command: "/bin/sleep",
              args: ["2"],
              cwd: "/tmp",
              label: "watcher",
            },
            result:
              '{"processId":"proc_completion","label":"watcher","command":"/bin/sleep","args":["2"],"cwd":"/tmp","state":"running"}',
            isError: false,
            durationMs: 5,
          },
        ],
      },
    ]) as any,
    supervisorLlm: createScriptedSupervisorLlm([
      '{"domain":"managed_process","kind":"until_condition","successCriteria":["Watch the process until it exits."],"completionCriteria":["Observe the managed process exit."],"blockedCriteria":["Managed process tooling unavailable."],"nextCheckMs":4000,"heartbeatMs":12000,"requiresUserStop":false,"managedProcessPolicy":{"mode":"until_exit"}}',
      '{"state":"working","userUpdate":"Watcher is running.","internalSummary":"verified running","nextCheckMs":4000,"shouldNotifyUser":true}',
      '{"summary":"Watcher is running until exit is observed.","verifiedFacts":["Watcher is running."],"openLoops":["Wait for the managed process to exit."],"nextFocus":"Observe the exit signal."}',
    ]),
    getSystemPrompt: () => "benchmark system prompt",
    runStore: store,
    createToolHandler: (): ToolHandler => async () => "ok",
    publishUpdate: async () => undefined,
    now,
  });

  await supervisor.startRun({
    sessionId: "background-run-quality-completion",
    objective: "Complete the benchmark task.",
  });
  await waitForSnapshot(
    supervisor,
    "background-run-quality-completion",
    (snapshot) => snapshot.state === "working",
  );
  await supervisor.signalRun({
    sessionId: "background-run-quality-completion",
    type: "process_exit",
    content: 'Managed process "watcher" (proc_completion) exited (exitCode=0).',
    data: {
      processId: "proc_completion",
      exitCode: 0,
    },
  });
  await waitForTerminalSnapshot(supervisor, "background-run-quality-completion");

  return buildScenarioArtifact({
    scenarioId: "canary_completion",
    category: "canary",
    store,
    sessionId: "background-run-quality-completion",
    expectedFinalState: "completed",
    tokenCount: 12,
    operatorUxOk: true,
  });
}

async function runBlockedScenario(
  now: () => number,
): Promise<BackgroundRunScenarioArtifact> {
  const store = new BackgroundRunStore({
    memoryBackend: new InMemoryBackend(),
  });
  const updates: string[] = [];
  const supervisor = new BackgroundRunSupervisor({
    chatExecutor: createScriptedChatExecutor([
      makeActorResult("Need approval.", 9),
    ]) as any,
    supervisorLlm: createScriptedSupervisorLlm([
      '{"domain":"generic","kind":"finite","successCriteria":["Complete the task."],"completionCriteria":["Observe success."],"blockedCriteria":["Operator input required."],"nextCheckMs":4000,"heartbeatMs":12000,"requiresUserStop":false}',
      '{"state":"blocked","userUpdate":"Need operator input before I can continue.","internalSummary":"approval required","shouldNotifyUser":true}',
      '{"summary":"Run is blocked on operator input.","verifiedFacts":[],"openLoops":["Wait for operator input."],"nextFocus":"Pause."}',
    ]),
    getSystemPrompt: () => "benchmark system prompt",
    runStore: store,
    createToolHandler: (): ToolHandler => async () => "ok",
    publishUpdate: async (_sessionId, content) => {
      updates.push(content);
    },
    now,
  });

  await supervisor.startRun({
    sessionId: "background-run-quality-blocked",
    objective: "Attempt a blocked task.",
  });
  await waitForSnapshot(
    supervisor,
    "background-run-quality-blocked",
    (snapshot) => snapshot.state === "blocked",
  );

  return buildScenarioArtifact({
    scenarioId: "blocked_notice",
    category: "canary",
    store,
    sessionId: "background-run-quality-blocked",
    expectedFinalState: "blocked",
    tokenCount: 9,
    operatorUxOk: updates.some((value) => value.includes("operator input")),
  });
}

async function runStopScenario(
  now: () => number,
): Promise<BackgroundRunScenarioArtifact> {
  const store = new BackgroundRunStore({
    memoryBackend: new InMemoryBackend(),
  });
  const supervisor = new BackgroundRunSupervisor({
    chatExecutor: createScriptedChatExecutor([
      makeActorResult("Still running.", 6),
    ]) as any,
    supervisorLlm: createScriptedSupervisorLlm([
      '{"domain":"generic","kind":"until_stopped","successCriteria":["Keep running until stopped."],"completionCriteria":["User cancels the run."],"blockedCriteria":["Runtime unavailable."],"nextCheckMs":4000,"heartbeatMs":12000,"requiresUserStop":true}',
      '{"state":"working","userUpdate":"Still running.","internalSummary":"background task active","nextCheckMs":4000,"shouldNotifyUser":true}',
      '{"summary":"Task is active and waiting for a stop request.","verifiedFacts":["Task started."],"openLoops":["Wait for a stop request."],"nextFocus":"Keep monitoring."}',
    ]),
    getSystemPrompt: () => "benchmark system prompt",
    runStore: store,
    createToolHandler: (): ToolHandler => async () => "ok",
    publishUpdate: async () => undefined,
    now,
  });

  await supervisor.startRun({
    sessionId: "background-run-quality-stop",
    objective: "Run until told to stop.",
  });
  await waitForSnapshot(
    supervisor,
    "background-run-quality-stop",
    (snapshot) => snapshot.state === "working",
  );
  await supervisor.cancelRun(
    "background-run-quality-stop",
    "Background run cancelled from the benchmark suite.",
  );

  return buildScenarioArtifact({
    scenarioId: "operator_stop",
    category: "canary",
    store,
    sessionId: "background-run-quality-stop",
    expectedFinalState: "cancelled",
    tokenCount: 6,
    operatorUxOk: true,
  });
}

async function runRecoveryScenario(
  now: () => number,
): Promise<BackgroundRunScenarioArtifact> {
  const sqliteDir = await mkdtemp(join(tmpdir(), "agenc-background-run-quality-"));
  const dbPath = join(sqliteDir, "runtime.sqlite");
  const backend1 = new SqliteBackend({ dbPath });
  const store1 = new BackgroundRunStore({ memoryBackend: backend1 });
  const supervisor1 = new BackgroundRunSupervisor({
    chatExecutor: createScriptedChatExecutor([
      {
        ...makeActorResult("Watcher is running.", 7),
        toolCalls: [
          {
            name: "desktop.process_start",
            args: {
              command: "/bin/sleep",
              args: ["2"],
              cwd: "/tmp",
              label: "watcher",
            },
            result:
              '{"processId":"proc_recovery","label":"watcher","command":"/bin/sleep","args":["2"],"cwd":"/tmp","state":"running"}',
            isError: false,
            durationMs: 5,
          },
        ],
      },
    ]) as any,
    supervisorLlm: createScriptedSupervisorLlm([
      '{"domain":"managed_process","kind":"until_condition","successCriteria":["Complete after restart."],"completionCriteria":["Observe the managed process exit after recovery."],"blockedCriteria":["Managed process tooling unavailable."],"nextCheckMs":4000,"heartbeatMs":12000,"requiresUserStop":false,"managedProcessPolicy":{"mode":"until_exit"}}',
      '{"state":"working","userUpdate":"Watcher is running before restart.","internalSummary":"waiting for restart recovery","nextCheckMs":4000,"shouldNotifyUser":true}',
      '{"summary":"Task is waiting for a recovery-time exit signal.","verifiedFacts":["Watcher started before restart."],"openLoops":["Wait for recovery signal."],"nextFocus":"Continue after restart."}',
    ]),
    getSystemPrompt: () => "benchmark system prompt",
    runStore: store1,
    createToolHandler: (): ToolHandler => async () => "ok",
    publishUpdate: async () => undefined,
    now,
    instanceId: "background-run-quality-1",
  });

  await supervisor1.startRun({
    sessionId: "background-run-quality-recovery",
    objective: "Complete after recovery.",
  });
  await waitForSnapshot(
    supervisor1,
    "background-run-quality-recovery",
    (snapshot) => snapshot.state === "working",
  );
  await supervisor1.shutdown();
  await backend1.close();

  const backend2 = new SqliteBackend({ dbPath });
  const store2 = new BackgroundRunStore({ memoryBackend: backend2 });
  const supervisor2 = new BackgroundRunSupervisor({
    chatExecutor: createScriptedChatExecutor([
      makeActorResult("Recovered and completed.", 7),
    ]) as any,
    supervisorLlm: createScriptedSupervisorLlm([
      '{"state":"completed","userUpdate":"Recovered and completed.","internalSummary":"recovered completion","shouldNotifyUser":true}',
      '{"summary":"Task recovered and completed.","verifiedFacts":["Recovery succeeded."],"openLoops":[],"nextFocus":"None."}',
    ]),
    getSystemPrompt: () => "benchmark system prompt",
    runStore: store2,
    createToolHandler: (): ToolHandler => async () => "ok",
    publishUpdate: async () => undefined,
    now,
    instanceId: "background-run-quality-2",
  });

  await supervisor2.recoverRuns();
  await supervisor2.signalRun({
    sessionId: "background-run-quality-recovery",
    type: "process_exit",
    content: 'Managed process "watcher" (proc_recovery) exited (exitCode=0).',
    data: {
      processId: "proc_recovery",
      exitCode: 0,
    },
  });
  await waitForTerminalSnapshot(supervisor2, "background-run-quality-recovery");
  const artifact = await buildScenarioArtifact({
    scenarioId: "restart_recovery",
    category: "chaos",
    store: store2,
    sessionId: "background-run-quality-recovery",
    expectedFinalState: "completed",
    tokenCount: 14,
    operatorUxOk: true,
  });
  await supervisor2.shutdown();
  await backend2.close();
  await rm(sqliteDir, { recursive: true, force: true });
  return artifact;
}

async function runSoakScenario(
  now: () => number,
): Promise<BackgroundRunScenarioArtifact> {
  const store = new BackgroundRunStore({
    memoryBackend: new InMemoryBackend(),
  });
  const supervisor = new BackgroundRunSupervisor({
    chatExecutor: createScriptedChatExecutor([
      makeActorResult("Still working, cycle 1.", 5),
      makeActorResult("Still working, cycle 2.", 5),
      makeActorResult("Completed after extended supervision.", 5),
    ]) as any,
    supervisorLlm: createScriptedSupervisorLlm([
      '{"domain":"generic","kind":"until_stopped","successCriteria":["Keep making progress until the operator stops the run."],"completionCriteria":["Receive an operator stop request."],"blockedCriteria":["Runtime unavailable."],"nextCheckMs":4000,"heartbeatMs":12000,"requiresUserStop":true}',
      '{"state":"working","userUpdate":"Cycle 1 complete.","internalSummary":"cycle 1","nextCheckMs":4000,"shouldNotifyUser":true}',
      '{"summary":"Cycle 1 complete.","verifiedFacts":["Cycle 1 finished."],"openLoops":["Continue the task."],"nextFocus":"Run cycle 2."}',
      '{"state":"working","userUpdate":"Cycle 2 complete.","internalSummary":"cycle 2","nextCheckMs":4000,"shouldNotifyUser":true}',
      '{"summary":"Cycle 2 complete.","verifiedFacts":["Cycle 2 finished."],"openLoops":["Finalize the task."],"nextFocus":"Run cycle 3."}',
      '{"state":"working","userUpdate":"Cycle 3 complete.","internalSummary":"cycle 3","nextCheckMs":4000,"shouldNotifyUser":true}',
      '{"summary":"Cycle 3 complete.","verifiedFacts":["Cycle 3 finished."],"openLoops":["Wait for the operator to stop the long-running task."],"nextFocus":"Keep monitoring."}',
    ]),
    getSystemPrompt: () => "benchmark system prompt",
    runStore: store,
    createToolHandler: (): ToolHandler => async () => "ok",
    publishUpdate: async () => undefined,
    now,
  });

  await supervisor.startRun({
    sessionId: "background-run-quality-soak",
    objective: "Stay active for multiple cycles before completion.",
  });
  await waitForSnapshot(
    supervisor,
    "background-run-quality-soak",
    (snapshot) =>
      snapshot.state === "working" &&
      snapshot.lastUserUpdate === "Cycle 1 complete.",
  );
  await supervisor.signalRun({
    sessionId: "background-run-quality-soak",
    content: "Continue with the next supervision cycle.",
  });
  await waitForSnapshot(
    supervisor,
    "background-run-quality-soak",
    (snapshot) =>
      snapshot.state === "working" &&
      snapshot.lastUserUpdate === "Cycle 2 complete.",
  );
  await supervisor.signalRun({
    sessionId: "background-run-quality-soak",
    content: "Finalize the supervision cycle.",
  });
  await waitForSnapshot(
    supervisor,
    "background-run-quality-soak",
    (snapshot) =>
      snapshot.state === "working" &&
      snapshot.lastUserUpdate === "Cycle 3 complete.",
  );
  await supervisor.cancelRun(
    "background-run-quality-soak",
    "Stopped the soak benchmark after multiple successful supervision cycles.",
  );

  return buildScenarioArtifact({
    scenarioId: "multi_cycle_soak",
    category: "soak",
    store,
    sessionId: "background-run-quality-soak",
    expectedFinalState: "cancelled",
    tokenCount: 15,
    operatorUxOk: true,
  });
}

async function runProviderStallScenario(
  now: () => number,
): Promise<BackgroundRunScenarioArtifact> {
  const store = new BackgroundRunStore({
    memoryBackend: new InMemoryBackend(),
  });
  const supervisor = new BackgroundRunSupervisor({
    chatExecutor: {
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return {
          ...makeActorResult("Recovered from a provider stall.", 8),
          toolCalls: [
            {
              name: "desktop.process_start",
              args: {
                command: "/bin/sleep",
                args: ["1"],
                cwd: "/tmp",
                label: "stall-watcher",
              },
              result:
                '{"processId":"proc_stall","label":"stall-watcher","command":"/bin/sleep","args":["1"],"cwd":"/tmp","state":"running"}',
              isError: false,
              durationMs: 5,
            },
          ],
        };
      },
    } as any,
    supervisorLlm: createScriptedSupervisorLlm([
      '{"domain":"managed_process","kind":"until_condition","successCriteria":["Complete despite a provider stall."],"completionCriteria":["Observe the managed process exit."],"blockedCriteria":["Managed process tooling unavailable."],"nextCheckMs":4000,"heartbeatMs":12000,"requiresUserStop":false,"managedProcessPolicy":{"mode":"until_exit"}}',
      '{"state":"working","userUpdate":"Recovered from a provider stall and watcher is running.","internalSummary":"provider stall tolerated","nextCheckMs":4000,"shouldNotifyUser":true}',
      '{"summary":"Provider stall recovered successfully and the watcher is active.","verifiedFacts":["Actor call completed after a delay.","Watcher is running."],"openLoops":["Wait for the managed process exit."],"nextFocus":"Observe the exit signal."}',
    ]),
    getSystemPrompt: () => "benchmark system prompt",
    runStore: store,
    createToolHandler: (): ToolHandler => async () => "ok",
    publishUpdate: async () => undefined,
    now,
  });

  await supervisor.startRun({
    sessionId: "background-run-quality-provider-stall",
    objective: "Complete even if the actor call stalls briefly.",
  });
  await waitForSnapshot(
    supervisor,
    "background-run-quality-provider-stall",
    (snapshot) => snapshot.state === "working",
  );
  await supervisor.signalRun({
    sessionId: "background-run-quality-provider-stall",
    type: "process_exit",
    content: 'Managed process "stall-watcher" (proc_stall) exited (exitCode=0).',
    data: {
      processId: "proc_stall",
      exitCode: 0,
    },
  });
  await waitForTerminalSnapshot(supervisor, "background-run-quality-provider-stall");

  return buildScenarioArtifact({
    scenarioId: "provider_stall",
    category: "chaos",
    store,
    sessionId: "background-run-quality-provider-stall",
    expectedFinalState: "completed",
    tokenCount: 8,
    operatorUxOk: true,
  });
}

export async function runBackgroundRunQualitySuite(
  config: BackgroundRunQualityRunnerConfig = {},
): Promise<BackgroundRunQualityArtifact> {
  const now = config.now ?? (() => Date.now());
  const scenarios = await Promise.all([
    runCompletionScenario(now),
    runBlockedScenario(now),
    runStopScenario(now),
    runRecoveryScenario(now),
    runSoakScenario(now),
    runProviderStallScenario(now),
  ]);

  return buildBackgroundRunQualityArtifact({
    runId: config.runId ?? `background-run-quality-${now()}`,
    generatedAtMs: now(),
    scenarios,
  });
}
