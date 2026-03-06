import { describe, expect, it } from "vitest";
import {
  getProviderNativeAdvertisedToolNames,
  getProviderNativeWebSearchRoutingDecision,
  supportsGrokServerSideTools,
} from "./provider-native-search.js";

describe("provider-native-search", () => {
  it("only enables Grok server-side tools for supported models", () => {
    expect(supportsGrokServerSideTools("grok-4-1-fast-reasoning")).toBe(true);
    expect(supportsGrokServerSideTools("grok-4-0709")).toBe(true);
    expect(supportsGrokServerSideTools("grok-code-fast-1")).toBe(false);
  });

  it("does not advertise web_search for unsupported Grok models", () => {
    expect(getProviderNativeAdvertisedToolNames({
      provider: "grok",
      model: "grok-code-fast-1",
      webSearch: true,
      searchMode: "auto",
    })).toEqual([]);
  });

  it("does not route web_search for generic current-state prompts", () => {
    const decision = getProviderNativeWebSearchRoutingDecision({
      llmConfig: {
        provider: "grok",
        model: "grok-4-1-fast-reasoning",
        webSearch: true,
        searchMode: "auto",
      },
      messageText: "What is the current working directory?",
      history: [],
    });

    expect(decision).toBeUndefined();
  });

  it("routes web_search for explicit research turns on supported models", () => {
    const decision = getProviderNativeWebSearchRoutingDecision({
      llmConfig: {
        provider: "grok",
        model: "grok-4-1-fast-reasoning",
        webSearch: true,
        searchMode: "auto",
      },
      messageText: "Compare Phaser and PixiJS from official docs and cite sources",
      history: [],
    });

    expect(decision?.toolName).toBe("web_search");
  });
});
