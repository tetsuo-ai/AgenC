import { homedir } from "node:os";
import { dirname, resolve as resolvePath } from "node:path";
import type { GatewayConfig } from "./types.js";

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
