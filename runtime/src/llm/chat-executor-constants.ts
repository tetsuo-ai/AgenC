/**
 * Constants for ChatExecutor.
 *
 * @module
 */

// ============================================================================
// Size and limit constants
// ============================================================================

/** Max chars for URL preview in tool summaries. */
export const MAX_URL_PREVIEW_CHARS = 80;
/** Max chars for bash output in tool summaries. */
export const MAX_BASH_OUTPUT_CHARS = 2000;
/** Max chars for command preview in tool summaries. */
export const MAX_COMMAND_PREVIEW_CHARS = 60;
/**
 * Max consecutive identical failing tool calls before the loop is broken.
 * When the LLM calls the same tool with the same arguments and gets an error
 * N times in a row, we inject a hint after (N-1) and break after N.
 */
export const MAX_CONSECUTIVE_IDENTICAL_FAILURES = 3;
/** Break tool loop after N rounds where every tool call failed. */
export const MAX_CONSECUTIVE_ALL_FAILED_ROUNDS = 3;
export const RECOVERY_HINT_PREFIX = "Tool recovery hint:";
export const SHELL_BUILTIN_COMMANDS = new Set([
  "set",
  "cd",
  "export",
  "source",
  "alias",
  "unalias",
  "unset",
  "shopt",
  "ulimit",
  "umask",
  "readonly",
  "declare",
  "typeset",
  "builtin",
]);
/** Max chars for JSON result previews. */
export const MAX_RESULT_PREVIEW_CHARS = 500;
/** Max chars for error message previews. */
export const MAX_ERROR_PREVIEW_CHARS = 300;
/** Max chars of user message sent to the evaluator. */
export const MAX_EVAL_USER_CHARS = 500;
/** Max chars of response sent to the evaluator. */
export const MAX_EVAL_RESPONSE_CHARS = 2000;
/** Cap history depth sent to providers per request. */
export const MAX_HISTORY_MESSAGES = 20;
/** Max chars retained per history message. */
export const MAX_HISTORY_MESSAGE_CHARS = 2_000;
/** Max chars from a single injected system context block (skills/memory/progress). */
export const MAX_CONTEXT_INJECTION_CHARS = 12_000;
/** Hard prompt-size guard (approx chars) to avoid provider context-length errors. */
export const MAX_PROMPT_CHARS_BUDGET = 100_000;
/** Max chars kept from a tool result when feeding it back into the LLM. */
export const MAX_TOOL_RESULT_CHARS = 12_000;
/** Max chars retained for any single string field inside JSON tool output. */
export const MAX_TOOL_RESULT_FIELD_CHARS = 2_000;
/** Max chars retained for one replayed assistant tool-call argument payload. */
export const MAX_TOOL_CALL_ARGUMENT_CHARS = 512;
/** Max chars of raw preview kept when tool-call args are truncated for replay. */
export const MAX_TOOL_CALL_ARGUMENT_PREVIEW_CHARS = 320;
/** Max array items retained in JSON tool output summaries. */
export const MAX_TOOL_RESULT_ARRAY_ITEMS = 40;
/** Max object keys retained in JSON tool output summaries. */
export const MAX_TOOL_RESULT_OBJECT_KEYS = 48;
export const TOOL_RESULT_PRIORITY_KEYS = [
  "error",
  "stderr",
  "stdout",
  "exitcode",
  "status",
  "message",
  "result",
  "output",
  "url",
  "title",
  "text",
  "data",
] as const;
/** Global image-data budget (chars) for tool results in a single execution. */
export const MAX_TOOL_IMAGE_CHARS_BUDGET = 100_000;
/** Max chars retained from a single user text message. */
export const MAX_USER_MESSAGE_CHARS = 8_000;
/** Hard cap for final assistant response size (protects against runaway output). */
export const MAX_FINAL_RESPONSE_CHARS = 24_000;
/** Minimum line count before repetitive-output suppression is evaluated. */
export const REPETITIVE_LINE_MIN_COUNT = 40;
/** Dominant-line repetition threshold for runaway detection. */
export const REPETITIVE_LINE_MIN_REPEATS = 20;
/** Unique-line ratio threshold for runaway detection. */
export const REPETITIVE_LINE_MAX_UNIQUE_RATIO = 0.35;
/** Upper bound on additive runtime hint system messages per execution. */
export const DEFAULT_MAX_RUNTIME_SYSTEM_HINTS = 4;
/** Default max planner output budget in tokens (soft, prompt-enforced). */
export const DEFAULT_PLANNER_MAX_TOKENS = 256;
/** Bounded planner retries when a delegated step is rejected for decomposition. */
export const DEFAULT_PLANNER_MAX_REFINEMENT_ATTEMPTS = 2;
/** Maximum deterministic steps accepted from a planner pass. */
export const MAX_PLANNER_STEPS = 24;
/** Parent history slice candidates retained for per-subagent curation. */
export const MAX_PLANNER_CONTEXT_HISTORY_CANDIDATES = 12;
/** Max chars retained for one planner history candidate entry. */
export const MAX_PLANNER_CONTEXT_HISTORY_CHARS = 600;
/** Max chars retained for one planner memory candidate entry. */
export const MAX_PLANNER_CONTEXT_MEMORY_CHARS = 1_200;
/** Max chars retained for one planner tool-output candidate entry. */
export const MAX_PLANNER_CONTEXT_TOOL_OUTPUT_CHARS = 1_200;
/** Default per-request tool-call budget. */
export const DEFAULT_TOOL_BUDGET_PER_REQUEST = 24;
/** Default per-request model recall budget (calls after first). */
export const DEFAULT_MODEL_RECALLS_PER_REQUEST = 24;
/** Default per-request failed-tool-call budget. */
export const DEFAULT_FAILURE_BUDGET_PER_REQUEST = 8;
/** Default timeout for a single tool execution call in ms. */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 180_000;
/** Default end-to-end timeout for one execute() invocation in ms. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;
/** Default minimum verifier confidence for accepting subagent outputs. */
export const DEFAULT_SUBAGENT_VERIFIER_MIN_CONFIDENCE = 0.65;
/** Default max rounds for verifier/critique loops (initial round included). */
export const DEFAULT_SUBAGENT_VERIFIER_MAX_ROUNDS = 2;
/** Max chars retained from one subagent output in verifier prompts. */
export const MAX_SUBAGENT_VERIFIER_OUTPUT_CHARS = 3_000;
/** Max chars retained from one verifier artifact payload. */
export const MAX_SUBAGENT_VERIFIER_ARTIFACT_CHARS = 2_000;
/** Break no-progress loops after repeated semantically equivalent rounds. */
export const MAX_CONSECUTIVE_SEMANTIC_DUPLICATE_ROUNDS = 2;
/** Default repeated-failure threshold before opening session breaker. */
export const DEFAULT_TOOL_FAILURE_BREAKER_THRESHOLD = 5;
/** Default rolling window for repeated-failure breaker accounting. */
export const DEFAULT_TOOL_FAILURE_BREAKER_WINDOW_MS = 300_000;
/** Default cooldown once repeated-failure breaker opens. */
export const DEFAULT_TOOL_FAILURE_BREAKER_COOLDOWN_MS = 120_000;
/** Keep raw tool image payloads out of model replay by default. */
export const ENABLE_TOOL_IMAGE_REPLAY = false;

