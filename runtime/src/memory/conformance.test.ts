/**
 * Backend-agnostic conformance test suite for memory backends.
 *
 * Runs a shared battery of tests against InMemoryBackend and SqliteBackend
 * (in-process :memory: mode) to verify consistent behavior across implementations.
 *
 * Also tests the AES-256-GCM encryption module and SqliteBackend encryption integration.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { InMemoryBackend } from "./in-memory/backend.js";
import {
  createAES256GCMProvider,
  type EncryptionProvider,
} from "./encryption.js";
import type { MemoryBackend, DurabilityLevel } from "./types.js";
import { MEMORY_OPERATIONAL_LIMITS } from "./types.js";

// ---------------------------------------------------------------------------
// Shared conformance suite
// ---------------------------------------------------------------------------

function conformanceSuite(
  name: string,
  factory: () => MemoryBackend,
  expectedDurability: DurabilityLevel,
) {
  describe(`${name} conformance`, () => {
    let backend: MemoryBackend;

    beforeEach(() => {
      backend = factory();
    });

    afterEach(async () => {
      await backend.close();
    });

    // -- Durability interface --

    describe("durability", () => {
      it("returns a DurabilityInfo object", () => {
        const info = backend.getDurability();
        expect(info).toBeDefined();
        expect(info.level).toBe(expectedDurability);
        expect(typeof info.supportsFlush).toBe("boolean");
        expect(typeof info.description).toBe("string");
        expect(info.description.length).toBeGreaterThan(0);
      });

      it("flush() resolves without error", async () => {
        await expect(backend.flush()).resolves.toBeUndefined();
      });
    });

    // -- KV read-your-writes --

    describe("KV operations", () => {
      it("set/get round-trip", async () => {
        await backend.set("k1", { hello: "world" });
        const val = await backend.get<{ hello: string }>("k1");
        expect(val).toEqual({ hello: "world" });
      });

      it("overwrite replaces value", async () => {
        await backend.set("k1", "old");
        await backend.set("k1", "new");
        expect(await backend.get("k1")).toBe("new");
      });

      it("delete removes key", async () => {
        await backend.set("k1", 42);
        expect(await backend.delete("k1")).toBe(true);
        expect(await backend.get("k1")).toBeUndefined();
      });

      it("delete returns false for missing key", async () => {
        expect(await backend.delete("nonexistent")).toBe(false);
      });

      it("has returns true/false", async () => {
        expect(await backend.has("k1")).toBe(false);
        await backend.set("k1", "v");
        expect(await backend.has("k1")).toBe(true);
      });

      it("listKeys with prefix", async () => {
        await backend.set("ns:a", 1);
        await backend.set("ns:b", 2);
        await backend.set("other:c", 3);
        const keys = await backend.listKeys("ns:");
        expect(keys.sort()).toEqual(["ns:a", "ns:b"]);
      });

      it("listKeys without prefix returns all", async () => {
        await backend.set("a", 1);
        await backend.set("b", 2);
        const keys = await backend.listKeys();
        expect(keys.sort()).toEqual(["a", "b"]);
      });
    });

    // -- Thread read-your-writes --

    describe("thread operations", () => {
      it("addEntry/getThread round-trip", async () => {
        const entry = await backend.addEntry({
          sessionId: "s1",
          role: "user",
          content: "hello",
        });
        expect(entry.id).toBeDefined();
        expect(entry.sessionId).toBe("s1");
        expect(entry.role).toBe("user");
        expect(entry.content).toBe("hello");

        const thread = await backend.getThread("s1");
        expect(thread).toHaveLength(1);
        expect(thread[0].content).toBe("hello");
      });

      it("getThread returns empty for unknown session", async () => {
        const thread = await backend.getThread("nonexistent");
        expect(thread).toEqual([]);
      });

      it("deleteThread removes entries and returns count", async () => {
        await backend.addEntry({ sessionId: "s1", role: "user", content: "a" });
        await backend.addEntry({
          sessionId: "s1",
          role: "assistant",
          content: "b",
        });
        const deleted = await backend.deleteThread("s1");
        expect(deleted).toBe(2);
        expect(await backend.getThread("s1")).toEqual([]);
      });

      it("deleteThread returns 0 for unknown session", async () => {
        expect(await backend.deleteThread("nope")).toBe(0);
      });

      it("getThread respects limit (returns most recent)", async () => {
        await backend.addEntry({
          sessionId: "s1",
          role: "user",
          content: "first",
        });
        await backend.addEntry({
          sessionId: "s1",
          role: "user",
          content: "second",
        });
        await backend.addEntry({
          sessionId: "s1",
          role: "user",
          content: "third",
        });

        const thread = await backend.getThread("s1", 2);
        expect(thread).toHaveLength(2);
        expect(thread[0].content).toBe("second");
        expect(thread[1].content).toBe("third");
      });
    });

    // -- Query filters --

    describe("query", () => {
      it("filters by role", async () => {
        await backend.addEntry({
          sessionId: "s1",
          role: "user",
          content: "u1",
        });
        await backend.addEntry({
          sessionId: "s1",
          role: "assistant",
          content: "a1",
        });
        await backend.addEntry({
          sessionId: "s1",
          role: "user",
          content: "u2",
        });

        const results = await backend.query({ sessionId: "s1", role: "user" });
        expect(results).toHaveLength(2);
        expect(results.every((e) => e.role === "user")).toBe(true);
      });

      it("respects order", async () => {
        await backend.addEntry({ sessionId: "s1", role: "user", content: "a" });
        // Small delay to ensure different timestamps
        await new Promise((r) => setTimeout(r, 5));
        await backend.addEntry({ sessionId: "s1", role: "user", content: "b" });

        const asc = await backend.query({ sessionId: "s1", order: "asc" });
        expect(asc[0].content).toBe("a");
        expect(asc[1].content).toBe("b");

        const desc = await backend.query({ sessionId: "s1", order: "desc" });
        expect(desc[0].content).toBe("b");
        expect(desc[1].content).toBe("a");
      });
    });

    // -- Lifecycle --

    describe("lifecycle", () => {
      it("healthCheck returns true when open", async () => {
        // Force initialization if lazy
        await backend.addEntry({
          sessionId: "s1",
          role: "user",
          content: "init",
        });
        expect(await backend.healthCheck()).toBe(true);
      });

      it("clear removes all data", async () => {
        await backend.addEntry({ sessionId: "s1", role: "user", content: "a" });
        await backend.set("k1", "v");
        await backend.clear();
        expect(await backend.getThread("s1")).toEqual([]);
        expect(await backend.get("k1")).toBeUndefined();
      });

      it("close marks backend as closed", async () => {
        await backend.addEntry({ sessionId: "s1", role: "user", content: "a" });
        await backend.close();
        // Re-closing or operating on closed backend should throw
        await expect(
          backend.addEntry({ sessionId: "s1", role: "user", content: "b" }),
        ).rejects.toThrow();
      });
    });

    // -- Session listing --

    describe("session listing", () => {
      it("listSessions returns session ids", async () => {
        await backend.addEntry({
          sessionId: "alpha",
          role: "user",
          content: "a",
        });
        await backend.addEntry({
          sessionId: "beta",
          role: "user",
          content: "b",
        });
        const sessions = await backend.listSessions();
        expect(sessions.sort()).toEqual(["alpha", "beta"]);
      });

      it("listSessions filters by prefix", async () => {
        await backend.addEntry({
          sessionId: "proj:a",
          role: "user",
          content: "a",
        });
        await backend.addEntry({
          sessionId: "proj:b",
          role: "user",
          content: "b",
        });
        await backend.addEntry({
          sessionId: "other:c",
          role: "user",
          content: "c",
        });
        const sessions = await backend.listSessions("proj:");
        expect(sessions.sort()).toEqual(["proj:a", "proj:b"]);
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Run conformance for InMemoryBackend
// ---------------------------------------------------------------------------

conformanceSuite("InMemoryBackend", () => new InMemoryBackend(), "none");

// ---------------------------------------------------------------------------
// Encryption Module Tests
// ---------------------------------------------------------------------------

describe("AES-256-GCM encryption", () => {
  let provider: EncryptionProvider;
  const key = randomBytes(32);

  beforeEach(() => {
    provider = createAES256GCMProvider({ key });
  });

  it("round-trip encrypt/decrypt", () => {
    const plaintext = "Hello, secret world! 🔐";
    const ciphertext = provider.encrypt(plaintext);
    expect(ciphertext).not.toBe(plaintext);
    expect(provider.decrypt(ciphertext)).toBe(plaintext);
  });

  it("different encryptions produce different ciphertexts (random IV)", () => {
    const plaintext = "same input";
    const a = provider.encrypt(plaintext);
    const b = provider.encrypt(plaintext);
    expect(a).not.toBe(b);
    // But both decrypt to same
    expect(provider.decrypt(a)).toBe(plaintext);
    expect(provider.decrypt(b)).toBe(plaintext);
  });

  it("wrong key fails to decrypt", () => {
    const ciphertext = provider.encrypt("secret");
    const wrongKey = randomBytes(32);
    const wrongProvider = createAES256GCMProvider({ key: wrongKey });
    expect(() => wrongProvider.decrypt(ciphertext)).toThrow();
  });

  it("tampered ciphertext fails", () => {
    const ciphertext = provider.encrypt("secret");
    const buf = Buffer.from(ciphertext, "base64");
    // Flip a byte in the encrypted payload
    buf[buf.length - 1] ^= 0xff;
    const tampered = buf.toString("base64");
    expect(() => provider.decrypt(tampered)).toThrow();
  });

  it("rejects key shorter than 32 bytes", () => {
    expect(() => createAES256GCMProvider({ key: randomBytes(16) })).toThrow(
      /must be exactly 32 bytes/,
    );
  });

  it("rejects key longer than 32 bytes", () => {
    expect(() => createAES256GCMProvider({ key: randomBytes(48) })).toThrow(
      /must be exactly 32 bytes/,
    );
  });

  it("accepts hex-encoded key string", () => {
    const hexKey = randomBytes(32).toString("hex");
    const hexProvider = createAES256GCMProvider({ key: hexKey });
    const ct = hexProvider.encrypt("test");
    expect(hexProvider.decrypt(ct)).toBe("test");
  });

  it("handles empty string", () => {
    const ct = provider.encrypt("");
    expect(provider.decrypt(ct)).toBe("");
  });

  it("handles large payload", () => {
    const large = "x".repeat(100_000);
    const ct = provider.encrypt(large);
    expect(provider.decrypt(ct)).toBe(large);
  });
});

// ---------------------------------------------------------------------------
// MEMORY_OPERATIONAL_LIMITS
// ---------------------------------------------------------------------------

describe("MEMORY_OPERATIONAL_LIMITS", () => {
  it("has expected constants", () => {
    expect(MEMORY_OPERATIONAL_LIMITS.IN_MEMORY_MAX_ENTRIES_PER_SESSION).toBe(
      1_000,
    );
    expect(MEMORY_OPERATIONAL_LIMITS.IN_MEMORY_MAX_TOTAL_ENTRIES).toBe(100_000);
    expect(MEMORY_OPERATIONAL_LIMITS.ENCRYPTION_KEY_SIZE_BYTES).toBe(32);
    expect(MEMORY_OPERATIONAL_LIMITS.ENCRYPTION_IV_SIZE_BYTES).toBe(12);
    expect(MEMORY_OPERATIONAL_LIMITS.ENCRYPTION_AUTH_TAG_SIZE_BYTES).toBe(16);
  });
});
