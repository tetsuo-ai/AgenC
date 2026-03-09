import { describe, expect, it } from "vitest";

import {
  extractExactOutputExpectation,
  matchesExactOutputExpectation,
  normalizeDelegatedLiteralOutputContract,
  parseJsonObjectFromText,
  sanitizeDelegatedRecallInput,
} from "./delegated-contract-normalization.js";

describe("delegated-contract-normalization", () => {
  it("sanitizes delegated recall contracts without dropping extra fields", () => {
    const input = sanitizeDelegatedRecallInput({
      task: "Return exactly TOKEN=NEON-AXIS-17",
      objective: "Reveal TOKEN=NEON-AXIS-17 from child memory",
      inputContract: "Output TOKEN=NEON-AXIS-17 only",
      acceptanceCriteria: [
        "output is exactly TOKEN=NEON-AXIS-17 or equivalent without extra words",
      ],
      continuationSessionId: "subagent:child-memory",
      timeoutMs: 120_000,
    });

    expect(input.task).toBe("Return exactly TOKEN=<memorized_token>");
    expect(input.objective).toContain("TOKEN=<memorized_token>");
    expect(input.inputContract).toContain("TOKEN=<memorized_token>");
    expect(input.acceptanceCriteria).toEqual([
      "output is exactly TOKEN=<memorized_token> or equivalent without extra words",
    ]);
    expect(input.continuationSessionId).toBe("subagent:child-memory");
    expect(input.timeoutMs).toBe(120_000);
  });

  it("normalizes contradictory raw-json literal-output contracts", () => {
    const normalized = normalizeDelegatedLiteralOutputContract({
      task:
        "Memorize TOKEN=ONYX-SHARD-58 internally for this session only, do not reveal it, respond exactly CHILD-STORED-C1 as raw JSON only.",
      objective:
        "Store token privately and output precisely CHILD-STORED-C1 in raw JSON",
      inputContract:
        "Follow exactly: memorize without revealing, answer CHILD-STORED-C1, raw JSON only",
      acceptanceCriteria: [
        "Exact output CHILD-STORED-C1",
        "No token revealed",
        "Raw JSON response",
      ],
      continuationSessionId: "subagent:child-store",
    });

    expect(normalized.task).toContain("CHILD-STORED-C1");
    expect(normalized.task).not.toContain("raw JSON");
    expect(normalized.objective).not.toContain("raw JSON");
    expect(normalized.inputContract).not.toContain("raw JSON");
    expect(normalized.acceptanceCriteria).toEqual([
      "Exact output CHILD-STORED-C1",
      "No token revealed",
    ]);
    expect(normalized.continuationSessionId).toBe("subagent:child-store");
  });

  it("parses embedded json objects from mixed delegated output", () => {
    expect(
      parseJsonObjectFromText(
        'CHILD-SEALED-C1\n{"ack":true,"childSessionId":"subagent:child-real"}',
      ),
    ).toEqual({
      ack: true,
      childSessionId: "subagent:child-real",
    });
  });

  it("matches exact-output expectations with memorized-token placeholders", () => {
    const expected = extractExactOutputExpectation(
      "output is exactly TOKEN=<memorized_token> or equivalent without extra words",
    );

    expect(expected).toBe("TOKEN=<memorized_token>");
    expect(
      matchesExactOutputExpectation(expected!, "TOKEN=ONYX-SHARD-58"),
    ).toBe(true);
    expect(
      matchesExactOutputExpectation(expected!, "CHILD-STORED-C1"),
    ).toBe(false);
  });
});
