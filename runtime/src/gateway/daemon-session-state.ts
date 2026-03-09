import type { ChatExecuteParams, ChatExecutorResult } from "../llm/chat-executor.js";
import type { LLMStatefulResumeAnchor } from "../llm/types.js";
import type { MemoryBackend } from "../memory/types.js";
import {
  SESSION_STATEFUL_HISTORY_COMPACTED_METADATA_KEY,
  SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY,
  type Session,
} from "./session.js";

const WEB_SESSION_RUNTIME_STATE_KEY_PREFIX = "webchat:runtime-state:";

interface PersistedWebSessionRuntimeState {
  readonly version: 1;
  readonly statefulResumeAnchor?: LLMStatefulResumeAnchor;
  readonly statefulHistoryCompacted?: boolean;
}

const SESSION_STATEFUL_LINEAGE_PHASES = new Set([
  "initial",
  "tool_followup",
  "evaluator_retry",
]);

function isStatefulResumeAnchor(
  value: unknown,
): value is LLMStatefulResumeAnchor {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.previousResponseId !== "string") return false;
  if (candidate.previousResponseId.trim().length === 0) return false;
  if (
    candidate.reconciliationHash !== undefined &&
    typeof candidate.reconciliationHash !== "string"
  ) {
    return false;
  }
  return true;
}

function cloneResumeAnchor(
  anchor: LLMStatefulResumeAnchor,
): LLMStatefulResumeAnchor {
  return {
    previousResponseId: anchor.previousResponseId,
    ...(anchor.reconciliationHash
      ? { reconciliationHash: anchor.reconciliationHash }
      : {}),
  };
}

function webSessionRuntimeStateKey(webSessionId: string): string {
  return `${WEB_SESSION_RUNTIME_STATE_KEY_PREFIX}${webSessionId}`;
}

function buildPersistedWebSessionRuntimeState(
  session: Session,
): PersistedWebSessionRuntimeState | undefined {
  const resumeAnchorCandidate =
    session.metadata[SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY];
  const resumeAnchor = isStatefulResumeAnchor(resumeAnchorCandidate)
    ? cloneResumeAnchor(resumeAnchorCandidate)
    : undefined;
  const historyCompacted =
    session.metadata[SESSION_STATEFUL_HISTORY_COMPACTED_METADATA_KEY] === true;
  if (!resumeAnchor && !historyCompacted) return undefined;
  return {
    version: 1,
    ...(resumeAnchor ? { statefulResumeAnchor: resumeAnchor } : {}),
    ...(historyCompacted ? { statefulHistoryCompacted: true } : {}),
  };
}

function coercePersistedWebSessionRuntimeState(
  value: unknown,
): PersistedWebSessionRuntimeState | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1) return undefined;
  const resumeAnchor = isStatefulResumeAnchor(candidate.statefulResumeAnchor)
    ? cloneResumeAnchor(candidate.statefulResumeAnchor)
    : undefined;
  const historyCompacted = candidate.statefulHistoryCompacted === true;
  if (!resumeAnchor && !historyCompacted) return undefined;
  return {
    version: 1,
    ...(resumeAnchor ? { statefulResumeAnchor: resumeAnchor } : {}),
    ...(historyCompacted ? { statefulHistoryCompacted: true } : {}),
  };
}

export function buildSessionStatefulOptions(
  session: Session,
): ChatExecuteParams["stateful"] | undefined {
  const resumeAnchorCandidate =
    session.metadata[SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY];
  const resumeAnchor = isStatefulResumeAnchor(resumeAnchorCandidate)
    ? resumeAnchorCandidate
    : undefined;
  const historyCompacted =
    session.metadata[SESSION_STATEFUL_HISTORY_COMPACTED_METADATA_KEY] === true;
  if (!resumeAnchor && !historyCompacted) return undefined;
  return {
    ...(resumeAnchor ? { resumeAnchor } : {}),
    ...(historyCompacted ? { historyCompacted: true } : {}),
  };
}

export async function persistWebSessionRuntimeState(
  memoryBackend: MemoryBackend,
  webSessionId: string,
  session: Session,
): Promise<void> {
  const persisted = buildPersistedWebSessionRuntimeState(session);
  const key = webSessionRuntimeStateKey(webSessionId);
  if (!persisted) {
    await memoryBackend.delete(key);
    return;
  }
  await memoryBackend.set(key, persisted);
}

export async function clearWebSessionRuntimeState(
  memoryBackend: MemoryBackend,
  webSessionId: string,
): Promise<void> {
  await memoryBackend.delete(webSessionRuntimeStateKey(webSessionId));
}

export async function hydrateWebSessionRuntimeState(
  memoryBackend: MemoryBackend,
  webSessionId: string,
  session: Session,
): Promise<void> {
  const persisted = coercePersistedWebSessionRuntimeState(
    await memoryBackend.get(webSessionRuntimeStateKey(webSessionId)),
  );
  if (!persisted) return;
  if (persisted.statefulResumeAnchor) {
    session.metadata[SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY] =
      cloneResumeAnchor(persisted.statefulResumeAnchor);
  }
  if (persisted.statefulHistoryCompacted) {
    session.metadata[SESSION_STATEFUL_HISTORY_COMPACTED_METADATA_KEY] = true;
  }
}

export function resolveSessionStatefulContinuation(
  result: ChatExecutorResult,
):
  | {
    readonly mode: "persist";
    readonly anchor: LLMStatefulResumeAnchor;
    readonly preserveHistoryCompacted?: boolean;
  }
  | {
    readonly mode: "clear";
  }
  | {
    readonly mode: "noop";
  } {
  if (result.callUsage.length === 0) {
    return { mode: "noop" };
  }

  const latestLineageDiagnostics = [...result.callUsage]
    .reverse()
    .find((entry) => {
      if (!SESSION_STATEFUL_LINEAGE_PHASES.has(entry.phase)) {
        return false;
      }
      const responseId = entry.statefulDiagnostics?.responseId?.trim();
      return typeof responseId === "string" && responseId.length > 0;
    })
    ?.statefulDiagnostics;
  const responseId = latestLineageDiagnostics?.responseId?.trim();
  const reconciliationHash =
    latestLineageDiagnostics?.reconciliationHash?.trim();
  const preserveHistoryCompacted =
    latestLineageDiagnostics?.historyCompacted === true &&
    latestLineageDiagnostics?.continued === true &&
    latestLineageDiagnostics?.anchorMatched === false;
  if (responseId && responseId.length > 0) {
    return {
      mode: "persist",
      anchor: {
        previousResponseId: responseId,
        ...(reconciliationHash ? { reconciliationHash } : {}),
      },
      ...(preserveHistoryCompacted ? { preserveHistoryCompacted: true } : {}),
    };
  }

  return { mode: "clear" };
}

export function persistSessionStatefulContinuation(
  session: Session,
  result: ChatExecutorResult,
): void {
  const continuation = resolveSessionStatefulContinuation(result);
  if (continuation.mode === "noop") {
    return;
  }
  if (continuation.mode === "persist") {
    session.metadata[SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY] =
      continuation.anchor;
    if (continuation.preserveHistoryCompacted) {
      session.metadata[SESSION_STATEFUL_HISTORY_COMPACTED_METADATA_KEY] = true;
      return;
    }
    delete session.metadata[SESSION_STATEFUL_HISTORY_COMPACTED_METADATA_KEY];
    return;
  }

  delete session.metadata[SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY];
  delete session.metadata[SESSION_STATEFUL_HISTORY_COMPACTED_METADATA_KEY];
}
