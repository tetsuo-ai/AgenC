import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  // Constants
  RuntimeErrorCodes,
  AnchorErrorCodes,
  // Types (imported for testing)
  type RuntimeErrorCode,
  type AnchorErrorCode,
  type AnchorErrorName,
  type ParsedAnchorError,
  // Base error class
  RuntimeError,
  // Specific error classes
  AgentNotRegisteredError,
  AgentAlreadyRegisteredError,
  ValidationError,
  RateLimitError,
  InsufficientStakeError,
  ActiveTasksError,
  PendingDisputeVotesError,
  RecentVoteActivityError,
  // Helper functions
  isAnchorError,
  parseAnchorError,
  getAnchorErrorName,
  getAnchorErrorMessage,
  isRuntimeError,
  // Validation helpers (#963)
  validateByteLength,
  validateNonZeroBytes,
} from "./errors";

interface IdlErrorEntry {
  code: number;
  name: string;
  msg: string;
}

const idlPath = resolve(process.cwd(), "idl", "agenc_coordination.json");
const idlErrors =
  (JSON.parse(readFileSync(idlPath, "utf8")) as { errors?: IdlErrorEntry[] })
    .errors ?? [];
const idlErrorMap = new Map(idlErrors.map((entry) => [entry.name, entry]));
const idlCodes = idlErrors.map((entry) => entry.code);
const idlMinCode = Math.min(...idlCodes);
const idlMaxCode = Math.max(...idlCodes);

describe("RuntimeErrorCodes", () => {
  it("has all expected error codes", () => {
    expect(RuntimeErrorCodes.AGENT_NOT_REGISTERED).toBe("AGENT_NOT_REGISTERED");
    expect(RuntimeErrorCodes.AGENT_ALREADY_REGISTERED).toBe(
      "AGENT_ALREADY_REGISTERED",
    );
    expect(RuntimeErrorCodes.VALIDATION_ERROR).toBe("VALIDATION_ERROR");
    expect(RuntimeErrorCodes.RATE_LIMIT_ERROR).toBe("RATE_LIMIT_ERROR");
    expect(RuntimeErrorCodes.INSUFFICIENT_STAKE).toBe("INSUFFICIENT_STAKE");
    expect(RuntimeErrorCodes.ACTIVE_TASKS_ERROR).toBe("ACTIVE_TASKS_ERROR");
    expect(RuntimeErrorCodes.PENDING_DISPUTE_VOTES).toBe(
      "PENDING_DISPUTE_VOTES",
    );
    expect(RuntimeErrorCodes.RECENT_VOTE_ACTIVITY).toBe("RECENT_VOTE_ACTIVITY");
    expect(RuntimeErrorCodes.TEAM_CONTRACT_VALIDATION_ERROR).toBe(
      "TEAM_CONTRACT_VALIDATION_ERROR",
    );
    expect(RuntimeErrorCodes.TEAM_CONTRACT_STATE_ERROR).toBe(
      "TEAM_CONTRACT_STATE_ERROR",
    );
    expect(RuntimeErrorCodes.TEAM_PAYOUT_ERROR).toBe("TEAM_PAYOUT_ERROR");
    expect(RuntimeErrorCodes.TEAM_WORKFLOW_TOPOLOGY_ERROR).toBe(
      "TEAM_WORKFLOW_TOPOLOGY_ERROR",
    );
    expect(RuntimeErrorCodes.MARKETPLACE_VALIDATION_ERROR).toBe(
      "MARKETPLACE_VALIDATION_ERROR",
    );
    expect(RuntimeErrorCodes.MARKETPLACE_STATE_ERROR).toBe(
      "MARKETPLACE_STATE_ERROR",
    );
    expect(RuntimeErrorCodes.MARKETPLACE_AUTHORIZATION_ERROR).toBe(
      "MARKETPLACE_AUTHORIZATION_ERROR",
    );
    expect(RuntimeErrorCodes.MARKETPLACE_MATCHING_ERROR).toBe(
      "MARKETPLACE_MATCHING_ERROR",
    );
  });

  it("has exactly 97 error codes", () => {
    expect(Object.keys(RuntimeErrorCodes)).toHaveLength(97);
  });
});

