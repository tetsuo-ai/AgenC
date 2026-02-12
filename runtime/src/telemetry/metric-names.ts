/**
 * Telemetry metric name constants for modules instrumented in Phase 11.
 *
 * Uses the `agenc.*` OpenTelemetry-compatible naming convention.
 * Does NOT re-export existing METRIC_NAMES or SPECULATION_METRIC_NAMES
 * from task/ — those remain in their respective modules.
 *
 * @module
 */

export const TELEMETRY_METRIC_NAMES = {
  // LLM
  LLM_REQUEST_DURATION: 'agenc.llm.request.duration_ms',
  LLM_PROMPT_TOKENS: 'agenc.llm.prompt_tokens',
  LLM_COMPLETION_TOKENS: 'agenc.llm.completion_tokens',
  LLM_TOTAL_TOKENS: 'agenc.llm.total_tokens',
  LLM_REQUESTS_TOTAL: 'agenc.llm.requests.total',
  LLM_ERRORS_TOTAL: 'agenc.llm.errors.total',
  LLM_TOOL_CALLS_TOTAL: 'agenc.llm.tool_calls.total',
  // Memory
  MEMORY_OP_DURATION: 'agenc.memory.op.duration_ms',
  MEMORY_OPS_TOTAL: 'agenc.memory.ops.total',
  MEMORY_ERRORS_TOTAL: 'agenc.memory.errors.total',
  // Proof
  PROOF_GENERATION_DURATION: 'agenc.proof.generation.duration_ms',
  PROOF_CACHE_HITS: 'agenc.proof.cache.hits',
  PROOF_CACHE_MISSES: 'agenc.proof.cache.misses',
  // RPC
  RPC_REQUEST_DURATION: 'agenc.rpc.request.duration_ms',
  RPC_RETRIES_TOTAL: 'agenc.rpc.retries.total',
  RPC_FAILOVERS_TOTAL: 'agenc.rpc.failovers.total',
  // Dispute
  DISPUTE_OPS_TOTAL: 'agenc.dispute.ops.total',
  DISPUTE_OP_DURATION: 'agenc.dispute.op.duration_ms',
  // Policy
  POLICY_VIOLATIONS_TOTAL: 'agenc.policy.violations.total',
  POLICY_DECISIONS_TOTAL: 'agenc.policy.decisions.total',
  // Eval
  EVAL_PASS_AT_K: 'agenc.eval.pass_at_k',
  EVAL_PASS_CARET_K: 'agenc.eval.pass_caret_k',
  EVAL_RISK_WEIGHTED_SUCCESS: 'agenc.eval.risk_weighted_success',
  EVAL_CONFORMANCE_SCORE: 'agenc.eval.conformance_score',
  EVAL_COST_NORMALIZED_UTILITY: 'agenc.eval.cost_normalized_utility',
  EVAL_CALIBRATION_ERROR: 'agenc.eval.calibration_error',
} as const;
