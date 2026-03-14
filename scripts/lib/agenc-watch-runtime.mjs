import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function resolveOperatorEventModuleCandidates({
  env = process.env,
  baseDir,
  cwd = process.cwd(),
} = {}) {
  return [
    env.AGENC_WATCH_OPERATOR_EVENTS_MODULE,
    baseDir ? path.resolve(baseDir, "..", "runtime", "dist", "operator-events.mjs") : null,
    path.resolve(cwd, "runtime", "dist", "operator-events.mjs"),
    path.resolve(cwd, "dist", "operator-events.mjs"),
  ];
}

export async function loadOperatorEventHelpers({
  env = process.env,
  baseDir,
  cwd = process.cwd(),
  existsSync = fs.existsSync,
  importer = async (resolvedPath) => import(pathToFileURL(resolvedPath).href),
} = {}) {
  const candidates = resolveOperatorEventModuleCandidates({ env, baseDir, cwd });
  let lastError = null;

  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.trim().length === 0) {
      continue;
    }
    const resolved = path.resolve(candidate);
    if (!existsSync(resolved)) {
      continue;
    }
    try {
      const module = await importer(resolved);
      if (
        typeof module.normalizeOperatorMessage === "function" &&
        typeof module.shouldIgnoreOperatorMessage === "function" &&
        typeof module.projectOperatorSurfaceEvent === "function"
      ) {
        return module;
      }
      lastError = new Error(
        `Operator event module at ${resolved} is missing required exports`,
      );
    } catch (error) {
      lastError = error;
    }
  }

  const baseMessage =
    "Unable to resolve operator event contract. Build runtime first with `npm --prefix runtime run build` or set AGENC_WATCH_OPERATOR_EVENTS_MODULE to runtime/dist/operator-events.mjs.";
  if (lastError instanceof Error && lastError.message.trim().length > 0) {
    throw new Error(`${baseMessage} Last error: ${lastError.message}`);
  }
  throw new Error(baseMessage);
}
