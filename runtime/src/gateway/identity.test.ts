import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { sign } from "node:crypto";
import {
  IdentityResolver,
  InMemoryIdentityStore,
  IdentityLinkExpiredError,
  IdentityLinkNotFoundError,
  IdentitySelfLinkError,
  IdentitySignatureError,
  IdentityValidationError,
} from "./identity.js";
import type { IdentityLink } from "./identity.js";

// ============================================================================
// Test Setup
// ============================================================================

describe("IdentityResolver", () => {
  let resolver: IdentityResolver;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1700000000000);
    resolver = new IdentityResolver();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---- register ----

  describe("register", () => {
    it("creates a new identity for an unlinked account", async () => {
      const identity = await resolver.register("telegram", "user123", "Alice");

      expect(identity.identityId).toBeDefined();
      expect(identity.accounts).toHaveLength(1);
      expect(identity.accounts[0].channel).toBe("telegram");
      expect(identity.accounts[0].senderId).toBe("user123");
      expect(identity.accounts[0].displayName).toBe("Alice");
      expect(identity.createdAt).toBe(1700000000000);
    });

    it("returns existing identity if account is already linked", async () => {
      const first = await resolver.register("telegram", "user123", "Alice");
      const second = await resolver.register("telegram", "user123", "Alice");

      expect(second.identityId).toBe(first.identityId);
    });

    it("rejects empty channel", async () => {
      await expect(resolver.register("", "user1", "Alice")).rejects.toThrow(
        IdentityValidationError,
      );
    });

    it("rejects empty senderId", async () => {
      await expect(resolver.register("telegram", "", "Alice")).rejects.toThrow(
        IdentityValidationError,
      );
    });

    it("rejects null bytes in channel", async () => {
      await expect(
        resolver.register("tele\x00gram", "user1", "Alice"),
      ).rejects.toThrow(IdentityValidationError);
    });

    it("rejects null bytes in senderId", async () => {
      await expect(
        resolver.register("telegram", "user\x001", "Alice"),
      ).rejects.toThrow(IdentityValidationError);
    });

    it("rejects oversized channel", async () => {
      const longChannel = "a".repeat(65);
      await expect(
        resolver.register(longChannel, "user1", "Alice"),
      ).rejects.toThrow(IdentityValidationError);
    });

    it("rejects oversized senderId", async () => {
      const longId = "a".repeat(257);
      await expect(
        resolver.register("telegram", longId, "Alice"),
      ).rejects.toThrow(IdentityValidationError);
    });

    it("rejects when max identities reached", async () => {
      const resolver = new IdentityResolver({ maxIdentities: 2 });
      await resolver.register("telegram", "user1", "Alice");
      await resolver.register("discord", "user2", "Bob");
      await expect(
        resolver.register("slack", "user3", "Charlie"),
      ).rejects.toThrow(IdentityValidationError);
    });
  });

  // ---- resolve ----

  describe("resolve", () => {
    it("returns identityId for a registered account", async () => {
      const identity = await resolver.register("discord", "user456", "Bob");
      const resolved = await resolver.resolve("discord", "user456");

      expect(resolved).toBe(identity.identityId);
    });

    it("returns undefined for an unregistered account", async () => {
      expect(await resolver.resolve("telegram", "unknown")).toBeUndefined();
    });
  });

  // ---- getIdentity / getIdentityByAccount ----

  describe("getIdentity", () => {
    it("returns identity by ID", async () => {
      const identity = await resolver.register("telegram", "user1", "Alice");
      const found = await resolver.getIdentity(identity.identityId);

      expect(found).toBeDefined();
      expect(found!.identityId).toBe(identity.identityId);
    });

    it("returns undefined for unknown ID", async () => {
      expect(await resolver.getIdentity("nonexistent")).toBeUndefined();
    });
  });

  describe("getIdentityByAccount", () => {
    it("returns identity for a linked account", async () => {
      await resolver.register("telegram", "user1", "Alice");
      const found = await resolver.getIdentityByAccount("telegram", "user1");

      expect(found).toBeDefined();
      expect(found!.accounts[0].senderId).toBe("user1");
    });

    it("returns undefined for unlinked account", async () => {
      expect(
        await resolver.getIdentityByAccount("telegram", "nope"),
      ).toBeUndefined();
    });
  });

  // ---- requestLink + confirmLink ----

  describe("requestLink", () => {
    it("returns a 6-character alphanumeric uppercase code", async () => {
      await resolver.register("telegram", "user1", "Alice");
      const code = await resolver.requestLink("telegram", "user1", "Alice");

      expect(code).toHaveLength(6);
      expect(code).toMatch(/^[A-Z0-9]{6}$/);
    });

    it("auto-registers account if not already registered", async () => {
      const code = await resolver.requestLink("telegram", "user1", "Alice");

      expect(code).toBeDefined();
      expect(await resolver.resolve("telegram", "user1")).toBeDefined();
    });

    it("rejects when pending link limit reached", async () => {
      const resolver = new IdentityResolver({ maxPendingLinksPerIdentity: 2 });
      await resolver.register("telegram", "user1", "Alice");
      await resolver.requestLink("telegram", "user1", "Alice");
      await resolver.requestLink("telegram", "user1", "Alice");

      await expect(
        resolver.requestLink("telegram", "user1", "Alice"),
      ).rejects.toThrow(IdentityValidationError);
    });
  });

  describe("confirmLink", () => {
    it("merges two accounts into one identity", async () => {
      await resolver.register("telegram", "user1", "Alice");
      const code = await resolver.requestLink("telegram", "user1", "Alice");

      const merged = await resolver.confirmLink(
        code,
        "discord",
        "user2",
        "Alice_Discord",
      );

      expect(merged.accounts).toHaveLength(2);
      expect(merged.accounts.some((a) => a.channel === "telegram")).toBe(true);
      expect(merged.accounts.some((a) => a.channel === "discord")).toBe(true);

      // Both accounts resolve to the same identity
      const id1 = await resolver.resolve("telegram", "user1");
      const id2 = await resolver.resolve("discord", "user2");
      expect(id1).toBe(id2);
    });

    it("throws IdentityLinkNotFoundError for invalid code", async () => {
      await expect(
        resolver.confirmLink("BADCOD", "discord", "user2", "Bob"),
      ).rejects.toThrow(IdentityLinkNotFoundError);
    });

    it("throws IdentityLinkExpiredError for expired code", async () => {
      const resolver = new IdentityResolver({ pendingLinkTtlMs: 1000 });
      await resolver.register("telegram", "user1", "Alice");
      const code = await resolver.requestLink("telegram", "user1", "Alice");

      vi.advanceTimersByTime(2000);

      await expect(
        resolver.confirmLink(code, "discord", "user2", "Bob"),
      ).rejects.toThrow(IdentityLinkExpiredError);
    });

    it("throws IdentitySelfLinkError for same channel + sender", async () => {
      await resolver.register("telegram", "user1", "Alice");
      const code = await resolver.requestLink("telegram", "user1", "Alice");

      await expect(
        resolver.confirmLink(code, "telegram", "user1", "Alice"),
      ).rejects.toThrow(IdentitySelfLinkError);
    });

    it("merges identities when completing account already has identity", async () => {
      // Register two separate identities
      await resolver.register("telegram", "user1", "Alice");
      await resolver.register("discord", "user2", "Alice_Discord");

      const id1Before = await resolver.resolve("telegram", "user1");
      const id2Before = await resolver.resolve("discord", "user2");
      expect(id1Before).not.toBe(id2Before);

      // Link them
      const code = await resolver.requestLink("telegram", "user1", "Alice");
      const merged = await resolver.confirmLink(
        code,
        "discord",
        "user2",
        "Alice_Discord",
      );

      expect(merged.accounts).toHaveLength(2);

      // Both now resolve to the same identity (the initiator's)
      const id1After = await resolver.resolve("telegram", "user1");
      const id2After = await resolver.resolve("discord", "user2");
      expect(id1After).toBe(id2After);
      expect(id1After).toBe(id1Before);
    });

    it("returns existing identity when already linked to same", async () => {
      await resolver.register("telegram", "user1", "Alice");
      const code1 = await resolver.requestLink("telegram", "user1", "Alice");
      await resolver.confirmLink(code1, "discord", "user2", "Alice_Discord");

      // Try linking again
      const code2 = await resolver.requestLink("telegram", "user1", "Alice");
      const result = await resolver.confirmLink(
        code2,
        "discord",
        "user2",
        "Alice_Discord",
      );

      expect(result.accounts).toHaveLength(2);
    });

    it("merge path preserves new displayName", async () => {
      await resolver.register("telegram", "user1", "Alice");
      await resolver.register("discord", "user2", "OldName");

      const code = await resolver.requestLink("telegram", "user1", "Alice");
      const merged = await resolver.confirmLink(
        code,
        "discord",
        "user2",
        "NewName",
      );

      const discordAccount = merged.accounts.find(
        (a) => a.channel === "discord",
      );
      expect(discordAccount!.displayName).toBe("NewName");
    });

    it("enforces attempt limit", async () => {
      const resolver = new IdentityResolver({ maxConfirmLinkAttempts: 3 });

      // 3 failed attempts
      for (let i = 0; i < 3; i++) {
        await expect(
          resolver.confirmLink("BADCOD", "discord", "user2", "Bob"),
        ).rejects.toThrow(IdentityLinkNotFoundError);
      }

      // 4th attempt should be blocked
      await expect(
        resolver.confirmLink("BADCOD", "discord", "user2", "Bob"),
      ).rejects.toThrow(IdentityValidationError);
    });

    it("resets attempt counter on success", async () => {
      const resolver = new IdentityResolver({ maxConfirmLinkAttempts: 3 });

      // 2 failed attempts
      await expect(
        resolver.confirmLink("BADCOD", "discord", "user2", "Bob"),
      ).rejects.toThrow();
      await expect(
        resolver.confirmLink("BADCO2", "discord", "user2", "Bob"),
      ).rejects.toThrow();

      // Successful link resets
      await resolver.register("telegram", "user1", "Alice");
      const code = await resolver.requestLink("telegram", "user1", "Alice");
      await resolver.confirmLink(code, "discord", "user2", "Bob");

      // Should be able to fail again (counter reset)
      await expect(
        resolver.confirmLink("BADCO3", "discord", "user2", "Bob"),
      ).rejects.toThrow(IdentityLinkNotFoundError);
    });
  });

  // ---- unlink ----

  describe("unlink", () => {
    it("removes an account from its identity", async () => {
      await resolver.register("telegram", "user1", "Alice");
      const code = await resolver.requestLink("telegram", "user1", "Alice");
      await resolver.confirmLink(code, "discord", "user2", "Alice_Discord");

      const unlinked = await resolver.unlink("discord", "user2");
      expect(unlinked).toBe(true);
      expect(await resolver.resolve("discord", "user2")).toBeUndefined();

      // Telegram account still linked
      const identity = await resolver.getIdentityByAccount("telegram", "user1");
      expect(identity).toBeDefined();
      expect(identity!.accounts).toHaveLength(1);
    });

    it("removes identity entirely when last account is unlinked", async () => {
      await resolver.register("telegram", "user1", "Alice");

      const unlinked = await resolver.unlink("telegram", "user1");
      expect(unlinked).toBe(true);
      const all = await resolver.listIdentities();
      expect(all).toHaveLength(0);
    });

    it("returns false for unregistered account", async () => {
      expect(await resolver.unlink("telegram", "nonexistent")).toBe(false);
    });
  });

  // ---- setAgentPubkey ----

  describe("setAgentPubkey", () => {
    it("sets on-chain pubkey for identity", async () => {
      const identity = await resolver.register("telegram", "user1", "Alice");
      const result = await resolver.setAgentPubkey(
        identity.identityId,
        "SomeSolanaPublicKey123",
      );

      expect(result).toBe(true);
      const updated = await resolver.getIdentity(identity.identityId);
      expect(updated!.agentPubkey).toBe("SomeSolanaPublicKey123");
    });

    it("returns false for unknown identity", async () => {
      expect(await resolver.setAgentPubkey("nonexistent", "key")).toBe(false);
    });
  });

  // ---- linkViaSolana ----

  describe("linkViaSolana", () => {
    it("links identity with valid ed25519 signature", async () => {
      const identity = await resolver.register("telegram", "user1", "Alice");
      const keypair = Keypair.generate();
      const message = Buffer.from("link-identity:" + identity.identityId);

      // Sign with node:crypto ed25519
      const { createPrivateKey } = await import("node:crypto");
      const privateKey = createPrivateKey({
        key: Buffer.concat([
          Buffer.from("302e020100300506032b657004220420", "hex"),
          Buffer.from(keypair.secretKey.slice(0, 32)),
        ]),
        format: "der",
        type: "pkcs8",
      });
      const signature = sign(null, message, privateKey);

      const linked = await resolver.linkViaSolana(
        identity.identityId,
        keypair.publicKey.toBase58(),
        message,
        signature,
      );

      expect(linked.agentPubkey).toBe(keypair.publicKey.toBase58());
    });

    it("throws IdentitySignatureError for invalid signature", async () => {
      const identity = await resolver.register("telegram", "user1", "Alice");
      const keypair = Keypair.generate();
      const message = Buffer.from("link-identity:test");
      const badSignature = Buffer.alloc(64);

      await expect(
        resolver.linkViaSolana(
          identity.identityId,
          keypair.publicKey.toBase58(),
          message,
          badSignature,
        ),
      ).rejects.toThrow(IdentitySignatureError);
    });

    it("throws IdentitySignatureError for invalid public key", async () => {
      const identity = await resolver.register("telegram", "user1", "Alice");

      await expect(
        resolver.linkViaSolana(
          identity.identityId,
          "not-a-valid-pubkey",
          Buffer.from("test"),
          Buffer.alloc(64),
        ),
      ).rejects.toThrow(IdentitySignatureError);
    });

    it("throws IdentityValidationError for unknown identity", async () => {
      const keypair = Keypair.generate();
      await expect(
        resolver.linkViaSolana(
          "nonexistent",
          keypair.publicKey.toBase58(),
          Buffer.from("test"),
          Buffer.alloc(64),
        ),
      ).rejects.toThrow(IdentityValidationError);
    });
  });

  // ---- setPreferences ----

  describe("setPreferences", () => {
    it("merges preferences for identity", async () => {
      const identity = await resolver.register("telegram", "user1", "Alice");
      await resolver.setPreferences(identity.identityId, { theme: "dark" });
      await resolver.setPreferences(identity.identityId, { language: "en" });

      const updated = await resolver.getIdentity(identity.identityId);
      expect(updated!.preferences).toEqual({ theme: "dark", language: "en" });
    });

    it("returns false for unknown identity", async () => {
      expect(await resolver.setPreferences("nonexistent", {})).toBe(false);
    });
  });

  // ---- purgeExpired ----

  describe("purgeExpired", () => {
    it("removes expired pending links", async () => {
      const resolver = new IdentityResolver({ pendingLinkTtlMs: 1000 });
      await resolver.register("telegram", "user1", "Alice");
      await resolver.requestLink("telegram", "user1", "Alice");

      vi.advanceTimersByTime(2000);

      const purged = await resolver.purgeExpired();
      expect(purged).toBe(1);
    });

    it("does not remove active links", async () => {
      await resolver.register("telegram", "user1", "Alice");
      await resolver.requestLink("telegram", "user1", "Alice");

      const purged = await resolver.purgeExpired();
      expect(purged).toBe(0);
    });
  });

  // ---- listIdentities ----

  describe("listIdentities", () => {
    it("returns all registered identities", async () => {
      await resolver.register("telegram", "user1", "Alice");
      await resolver.register("discord", "user2", "Bob");

      const list = await resolver.listIdentities();
      expect(list).toHaveLength(2);
    });
  });

  // ---- multi-channel linking (3+ channels) ----

  describe("multi-channel linking", () => {
    it("supports linking 3+ channels to a single identity", async () => {
      await resolver.register("telegram", "user1", "Alice");

      const code1 = await resolver.requestLink("telegram", "user1", "Alice");
      await resolver.confirmLink(code1, "discord", "user2", "Alice_Discord");

      const code2 = await resolver.requestLink("telegram", "user1", "Alice");
      await resolver.confirmLink(code2, "slack", "user3", "Alice_Slack");

      const identity = await resolver.getIdentityByAccount("telegram", "user1");
      expect(identity!.accounts).toHaveLength(3);

      // All three resolve to same identity
      const id1 = await resolver.resolve("telegram", "user1");
      const id2 = await resolver.resolve("discord", "user2");
      const id3 = await resolver.resolve("slack", "user3");
      expect(id1).toBe(id2);
      expect(id2).toBe(id3);
    });
  });
});

