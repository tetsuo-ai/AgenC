import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENC_COORDINATION_IDL } from "@tetsuo-ai/protocol";

export type { AgencCoordination } from "@tetsuo-ai/protocol";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_TARGET_IDL_PATH = path.resolve(
  REPO_ROOT,
  "target",
  "idl",
  "agenc_coordination.json",
);

/**
 * Returns the canonical published protocol IDL by default.
 *
 * For local unreleased protocol development inside the monorepo, tests may set
 * `AGENC_USE_LOCAL_PROTOCOL_TARGET=1` to validate against a fresh local Anchor
 * build instead of the latest published protocol package.
 */
export function loadProtocolIdl(options?: {
  preferLocalTarget?: boolean;
}): typeof AGENC_COORDINATION_IDL {
  const preferLocalTarget =
    options?.preferLocalTarget ??
    process.env.AGENC_USE_LOCAL_PROTOCOL_TARGET === "1";

  if (!preferLocalTarget) {
    return AGENC_COORDINATION_IDL;
  }

  try {
    return JSON.parse(
      readFileSync(LOCAL_TARGET_IDL_PATH, "utf8"),
    ) as typeof AGENC_COORDINATION_IDL;
  } catch (error) {
    throw new Error(
      `AGENC_USE_LOCAL_PROTOCOL_TARGET=1 was set, but ${LOCAL_TARGET_IDL_PATH} is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