describe("AnchorErrorCodes", () => {
  it("matches IDL error count", () => {
    expect(Object.keys(AnchorErrorCodes)).toHaveLength(idlErrors.length);
  });

  it("matches IDL code range", () => {
    expect(idlErrors.length).toBeGreaterThan(0);
    const codes = Object.values(AnchorErrorCodes);
    const minCode = Math.min(...codes);
    const maxCode = Math.max(...codes);
    const idlCodes = idlErrors.map((entry) => entry.code);

    expect(minCode).toBe(Math.min(...idlCodes));
    expect(maxCode).toBe(Math.max(...idlCodes));
  });

  it("has sequential codes (no gaps)", () => {
    const codes = Object.values(AnchorErrorCodes).sort((a, b) => a - b);
    const start = Math.min(...codes);
    for (let i = 0; i < codes.length; i++) {
      expect(codes[i]).toBe(start + i);
    }
  });

  it("has exact name->code parity with IDL", () => {
    const runtimeEntries = Object.entries(AnchorErrorCodes);
    for (const [name, code] of runtimeEntries) {
      const idlEntry = idlErrorMap.get(name);
      expect(idlEntry, `Missing IDL entry for ${name}`).toBeDefined();
      expect(code).toBe(idlEntry!.code);
    }
  });

  it("includes new private verification error codes", () => {
    expect(idlErrorMap.get("InvalidSealEncoding")).toBeDefined();
    expect(idlErrorMap.get("InvalidJournalLength")).toBeDefined();
    expect(idlErrorMap.get("InvalidJournalBinding")).toBeDefined();
    expect(idlErrorMap.get("TrustedSelectorMismatch")).toBeDefined();
    expect(idlErrorMap.get("RouterAccountMismatch")).toBeDefined();
    expect(AnchorErrorCodes.InvalidSealEncoding).toBe(
      idlErrorMap.get("InvalidSealEncoding")!.code,
    );
    expect(AnchorErrorCodes.TrustedSelectorMismatch).toBe(
      idlErrorMap.get("TrustedSelectorMismatch")!.code,
    );
    expect(AnchorErrorCodes.RouterAccountMismatch).toBe(
      idlErrorMap.get("RouterAccountMismatch")!.code,
    );
  });
});

describe("RuntimeError", () => {
  it("has correct properties", () => {
    const error = new RuntimeError(
      "Test message",
      RuntimeErrorCodes.VALIDATION_ERROR,
    );

    expect(error.name).toBe("RuntimeError");
    expect(error.message).toBe("Test message");
    expect(error.code).toBe("VALIDATION_ERROR");
  });

  it("is instanceof Error", () => {
    const error = new RuntimeError("Test", RuntimeErrorCodes.VALIDATION_ERROR);

    expect(error instanceof Error).toBe(true);
    expect(error instanceof RuntimeError).toBe(true);
  });

  it("has stack trace", () => {
    const error = new RuntimeError("Test", RuntimeErrorCodes.VALIDATION_ERROR);

    expect(error.stack).toBeDefined();
    expect(error.stack).toContain("RuntimeError");
  });
});

describe("AgentNotRegisteredError", () => {
  it("has correct message and code", () => {
    const error = new AgentNotRegisteredError();

    expect(error.name).toBe("AgentNotRegisteredError");
    expect(error.message).toBe("Agent is not registered in the protocol");
    expect(error.code).toBe(RuntimeErrorCodes.AGENT_NOT_REGISTERED);
  });

  it("is instanceof RuntimeError", () => {
    const error = new AgentNotRegisteredError();

    expect(error instanceof RuntimeError).toBe(true);
    expect(error instanceof Error).toBe(true);
  });
});

describe("AgentAlreadyRegisteredError", () => {
  it("has correct message, code, and agentId", () => {
    const error = new AgentAlreadyRegisteredError("agent-123");

    expect(error.name).toBe("AgentAlreadyRegisteredError");
    expect(error.message).toBe('Agent "agent-123" is already registered');
    expect(error.code).toBe(RuntimeErrorCodes.AGENT_ALREADY_REGISTERED);
    expect(error.agentId).toBe("agent-123");
  });

  it("is instanceof RuntimeError", () => {
    const error = new AgentAlreadyRegisteredError("test");

    expect(error instanceof RuntimeError).toBe(true);
  });
});