// ============================================================================
// Tool classification sets
// ============================================================================

/**
 * High-risk side-effect tools MUST NOT be auto-retried unless an explicit
 * idempotency token is provided in tool args.
 */
export const HIGH_RISK_TOOL_PREFIXES = [
  "agenc.",
  "wallet.",
  "solana.",
  "desktop.",
];
export const HIGH_RISK_TOOLS = new Set([
  "system.bash",
  "system.writeFile",
  "system.delete",
  "system.applescript",
  "system.open",
  "system.notification",
  "system.execute",
]);
export const SAFE_TOOL_RETRY_PREFIXES = [
  "system.http",
  "system.browse",
  "system.extract",
  "system.read",
  "playwright.browser_",
];
export const SAFE_TOOL_RETRY_TOOLS = new Set([
  "system.listFiles",
  "system.readFile",
  "system.searchFiles",
  "system.htmlToMarkdown",
]);

// ============================================================================
// Class-level constants (formerly private static readonly on ChatExecutor)
// ============================================================================

export const DEFAULT_EVAL_RUBRIC =
  "Rate this AI response 0.0-1.0. Consider accuracy, completeness, clarity, " +
  "and appropriate use of tool results.\n" +
  'Return ONLY JSON: {"score": 0.0-1.0, "feedback": "brief explanation"}';

/** Max chars of history text sent to the summarization call. */
export const MAX_COMPACT_INPUT = 20_000;
