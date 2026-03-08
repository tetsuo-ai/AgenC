import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

import type { ApprovalRule } from "../gateway/approvals.js";
import type {
  GatewayMCPServerConfig,
  GatewayMCPTrustTier,
} from "../gateway/types.js";

export interface MCPToolSchemaDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

export interface MCPToolCatalogPolicyConfig {
  readonly riskControls?: {
    readonly toolAllowList?: readonly string[];
    readonly toolDenyList?: readonly string[];
  };
  readonly supplyChain?: {
    readonly catalogSha256?: string;
  };
}

export interface MCPServerPolicyViolation {
  readonly code:
    | "trust_requires_desktop_container"
    | "pinned_package_required"
    | "desktop_image_digest_required"
    | "binary_integrity_mismatch"
    | "catalog_integrity_mismatch";
  readonly message: string;
}

export interface ValidateMCPServerPolicyOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly desktopImage?: string;
}

function globMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return value === pattern;
  const parts = pattern.split("*");
  let cursor = 0;
  const [first, ...rest] = parts;
  if (!value.startsWith(first ?? "")) {
    return false;
  }
  cursor = (first ?? "").length;
  for (let i = 0; i < rest.length; i += 1) {
    const part = rest[i] ?? "";
    if (part.length === 0) continue;
    if (i === rest.length - 1) {
      return value.slice(cursor).endsWith(part);
    }
    const next = value.indexOf(part, cursor);
    if (next === -1) return false;
    cursor = next + part.length;
  }
  return true;
}

async function resolveExecutablePath(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (isAbsolute(command)) {
    try {
      await access(command, constants.X_OK);
      return command;
    } catch {
      return undefined;
    }
  }
  const pathValue = env.PATH;
  if (!pathValue) return undefined;
  for (const entry of pathValue.split(delimiter)) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const candidate = join(trimmed, command);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }
  return undefined;
}

function usesPinnedPackageSpec(command: string, args: readonly string[]): boolean {
  if (
    command !== "npx" &&
    command !== "pnpm" &&
    command !== "bunx"
  ) {
    return true;
  }
  const normalizedArgs = [...args];
  const packageSpec = normalizedArgs.find(
    (arg) =>
      !arg.startsWith("-") &&
      !arg.startsWith("--") &&
      arg !== "dlx" &&
      arg !== "exec",
  );
  if (!packageSpec) {
    return false;
  }
  if (/@latest$/i.test(packageSpec)) {
    return false;
  }
  const atIndex = packageSpec.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === packageSpec.length - 1) {
    return false;
  }
  const version = packageSpec.slice(atIndex + 1);
  return /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(version);
}

function isDesktopImageDigestPinned(image: string | undefined): boolean {
  return typeof image === "string" && /@sha256:[a-f0-9]{64}$/i.test(image.trim());
}

export function validateMCPServerStaticPolicy(
  server: GatewayMCPServerConfig,
  options: ValidateMCPServerPolicyOptions = {},
): MCPServerPolicyViolation[] {
  const violations: MCPServerPolicyViolation[] = [];
  const trustTier: GatewayMCPTrustTier = server.trustTier ?? "trusted";

  if (trustTier !== "trusted" && server.container !== "desktop") {
    violations.push({
      code: "trust_requires_desktop_container",
      message:
        `MCP server "${server.name}" trust tier "${trustTier}" requires container:"desktop".`,
    });
  }

  if (
    server.supplyChain?.requirePinnedPackageVersion === true &&
    !usesPinnedPackageSpec(server.command, server.args)
  ) {
    violations.push({
      code: "pinned_package_required",
      message:
        `MCP server "${server.name}" must pin an explicit package version; ` +
        `avoid unversioned or @latest package specs.`,
    });
  }

  if (
    server.container === "desktop" &&
    server.supplyChain?.requireDesktopImageDigest === true &&
    !isDesktopImageDigestPinned(options.desktopImage)
  ) {
    violations.push({
      code: "desktop_image_digest_required",
      message:
        `MCP server "${server.name}" requires a digest-pinned desktop image.`,
    });
  }

  return violations;
}

export async function validateMCPServerBinaryIntegrity(params: {
  server: GatewayMCPServerConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<MCPServerPolicyViolation[]> {
  const expectedSha = params.server.supplyChain?.binarySha256?.trim().toLowerCase();
  if (!expectedSha) {
    return [];
  }
  if (!/^[a-f0-9]{64}$/i.test(expectedSha)) {
    return [
      {
        code: "binary_integrity_mismatch",
        message:
          `MCP server "${params.server.name}" has an invalid binarySha256 expectation.`,
      },
    ];
  }
  const env = params.env ?? process.env;
  const executablePath = await resolveExecutablePath(params.server.command, env);
  if (!executablePath) {
    return [
      {
        code: "binary_integrity_mismatch",
        message:
          `Unable to resolve executable for MCP server "${params.server.name}" to verify binary integrity.`,
      },
    ];
  }
  const buffer = await readFile(executablePath);
  const actualSha = createHash("sha256").update(buffer).digest("hex");
  if (actualSha !== expectedSha) {
    return [
      {
        code: "binary_integrity_mismatch",
        message:
          `Executable digest mismatch for MCP server "${params.server.name}".`,
      },
    ];
  }
  return [];
}

export function filterMCPToolCatalog(
  server: MCPToolCatalogPolicyConfig,
  tools: readonly MCPToolSchemaDescriptor[],
): MCPToolSchemaDescriptor[] {
  const allowList = server.riskControls?.toolAllowList;
  const denyList = server.riskControls?.toolDenyList;
  return tools.filter((tool) => {
    const shortName = tool.name;
    if (denyList?.some((pattern) => globMatch(pattern, shortName))) {
      return false;
    }
    if (allowList && allowList.length > 0) {
      return allowList.some((pattern) => globMatch(pattern, shortName));
    }
    return true;
  });
}

export function computeMCPToolCatalogSha256(
  tools: readonly MCPToolSchemaDescriptor[],
): string {
  const canonical = tools
    .map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema ?? null,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
}

export function validateMCPToolCatalogIntegrity(
  server: GatewayMCPServerConfig,
  tools: readonly MCPToolSchemaDescriptor[],
): MCPServerPolicyViolation[] {
  const expectedSha = server.supplyChain?.catalogSha256?.trim().toLowerCase();
  if (!expectedSha) {
    return [];
  }
  const actualSha = computeMCPToolCatalogSha256(tools);
  if (actualSha !== expectedSha) {
    return [
      {
        code: "catalog_integrity_mismatch",
        message:
          `Tool catalog digest mismatch for MCP server "${server.name}".`,
      },
    ];
  }
  return [];
}

export function buildMCPApprovalRules(
  servers: readonly GatewayMCPServerConfig[] | undefined,
): ApprovalRule[] {
  if (!servers || servers.length === 0) {
    return [];
  }
  const rules: ApprovalRule[] = [];
  for (const server of servers) {
    const trustTier: GatewayMCPTrustTier = server.trustTier ?? "trusted";
    const requireApproval =
      server.riskControls?.requireApproval === true || trustTier === "untrusted";
    if (!requireApproval) {
      continue;
    }
    rules.push({
      tool: `mcp.${server.name}.*`,
      description: `MCP tool invocation for ${server.name}`,
      approverGroup: trustTier === "untrusted" ? "security-review" : undefined,
      approverRoles:
        trustTier === "untrusted" ? ["security", "admin"] : undefined,
    });
  }
  return rules;
}