describe("ValidationError", () => {
  it("has correct message and code", () => {
    const error = new ValidationError("Invalid endpoint URL");

    expect(error.name).toBe("ValidationError");
    expect(error.message).toBe("Invalid endpoint URL");
    expect(error.code).toBe(RuntimeErrorCodes.VALIDATION_ERROR);
  });
});

describe("RateLimitError", () => {
  it("has correct properties", () => {
    const cooldownEnds = new Date("2024-01-01T12:00:00Z");
    const error = new RateLimitError("task_creation", cooldownEnds);

    expect(error.name).toBe("RateLimitError");
    expect(error.message).toContain("task_creation");
    expect(error.message).toContain(cooldownEnds.toISOString());
    expect(error.code).toBe(RuntimeErrorCodes.RATE_LIMIT_ERROR);
    expect(error.limitType).toBe("task_creation");
    expect(error.cooldownEnds).toBe(cooldownEnds);
  });
});

describe("InsufficientStakeError", () => {
  it("has correct properties with bigint values", () => {
    const required = BigInt("1000000000000");
    const available = BigInt("500000000000");
    const error = new InsufficientStakeError(required, available);

    expect(error.name).toBe("InsufficientStakeError");
    expect(error.message).toContain("1000000000000");
    expect(error.message).toContain("500000000000");
    expect(error.code).toBe(RuntimeErrorCodes.INSUFFICIENT_STAKE);
    expect(error.required).toBe(required);
    expect(error.available).toBe(available);
  });

  it("handles large bigint values correctly", () => {
    const required = BigInt("9007199254740993"); // Larger than MAX_SAFE_INTEGER
    const available = BigInt("1");
    const error = new InsufficientStakeError(required, available);

    expect(error.required).toBe(required);
    expect(error.available).toBe(available);
  });
});

describe("ActiveTasksError", () => {
  it("has correct properties", () => {
    const error = new ActiveTasksError(5);

    expect(error.name).toBe("ActiveTasksError");
    expect(error.message).toContain("5 active tasks");
    expect(error.code).toBe(RuntimeErrorCodes.ACTIVE_TASKS_ERROR);
    expect(error.activeTaskCount).toBe(5);
  });

  it("handles singular correctly", () => {
    const error = new ActiveTasksError(1);

    expect(error.message).toContain("1 active task");
    expect(error.message).not.toContain("tasks");
  });
});

describe("PendingDisputeVotesError", () => {
  it("has correct properties", () => {
    const error = new PendingDisputeVotesError(3);

    expect(error.name).toBe("PendingDisputeVotesError");
    expect(error.message).toContain("3 pending dispute votes");
    expect(error.code).toBe(RuntimeErrorCodes.PENDING_DISPUTE_VOTES);
    expect(error.voteCount).toBe(3);
  });

  it("handles singular correctly", () => {
    const error = new PendingDisputeVotesError(1);

    expect(error.message).toContain("1 pending dispute vote");
    expect(error.message).not.toContain("votes");
  });
});

describe("RecentVoteActivityError", () => {
  it("has correct properties", () => {
    const lastVote = new Date("2024-01-01T10:00:00Z");
    const error = new RecentVoteActivityError(lastVote);

    expect(error.name).toBe("RecentVoteActivityError");
    expect(error.message).toContain("24 hours");
    expect(error.message).toContain(lastVote.toISOString());
    expect(error.code).toBe(RuntimeErrorCodes.RECENT_VOTE_ACTIVITY);
    expect(error.lastVoteTimestamp).toBe(lastVote);
  });
});

