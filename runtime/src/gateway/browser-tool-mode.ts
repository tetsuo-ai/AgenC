import type { Logger } from "../utils/logger.js";

export async function resolveBrowserToolMode(
  logger: Pick<Logger, "debug">,
  loadPlaywright: () => Promise<unknown> = () => import("playwright"),
): Promise<"basic" | "advanced"> {
  try {
    await loadPlaywright();
    return "advanced";
  } catch (error) {
    logger.debug("Playwright unavailable; falling back to basic browser tools", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "basic";
  }
}
