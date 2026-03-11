import { describe, expect, it } from "vitest";
import {
  filterSystemPromptForToolRouting,
  hasProtocolToolRouting,
} from "./system-prompt-routing.js";

const SYSTEM_PROMPT = `# Agent Configuration

## Name
AgenC

## Role
A privacy-preserving AI agent on the AgenC protocol.

## Instructions
- Respond helpfully and concisely
- Prioritize user privacy
- Use available tools to query on-chain state before making decisions

# Identity

## Addresses
- Solana: (your pubkey here)

# Capabilities

## Registered Capabilities
- COMPUTE (1 << 0)
- INFERENCE (1 << 1)

# Policy

## Budget
- Max SOL per task: 1.0

# Reputation

## Thresholds
- Min reputation for tasks: 50

# User Preferences

## Context
- Network: Devnet
- Explorer: Solana Explorer

# Tool Guidelines

## Available Tools
- Task operations (list, get, create, claim, complete)
- Agent operations (register, update, query)
- Protocol queries (config, PDA derivation)

# Memory

## Key Facts
- (Add persistent context here)

You have broad access to this machine via the system.bash tool.`;

describe("system prompt routing filter", () => {
  it("detects when routed tools still require protocol context", () => {
    expect(
      hasProtocolToolRouting(["system.bash", "agenc.createTask"]),
    ).toBe(true);
    expect(
      hasProtocolToolRouting(["system.bash", "social.sendMessage"]),
    ).toBe(true);
    expect(
      hasProtocolToolRouting(["system.bash", "system.writeFile"]),
    ).toBe(false);
  });

  it("removes protocol sections for generic coding turns", () => {
    const filtered = filterSystemPromptForToolRouting({
      systemPrompt: SYSTEM_PROMPT,
      routedToolNames: ["system.bash", "system.writeFile", "execute_with_agent"],
    });

    expect(filtered).toContain("A helpful AI assistant.");
    expect(filtered).not.toContain("Solana:");
    expect(filtered).not.toContain("Registered Capabilities");
    expect(filtered).not.toContain("Max SOL per task");
    expect(filtered).not.toContain("Protocol queries");
    expect(filtered).not.toContain("Task operations");
    expect(filtered).toContain("You have broad access to this machine");
  });

  it("preserves protocol sections when routed tools include protocol families", () => {
    const filtered = filterSystemPromptForToolRouting({
      systemPrompt: SYSTEM_PROMPT,
      routedToolNames: ["system.bash", "agenc.createTask"],
    });

    expect(filtered).toContain("Solana:");
    expect(filtered).toContain("Registered Capabilities");
    expect(filtered).toContain("Max SOL per task");
    expect(filtered).toContain("Protocol queries");
  });
});