describe("isAnchorError", () => {
  it("returns true for direct code property", () => {
    const error = { code: 6000 };
    expect(isAnchorError(error, AnchorErrorCodes.AgentAlreadyRegistered)).toBe(
      true,
    );
  });

  it("returns false for wrong code", () => {
    const error = { code: 6000 };
    expect(isAnchorError(error, AnchorErrorCodes.AgentNotFound)).toBe(false);
  });

  it("handles Anchor SDK errorCode format", () => {
    const error = {
      errorCode: {
        code: "AgentNotFound",
        number: 6001,
      },
    };
    expect(isAnchorError(error, AnchorErrorCodes.AgentNotFound)).toBe(true);
    expect(isAnchorError(error, AnchorErrorCodes.AgentAlreadyRegistered)).toBe(
      false,
    );
  });

  it("handles nested error.error format", () => {
    const error = {
      error: {
        errorCode: {
          code: "TaskNotOpen",
          number: AnchorErrorCodes.TaskNotOpen,
        },
      },
    };
    expect(isAnchorError(error, AnchorErrorCodes.TaskNotOpen)).toBe(true);
  });

  it("handles transaction logs", () => {
    const error = {
      logs: [
        "Program log: AnchorError",
        "Program log: Error Code: AgentNotFound. Error Number: 6001. Message: Agent not found",
      ],
    };
    expect(isAnchorError(error, AnchorErrorCodes.AgentNotFound)).toBe(true);
    expect(isAnchorError(error, AnchorErrorCodes.AgentAlreadyRegistered)).toBe(
      false,
    );
  });

  it("handles hex error code in message", () => {
    const error = {
      message:
        "failed to send transaction: Transaction simulation failed: custom program error: 0x1770",
    };
    // 0x1770 = 6000
    expect(isAnchorError(error, AnchorErrorCodes.AgentAlreadyRegistered)).toBe(
      true,
    );
  });

  it("handles decimal error code in message", () => {
    const error = {
      message: `Error Number: ${AnchorErrorCodes.AlreadyClaimed}`,
    };
    expect(isAnchorError(error, AnchorErrorCodes.AlreadyClaimed)).toBe(true);
  });

  it("returns false for null", () => {
    expect(isAnchorError(null, AnchorErrorCodes.AgentNotFound)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isAnchorError(undefined, AnchorErrorCodes.AgentNotFound)).toBe(
      false,
    );
  });

  it("returns false for non-object", () => {
    expect(isAnchorError("error", AnchorErrorCodes.AgentNotFound)).toBe(false);
    expect(isAnchorError(123, AnchorErrorCodes.AgentNotFound)).toBe(false);
  });

  it("returns false for empty object", () => {
    expect(isAnchorError({}, AnchorErrorCodes.AgentNotFound)).toBe(false);
  });
});

describe("parseAnchorError", () => {
  it("parses direct code property", () => {
    const error = { code: 6000 };
    const parsed = parseAnchorError(error);

    expect(parsed).not.toBeNull();
    expect(parsed?.code).toBe(6000);
    expect(parsed?.name).toBe("AgentAlreadyRegistered");
    expect(parsed?.message).toBe("Agent is already registered");
  });

  it("parses Anchor SDK errorCode format", () => {
    const error = {
      errorCode: {
        code: "TaskExpired",
        number: AnchorErrorCodes.TaskExpired,
      },
    };
    const parsed = parseAnchorError(error);

    expect(parsed).not.toBeNull();
    expect(parsed?.code).toBe(AnchorErrorCodes.TaskExpired);
    expect(parsed?.name).toBe("TaskExpired");
    expect(parsed?.message).toBe("Task has expired");
  });

  it("parses nested error.error format", () => {
    const error = {
      error: {
        errorCode: {
          code: "ZkVerificationFailed",
          number: AnchorErrorCodes.ZkVerificationFailed,
        },
      },
    };
    const parsed = parseAnchorError(error);

    expect(parsed).not.toBeNull();
    expect(parsed?.code).toBe(AnchorErrorCodes.ZkVerificationFailed);
    expect(parsed?.name).toBe("ZkVerificationFailed");
  });

  it("parses transaction logs", () => {
    const error = {
      logs: [
        `Program log: Error Code: DisputeNotActive. Error Number: ${AnchorErrorCodes.DisputeNotActive}. Some message`,
      ],
    };
    const parsed = parseAnchorError(error);

    expect(parsed).not.toBeNull();
    expect(parsed?.code).toBe(AnchorErrorCodes.DisputeNotActive);
    expect(parsed?.name).toBe("DisputeNotActive");
  });

  it("parses hex error code in message", () => {
    const error = {
      message: `custom program error: 0x${AnchorErrorCodes.RateLimitExceeded.toString(16)}`,
    };
    const parsed = parseAnchorError(error);

    expect(parsed).not.toBeNull();
    expect(parsed?.code).toBe(AnchorErrorCodes.RateLimitExceeded);
    expect(parsed?.name).toBe("RateLimitExceeded");
  });

  it("parses decimal error code in message", () => {
    const error = {
      message: `Error Number: ${AnchorErrorCodes.InsufficientStake}`,
    };
    const parsed = parseAnchorError(error);

    expect(parsed).not.toBeNull();
    expect(parsed?.code).toBe(AnchorErrorCodes.InsufficientStake);
    expect(parsed?.name).toBe("InsufficientStake");
  });

  it("returns null for unknown error code", () => {
    const error = { code: 9999 };
    const parsed = parseAnchorError(error);

    expect(parsed).toBeNull();
  });

  it("returns null for code outside range", () => {
    expect(parseAnchorError({ code: idlMinCode - 1 })).toBeNull();
    expect(parseAnchorError({ code: idlMaxCode + 1 })).toBeNull();
  });

  it("returns null for null/undefined", () => {
    expect(parseAnchorError(null)).toBeNull();
    expect(parseAnchorError(undefined)).toBeNull();
  });

  it("returns null for non-object", () => {
    expect(parseAnchorError("error")).toBeNull();
    expect(parseAnchorError(123)).toBeNull();
  });

  it("returns correct message for all error codes", () => {
    // Test a sampling of error codes to ensure messages are mapped
    const testCases = [
      { code: 6000, expected: "Agent is already registered" },
      {
        code: AnchorErrorCodes.ZkVerificationFailed,
        expected: "ZK proof verification failed",
      },
      {
        code: AnchorErrorCodes.InsufficientStake,
        expected: "Insufficient stake for arbiter registration",
      },
      {
        code: AnchorErrorCodes.UnauthorizedUpgrade,
        expected: "Only upgrade authority can perform this action",
      },
      {
        code: AnchorErrorCodes.TokenTransferFailed,
        expected: "SPL token transfer CPI failed",
      },
    ];

    for (const { code, expected } of testCases) {
      const parsed = parseAnchorError({ code });
      expect(parsed?.message).toBe(expected);
    }
  });
});

