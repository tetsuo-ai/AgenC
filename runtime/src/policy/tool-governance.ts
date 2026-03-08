import { isAbsolute, resolve as resolvePath } from "node:path";
import type {
  PolicyAction,
  PolicyAccess,
  PolicyClass,
  PolicyEvaluationScope,
} from "./types.js";

export interface ToolGovernanceClassification {
  readonly access: PolicyAccess;
  readonly policyClass: PolicyClass;
  readonly riskScore: number;
  readonly metadata: Record<string, unknown>;
}

const READ_ACTION_PREFIXES = ["get", "list", "query", "inspect", "read", "status"];

const IRREVERSIBLE_FINANCIAL_RE = /^(wallet\.|agenc\.(?:create|claim|complete|submit|transfer|register|stake|reward)|system\.wallet)/i;
const DESTRUCTIVE_SIDE_EFFECT_RE = /(?:delete|destroy|drop|remove|revoke|terminate|kill|stop|cancel|reset|overwrite|truncate)/i;
const SECRET_ACCESS_RE = /^(system\.bash|desktop\.bash|system\.evaluateJs|system\.sandbox(?:Start|Exec|Stop)|system\.processStart|desktop\.process_start)/i;
const NETWORK_OPEN_WORLD_RE = /^(system\.http|system\.remoteJob|system\.research|system\.server|desktop\.bash|system\.bash|mcp\.)/i;
const PROCESS_MUTATION_RE = /(?:process(?:Start|Stop|Status)?|server(?:Start|Stop|Status)?|sandbox(?:Start|Stop|Exec)?|remoteJob(?:Start|Resume|Cancel)?)/i;
const URL_ARG_KEYS = ["url", "baseUrl"] as const;
const WRITE_PATH_ARG_KEYS = [
  "path",
  "target",
  "destination",
  "dest",
  "outputPath",
  "workspacePath",
  "directory",
  "cwd",
  "workdir",
] as const;

function collectStringValues(
  value: unknown,
  into: Set<string>,
): void {
  if (typeof value === "string" && value.trim().length > 0) {
    into.add(value.trim());
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectStringValues(entry, into);
    }
  }
}

function extractNetworkHosts(args: Record<string, unknown>): string[] | undefined {
  const urls = new Set<string>();
  for (const key of URL_ARG_KEYS) {
    collectStringValues(args[key], urls);
  }
  const hosts = new Set<string>();
  for (const candidate of urls) {
    try {
      hosts.add(new URL(candidate).hostname.toLowerCase());
    } catch {
      // Ignore malformed URLs here; tool validation handles shape-level errors.
    }
  }
  return hosts.size > 0 ? [...hosts] : undefined;
}

function extractWritePaths(args: Record<string, unknown>): string[] | undefined {
  const paths = new Set<string>();
  for (const key of WRITE_PATH_ARG_KEYS) {
    collectStringValues(args[key], paths);
  }
  if (paths.size === 0) {
    return undefined;
  }
  return [...paths].map((entry) =>
    isAbsolute(entry) ? resolvePath(entry) : entry,
  );
}

export function inferToolAccess(toolName: string): PolicyAccess {
  const action = (toolName.split(".").pop() ?? toolName).toLowerCase();
  if (READ_ACTION_PREFIXES.some((prefix) => action.startsWith(prefix))) {
    return "read";
  }
  return "write";
}

export function classifyToolGovernance(
  toolName: string,
  args: Record<string, unknown> = {},
): ToolGovernanceClassification {
  const access = inferToolAccess(toolName);
  const networkHosts = extractNetworkHosts(args);
  const writePaths = extractWritePaths(args);
  const metadata: Record<string, unknown> = {
    args,
    ...(networkHosts ? { networkHosts } : {}),
    ...(writePaths ? { writePaths } : {}),
  };
  if (access === "read") {
    return {
      access,
      policyClass: "read_only",
      riskScore: 0.1,
      metadata,
    };
  }

  if (IRREVERSIBLE_FINANCIAL_RE.test(toolName)) {
    metadata.destructive = true;
    metadata.financial = true;
    return {
      access,
      policyClass: "irreversible_financial_action",
      riskScore: 0.95,
      metadata,
    };
  }

  if (SECRET_ACCESS_RE.test(toolName)) {
    metadata.credentialSurface = true;
    metadata.openWorld = NETWORK_OPEN_WORLD_RE.test(toolName);
    metadata.processMutation = PROCESS_MUTATION_RE.test(toolName);
    return {
      access,
      policyClass: "credential_secret_access",
      riskScore: 0.9,
      metadata,
    };
  }

  if (DESTRUCTIVE_SIDE_EFFECT_RE.test(toolName)) {
    metadata.destructive = true;
    metadata.processMutation = PROCESS_MUTATION_RE.test(toolName);
    return {
      access,
      policyClass: "destructive_side_effect",
      riskScore: 0.75,
      metadata,
    };
  }

  metadata.openWorld = NETWORK_OPEN_WORLD_RE.test(toolName);
  metadata.processMutation = PROCESS_MUTATION_RE.test(toolName);
  return {
    access,
    policyClass: "reversible_side_effect",
    riskScore: metadata.openWorld ? 0.55 : 0.45,
    metadata,
  };
}

export function buildToolPolicyAction(params: {
  toolName: string;
  args?: Record<string, unknown>;
  scope?: PolicyEvaluationScope;
  extraMetadata?: Record<string, unknown>;
}): PolicyAction {
  const classification = classifyToolGovernance(
    params.toolName,
    params.args ?? {},
  );

  return {
    type: "tool_call",
    name: params.toolName,
    access: classification.access,
    policyClass: classification.policyClass,
    riskScore: classification.riskScore,
    scope: params.scope,
    metadata: {
      ...classification.metadata,
      ...(params.extraMetadata ?? {}),
    },
  };
}
