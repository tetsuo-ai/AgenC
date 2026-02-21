/**
 * Tests for the IDL drift checker contract validation.
 */

import { describe, it, expect } from "vitest";
import { checkIdlDrift, type IdlDriftCheckResult } from "./idl-drift-check.js";
import { type EventContract } from "./idl-contract.js";

interface TestField {
  name: string;
  type: unknown;
}

function buildIdlType(name: string, fields: TestField[]) {
  return {
    name,
    type: {
      kind: "struct",
      fields,
    },
  };
}

function expectFailure(
  result: IdlDriftCheckResult,
  expectedSnippet: string,
): void {
  expect(result.passed).toBe(false);
  expect(result.mismatches).toHaveLength(1);
  expect(result.mismatches[0]?.message).toContain(expectedSnippet);
}

describe("idl drift checker", () => {
  it("skips mismatched family checks for override fields", async () => {
    const contract: readonly EventContract[] = [
      {
        eventName: "taskCreated",
        fields: [{ name: "taskId", family: "bytes<32>" }],
      },
    ];

    const result = await checkIdlDrift({
      contract,
      idl: {
        events: [{ name: "TaskCreated" }],
        types: [
          buildIdlType("TaskCreated", [
            { name: "task_id", type: { array: ["u8", 16] } },
          ]),
        ],
      },
      overrides: [
        {
          eventName: "taskCreated",
          fieldName: "taskId",
          reason: "legacy v2 migration hash",
        },
      ],
    });

    expect(result.passed).toBe(true);
    expect(result.mismatches).toHaveLength(0);
  });

  it("passes when runtime contract matches fixture IDL schema", async () => {
    const contract: readonly EventContract[] = [
      {
        eventName: "taskCreated",
        fields: [
          { name: "taskId", family: "bytes<32>" },
          { name: "creator", family: "pubkey" },
          { name: "requiredCapabilities", family: "u64" },
          { name: "rewardAmount", family: "u64" },
          { name: "taskType", family: "u8" },
          { name: "deadline", family: "i64" },
          { name: "minReputation", family: "u16" },
          { name: "rewardMint", family: "option<pubkey>" },
          { name: "timestamp", family: "i64" },
        ],
      },
    ];

    const result = await checkIdlDrift({
      contract,
      idl: {
        events: [{ name: "TaskCreated" }],
        types: [
          buildIdlType("TaskCreated", [
            { name: "task_id", type: { array: ["u8", 32] } },
            { name: "creator", type: "pubkey" },
            { name: "required_capabilities", type: "u64" },
            { name: "reward_amount", type: "u64" },
            { name: "task_type", type: "u8" },
            { name: "deadline", type: "i64" },
            { name: "min_reputation", type: "u16" },
            { name: "reward_mint", type: { option: "pubkey" } },
            { name: "timestamp", type: "i64" },
          ]),
        ],
      },
    });

    expect(result.passed).toBe(true);
  });

  it("detects missing event in IDL", async () => {
    const contract: readonly EventContract[] = [
      {
        eventName: "taskCreated",
        fields: [{ name: "taskId", family: "bytes<32>" }],
      },
    ];

    const result = await checkIdlDrift({
      contract,
      idl: {
        events: [{ name: "TaskCompleted" }],
        types: [
          buildIdlType("TaskCompleted", [
            { name: "task_id", type: { array: ["u8", 32] } },
          ]),
        ],
      },
    });

    expectFailure(result, "does not contain non-agent event");
  });

  it("detects field mismatch", async () => {
    const contract: readonly EventContract[] = [
      {
        eventName: "taskCreated",
        fields: [{ name: "taskPda", family: "bytes<32>" }],
      },
    ];

    const result = await checkIdlDrift({
      contract,
      idl: {
        events: [{ name: "TaskCreated" }],
        types: [
          buildIdlType("TaskCreated", [
            { name: "task_id", type: { array: ["u8", 32] } },
          ]),
        ],
      },
    });

    expectFailure(result, "field mismatch");
  });

  it("detects field-family mismatch", async () => {
    const contract: readonly EventContract[] = [
      {
        eventName: "taskCreated",
        fields: [{ name: "taskId", family: "u8" }],
      },
    ];

    const result = await checkIdlDrift({
      contract,
      idl: {
        events: [{ name: "TaskCreated" }],
        types: [
          buildIdlType("TaskCreated", [
            { name: "task_id", type: { array: ["u8", 32] } },
          ]),
        ],
      },
    });

    expectFailure(result, "family mismatch");
  });

  it("detects runtime contract missing event from IDL", async () => {
    const result = await checkIdlDrift({
      contract: [],
      idl: {
        events: [{ name: "TaskCreated" }],
        types: [
          buildIdlType("TaskCreated", [
            { name: "task_id", type: { array: ["u8", 32] } },
          ]),
        ],
      },
    });

    expectFailure(result, 'missing non-agent event "TaskCreated"');
  });

  it("reports deterministic local path and first mismatch line", async () => {
    const result = await checkIdlDrift({
      contract: [
        {
          eventName: "taskCreated",
          fields: [{ name: "taskPda", family: "bytes<32>" }],
        },
      ],
      idl: {
        events: [{ name: "TaskCreated" }],
        types: [
          buildIdlType("TaskCreated", [
            { name: "task_id", type: { array: ["u8", 32] } },
          ]),
        ],
      },
    });

    expect(result.passed).toBe(false);
    expect(result.mismatches).toHaveLength(1);
    const firstMismatch = result.mismatches[0];
    expect(firstMismatch.path).not.toContain("/home/");
    expect(firstMismatch.path).toBe("src/events/idl-contract.ts");
    expect(firstMismatch.line).toBeGreaterThan(0);
  });
});