describe("getAnchorErrorName", () => {
  it("returns correct name for valid code", () => {
    expect(getAnchorErrorName(6000)).toBe("AgentAlreadyRegistered");
    expect(getAnchorErrorName(AnchorErrorCodes.ZkVerificationFailed)).toBe(
      "ZkVerificationFailed",
    );
    expect(getAnchorErrorName(AnchorErrorCodes.UnauthorizedUpgrade)).toBe(
      "UnauthorizedUpgrade",
    );
    expect(getAnchorErrorName(AnchorErrorCodes.TokenTransferFailed)).toBe(
      "TokenTransferFailed",
    );
  });

  it("returns undefined for invalid code", () => {
    expect(getAnchorErrorName(idlMinCode - 1)).toBeUndefined();
    expect(getAnchorErrorName(idlMaxCode + 1)).toBeUndefined();
    expect(getAnchorErrorName(0)).toBeUndefined();
  });

  it("returns name for all IDL Anchor codes", () => {
    for (let code = idlMinCode; code <= idlMaxCode; code++) {
      const name = getAnchorErrorName(code);
      expect(name).toBeDefined();
      expect(typeof name).toBe("string");
    }
  });
});

describe("getAnchorErrorMessage", () => {
  it("returns correct message for valid code", () => {
    expect(getAnchorErrorMessage(6000)).toBe("Agent is already registered");
    expect(getAnchorErrorMessage(AnchorErrorCodes.ZkVerificationFailed)).toBe(
      "ZK proof verification failed",
    );
    expect(getAnchorErrorMessage(AnchorErrorCodes.TokenTransferFailed)).toBe(
      "SPL token transfer CPI failed",
    );
  });

  it("returns message for all IDL Anchor codes", () => {
    for (let code = idlMinCode; code <= idlMaxCode; code++) {
      const message = getAnchorErrorMessage(code as AnchorErrorCode);
      expect(message).toBeDefined();
      expect(typeof message).toBe("string");
      expect(message.length).toBeGreaterThan(0);
    }
  });
});

