export const DEFAULT_INPUT_BATCH_DELAY_MS = 45;

export const WATCH_COMMANDS = Object.freeze([
  Object.freeze({
    name: "/help",
    aliases: ["/commands"],
    usage: "/help",
    description: "Show the operator command reference.",
  }),
  Object.freeze({
    name: "/new",
    usage: "/new",
    description: "Start a fresh chat session.",
  }),
  Object.freeze({
    name: "/sessions",
    usage: "/sessions",
    description: "List resumable chat sessions for this operator.",
  }),
  Object.freeze({
    name: "/session",
    usage: "/session <sessionId>",
    description: "Resume a specific chat session.",
  }),
  Object.freeze({
    name: "/history",
    usage: "/history [limit]",
    description: "Show recent chat history for the active session.",
  }),
  Object.freeze({
    name: "/runs",
    usage: "/runs",
    description: "List active durable background runs.",
  }),
  Object.freeze({
    name: "/inspect",
    usage: "/inspect",
    description: "Inspect the current background run.",
  }),
  Object.freeze({
    name: "/trace",
    usage: "/trace [traceId]",
    description: "List recent traces or inspect one trace by id.",
  }),
  Object.freeze({
    name: "/logs",
    usage: "/logs [lines]",
    description: "Fetch recent daemon logs.",
  }),
  Object.freeze({
    name: "/status",
    usage: "/status",
    description: "Fetch gateway status and active channel info.",
  }),
  Object.freeze({
    name: "/pause",
    usage: "/pause",
    description: "Pause the current background run.",
  }),
  Object.freeze({
    name: "/resume",
    usage: "/resume",
    description: "Resume the current background run.",
  }),
  Object.freeze({
    name: "/stop",
    usage: "/stop",
    description: "Stop the current background run.",
  }),
  Object.freeze({
    name: "/cancel",
    usage: "/cancel",
    description: "Cancel the active chat turn.",
  }),
  Object.freeze({
    name: "/clear",
    usage: "/clear",
    description: "Clear the local transcript surface.",
  }),
  Object.freeze({
    name: "/quit",
    aliases: ["/exit"],
    usage: "/quit",
    description: "Exit the watch console.",
  }),
]);

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

function normalizeSlashInput(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function findWatchCommandDefinition(nameOrAlias) {
  const normalized = normalizeSlashInput(nameOrAlias);
  if (!normalized.startsWith("/")) {
    return null;
  }
  for (const command of WATCH_COMMANDS) {
    if (command.name === normalized) {
      return command;
    }
    if (Array.isArray(command.aliases) && command.aliases.includes(normalized)) {
      return command;
    }
  }
  return null;
}

export function matchWatchCommands(input, { limit = WATCH_COMMANDS.length } = {}) {
  const normalized = normalizeSlashInput(input);
  if (!normalized.startsWith("/")) {
    return [];
  }
  const [commandToken = "/"] = normalized.split(/\s+/, 1);
  const query = commandToken === "/" ? "" : commandToken.slice(1);
  const ranked = WATCH_COMMANDS
    .map((command) => {
      const names = [command.name, ...(command.aliases ?? [])];
      const exact = names.some((name) => name === commandToken);
      const startsWith = names.some((name) => name.slice(1).startsWith(query));
      if (query.length > 0 && !exact && !startsWith) {
        return null;
      }
      return {
        command,
        score: exact ? 0 : startsWith ? 1 : 2,
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }
      return left.command.name.localeCompare(right.command.name);
    })
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.command);
  return ranked;
}

export function parseWatchSlashCommand(input) {
  const trimmed = String(input ?? "").trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const [commandToken = "", ...args] = trimmed.split(/\s+/);
  const command = findWatchCommandDefinition(commandToken);
  if (!command) {
    return {
      raw: trimmed,
      commandToken,
      args,
      command: null,
    };
  }
  return {
    raw: trimmed,
    commandToken,
    args,
    command,
  };
}
