import { describe, expect, it } from "vitest";

import { resolveLLMStatefulResponsesConfig } from "./provider-capabilities.js";

describe("resolveLLMStatefulResponsesConfig", () => {
  it("defaults store=false when stateful responses are enabled without an explicit store override", () => {
    expect(
      resolveLLMStatefulResponsesConfig({
        enabled: true,
        fallbackToStateless: true,
      }),
    ).toMatchObject({
      enabled: true,
      store: false,
      fallbackToStateless: true,
    });
  });

  it("preserves explicit store=true overrides", () => {
    expect(
      resolveLLMStatefulResponsesConfig({
        enabled: true,
        store: true,
      }),
    ).toMatchObject({
      enabled: true,
      store: true,
    });
  });
});
