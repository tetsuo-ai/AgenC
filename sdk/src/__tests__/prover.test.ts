/**
 * Unit tests for the remote prover backend.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  prove,
  ProverError,
  type ProverInput,
  type RemoteProverConfig,
} from "../prover";
import {
  RISC0_SEAL_BYTES_LEN,
  RISC0_JOURNAL_LEN,
  RISC0_IMAGE_ID_LEN,
} from "../constants";

function validInput(): ProverInput {
  return {
    taskPda: new Uint8Array(32).fill(1),
    agentAuthority: new Uint8Array(32).fill(2),
    constraintHash: new Uint8Array(32).fill(3),
    outputCommitment: new Uint8Array(32).fill(4),
    binding: new Uint8Array(32).fill(5),
    nullifier: new Uint8Array(32).fill(6),
    output: [
      new Uint8Array(32).fill(7),
      new Uint8Array(32).fill(8),
      new Uint8Array(32).fill(9),
      new Uint8Array(32).fill(10),
    ],
    salt: new Uint8Array(32).fill(11),
    agentSecret: new Uint8Array(32).fill(12),
  };
}

function validOutputPayload() {
  return {
    seal_bytes: Array.from(
      { length: RISC0_SEAL_BYTES_LEN },
      (_, i) => i & 0xff,
    ),
    journal: Array.from(
      { length: RISC0_JOURNAL_LEN },
      (_, i) => (i * 3) & 0xff,
    ),
    image_id: Array.from(
      { length: RISC0_IMAGE_ID_LEN },
      (_, i) => (i * 7) & 0xff,
    ),
  };
}

describe("prove — input validation", () => {
  const remoteConfig: RemoteProverConfig = {
    kind: "remote",
    endpoint: "https://prover.example.com",
  };

  it("rejects taskPda that is not 32 bytes", async () => {
    const input = validInput();
    input.taskPda = new Uint8Array(16);
    await expect(prove(input, remoteConfig)).rejects.toThrow(
      "taskPda must be exactly 32 bytes",
    );
  });

  it("rejects agentAuthority that is not 32 bytes", async () => {
    const input = validInput();
    input.agentAuthority = new Uint8Array(0);
    await expect(prove(input, remoteConfig)).rejects.toThrow(
      "agentAuthority must be exactly 32 bytes",
    );
  });

  it("rejects constraintHash that is not 32 bytes", async () => {
    const input = validInput();
    input.constraintHash = new Uint8Array(64);
    await expect(prove(input, remoteConfig)).rejects.toThrow(
      "constraintHash must be exactly 32 bytes",
    );
  });

  it("rejects outputCommitment that is not 32 bytes", async () => {
    const input = validInput();
    input.outputCommitment = new Uint8Array(31);
    await expect(prove(input, remoteConfig)).rejects.toThrow(
      "outputCommitment must be exactly 32 bytes",
    );
  });

  it("rejects binding that is not 32 bytes", async () => {
    const input = validInput();
    input.binding = new Uint8Array(33);
    await expect(prove(input, remoteConfig)).rejects.toThrow(
      "binding must be exactly 32 bytes",
    );
  });

  it("rejects nullifier that is not 32 bytes", async () => {
    const input = validInput();
    input.nullifier = new Uint8Array(1);
    await expect(prove(input, remoteConfig)).rejects.toThrow(
      "nullifier must be exactly 32 bytes",
    );
  });

  it("rejects output arrays with the wrong element count", async () => {
    const input = validInput();
    input.output = [new Uint8Array(32).fill(7)];
    await expect(prove(input, remoteConfig)).rejects.toThrow(
      "output must contain exactly 4 field elements",
    );
  });

  it("rejects output elements that are not 32 bytes", async () => {
    const input = validInput();
    input.output[2] = new Uint8Array(31);
    await expect(prove(input, remoteConfig)).rejects.toThrow(
      "output[2] must be exactly 32 bytes",
    );
  });

  it("rejects salt that is not 32 bytes", async () => {
    const input = validInput();
    input.salt = new Uint8Array(16);
    await expect(prove(input, remoteConfig)).rejects.toThrow(
      "salt must be exactly 32 bytes",
    );
  });

  it("rejects agentSecret that is not 32 bytes", async () => {
    const input = validInput();
    input.agentSecret = new Uint8Array(48);
    await expect(prove(input, remoteConfig)).rejects.toThrow(
      "agentSecret must be exactly 32 bytes",
    );
  });
});

describe("prove — remote backend", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns valid buffers on HTTP 200", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(validOutputPayload()),
    }) as unknown as typeof fetch;

    const result = await prove(validInput(), {
      kind: "remote",
      endpoint: "https://prover.example.com",
    });

    expect(result.sealBytes.length).toBe(RISC0_SEAL_BYTES_LEN);
    expect(result.journal.length).toBe(RISC0_JOURNAL_LEN);
    expect(result.imageId.length).toBe(RISC0_IMAGE_ID_LEN);
    expect(Buffer.isBuffer(result.sealBytes)).toBe(true);
    expect(Buffer.isBuffer(result.journal)).toBe(true);
    expect(Buffer.isBuffer(result.imageId)).toBe(true);

    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toBe("https://prover.example.com/prove");
    expect(calls[0][1].method).toBe("POST");
  });

  it("appends /prove to endpoint without trailing slash", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(validOutputPayload()),
    }) as unknown as typeof fetch;

    await prove(validInput(), {
      kind: "remote",
      endpoint: "https://prover.example.com/api",
    });

    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toBe("https://prover.example.com/api/prove");
  });

  it("does not double-append /prove if already present", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(validOutputPayload()),
    }) as unknown as typeof fetch;

    await prove(validInput(), {
      kind: "remote",
      endpoint: "https://prover.example.com/prove",
    });

    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toBe("https://prover.example.com/prove");
  });

  it("strips trailing slashes from endpoint", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(validOutputPayload()),
    }) as unknown as typeof fetch;

    await prove(validInput(), {
      kind: "remote",
      endpoint: "https://prover.example.com/api/",
    });

    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toBe("https://prover.example.com/api/prove");
  });

  it("wraps HTTP error in ProverError", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    }) as unknown as typeof fetch;

    await expect(
      prove(validInput(), {
        kind: "remote",
        endpoint: "https://prover.example.com",
      }),
    ).rejects.toThrow(ProverError);

    try {
      await prove(validInput(), {
        kind: "remote",
        endpoint: "https://prover.example.com",
      });
    } catch (err) {
      expect(err).toBeInstanceOf(ProverError);
      expect((err as ProverError).backend).toBe("remote");
      expect((err as ProverError).message).toContain("HTTP 500");
    }
  });

  it("wraps network failure in ProverError", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(
        new TypeError("Failed to fetch"),
      ) as unknown as typeof fetch;

    await expect(
      prove(validInput(), {
        kind: "remote",
        endpoint: "https://prover.example.com",
      }),
    ).rejects.toThrow(ProverError);
  });

  it("passes custom headers", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(validOutputPayload()),
    }) as unknown as typeof fetch;

    await prove(validInput(), {
      kind: "remote",
      endpoint: "https://prover.example.com",
      headers: { Authorization: "Bearer token123" },
    });

    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][1].headers).toMatchObject({
      Authorization: "Bearer token123",
      "Content-Type": "application/json",
    });
  });

  it("sends correct JSON body with public fields and witness", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(validOutputPayload()),
    }) as unknown as typeof fetch;

    const input = validInput();
    await prove(input, { kind: "remote", endpoint: "https://test.com" });

    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const body = JSON.parse(calls[0][1].body);
    expect(body.task_pda).toEqual(Array.from(input.taskPda));
    expect(body.agent_authority).toEqual(Array.from(input.agentAuthority));
    expect(body.constraint_hash).toEqual(Array.from(input.constraintHash));
    expect(body.output_commitment).toEqual(
      Array.from(input.outputCommitment),
    );
    expect(body.binding).toEqual(Array.from(input.binding));
    expect(body.nullifier).toEqual(Array.from(input.nullifier));
    expect(body.output).toEqual(input.output.map((field) => Array.from(field)));
    expect(body.salt).toEqual(Array.from(input.salt));
    expect(body.agent_secret).toEqual(Array.from(input.agentSecret));
  });
});

describe("prove — output validation", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("rejects seal_bytes with wrong length", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          seal_bytes: [1, 2, 3],
          journal: Array.from({ length: RISC0_JOURNAL_LEN }, () => 0),
          image_id: Array.from({ length: RISC0_IMAGE_ID_LEN }, () => 0),
        }),
    }) as unknown as typeof fetch;

    await expect(
      prove(validInput(), { kind: "remote", endpoint: "https://test.com" }),
    ).rejects.toThrow(`seal_bytes must be ${RISC0_SEAL_BYTES_LEN} bytes`);
  });

  it("rejects journal with wrong length", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          seal_bytes: Array.from({ length: RISC0_SEAL_BYTES_LEN }, () => 0),
          journal: [1, 2],
          image_id: Array.from({ length: RISC0_IMAGE_ID_LEN }, () => 0),
        }),
    }) as unknown as typeof fetch;

    await expect(
      prove(validInput(), { kind: "remote", endpoint: "https://test.com" }),
    ).rejects.toThrow(`journal must be ${RISC0_JOURNAL_LEN} bytes`);
  });

  it("rejects image_id with wrong length", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          seal_bytes: Array.from({ length: RISC0_SEAL_BYTES_LEN }, () => 0),
          journal: Array.from({ length: RISC0_JOURNAL_LEN }, () => 0),
          image_id: [1],
        }),
    }) as unknown as typeof fetch;

    await expect(
      prove(validInput(), { kind: "remote", endpoint: "https://test.com" }),
    ).rejects.toThrow(`image_id must be ${RISC0_IMAGE_ID_LEN} bytes`);
  });

  it("rejects missing seal_bytes array", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          journal: Array.from({ length: RISC0_JOURNAL_LEN }, () => 0),
          image_id: Array.from({ length: RISC0_IMAGE_ID_LEN }, () => 0),
        }),
    }) as unknown as typeof fetch;

    await expect(
      prove(validInput(), { kind: "remote", endpoint: "https://test.com" }),
    ).rejects.toThrow("prover output missing seal_bytes array");
  });

  it("rejects missing journal array", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          seal_bytes: Array.from({ length: RISC0_SEAL_BYTES_LEN }, () => 0),
          image_id: Array.from({ length: RISC0_IMAGE_ID_LEN }, () => 0),
        }),
    }) as unknown as typeof fetch;

    await expect(
      prove(validInput(), { kind: "remote", endpoint: "https://test.com" }),
    ).rejects.toThrow("prover output missing journal array");
  });

  it("rejects missing image_id array", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          seal_bytes: Array.from({ length: RISC0_SEAL_BYTES_LEN }, () => 0),
          journal: Array.from({ length: RISC0_JOURNAL_LEN }, () => 0),
        }),
    }) as unknown as typeof fetch;

    await expect(
      prove(validInput(), { kind: "remote", endpoint: "https://test.com" }),
    ).rejects.toThrow("prover output missing image_id array");
  });
});

describe("ProverError", () => {
  it("has correct name property", () => {
    const err = new ProverError("test", "remote");
    expect(err.name).toBe("ProverError");
    expect(err instanceof Error).toBe(true);
  });

  it("preserves backend type", () => {
    const remote = new ProverError("msg", "remote");
    expect(remote.backend).toBe("remote");
  });

  it("preserves cause", () => {
    const originalError = new Error("original");
    const err = new ProverError("wrapped", "remote", originalError);
    expect(err.cause).toBe(originalError);
  });

  it("message is accessible", () => {
    const err = new ProverError("test message", "remote");
    expect(err.message).toBe("test message");
  });
});
