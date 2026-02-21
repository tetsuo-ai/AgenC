import { describe, it, expect } from "vitest";
import { RuntimeError, RuntimeErrorCodes } from "../types/errors.js";
import {
  MessageRouter,
  RoutingValidationError,
  type RoutingRule,
  type GatewayMessage,
} from "./routing.js";

// ============================================================================
// Test helpers
// ============================================================================

function makeMessage(overrides?: Partial<GatewayMessage>): GatewayMessage {
  return {
    id: "test-id",
    channel: "telegram",
    senderId: "user-123",
    senderName: "Alice",
    sessionId: "session-abc",
    content: "Hello world",
    timestamp: Date.now(),
    scope: "dm",
    ...overrides,
  };
}

function makeRule(overrides?: Partial<RoutingRule>): RoutingRule {
  return {
    name: "rule-a",
    match: {},
    workspace: "default",
    priority: 0,
    ...overrides,
  };
}

// ============================================================================
// RoutingValidationError
// ============================================================================

describe("RoutingValidationError", () => {
  it("has correct error code", () => {
    const err = new RoutingValidationError("name", "bad");
    expect(err.code).toBe(RuntimeErrorCodes.GATEWAY_VALIDATION_ERROR);
  });

  it("has field and reason properties", () => {
    const err = new RoutingValidationError("workspace", "invalid format");
    expect(err.field).toBe("workspace");
    expect(err.reason).toBe("invalid format");
  });

  it("is instanceof RuntimeError", () => {
    const err = new RoutingValidationError("x", "y");
    expect(err).toBeInstanceOf(RuntimeError);
    expect(err).toBeInstanceOf(RoutingValidationError);
  });

  it("has descriptive message", () => {
    const err = new RoutingValidationError("name", "duplicate");
    expect(err.message).toContain("name");
    expect(err.message).toContain("duplicate");
  });
});

// ============================================================================
// MessageRouter — constructor
// ============================================================================