// ============================================================================
// Error Class Tests
// ============================================================================

describe("Identity Errors", () => {
  it("IdentityLinkExpiredError has correct name and fields", () => {
    const err = new IdentityLinkExpiredError("ABC123");
    expect(err.name).toBe("IdentityLinkExpiredError");
    expect(err.linkCode).toBe("ABC123");
    expect(err.message).toContain("ABC123");
  });

  it("IdentityLinkNotFoundError has correct name and fields", () => {
    const err = new IdentityLinkNotFoundError("XYZ789");
    expect(err.name).toBe("IdentityLinkNotFoundError");
    expect(err.linkCode).toBe("XYZ789");
    expect(err.message).toContain("XYZ789");
  });

  it("IdentitySelfLinkError has correct name and fields", () => {
    const err = new IdentitySelfLinkError("telegram", "user1");
    expect(err.name).toBe("IdentitySelfLinkError");
    expect(err.channel).toBe("telegram");
    expect(err.senderId).toBe("user1");
  });

  it("IdentitySignatureError has correct name and fields", () => {
    const err = new IdentitySignatureError("SomePubkey", "bad sig");
    expect(err.name).toBe("IdentitySignatureError");
    expect(err.publicKey).toBe("SomePubkey");
    expect(err.reason).toBe("bad sig");
  });

  it("IdentityValidationError has correct name and fields", () => {
    const err = new IdentityValidationError("channel", "too long");
    expect(err.name).toBe("IdentityValidationError");
    expect(err.field).toBe("channel");
    expect(err.reason).toBe("too long");
  });
});

