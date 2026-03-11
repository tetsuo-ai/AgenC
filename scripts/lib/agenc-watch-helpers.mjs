export const DEFAULT_INPUT_BATCH_DELAY_MS = 45;

const BACKGROUND_RUN_STATES = new Set([
  "pending",
  "running",
  "working",
  "blocked",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "suspended",
]);

export function shouldAutoInspectRun(runDetail, runState) {
  if (runDetail && typeof runDetail === "object") {
    return true;
  }
  const normalizedState = String(runState ?? "")
    .trim()
    .toLowerCase();
  return BACKGROUND_RUN_STATES.has(normalizedState);
}

export function createOperatorInputBatcher({
  onDispatch,
  delayMs = DEFAULT_INPUT_BATCH_DELAY_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  if (typeof onDispatch !== "function") {
    throw new TypeError("createOperatorInputBatcher requires an onDispatch callback");
  }

  let pendingLines = [];
  let timer = null;

  const clearPendingTimer = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  const flush = () => {
    clearPendingTimer();
    if (pendingLines.length === 0) return;
    const value = pendingLines.join("\n").trim();
    pendingLines = [];
    if (value) {
      onDispatch(value);
    }
  };

  const scheduleFlush = () => {
    clearPendingTimer();
    timer = setTimer(() => {
      timer = null;
      flush();
    }, delayMs);
  };

  return {
    push(line) {
      const trimmed = String(line ?? "").trim();
      if (!trimmed) {
        return;
      }
      pendingLines.push(trimmed);
      scheduleFlush();
    },
    flush,
    dispose({ flushPending = false } = {}) {
      if (flushPending) {
        flush();
        return;
      }
      clearPendingTimer();
      pendingLines = [];
    },
  };
}
