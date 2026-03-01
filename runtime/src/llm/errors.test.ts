import { describe, expect, it } from "vitest";
import { RuntimeError, RuntimeErrorCodes } from "../types/errors.js";
import {
  LLMAuthenticationError,
  LLMMessageValidationError,
  LLMProviderError,
  LLMRateLimitError,
  LLMTimeoutError,
  classifyLLMFailure,
} from "./errors.js";

describe("classifyLLMFailure", () => {
  it("classifies typed LLM errors", () => {
    expect(classifyLLMFailure(new LLMTimeoutError("grok", 1000))).toBe("timeout");
    expect(classifyLLMFailure(new LLMRateLimitError("grok", 1000))).toBe("rate_limited");
    expect(classifyLLMFailure(new LLMAuthenticationError("grok", 401))).toBe("authentication_error");
    expect(
      classifyLLMFailure(
        new LLMMessageValidationError("grok", {
          validationCode: "missing",
          messageIndex: 2,
          reason: "missing tool_call_id",
        }),
      ),
    ).toBe("validation_error");
    expect(classifyLLMFailure(new LLMProviderError("grok", "bad request", 400))).toBe(
      "provider_error",
    );
  });

  it("classifies runtime budget errors", () => {
    const err = new RuntimeError(
      "budget exceeded",
      RuntimeErrorCodes.CHAT_BUDGET_EXCEEDED,
    );
    expect(classifyLLMFailure(err)).toBe("budget_exceeded");
  });

  it("maps unknown cancel-like failures to cancelled", () => {
    expect(classifyLLMFailure(new Error("Request aborted by caller"))).toBe(
      "cancelled",
    );
  });

  it("maps non-matching unknown errors to unknown", () => {
    expect(classifyLLMFailure(new Error("mystery failure"))).toBe("unknown");
  });
});