// ============================================================================
// InMemoryIdentityStore Tests
// ============================================================================

describe("InMemoryIdentityStore", () => {
  let store: InMemoryIdentityStore;

  beforeEach(() => {
    store = new InMemoryIdentityStore();
  });

  it("saves and loads identity", async () => {
    const identity: IdentityLink = {
      identityId: "test-id",
      accounts: [
        {
          channel: "telegram",
          senderId: "user1",
          displayName: "Alice",
          linkedAt: 1000,
        },
      ],
      preferences: {},
      createdAt: 1000,
    };

    await store.saveIdentity(identity);
    const loaded = await store.loadIdentity("test-id");
    expect(loaded).toEqual(identity);
  });

  it("findByAccount returns identity ID", async () => {
    const identity: IdentityLink = {
      identityId: "test-id",
      accounts: [
        {
          channel: "telegram",
          senderId: "user1",
          displayName: "Alice",
          linkedAt: 1000,
        },
      ],
      preferences: {},
      createdAt: 1000,
    };

    await store.saveIdentity(identity);
    expect(await store.findByAccount("telegram", "user1")).toBe("test-id");
    expect(await store.findByAccount("telegram", "unknown")).toBeUndefined();
  });

  it("deleteIdentity removes identity and index", async () => {
    const identity: IdentityLink = {
      identityId: "test-id",
      accounts: [
        {
          channel: "telegram",
          senderId: "user1",
          displayName: "Alice",
          linkedAt: 1000,
        },
      ],
      preferences: {},
      createdAt: 1000,
    };

    await store.saveIdentity(identity);
    expect(await store.deleteIdentity("test-id")).toBe(true);
    expect(await store.loadIdentity("test-id")).toBeUndefined();
    expect(await store.findByAccount("telegram", "user1")).toBeUndefined();
  });

  it("listAll returns all identities", async () => {
    await store.saveIdentity({
      identityId: "id1",
      accounts: [
        {
          channel: "telegram",
          senderId: "u1",
          displayName: "A",
          linkedAt: 1000,
        },
      ],
      preferences: {},
      createdAt: 1000,
    });
    await store.saveIdentity({
      identityId: "id2",
      accounts: [
        {
          channel: "discord",
          senderId: "u2",
          displayName: "B",
          linkedAt: 1000,
        },
      ],
      preferences: {},
      createdAt: 1000,
    });

    const all = await store.listAll();
    expect(all).toHaveLength(2);
  });

  it("countIdentities returns correct count", async () => {
    expect(await store.countIdentities()).toBe(0);
    await store.saveIdentity({
      identityId: "id1",
      accounts: [
        {
          channel: "telegram",
          senderId: "u1",
          displayName: "A",
          linkedAt: 1000,
        },
      ],
      preferences: {},
      createdAt: 1000,
    });
    expect(await store.countIdentities()).toBe(1);
  });

  it("saves and loads pending links", async () => {
    const pending = {
      code: "ABC123",
      fromChannel: "telegram",
      fromSenderId: "u1",
      fromDisplayName: "A",
      expiresAt: 9999,
    };
    await store.savePendingLink(pending);
    expect(await store.loadPendingLink("ABC123")).toEqual(pending);
  });

  it("listExpiredPendingLinks returns only expired codes", async () => {
    await store.savePendingLink({
      code: "A",
      fromChannel: "c",
      fromSenderId: "s",
      fromDisplayName: "d",
      expiresAt: 500,
    });
    await store.savePendingLink({
      code: "B",
      fromChannel: "c",
      fromSenderId: "s",
      fromDisplayName: "d",
      expiresAt: 9999,
    });

    const expired = await store.listExpiredPendingLinks(1000);
    expect(expired).toEqual(["A"]);
  });

  it("saveIdentity cleans up stale account index entries on update", async () => {
    const identity: IdentityLink = {
      identityId: "test-id",
      accounts: [
        {
          channel: "telegram",
          senderId: "u1",
          displayName: "A",
          linkedAt: 1000,
        },
        {
          channel: "discord",
          senderId: "u2",
          displayName: "B",
          linkedAt: 1000,
        },
      ],
      preferences: {},
      createdAt: 1000,
    };

    await store.saveIdentity(identity);
    expect(await store.findByAccount("telegram", "u1")).toBe("test-id");
    expect(await store.findByAccount("discord", "u2")).toBe("test-id");

    // Update identity with one account removed (simulates unlink)
    const updated: IdentityLink = {
      ...identity,
      accounts: [
        {
          channel: "telegram",
          senderId: "u1",
          displayName: "A",
          linkedAt: 1000,
        },
      ],
    };
    await store.saveIdentity(updated);

    // Removed account should no longer resolve
    expect(await store.findByAccount("telegram", "u1")).toBe("test-id");
    expect(await store.findByAccount("discord", "u2")).toBeUndefined();
  });
});
