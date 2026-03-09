import { classifyLLMFailure } from "../llm/errors.js";
import { toPipelineStopReason } from "../llm/policy.js";
import type { LLMPipelineStopReason } from "../llm/policy.js";

export interface LLMFailureSurfaceSummary {
  stopReason: LLMPipelineStopReason;
  stopReasonDetail: string;
  userMessage: string;
}

export function summarizeLLMFailureForSurface(
  error: unknown,
): LLMFailureSurfaceSummary {
  const fallbackDetail =
    error instanceof Error ? error.message : String(error ?? "Unknown error");
  const annotated = error as {
    stopReason?: unknown;
    stopReasonDetail?: unknown;
  };
  const stopReason =
    typeof annotated.stopReason === "string"
      ? (annotated.stopReason as LLMPipelineStopReason)
      : toPipelineStopReason(classifyLLMFailure(error));
  const stopReasonDetail =
    typeof annotated.stopReasonDetail === "string"
      ? annotated.stopReasonDetail
      : fallbackDetail;
  return {
    stopReason,
    stopReasonDetail,
    userMessage: `Error (${stopReason}): ${stopReasonDetail}`,
  };
}
