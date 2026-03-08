import { describe, expect, it, vi } from "vitest";

import { resolveBrowserToolMode } from "./browser-tool-mode.js";

describe("resolveBrowserToolMode", () => {
  it("returns advanced when Playwright is available", async () => {
    const logger = { debug: vi.fn() };

    await expect(
      resolveBrowserToolMode(logger, async () => ({ chromium: {} })),
    ).resolves.toBe("advanced");
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it("falls back to basic when Playwright is unavailable", async () => {
    const logger = { debug: vi.fn() };

    await expect(
      resolveBrowserToolMode(logger, async () => {
        throw new Error("Cannot find module 'playwright'");
      }),
    ).resolves.toBe("basic");
    expect(logger.debug).toHaveBeenCalledWith(
      "Playwright unavailable; falling back to basic browser tools",
      expect.objectContaining({
        error: expect.stringContaining("Cannot find module"),
      }),
    );
  });
});
