import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import { responseToOutput } from "./response-converter.js";

describe("responseToOutput", () => {
  it("returns exactly 4 bigints", () => {
    const output = responseToOutput("hello world");
    expect(output).toHaveLength(4);
    for (const v of output) {
      expect(typeof v).toBe("bigint");
    }
  });

  it("is deterministic — same input produces same output", () => {
    const a = responseToOutput("test response");
    const b = responseToOutput("test response");
    expect(a).toEqual(b);
  });

  it("produces different output for different input", () => {
    const a = responseToOutput("response A");
    const b = responseToOutput("response B");
    expect(a).not.toEqual(b);
  });

  it("all values fit in 64 bits", () => {
    const MAX_U64 = (1n << 64n) - 1n;
    const output = responseToOutput("some text to hash");
    for (const v of output) {
      expect(v).toBeGreaterThanOrEqual(0n);
      expect(v).toBeLessThanOrEqual(MAX_U64);
    }
  });

  it("handles empty string", () => {
    const output = responseToOutput("");
    expect(output).toHaveLength(4);
    // SHA-256 of empty string is well-known
    const emptyHash = createHash("sha256").update("", "utf-8").digest();
    expect(emptyHash.length).toBe(32);
    // Verify values are non-zero (SHA-256 of '' is not all zeros)
    const allZero = output.every((v) => v === 0n);
    expect(allZero).toBe(false);
  });

  it("handles unicode input", () => {
    const output = responseToOutput("こんにちは世界 🌍");
    expect(output).toHaveLength(4);
    for (const v of output) {
      expect(typeof v).toBe("bigint");
      expect(v).toBeGreaterThanOrEqual(0n);
    }
  });

  it("matches known SHA-256 test vector", () => {
    // SHA-256("abc") = ba7816bf 8f01cfea 414140de 5dae2223 b00361a3 96177a9c b410ff61 f20015ad
    const output = responseToOutput("abc");
    // First 8 bytes LE: ba 78 16 bf 8f 01 cf ea
    const expected0 =
      0xban |
      (0x78n << 8n) |
      (0x16n << 16n) |
      (0xbfn << 24n) |
      (0x8fn << 32n) |
      (0x01n << 40n) |
      (0xcfn << 48n) |
      (0xean << 56n);
    expect(output[0]).toBe(expected0);
  });
});
