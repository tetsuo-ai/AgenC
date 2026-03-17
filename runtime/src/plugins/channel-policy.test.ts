import { describe, expect, it } from "vitest";
import {
  isTrustedPluginModuleSpecifier,
  isValidPluginModuleSpecifier,
  parsePluginModuleSpecifier,
} from "./channel-policy.js";

describe("channel-policy", () => {
  it("parses scoped package specifiers with subpaths", () => {
    expect(
      parsePluginModuleSpecifier("@tetsuo-ai/plugin-kit-channel-fixture/slack"),
    ).toEqual({
      packageName: "@tetsuo-ai/plugin-kit-channel-fixture",
      subpath: "slack",
    });
  });

  it("rejects unsafe specifiers", () => {
    expect(isValidPluginModuleSpecifier("file:../../evil.mjs")).toBe(false);
    expect(parsePluginModuleSpecifier("file:../../evil.mjs")).toBeNull();
  });

  it("requires explicit subpath trust for subpath imports", () => {
    expect(
      isTrustedPluginModuleSpecifier({
        moduleSpecifier: "@tetsuo-ai/plugin-kit-channel-fixture/slack",
        trustedPackages: [
          { packageName: "@tetsuo-ai/plugin-kit-channel-fixture" },
        ],
      }),
    ).toBe(false);
  });

  it("allows bare package imports when the package is trusted", () => {
    expect(
      isTrustedPluginModuleSpecifier({
        moduleSpecifier: "@tetsuo-ai/plugin-kit",
        trustedPackages: [{ packageName: "@tetsuo-ai/plugin-kit" }],
      }),
    ).toBe(true);
  });

  it("allows explicitly trusted subpaths", () => {
    expect(
      isTrustedPluginModuleSpecifier({
        moduleSpecifier: "@tetsuo-ai/plugin-kit-channel-fixture/slack",
        trustedPackages: [
          {
            packageName: "@tetsuo-ai/plugin-kit-channel-fixture",
            allowedSubpaths: ["slack"],
          },
        ],
      }),
    ).toBe(true);
  });
});
