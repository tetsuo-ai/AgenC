import fs from "node:fs";
import { pathToFileURL } from "node:url";

export function resolveOperatorEventModuleCandidates({
  env = process.env,
} = {}) {
  return [
    typeof env.AGENC_WATCH_OPERATOR_EVENTS_MODULE === "string"
      && env.AGENC_WATCH_OPERATOR_EVENTS_MODULE.trim().length > 0
      ? {
          kind: "path",
          specifier: env.AGENC_WATCH_OPERATOR_EVENTS_MODULE.trim(),
          required: true,
        }
      : null,
    {
      kind: "package",
      specifier: "@tetsuo-ai/runtime/operator-events",
    },
  ];
}

export async function loadOperatorEventHelpers({
  env = process.env,
  existsSync = fs.existsSync,
  importer = async (resolvedPath) => import(pathToFileURL(resolvedPath).href),
  packageImporter = async (specifier) => import(specifier),
} = {}) {
  const candidates = resolveOperatorEventModuleCandidates({ env });
  let lastError = null;

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    try {
      const module =
        candidate.kind === "path"
          ? await (async () => {
              const resolved = candidate.specifier;
              if (!existsSync(resolved)) {
                if (candidate.required) {
                  throw new Error(`Operator event module ${resolved} does not exist`);
                }
                return null;
              }
              return importer(resolved);
            })()
          : await packageImporter(candidate.specifier);
      if (!module) {
        continue;
      }
      if (
        typeof module.normalizeOperatorMessage === "function" &&
        typeof module.shouldIgnoreOperatorMessage === "function" &&
        typeof module.projectOperatorSurfaceEvent === "function"
      ) {
        return module;
      }
      lastError = new Error(
        `Operator event module ${candidate.specifier} is missing required exports`,
      );
      if (candidate.kind === "path" && candidate.required) {
        break;
      }
    } catch (error) {
      lastError = error;
      if (candidate.kind === "path" && candidate.required) {
        break;
      }
    }
  }

  const baseMessage =
    "Unable to resolve operator event contract. Build or install @tetsuo-ai/runtime so the @tetsuo-ai/runtime/operator-events subpath exists, or set AGENC_WATCH_OPERATOR_EVENTS_MODULE to an explicit module path.";
  if (lastError instanceof Error && lastError.message.trim().length > 0) {
    throw new Error(`${baseMessage} Last error: ${lastError.message}`);
  }
  throw new Error(baseMessage);
}
