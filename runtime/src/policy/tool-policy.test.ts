import { describe, it, expect } from "vitest";
import {
  ToolPolicyEvaluator,
  type ToolPermissionPolicy,
  type ToolPolicyContext,
} from "./tool-policy.js";

function ctx(overrides: Partial<ToolPolicyContext> = {}): ToolPolicyContext {
  return {
    toolName: "system.bash",
    sessionId: "sess-1",
    channel: "telegram",
    isHeartbeat: false,
    isSandboxed: false,
    ...overrides,
  };
}

describe("ToolPolicyEvaluator", () => {
  // -------------------------------------------------------------------
  // Basic allow / deny
  // -------------------------------------------------------------------

  it("denies when a deny rule matches", () => {
    const evaluator = new ToolPolicyEvaluator([
      { tool: "system.bash", effect: "deny" },
    ]);
    const decision = evaluator.evaluate(ctx());
    expect(decision.allowed).toBe(false);
    expect(decision.matchedRule?.tool).toBe("system.bash");
  });

  it("allows when an allow rule matches", () => {
    const evaluator = new ToolPolicyEvaluator([
      { tool: "system.bash", effect: "allow" },
    ]);
    const decision = evaluator.evaluate(ctx());
    expect(decision.allowed).toBe(true);
    expect(decision.matchedRule?.tool).toBe("system.bash");
  });

  it("deny takes precedence over allow when deny comes first", () => {
    const evaluator = new ToolPolicyEvaluator([
      { tool: "system.bash", effect: "deny" },
      { tool: "system.bash", effect: "allow" },
    ]);
    const decision = evaluator.evaluate(ctx());
    expect(decision.allowed).toBe(false);
  });

  it("deny takes precedence over allow even when allow comes first", () => {
    const evaluator = new ToolPolicyEvaluator([
      { tool: "system.bash", effect: "allow" },
      { tool: "system.bash", effect: "deny" },
    ]);
    const decision = evaluator.evaluate(ctx());
    expect(decision.allowed).toBe(false);
  });

  it("defaults to deny when no rule matches", () => {
    const evaluator = new ToolPolicyEvaluator([
      { tool: "agenc.listTasks", effect: "allow" },
    ]);
    const decision = evaluator.evaluate(ctx());
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("No matching allow rule");
  });

  // -------------------------------------------------------------------
  // Glob pattern matching
  // -------------------------------------------------------------------

  it("glob pattern system.* matches system.bash", () => {
    const evaluator = new ToolPolicyEvaluator([
      { tool: "system.*", effect: "allow" },
    ]);
    const decision = evaluator.evaluate(ctx({ toolName: "system.bash" }));
    expect(decision.allowed).toBe(true);
  });

  it("glob pattern system.* matches system.http", () => {
    const evaluator = new ToolPolicyEvaluator([
      { tool: "system.*", effect: "allow" },
    ]);
    const decision = evaluator.evaluate(ctx({ toolName: "system.http" }));
    expect(decision.allowed).toBe(true);
  });

  it("glob pattern system.* does NOT match systemd", () => {
    const evaluator = new ToolPolicyEvaluator([
      { tool: "system.*", effect: "allow" },
    ]);
    const decision = evaluator.evaluate(ctx({ toolName: "systemd" }));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("No matching allow rule");
  });

  it("wildcard * matches everything", () => {
    const evaluator = new ToolPolicyEvaluator([{ tool: "*", effect: "allow" }]);
    expect(evaluator.evaluate(ctx({ toolName: "anything" })).allowed).toBe(
      true,
    );
    expect(evaluator.evaluate(ctx({ toolName: "system.bash" })).allowed).toBe(
      true,
    );
  });

  it("exact name matches exactly", () => {
    const evaluator = new ToolPolicyEvaluator([
      { tool: "agenc.listTasks", effect: "allow" },
    ]);
    expect(
      evaluator.evaluate(ctx({ toolName: "agenc.listTasks" })).allowed,
    ).toBe(true);
    expect(evaluator.evaluate(ctx({ toolName: "agenc.getTask" })).allowed).toBe(
      false,
    );
  });

  it("glob pattern works with deny rules", () => {
    const evaluator = new ToolPolicyEvaluator([
      { tool: "system.*", effect: "deny" },
      { tool: "*", effect: "allow" },
    ]);
    // system.bash denied by glob deny
    expect(evaluator.evaluate(ctx({ toolName: "system.bash" })).allowed).toBe(
      false,
    );
    // agenc.listTasks allowed by wildcard allow (no deny match)
    expect(
      evaluator.evaluate(ctx({ toolName: "agenc.listTasks" })).allowed,
    ).toBe(true);
  });

  it("glob does not match across dot segments", () => {
    const evaluator = new ToolPolicyEvaluator([
      { tool: "system.*", effect: "allow" },
    ]);
    // Two segments deep — should not match single * glob
    expect(
      evaluator.evaluate(ctx({ toolName: "system.bash.sub" })).allowed,
    ).toBe(false);
  });

  // -------------------------------------------------------------------
  // heartbeatOnly condition
  // -------------------------------------------------------------------

  it("heartbeatOnly blocks user-initiated calls", () => {
    const evaluator = new ToolPolicyEvaluator([
      {
        tool: "system.bash",
        effect: "allow",
        conditions: { heartbeatOnly: true },
      },
    ]);
    const decision = evaluator.evaluate(ctx({ isHeartbeat: false }));
    expect(decision.allowed).toBe(false);
  });

  it("heartbeatOnly allows heartbeat-initiated calls", () => {
    const evaluator = new ToolPolicyEvaluator([
      {
        tool: "system.bash",
        effect: "allow",
        conditions: { heartbeatOnly: true },
      },
    ]);
    const decision = evaluator.evaluate(ctx({ isHeartbeat: true }));
    expect(decision.allowed).toBe(true);
  });

  // -------------------------------------------------------------------
  // sessionIds condition
  // -------------------------------------------------------------------

  it("sessionIds restriction blocks non-matching sessions", () => {
    const evaluator = new ToolPolicyEvaluator([
      {
        tool: "system.bash",
        effect: "allow",
        conditions: { sessionIds: ["sess-admin"] },
      },
    ]);
    const decision = evaluator.evaluate(ctx({ sessionId: "sess-user" }));
    expect(decision.allowed).toBe(false);
  });

  it("sessionIds allows matching sessions", () => {
    const evaluator = new ToolPolicyEvaluator([
      {
        tool: "system.bash",
        effect: "allow",
        conditions: { sessionIds: ["sess-admin"] },
      },
    ]);
    const decision = evaluator.evaluate(ctx({ sessionId: "sess-admin" }));
    expect(decision.allowed).toBe(true);
  });

  // -------------------------------------------------------------------
  // channels condition
  // -------------------------------------------------------------------

  it("channels restriction blocks non-matching channels", () => {
    const evaluator = new ToolPolicyEvaluator([
      {
        tool: "system.bash",
        effect: "allow",
        conditions: { channels: ["discord"] },
      },
    ]);
    const decision = evaluator.evaluate(ctx({ channel: "telegram" }));
    expect(decision.allowed).toBe(false);
  });

  it("channels allows matching channels", () => {
    const evaluator = new ToolPolicyEvaluator([
      {
        tool: "system.bash",
        effect: "allow",
        conditions: { channels: ["telegram"] },
      },
    ]);
    const decision = evaluator.evaluate(ctx({ channel: "telegram" }));
    expect(decision.allowed).toBe(true);
  });

  // -------------------------------------------------------------------
  // sandboxOnly condition
  // -------------------------------------------------------------------

  it("sandboxOnly blocks non-sandboxed calls", () => {
    const evaluator = new ToolPolicyEvaluator([
      {
        tool: "system.bash",
        effect: "allow",
        conditions: { sandboxOnly: true },
      },
    ]);
    const decision = evaluator.evaluate(ctx({ isSandboxed: false }));
    expect(decision.allowed).toBe(false);
  });

  it("sandboxOnly allows sandboxed calls", () => {
    const evaluator = new ToolPolicyEvaluator([
      {
        tool: "system.bash",
        effect: "allow",
        conditions: { sandboxOnly: true },
      },
    ]);
    const decision = evaluator.evaluate(ctx({ isSandboxed: true }));
    expect(decision.allowed).toBe(true);
  });

  // -------------------------------------------------------------------
  // Rate limiting
  // -------------------------------------------------------------------

  it("allows calls within rate limit", () => {
    let nowMs = 1_000;
    const evaluator = new ToolPolicyEvaluator(
      [{ tool: "system.bash", effect: "allow", conditions: { rateLimit: 3 } }],
      () => nowMs,
    );
    expect(evaluator.evaluate(ctx()).allowed).toBe(true);
    nowMs += 100;
    expect(evaluator.evaluate(ctx()).allowed).toBe(true);
    nowMs += 100;
    expect(evaluator.evaluate(ctx()).allowed).toBe(true);
  });

  it("blocks calls exceeding rate limit", () => {
    let nowMs = 1_000;
    const evaluator = new ToolPolicyEvaluator(
      [{ tool: "system.bash", effect: "allow", conditions: { rateLimit: 2 } }],
      () => nowMs,
    );
    expect(evaluator.evaluate(ctx()).allowed).toBe(true);
    nowMs += 100;
    expect(evaluator.evaluate(ctx()).allowed).toBe(true);
    nowMs += 100;
    const decision = evaluator.evaluate(ctx());
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("Rate limit exceeded");
  });

  it("rate limit window resets after expiry", () => {
    let nowMs = 1_000;
    const evaluator = new ToolPolicyEvaluator(
      [{ tool: "system.bash", effect: "allow", conditions: { rateLimit: 1 } }],
      () => nowMs,
    );
    expect(evaluator.evaluate(ctx()).allowed).toBe(true);
    nowMs += 100;
    expect(evaluator.evaluate(ctx()).allowed).toBe(false);

    // Advance past the 60s window
    nowMs += 60_000;
    expect(evaluator.evaluate(ctx()).allowed).toBe(true);
  });

  // -------------------------------------------------------------------
  // Multiple conditions (AND logic)
  // -------------------------------------------------------------------

  it("all conditions must be met (AND logic)", () => {
    const policies: ToolPermissionPolicy[] = [
      {
        tool: "system.bash",
        effect: "allow",
        conditions: {
          heartbeatOnly: true,
          channels: ["telegram"],
          sandboxOnly: true,
        },
      },
    ];
    const evaluator = new ToolPolicyEvaluator(policies);

    // All conditions met
    expect(
      evaluator.evaluate(
        ctx({
          isHeartbeat: true,
          channel: "telegram",
          isSandboxed: true,
        }),
      ).allowed,
    ).toBe(true);

    // heartbeat missing
    expect(
      evaluator.evaluate(
        ctx({
          isHeartbeat: false,
          channel: "telegram",
          isSandboxed: true,
        }),
      ).allowed,
    ).toBe(false);

    // wrong channel
    expect(
      evaluator.evaluate(
        ctx({
          isHeartbeat: true,
          channel: "discord",
          isSandboxed: true,
        }),
      ).allowed,
    ).toBe(false);

    // not sandboxed
    expect(
      evaluator.evaluate(
        ctx({
          isHeartbeat: true,
          channel: "telegram",
          isSandboxed: false,
        }),
      ).allowed,
    ).toBe(false);
  });

  it("rate limit combined with channel condition", () => {
    let nowMs = 1_000;
    const evaluator = new ToolPolicyEvaluator(
      [
        {
          tool: "system.bash",
          effect: "allow",
          conditions: { channels: ["telegram"], rateLimit: 1 },
        },
      ],
      () => nowMs,
    );
    // Wrong channel — no allow rule matches
    expect(evaluator.evaluate(ctx({ channel: "discord" })).allowed).toBe(false);
    // Right channel — allowed
    expect(evaluator.evaluate(ctx({ channel: "telegram" })).allowed).toBe(true);
    nowMs += 100;
    // Right channel but rate limited
    const decision = evaluator.evaluate(ctx({ channel: "telegram" }));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("Rate limit exceeded");
  });

  // -------------------------------------------------------------------
  // updatePolicies
  // -------------------------------------------------------------------

  it("updatePolicies replaces policy set and clears rate counters", () => {
    let nowMs = 1_000;
    const evaluator = new ToolPolicyEvaluator(
      [{ tool: "system.bash", effect: "allow", conditions: { rateLimit: 1 } }],
      () => nowMs,
    );

    // Exhaust rate limit
    expect(evaluator.evaluate(ctx()).allowed).toBe(true);
    nowMs += 100;
    expect(evaluator.evaluate(ctx()).allowed).toBe(false);

    // Update policies — rate counters reset
    evaluator.updatePolicies([
      { tool: "system.bash", effect: "allow", conditions: { rateLimit: 1 } },
    ]);
    nowMs += 100;
    expect(evaluator.evaluate(ctx()).allowed).toBe(true);
  });

  it("updatePolicies changes which tools are allowed", () => {
    const evaluator = new ToolPolicyEvaluator([
      { tool: "system.bash", effect: "allow" },
    ]);
    expect(evaluator.evaluate(ctx()).allowed).toBe(true);

    evaluator.updatePolicies([{ tool: "system.bash", effect: "deny" }]);
    expect(evaluator.evaluate(ctx()).allowed).toBe(false);
  });

  // -------------------------------------------------------------------
  // recordCall
  // -------------------------------------------------------------------

  it("recordCall tracks calls for rate limit externally", () => {
    let nowMs = 1_000;
    const evaluator = new ToolPolicyEvaluator(
      [{ tool: "system.bash", effect: "allow", conditions: { rateLimit: 2 } }],
      () => nowMs,
    );

    // Record one call externally
    evaluator.recordCall("system.bash");
    nowMs += 100;

    // Only one more allowed via evaluate
    expect(evaluator.evaluate(ctx()).allowed).toBe(true);
    nowMs += 100;
    expect(evaluator.evaluate(ctx()).allowed).toBe(false);
  });

  // -------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------

  it("empty policies list defaults to deny", () => {
    const evaluator = new ToolPolicyEvaluator([]);
    const decision = evaluator.evaluate(ctx());
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("No matching allow rule");
  });

  it("deny rule with unmet conditions does not block", () => {
    const evaluator = new ToolPolicyEvaluator([
      {
        tool: "system.bash",
        effect: "deny",
        conditions: { channels: ["discord"] },
      },
      { tool: "system.bash", effect: "allow" },
    ]);
    // Deny rule targets discord only; we're on telegram → deny doesn't fire
    const decision = evaluator.evaluate(ctx({ channel: "telegram" }));
    expect(decision.allowed).toBe(true);
  });

  it("first matching allow rule wins", () => {
    const evaluator = new ToolPolicyEvaluator([
      {
        tool: "system.bash",
        effect: "allow",
        conditions: { channels: ["telegram"] },
      },
      {
        tool: "system.bash",
        effect: "allow",
        conditions: { channels: ["discord"] },
      },
    ]);
    const decision = evaluator.evaluate(ctx({ channel: "telegram" }));
    expect(decision.allowed).toBe(true);
    expect(decision.matchedRule?.conditions?.channels).toEqual(["telegram"]);
  });
});