describe("MessageRouter", () => {
  describe("constructor", () => {
    it("accepts empty rules array", () => {
      const router = new MessageRouter([], "default");
      expect(router.getRules()).toHaveLength(0);
    });

    it("validates defaultWorkspace format", () => {
      expect(() => new MessageRouter([], "INVALID")).toThrow(
        RoutingValidationError,
      );
    });

    it("validates defaultWorkspace length", () => {
      const longId = "a".repeat(65);
      expect(() => new MessageRouter([], longId)).toThrow(
        RoutingValidationError,
      );
    });

    it("rejects duplicate rule names", () => {
      const rules: RoutingRule[] = [
        makeRule({ name: "dup" }),
        makeRule({ name: "dup", priority: 1 }),
      ];
      expect(() => new MessageRouter(rules, "default")).toThrow(
        RoutingValidationError,
      );
    });

    it("rejects invalid contentPattern regex", () => {
      const rules: RoutingRule[] = [
        makeRule({ name: "bad", match: { contentPattern: "[invalid(" } }),
      ];
      expect(() => new MessageRouter(rules, "default")).toThrow(
        RoutingValidationError,
      );
    });

    it("rejects invalid workspace ID in rule", () => {
      expect(
        () => new MessageRouter([makeRule({ workspace: "BAD!" })], "default"),
      ).toThrow(RoutingValidationError);
    });

    it("rejects non-finite priority", () => {
      expect(
        () => new MessageRouter([makeRule({ priority: Infinity })], "default"),
      ).toThrow(RoutingValidationError);
      expect(
        () => new MessageRouter([makeRule({ priority: NaN })], "default"),
      ).toThrow(RoutingValidationError);
    });

    it("rejects invalid scope", () => {
      const rules = [makeRule({ match: { scope: "invalid" as "dm" } })];
      expect(() => new MessageRouter(rules, "default")).toThrow(
        RoutingValidationError,
      );
    });

    it("rejects empty rule name", () => {
      expect(
        () => new MessageRouter([makeRule({ name: "" })], "default"),
      ).toThrow(RoutingValidationError);
    });
  });

  // ==========================================================================
  // route
  // ==========================================================================

  describe("route", () => {
    it("returns defaultWorkspace when no rules match", () => {
      const router = new MessageRouter(
        [makeRule({ name: "nomatch", match: { peer: "nobody" } })],
        "fallback",
      );
      expect(router.route(makeMessage())).toBe("fallback");
    });

    it("returns defaultWorkspace with empty rules", () => {
      const router = new MessageRouter([], "fallback");
      expect(router.route(makeMessage())).toBe("fallback");
    });

    it("matches by peer (senderId)", () => {
      const router = new MessageRouter(
        [
          makeRule({
            name: "peer",
            match: { peer: "user-123" },
            workspace: "work",
          }),
        ],
        "default",
      );
      expect(router.route(makeMessage())).toBe("work");
      expect(router.route(makeMessage({ senderId: "other" }))).toBe("default");
    });

    it("matches by guildId from metadata", () => {
      const router = new MessageRouter(
        [
          makeRule({
            name: "guild",
            match: { guildId: "guild-42" },
            workspace: "work",
          }),
        ],
        "default",
      );
      expect(
        router.route(makeMessage({ metadata: { guildId: "guild-42" } })),
      ).toBe("work");
      expect(
        router.route(makeMessage({ metadata: { guildId: "other" } })),
      ).toBe("default");
    });

    it("guildId does not match when metadata is undefined", () => {
      const router = new MessageRouter(
        [
          makeRule({
            name: "guild",
            match: { guildId: "guild-42" },
            workspace: "work",
          }),
        ],
        "default",
      );
      expect(router.route(makeMessage())).toBe("default");
    });

    it("guildId does not match when metadata.guildId is not a string", () => {
      const router = new MessageRouter(
        [
          makeRule({
            name: "guild",
            match: { guildId: "42" },
            workspace: "work",
          }),
        ],
        "default",
      );
      expect(router.route(makeMessage({ metadata: { guildId: 42 } }))).toBe(
        "default",
      );
    });

    it("matches by accountId (identityId)", () => {
      const router = new MessageRouter(
        [
          makeRule({
            name: "acct",
            match: { accountId: "identity-1" },
            workspace: "work",
          }),
        ],
        "default",
      );
      expect(router.route(makeMessage({ identityId: "identity-1" }))).toBe(
        "work",
      );
      expect(router.route(makeMessage())).toBe("default");
    });

    it("matches by channel name", () => {
      const router = new MessageRouter(
        [
          makeRule({
            name: "chan",
            match: { channel: "discord" },
            workspace: "disc",
          }),
        ],
        "default",
      );
      expect(router.route(makeMessage({ channel: "discord" }))).toBe("disc");
      expect(router.route(makeMessage({ channel: "telegram" }))).toBe(
        "default",
      );
    });

    it("matches by scope (exact)", () => {
      const router = new MessageRouter(
        [
          makeRule({
            name: "grp",
            match: { scope: "group" },
            workspace: "group-ws",
          }),
        ],
        "default",
      );
      expect(router.route(makeMessage({ scope: "group" }))).toBe("group-ws");
      expect(router.route(makeMessage({ scope: "dm" }))).toBe("default");
    });

    it("matches by contentPattern (regex)", () => {
      const router = new MessageRouter(
        [
          makeRule({
            name: "defi",
            match: { contentPattern: "swap|trade" },
            workspace: "defi",
          }),
        ],
        "default",
      );
      expect(router.route(makeMessage({ content: "please swap USDC" }))).toBe(
        "defi",
      );
      expect(router.route(makeMessage({ content: "hello" }))).toBe("default");
    });

    it("glob wildcards work", () => {
      const router = new MessageRouter(
        [
          makeRule({
            name: "wild",
            match: { peer: "user-*" },
            workspace: "work",
          }),
        ],
        "default",
      );
      expect(router.route(makeMessage({ senderId: "user-999" }))).toBe("work");
      expect(router.route(makeMessage({ senderId: "admin-1" }))).toBe(
        "default",
      );
    });

    it("higher priority is evaluated first", () => {
      const router = new MessageRouter(
        [
          makeRule({
            name: "low",
            match: { channel: "telegram" },
            workspace: "low-ws",
            priority: 1,
          }),
          makeRule({
            name: "high",
            match: { channel: "telegram" },
            workspace: "high-ws",
            priority: 10,
          }),
        ],
        "default",
      );
      expect(router.route(makeMessage())).toBe("high-ws");
    });

    it("specificity tiebreak: peer beats guildId at same priority", () => {
      const router = new MessageRouter(
        [
          makeRule({
            name: "guild",
            match: { guildId: "g1" },
            workspace: "guild-ws",
            priority: 5,
          }),
          makeRule({
            name: "peer",
            match: { peer: "user-123" },
            workspace: "peer-ws",
            priority: 5,
          }),
        ],
        "default",
      );
      const msg = makeMessage({ metadata: { guildId: "g1" } });
      expect(router.route(msg)).toBe("peer-ws");
    });

    it("specificity tiebreak: peer beats combined guildId+channel at same priority", () => {
      const router = new MessageRouter(
        [
          makeRule({
            name: "multi",
            match: { guildId: "g1", channel: "discord" },
            workspace: "multi-ws",
            priority: 5,
          }),
          makeRule({
            name: "peer",
            match: { peer: "user-123" },
            workspace: "peer-ws",
            priority: 5,
          }),
        ],
        "default",
      );
      const msg = makeMessage({
        channel: "discord",
        metadata: { guildId: "g1" },
      });
      expect(router.route(msg)).toBe("peer-ws");
    });

    it("all match fields are ANDed", () => {
      const router = new MessageRouter(
        [
          makeRule({
            name: "both",
            match: { channel: "discord", scope: "group" },
            workspace: "work",
          }),
        ],
        "default",
      );
      // Both conditions met
      expect(
        router.route(makeMessage({ channel: "discord", scope: "group" })),
      ).toBe("work");
      // Only one condition met
      expect(
        router.route(makeMessage({ channel: "discord", scope: "dm" })),
      ).toBe("default");
    });

    it("empty match object matches everything (catch-all)", () => {
      const router = new MessageRouter(
        [makeRule({ name: "catchall", match: {}, workspace: "catch" })],
        "default",
      );
      expect(router.route(makeMessage())).toBe("catch");
    });

    it("deterministic alphabetical ordering for equal priority and specificity", () => {
      const router = new MessageRouter(
        [
          makeRule({
            name: "beta",
            match: { channel: "telegram" },
            workspace: "beta-ws",
            priority: 5,
          }),
          makeRule({
            name: "alpha",
            match: { channel: "telegram" },
            workspace: "alpha-ws",
            priority: 5,
          }),
        ],
        "default",
      );
      expect(router.route(makeMessage())).toBe("alpha-ws");
    });
  });

  // ==========================================================================
  // addRule
  // ==========================================================================

  describe("addRule", () => {
    it("adds rule and routes to it", () => {
      const router = new MessageRouter([], "default");
      router.addRule(
        makeRule({
          name: "new",
          match: { peer: "user-123" },
          workspace: "new-ws",
        }),
      );
      expect(router.route(makeMessage())).toBe("new-ws");
    });

    it("rejects duplicate name", () => {
      const router = new MessageRouter(
        [makeRule({ name: "existing" })],
        "default",
      );
      expect(() => router.addRule(makeRule({ name: "existing" }))).toThrow(
        RoutingValidationError,
      );
    });

    it("rejects invalid rule", () => {
      const router = new MessageRouter([], "default");
      expect(() => router.addRule(makeRule({ name: "" }))).toThrow(
        RoutingValidationError,
      );
    });
  });

  // ==========================================================================
  // removeRule
  // ==========================================================================

  describe("removeRule", () => {
    it("removes existing rule and returns true", () => {
      const router = new MessageRouter(
        [makeRule({ name: "rm-me" })],
        "default",
      );
      expect(router.removeRule("rm-me")).toBe(true);
      expect(router.getRules()).toHaveLength(0);
    });

    it("returns false for non-existent rule", () => {
      const router = new MessageRouter([], "default");
      expect(router.removeRule("nope")).toBe(false);
    });

    it("removed rule no longer matches", () => {
      const router = new MessageRouter(
        [
          makeRule({
            name: "temp",
            match: { peer: "user-123" },
            workspace: "temp-ws",
          }),
        ],
        "default",
      );
      expect(router.route(makeMessage())).toBe("temp-ws");
      router.removeRule("temp");
      expect(router.route(makeMessage())).toBe("default");
    });

    it("allows re-adding a removed rule name", () => {
      const router = new MessageRouter(
        [makeRule({ name: "reuse", workspace: "old" })],
        "default",
      );
      router.removeRule("reuse");
      router.addRule(makeRule({ name: "reuse", workspace: "new-ws" }));
      expect(router.route(makeMessage())).toBe("new-ws");
    });
  });

  // ==========================================================================
  // getRules
  // ==========================================================================

  describe("getRules", () => {
    it("returns all rules", () => {
      const rules = [
        makeRule({ name: "a", priority: 1 }),
        makeRule({ name: "b", priority: 2 }),
      ];
      const router = new MessageRouter(rules, "default");
      expect(router.getRules()).toHaveLength(2);
    });

    it("returned array is frozen", () => {
      const router = new MessageRouter([makeRule()], "default");
      const result = router.getRules();
      expect(Object.isFrozen(result)).toBe(true);
    });

    it("does not expose internal array (mutation safety)", () => {
      const router = new MessageRouter([makeRule({ name: "a" })], "default");
      const r1 = router.getRules();
      router.addRule(makeRule({ name: "b" }));
      const r2 = router.getRules();
      expect(r1).toHaveLength(1);
      expect(r2).toHaveLength(2);
    });
  });
});
