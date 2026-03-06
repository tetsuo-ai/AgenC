import { realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

export const DEFAULT_TEXT_EDITOR_ALLOWED_ROOTS = [
  "/home/agenc",
  "/tmp",
] as const;

const DEFAULT_TEXT_EDITOR_BASE_DIR = "/home/agenc";

interface TextEditorPathOptions {
  allowedRoots?: readonly string[];
  baseDir?: string;
}

export async function resolveValidatedTextEditorPath(
  inputPath: string,
  options: TextEditorPathOptions = {},
): Promise<string> {
  const allowedRoots =
    options.allowedRoots ?? DEFAULT_TEXT_EDITOR_ALLOWED_ROOTS;
  const candidatePath = resolveInputPath(
    inputPath,
    options.baseDir ?? DEFAULT_TEXT_EDITOR_BASE_DIR,
  );
  const resolvedRoots = await Promise.all(
    allowedRoots.map((root) => resolvePolicyRoot(root)),
  );
  const canonicalCandidate = await resolvePathForContainment(candidatePath);

  if (!resolvedRoots.some((root) => isPathWithinRoot(canonicalCandidate, root))) {
    throw new Error(
      `Access denied: path must be under ${allowedRoots.join(" or ")}`,
    );
  }

  return canonicalCandidate;
}

function resolveInputPath(inputPath: string, baseDir: string): string {
  return inputPath.startsWith("/")
    ? resolve(inputPath)
    : resolve(baseDir, inputPath);
}

async function resolvePolicyRoot(root: string): Promise<string> {
  try {
    return await realpath(root);
  } catch (error) {
    if (isPathMissingError(error)) {
      return resolve(root);
    }
    throw error;
  }
}

async function resolvePathForContainment(candidatePath: string): Promise<string> {
  try {
    return await realpath(candidatePath);
  } catch (error) {
    if (!isPathMissingError(error)) {
      throw error;
    }
  }

  const { path: ancestorPath, realPath: ancestorRealPath } =
    await findNearestExistingAncestor(candidatePath);

  return resolve(ancestorRealPath, relative(ancestorPath, candidatePath));
}

async function findNearestExistingAncestor(
  candidatePath: string,
): Promise<{ path: string; realPath: string }> {
  let currentPath = dirname(candidatePath);

  while (true) {
    try {
      return { path: currentPath, realPath: await realpath(currentPath) };
    } catch (error) {
      if (!isPathMissingError(error)) {
        throw error;
      }
    }

    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) {
      throw new Error(`Failed to resolve a safe parent directory for ${candidatePath}`);
    }
    currentPath = parentPath;
  }
}

function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  return (
    candidatePath === rootPath ||
    candidatePath.startsWith(`${rootPath}${sep}`)
  );
}

function isPathMissingError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
