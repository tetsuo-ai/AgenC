import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import {
  projectOnChainEvents,
  type OnChainProjectionInput,
} from "./projector.js";
import { buildIncidentCase } from "./incident-case.js";
import {
  EVIDENCE_PACK_SCHEMA_VERSION,
  buildEvidencePack,
  serializeEvidencePack,
} from "./evidence-pack.js";

function pubkey(seed: number): PublicKey {
  const bytes = new Uint8Array(32);
  bytes.fill(seed);
  return new PublicKey(bytes);
}

function bytes(seed = 0, length = 32): Uint8Array {
  const output = new Uint8Array(length);
  output.fill(seed);
  return output;
}

describe("evidence-pack", () => {
  it("builds a basic evidence pack manifest with deterministic hashes", () => {
    const taskId = bytes(1);
    const creator = pubkey(2);
    const worker = pubkey(3);

    const inputs: OnChainProjectionInput[] = [
      {
        eventName: "taskCreated",
        slot: 10,
        signature: "AAA",
        timestampMs: 1_000,
        event: {
          taskId,
          creator,
          requiredCapabilities: 0n,
          rewardAmount: 0n,
          taskType: 0,
          deadline: 0,
          minReputation: 0,
          rewardMint: null,
          timestamp: 1_000,
        },
      },
      {
        eventName: "taskClaimed",
        slot: 11,
        signature: "BBB",
        timestampMs: 1_100,
        event: {
          taskId,
          worker,
          currentWorkers: 1,
          maxWorkers: 1,
          timestamp: 1_100,
        },
      },
    ];

    const events = projectOnChainEvents(inputs).events;
    const incidentCase = buildIncidentCase({ events });
    const queryHash = createHash("sha256").update("query").digest("hex");

    const pack = buildEvidencePack({
      incidentCase,
      events,
      seed: 99,
      queryHash,
      runtimeVersion: "0.1.0-test",
    });

    expect(pack.manifest.schemaVersion).toBe(EVIDENCE_PACK_SCHEMA_VERSION);
    expect(pack.manifest.seed).toBe(99);
    expect(pack.manifest.queryHash).toBe(queryHash);
    expect(pack.manifest.runtimeVersion).toBe("0.1.0-test");
    expect(pack.manifest.sealed).toBe(false);
    expect(pack.manifest.cursorRange.fromSlot).toBe(
      pack.incidentCase.traceWindow.fromSlot,
    );
    expect(pack.manifest.cursorRange.toSlot).toBe(
      pack.incidentCase.traceWindow.toSlot,
    );
    expect(pack.manifest.cursorRange.fromSignature).toBe(events[0]?.signature);
    expect(pack.manifest.cursorRange.toSignature).toBe(
      events[events.length - 1]?.signature,
    );

    expect(pack.manifest.schemaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(pack.manifest.toolFingerprint).toMatch(/^[0-9a-f]{64}$/);

    expect(pack.manifest.evidenceHashes).toHaveLength(2);
    expect(pack.manifest.evidenceHashes.map((entry) => entry.label)).toEqual([
      "incident-case",
      "events",
    ]);
    expect(
      pack.manifest.evidenceHashes.every((entry) =>
        /^[0-9a-f]{64}$/.test(entry.sha256),
      ),
    ).toBe(true);
    expect(
      pack.incidentCase.evidenceHashes.some(
        (entry) => entry.label === "events",
      ),
    ).toBe(true);
  });

  it("serializes to manifest + case jsonl + events jsonl", () => {
    const events = projectOnChainEvents([
      {
        eventName: "taskCreated",
        slot: 1,
        signature: "SIG",
        timestampMs: 1_000,
        event: {
          taskId: bytes(1),
          creator: pubkey(1),
          requiredCapabilities: 0n,
          rewardAmount: 0n,
          taskType: 0,
          deadline: 0,
          minReputation: 0,
          rewardMint: null,
          timestamp: 1_000,
        },
      },
    ]).events;

    const pack = buildEvidencePack({
      incidentCase: buildIncidentCase({ events }),
      events,
      seed: 0,
      queryHash: createHash("sha256").update("q").digest("hex"),
      runtimeVersion: "0.1.0-test",
    });

    const files = serializeEvidencePack(pack);
    const manifest = JSON.parse(files["manifest.json"]) as Record<
      string,
      unknown
    >;
    expect(manifest.schemaVersion).toBe(EVIDENCE_PACK_SCHEMA_VERSION);

    const parsedCase = JSON.parse(files["incident-case.jsonl"]) as Record<
      string,
      unknown
    >;
    expect(parsedCase.caseId).toBe(pack.incidentCase.caseId);

    const parsedEvents = files["events.jsonl"]
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsedEvents).toHaveLength(events.length);
    expect(parsedEvents[0]?.signature).toBe(events[0]?.signature);
  });

  it("supports sealed mode with dot-path redaction", () => {
    const taskId = bytes(1);
    const traceContext = {
      traceId: "trace-1",
      spanId: "span-1",
      parentSpanId: "parent-1",
      sampled: true,
    };

    const events = projectOnChainEvents([
      {
        eventName: "taskCreated",
        slot: 1,
        signature: "SIG",
        timestampMs: 1_000,
        traceContext,
        event: {
          taskId,
          creator: pubkey(1),
          requiredCapabilities: 0n,
          rewardAmount: 0n,
          taskType: 0,
          deadline: 0,
          minReputation: 0,
          rewardMint: null,
          timestamp: 1_000,
        },
      },
    ]).events;

    const pack = buildEvidencePack({
      incidentCase: buildIncidentCase({ events }),
      events,
      seed: 0,
      queryHash: createHash("sha256").update("q").digest("hex"),
      runtimeVersion: "0.1.0-test",
      sealed: true,
      redactionPolicy: {
        stripFields: ["payload.onchain.trace"],
      },
    });

    const onchain = (pack.events[0]?.payload as Record<string, unknown>)
      .onchain as Record<string, unknown>;
    expect(onchain.trace).toBeUndefined();
  });

  it("supports actor redaction in sealed mode", () => {
    const taskId = bytes(1);
    const creator = pubkey(2);

    const events = projectOnChainEvents([
      {
        eventName: "taskCreated",
        slot: 1,
        signature: "SIG",
        timestampMs: 1_000,
        event: {
          taskId,
          creator,
          requiredCapabilities: 0n,
          rewardAmount: 0n,
          taskType: 0,
          deadline: 0,
          minReputation: 0,
          rewardMint: null,
          timestamp: 1_000,
        },
      },
    ]).events;

    const caseUnsealed = buildIncidentCase({ events });
    const pack = buildEvidencePack({
      incidentCase: caseUnsealed,
      events,
      seed: 0,
      queryHash: createHash("sha256").update("q").digest("hex"),
      runtimeVersion: "0.1.0-test",
      sealed: true,
      redactionPolicy: {
        redactActors: true,
      },
    });

    expect(caseUnsealed.actorMap[0]?.pubkey).toBe(creator.toBase58());
    expect(pack.incidentCase.actorMap[0]?.pubkey).not.toBe(creator.toBase58());
    expect(pack.incidentCase.actorMap[0]?.pubkey).toMatch(/^[0-9a-f]{16}$/);
  });

  it("produces identical evidence hashes for identical inputs", () => {
    const events = projectOnChainEvents([
      {
        eventName: "taskCreated",
        slot: 1,
        signature: "SIG",
        timestampMs: 1_000,
        event: {
          taskId: bytes(1),
          creator: pubkey(1),
          requiredCapabilities: 0n,
          rewardAmount: 0n,
          taskType: 0,
          deadline: 0,
          minReputation: 0,
          rewardMint: null,
          timestamp: 1_000,
        },
      },
    ]).events;

    const incidentCase = buildIncidentCase({ events });
    const queryHash = createHash("sha256").update("q").digest("hex");

    const pack1 = buildEvidencePack({
      incidentCase,
      events,
      seed: 0,
      queryHash,
      runtimeVersion: "0.1.0-test",
    });
    const pack2 = buildEvidencePack({
      incidentCase,
      events,
      seed: 0,
      queryHash,
      runtimeVersion: "0.1.0-test",
    });

    expect(pack1.manifest.queryHash).toBe(pack2.manifest.queryHash);
    expect(pack1.manifest.evidenceHashes).toEqual(
      pack2.manifest.evidenceHashes,
    );
  });

  it("handles empty events", () => {
    const pack = buildEvidencePack({
      incidentCase: buildIncidentCase({ events: [] }),
      events: [],
      seed: 0,
      queryHash: createHash("sha256").update("q").digest("hex"),
      runtimeVersion: "0.1.0-test",
    });

    expect(pack.manifest.cursorRange.fromSlot).toBe(0);
    expect(pack.manifest.cursorRange.toSlot).toBe(0);
    expect(pack.events).toHaveLength(0);
    expect(serializeEvidencePack(pack)["events.jsonl"]).toBe("");
  });

  it("does not change evidence hashes when runtimeVersion changes", () => {
    const events = projectOnChainEvents([
      {
        eventName: "taskCreated",
        slot: 1,
        signature: "SIG",
        timestampMs: 1_000,
        event: {
          taskId: bytes(1),
          creator: pubkey(1),
          requiredCapabilities: 0n,
          rewardAmount: 0n,
          taskType: 0,
          deadline: 0,
          minReputation: 0,
          rewardMint: null,
          timestamp: 1_000,
        },
      },
    ]).events;

    const incidentCase = buildIncidentCase({ events });
    const queryHash = createHash("sha256").update("q").digest("hex");

    const pack1 = buildEvidencePack({
      incidentCase,
      events,
      seed: 0,
      queryHash,
      runtimeVersion: "0.1.0-test",
    });
    const pack2 = buildEvidencePack({
      incidentCase,
      events,
      seed: 0,
      queryHash,
      runtimeVersion: "0.2.0-test",
    });

    expect(pack1.manifest.runtimeVersion).not.toBe(
      pack2.manifest.runtimeVersion,
    );
    expect(pack1.manifest.evidenceHashes).toEqual(
      pack2.manifest.evidenceHashes,
    );
  });
});
