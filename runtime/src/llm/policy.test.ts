import { describe, expect, it } from "vitest";
import {
  DEFAULT_LLM_RETRY_POLICY_MATRIX,
  toPipelineStopReason,
} from "./policy.js";

describe("llm policy taxonomy", () => {
  it("defines non-retriable validation/auth/budget failures", () => {
    expect(DEFAULT_LLM_RETRY_POLICY_MATRIX.validation_error.maxRetries).toBe(0);
    expect(DEFAULT_LLM_RETRY_POLICY_MATRIX.authentication_error.maxRetries).toBe(0);
    expect(DEFAULT_LLM_RETRY_POLICY_MATRIX.budget_exceeded.maxRetries).toBe(0);
  });

  it("defines retriable transient provider classes", () => {
    expect(DEFAULT_LLM_RETRY_POLICY_MATRIX.provider_error.maxRetries).toBeGreaterThan(0);
    expect(DEFAULT_LLM_RETRY_POLICY_MATRIX.rate_limited.maxRetries).toBeGreaterThan(0);
    expect(DEFAULT_LLM_RETRY_POLICY_MATRIX.timeout.maxRetries).toBeGreaterThan(0);
  });

  it("maps unknown failures to provider_error stop reason", () => {
    expect(toPipelineStopReason("unknown")).toBe("provider_error");
    expect(toPipelineStopReason("validation_error")).toBe("validation_error");
  });
});
