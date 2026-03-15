import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve as resolvePath } from "node:path";
import type { GatewayConfig } from "./types.js";

const SENSITIVE_SESSION_ROOT_RELATIVE_PATHS = Object.freeze([
  ".ssh",
  ".gnupg",
  ".config",
  ".config/solana",
  ".aws",
  ".kube",
  ".local/share/keyrings",
]);

function expandHomeDirectory(rawPath: string): string {
  if (
    rawPath === "~" ||
    rawPath.startsWith("~/") ||
    rawPath.startsWith("~\\")
  ) {
    const homePath = homedir();
    if (!homePath || homePath.trim().length === 0) {
      return rawPath;
    }
    if (rawPath === "~") {
      return homePath;
    }
    return resolvePath(homePath, rawPath.slice(2));
  }
  return rawPath;
}

function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  const rel = relative(rootPath, candidatePath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function canonicalizeExistingDirectory(rawPath: string): string | null {
  try {
    const canonicalPath = realpathSync.native(rawPath);
    const stats = lstatSync(canonicalPath);
    if (!stats.isDirectory()) {
      return null;
    }
    return canonicalPath;
  } catch {
    return null;
  }
}

function resolveConfiguredHostPath(
  configuredPath: string,
  configPath: string,
): string {
  const trimmed = configuredPath.trim();
  const resolved = resolvePath(dirname(configPath), trimmed);
  if (resolved === "/") {
    throw new Error("workspace.hostPath must not resolve to the filesystem root");
  }
  return resolved;
}

export function resolveHostWorkspacePath(params: {
  config: GatewayConfig;
  configPath: string;
  daemonCwd?: string;
}): string {
  const configuredPath = params.config.workspace?.hostPath;
  if (typeof configuredPath === "string" && configuredPath.trim().length > 0) {
    return resolveConfiguredHostPath(configuredPath, params.configPath);
  }
  return resolvePath(params.daemonCwd ?? process.cwd());
}

export function buildAllowedFilesystemPaths(params: {
  hostWorkspacePath: string;
  homePath?: string;
}): string[] {
  const homePath = params.homePath ?? homedir();
  const allowedPaths = [
    resolvePath(homePath, ".agenc", "workspace"),
    resolvePath(homePath, "Desktop"),
    "/tmp",
  ];
  const hostWorkspacePath = resolvePath(params.hostWorkspacePath);
  if (hostWorkspacePath !== "/" && !allowedPaths.includes(hostWorkspacePath)) {
    allowedPaths.push(hostWorkspacePath);
  }
  return allowedPaths;
}

export function resolveSessionWorkspaceRoot(
  candidatePath: unknown,
  params: {
    homePath?: string;
  } = {},
): string | null {
  if (typeof candidatePath !== "string" || candidatePath.trim().length === 0) {
    return null;
  }
  const expanded = expandHomeDirectory(candidatePath.trim());
  if (!isAbsolute(expanded)) {
    return null;
  }

  const resolved = resolvePath(expanded);
  if (resolved === "/") {
    return null;
  }
  const canonicalWorkspaceRoot = canonicalizeExistingDirectory(resolved);
  if (!canonicalWorkspaceRoot) {
    return null;
  }

  const homePath = resolvePath(params.homePath ?? homedir());
  const sensitiveRoots = SENSITIVE_SESSION_ROOT_RELATIVE_PATHS.map((entry) =>
    canonicalizeExistingDirectory(resolvePath(homePath, entry)) ??
    resolvePath(homePath, entry),
  );
  for (const sensitiveRoot of sensitiveRoots) {
    if (
      isWithinRoot(sensitiveRoot, canonicalWorkspaceRoot) ||
      isWithinRoot(canonicalWorkspaceRoot, sensitiveRoot)
    ) {
      return null;
    }
  }

  return canonicalWorkspaceRoot;
}