describe("isRuntimeError", () => {
  it("returns true for RuntimeError instance", () => {
    const error = new RuntimeError("Test", RuntimeErrorCodes.VALIDATION_ERROR);
    expect(isRuntimeError(error)).toBe(true);
  });

  it("returns true for subclasses", () => {
    expect(isRuntimeError(new AgentNotRegisteredError())).toBe(true);
    expect(isRuntimeError(new AgentAlreadyRegisteredError("test"))).toBe(true);
    expect(isRuntimeError(new ValidationError("test"))).toBe(true);
    expect(isRuntimeError(new RateLimitError("test", new Date()))).toBe(true);
    expect(isRuntimeError(new InsufficientStakeError(1n, 0n))).toBe(true);
    expect(isRuntimeError(new ActiveTasksError(1))).toBe(true);
    expect(isRuntimeError(new PendingDisputeVotesError(1))).toBe(true);
    expect(isRuntimeError(new RecentVoteActivityError(new Date()))).toBe(true);
  });

  it("returns false for regular Error", () => {
    expect(isRuntimeError(new Error("Test"))).toBe(false);
  });

  it("returns false for non-errors", () => {
    expect(isRuntimeError(null)).toBe(false);
    expect(isRuntimeError(undefined)).toBe(false);
    expect(isRuntimeError("error")).toBe(false);
    expect(isRuntimeError({ message: "error" })).toBe(false);
  });

  it("provides type guard functionality", () => {
    const error: unknown = new ValidationError("test");

    if (isRuntimeError(error)) {
      // TypeScript should recognize error.code is accessible
      expect(error.code).toBe(RuntimeErrorCodes.VALIDATION_ERROR);
    } else {
      throw new Error("Should have passed type guard");
    }
  });
});

describe("Error inheritance chain", () => {
  it("all specific errors extend RuntimeError", () => {
    const errors = [
      new AgentNotRegisteredError(),
      new AgentAlreadyRegisteredError("test"),
      new ValidationError("test"),
      new RateLimitError("test", new Date()),
      new InsufficientStakeError(1n, 0n),
      new ActiveTasksError(1),
      new PendingDisputeVotesError(1),
      new RecentVoteActivityError(new Date()),
    ];

    for (const error of errors) {
      expect(error instanceof RuntimeError).toBe(true);
      expect(error instanceof Error).toBe(true);
    }
  });

  it("error names are distinct", () => {
    const names = [
      new RuntimeError("", RuntimeErrorCodes.VALIDATION_ERROR).name,
      new AgentNotRegisteredError().name,
      new AgentAlreadyRegisteredError("test").name,
      new ValidationError("test").name,
      new RateLimitError("test", new Date()).name,
      new InsufficientStakeError(1n, 0n).name,
      new ActiveTasksError(1).name,
      new PendingDisputeVotesError(1).name,
      new RecentVoteActivityError(new Date()).name,
    ];

    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });
});

describe("Type exports", () => {
  it("RuntimeErrorCode is assignable from RuntimeErrorCodes values", () => {
    const code: RuntimeErrorCode = RuntimeErrorCodes.VALIDATION_ERROR;
    expect(code).toBe("VALIDATION_ERROR");
  });

  it("AnchorErrorCode is assignable from AnchorErrorCodes values", () => {
    const code: AnchorErrorCode = AnchorErrorCodes.AgentNotFound;
    expect(code).toBe(6001);
  });

  it("AnchorErrorName is assignable from AnchorErrorCodes keys", () => {
    const name: AnchorErrorName = "AgentNotFound";
    expect(name).toBe("AgentNotFound");
  });

  it("ParsedAnchorError has correct shape", () => {
    const parsed: ParsedAnchorError = {
      code: 6000,
      name: "AgentAlreadyRegistered",
      message: "Agent is already registered",
    };

    expect(parsed.code).toBe(6000);
    expect(parsed.name).toBe("AgentAlreadyRegistered");
    expect(parsed.message).toBe("Agent is already registered");
  });
});

describe("validateByteLength", () => {
  it("returns Uint8Array for valid input", () => {
    const input = new Uint8Array(32);
    const result = validateByteLength(input, 32, "testParam");
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(32);
  });

  it("throws ValidationError for wrong length", () => {
    expect(() =>
      validateByteLength(new Uint8Array(16), 32, "testParam"),
    ).toThrow(ValidationError);
  });
});

describe("validateNonZeroBytes", () => {
  it("passes for non-zero bytes", () => {
    const input = new Uint8Array([1, 2, 3, 4]);
    expect(() => validateNonZeroBytes(input, "testParam")).not.toThrow();
  });

  it("throws ValidationError for all-zero bytes", () => {
    expect(() => validateNonZeroBytes(new Uint8Array(32), "testParam")).toThrow(
      ValidationError,
    );
  });
});
