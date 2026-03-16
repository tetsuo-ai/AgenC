/**
 * Constants, regex patterns, and system prompts for the BackgroundRunSupervisor.
 *
 * Extracted from background-run-supervisor.ts to keep the supervisor module focused
 * on orchestration logic.
 *
 * @module
 */

import type { BackgroundRunWorkerPool } from "./background-run-store.js";

export const DEFAULT_POLL_INTERVAL_MS = 8_000;
export const BUSY_RETRY_INTERVAL_MS = 1_500;
export const MIN_POLL_INTERVAL_MS = 2_000;
export const MAX_POLL_INTERVAL_MS = 60_000;
export const FAST_FOLLOWUP_POLL_INTERVAL_MS = 4_000;
export const STABLE_POLL_STEP_MS = 8_000;
export const ACTIVE_CYCLE_HEARTBEAT_INITIAL_MS = 8_000;
export const ACTIVE_CYCLE_HEARTBEAT_REPEAT_MS = 15_000;
export const HEARTBEAT_MIN_DELAY_MS = 10_000;
export const HEARTBEAT_MAX_DELAY_MS = 20_000;
export const MAX_RUN_HISTORY_MESSAGES = 12;
export const HISTORY_COMPACTION_THRESHOLD = 10;
export const MAX_TOOL_RESULT_PREVIEW_CHARS = 240;
export const MAX_USER_UPDATE_CHARS = 240;
export const MAX_MEMORY_FACTS = 6;
export const MAX_MEMORY_OPEN_LOOPS = 6;
export const BACKGROUND_RUN_ACTOR_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_MEMORY_ARTIFACTS = 6;
export const MAX_MEMORY_ANCHORS = 6;
export const BACKGROUND_RUN_MAX_TOOL_ROUNDS = 1;
export const BACKGROUND_RUN_MAX_TOOL_BUDGET = 4;
export const BACKGROUND_RUN_MAX_MODEL_RECALLS = 0;
export const MAX_CONSECUTIVE_ERROR_CYCLES = 3;
export const DEFAULT_MANAGED_PROCESS_MAX_RESTARTS = 5;
export const DEFAULT_MANAGED_PROCESS_RESTART_BACKOFF_MS = 5_000;
export const DEFAULT_WORKER_HEARTBEAT_MS = 5_000;
export const DEFAULT_DISPATCH_RETRY_MS = 2_000;
export const DEFAULT_DISPATCH_QUEUE_MAX_TOTAL = 256;
export const EVENT_DRIVEN_MANAGED_PROCESS_RECONCILE_MS = 5 * 60_000;
export const DEFAULT_DISPATCH_QUEUE_MAX_PER_POOL: Record<
  BackgroundRunWorkerPool,
  number
> = {
  generic: 96,
  browser: 48,
  desktop: 48,
  code: 96,
  research: 32,
  approval: 96,
  remote_mcp: 48,
};
export const MAX_BACKGROUND_RUN_ALERTS = 16;

export const MANAGED_PROCESS_BOOTSTRAP_QUOTED_COMMAND_RE =
  /\b(?:run|start|launch)\s+(?:"([^"]+)"|'([^']+)')/i;
export const MANAGED_PROCESS_BOOTSTRAP_COMMAND_RE =
  /\b(?:run|start|launch)\s+((?:\/)?[A-Za-z0-9_./:+%@=-]+(?:\s+[A-Za-z0-9_./:+%@=-]+)*)(?=\s+(?:under\s+the\s+label|with\s+label|label)\b|[.,]|$)/i;
export const MANAGED_PROCESS_BOOTSTRAP_LABEL_RE =
  /\b(?:under\s+the\s+label|with\s+label|label)\s+([A-Za-z0-9_.:-]+)/i;
export const NON_EXECUTABLE_BOOTSTRAP_TOKENS = new Set([
  "a",
  "an",
  "the",
  "this",
  "that",
  "durable",
  "background",
  "long-running",
  "typed",
  "http",
  "https",
  "server",
  "process",
  "job",
  "task",
  "worker",
  "browser",
  "desktop",
  "sandbox",
  "local",
  "remote",
]);

export const UNTIL_STOP_RE =
  /\buntil\s+(?:i|you)\s+(?:say|tell)\s+(?:(?:me|you)\s+)?(?:to\s+)?stop\b/i;
export const KEEP_UPDATING_RE =
  /\b(?:keep\s+me\s+updated|(?:give|provide|send)\s+(?:me\s+)?(?:regular|periodic)?\s*(?:status\s+)?updates|report\s+back)\b/i;
export const BACKGROUND_RE =
  /\b(?:in\s+the\s+background|background\s+(?:run|task|job|monitor|execution))\b/i;
export const CONTINUOUS_RE =
  /\b(?:keep\s+(?:it\s+)?(?:running|playing|watching|monitoring|checking|tracking)|stay\s+running|monitor(?:ing)?|watch(?:ing)?\s+for|poll(?:ing)?|continu(?:ous|ously))\b/i;
export const STOP_REQUEST_RE =
  /^\s*(?:stop|cancel|halt|end(?:\s+it|\s+that|\s+the\s+run)?|stop\s+that|stop\s+it|stop\s+the\s+run)\s*$/i;
export const PAUSE_REQUEST_RE =
  /^\s*(?:pause|hold|wait|pause\s+that|pause\s+it|pause\s+the\s+run)\s*$/i;
export const RESUME_REQUEST_RE =
  /^\s*(?:resume|continue|continue\s+it|continue\s+that|unpause|restart\s+the\s+run)\s*$/i;
export const STATUS_REQUEST_RE =
  /^\s*(?:status|update|progress|how(?:'s|\s+is)\s+it\s+going|what(?:'s|\s+is)\s+the\s+status)\s*$/i;

export const BACKGROUND_ACTOR_SECTION =
  "## Background Run Mode\n" +
  "This is an internal long-running task supervisor cycle for a user-owned objective.\n" +
  "Take one bounded step toward the objective. Use tools when needed.\n" +
  "For long-running shell work, launch it so the tool call returns immediately: background the long-running process, redirect stdout/stderr, and verify in a later cycle instead of waiting inside one command.\n" +
  "Do not spend a whole tool call sleeping or waiting for a delayed effect when the objective is ongoing.\n" +
  "If the objective involves a process that should keep running after setup, do not treat a successful launch as final completion.\n" +
  "Do not claim the task is fully complete unless the user objective is actually satisfied.\n" +
  "Return a concise factual update. Avoid sign-off language.\n";

export const DECISION_SYSTEM_PROMPT =
  "You are a runtime supervisor deciding whether a background task should keep running. " +
  "Return JSON only with no markdown.";

export const CONTRACT_SYSTEM_PROMPT =
  "You are a runtime planner for durable long-running task supervision. " +
  "Return JSON only with no markdown.";

export const CARRY_FORWARD_SYSTEM_PROMPT =
  "You maintain durable runtime state for a long-running task. " +
  "Compress only the task-relevant context into concise JSON for the next cycle. " +
  "Return JSON only with no markdown.";

export const DEFAULT_NATIVE_SERVER_PROTOCOL = "http" as const;
export const DEFAULT_NATIVE_SERVER_HEALTH_PATH = "/";
export const DEFAULT_NATIVE_SERVER_READY_STATUS_CODES = [200] as const;
export const DEFAULT_NATIVE_SERVER_READINESS_TIMEOUT_MS = 10_000;
