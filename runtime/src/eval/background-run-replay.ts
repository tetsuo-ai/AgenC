import type {
  BackgroundRunRecentSnapshot,
  BackgroundRunState,
  BackgroundRunStore,
} from "../gateway/background-run-store.js";
import type { MemoryEntry } from "../memory/types.js";

export interface BackgroundRunReplayEvent {
  readonly type: string;
  readonly timestamp: number;
  readonly summary: string;
  readonly kind?: string;
  readonly verified: boolean;
}

export interface BackgroundRunReplayResult {
  readonly sessionId: string;
  readonly runId: string;
  readonly finalState: BackgroundRunState;
  readonly snapshot: BackgroundRunRecentSnapshot;
  readonly eventCount: number;
  readonly startedAt?: number;
  readonly firstAckAt?: number;
  readonly firstVerifiedUpdateAt?: number;
  readonly terminalEventAt?: number;
  readonly timeToFirstAckMs?: number;
  readonly timeToFirstVerifiedUpdateMs?: number;
  readonly stopLatencyMs?: number;
  readonly falseCompletion: boolean;
  readonly blockedWithoutNotice: boolean;
  readonly recoveryObserved: boolean;
  readonly verifierAccurate: boolean;
  readonly replayConsistent: boolean;
  readonly transitionViolations: readonly string[];
  readonly events: readonly BackgroundRunReplayEvent[];
}

function readEventType(entry: MemoryEntry): string {
  return typeof entry.metadata?.eventType === "string"
    ? entry.metadata.eventType
    : "unknown";
}

function readEventKind(entry: MemoryEntry): string | undefined {
  return typeof entry.metadata?.kind === "string" ? entry.metadata.kind : undefined;
}

function readVerified(entry: MemoryEntry): boolean {
  return entry.metadata?.verified === true;
}

function buildReplayEvents(
  entries: readonly MemoryEntry[],
): readonly BackgroundRunReplayEvent[] {
  return [...entries]
    .sort((left, right) => left.timestamp - right.timestamp)
    .map((entry) => ({
      type: readEventType(entry),
      timestamp: entry.timestamp,
      summary: entry.content,
      kind: readEventKind(entry),
      verified: readVerified(entry),
    }));
}

function expectedTerminalEvent(state: BackgroundRunState): string | undefined {
  switch (state) {
    case "completed":
      return "run_completed";
    case "failed":
      return "run_failed";
    case "cancelled":
      return "run_cancelled";
    default:
      return undefined;
  }
}

export async function replayBackgroundRunFromStore(params: {
  store: BackgroundRunStore;
  sessionId: string;
}): Promise<BackgroundRunReplayResult> {
  const snapshot = await params.store.loadRecentSnapshot(params.sessionId);
  if (!snapshot) {
    throw new Error(`Missing recent snapshot for background run session ${params.sessionId}`);
  }

  const entries = await params.store.listEvents(snapshot.runId);
  const events = buildReplayEvents(entries);
  const transitionViolations: string[] = [];
  const terminalEventType = expectedTerminalEvent(snapshot.state);
  const terminalEvent = terminalEventType
    ? [...events].reverse().find((event) => event.type === terminalEventType)
    : undefined;
  const runStarted = events.find((event) => event.type === "run_started");
  const firstAck = events.find(
    (event) => event.type === "user_update" && event.kind === "ack",
  );
  const firstVerifiedUpdate = events.find(
    (event) => event.type === "user_update" && event.verified,
  );
  const lastBlockedEvent = [...events]
    .reverse()
    .find((event) => event.type === "run_blocked");
  const blockedNotice = lastBlockedEvent
    ? events.find(
        (event) =>
          event.type === "user_update" &&
          event.timestamp >= lastBlockedEvent.timestamp,
      )
      ?? (snapshot.lastUserUpdate
        ? {
            type: "user_update",
            timestamp: snapshot.updatedAt,
            summary: snapshot.lastUserUpdate,
            verified: snapshot.lastVerifiedAt !== undefined,
          }
        : undefined)
    : undefined;
  const recoveryObserved = events.some((event) => event.type === "run_recovered");
  const cancelEventEntry = [...entries]
    .reverse()
    .find((entry) => readEventType(entry) === "run_cancelled");
  const stopRequestedAt =
    typeof cancelEventEntry?.metadata?.stopRequestedAt === "number"
      ? cancelEventEntry.metadata.stopRequestedAt
      : undefined;

  if (terminalEventType && !terminalEvent) {
    transitionViolations.push(
      `Expected terminal event "${terminalEventType}" for final state "${snapshot.state}".`,
    );
  }

  const falseCompletion =
    snapshot.state === "completed" &&
    firstVerifiedUpdate === undefined &&
    snapshot.lastVerifiedAt === undefined;
  const blockedWithoutNotice =
    snapshot.state === "blocked" && blockedNotice === undefined;
  const verifierAccurate = !falseCompletion && !blockedWithoutNotice;

  if (falseCompletion) {
    transitionViolations.push(
      "Completed run has no verified update or lastVerifiedAt evidence.",
    );
  }
  if (blockedWithoutNotice) {
    transitionViolations.push(
      "Blocked run has no user-visible update after the blocking event.",
    );
  }

  return {
    sessionId: snapshot.sessionId,
    runId: snapshot.runId,
    finalState: snapshot.state,
    snapshot,
    eventCount: events.length,
    startedAt: runStarted?.timestamp,
    firstAckAt: firstAck?.timestamp,
    firstVerifiedUpdateAt: firstVerifiedUpdate?.timestamp,
    terminalEventAt: terminalEvent?.timestamp ?? lastBlockedEvent?.timestamp,
    timeToFirstAckMs:
      runStarted && firstAck ? firstAck.timestamp - runStarted.timestamp : undefined,
    timeToFirstVerifiedUpdateMs:
      runStarted && firstVerifiedUpdate
        ? firstVerifiedUpdate.timestamp - runStarted.timestamp
        : undefined,
    stopLatencyMs:
      stopRequestedAt !== undefined && cancelEventEntry
        ? cancelEventEntry.timestamp - stopRequestedAt
        : undefined,
    falseCompletion,
    blockedWithoutNotice,
    recoveryObserved,
    verifierAccurate,
    replayConsistent: transitionViolations.length === 0,
    transitionViolations,
    events,
  };
}
