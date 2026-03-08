import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";
import { resolvePolicyContext } from "./bundles.js";
import type {
  PolicyEvaluationScope,
  RuntimePolicyConfig,
  RuntimeSessionCredentialConfig,
} from "./types.js";

const DEFAULT_CREDENTIAL_TTL_MS = 300_000;

type CredentialTarget =
  | {
      toolName: "system.httpGet" | "system.httpPost" | "system.httpFetch";
      url: string;
    };

interface ResolvedCredentialMatch {
  readonly credentialId: string;
  readonly config: RuntimeSessionCredentialConfig;
}

export interface SessionCredentialPreview {
  readonly credentialIds: readonly string[];
  readonly headerNames: readonly string[];
  readonly domains: readonly string[];
}

export interface SessionCredentialLease {
  readonly sessionId: string;
  readonly credentialId: string;
  readonly sourceEnvVar: string;
  readonly domains: readonly string[];
  readonly allowedTools: readonly string[];
  readonly issuedAt: number;
  readonly expiresAt: number;
  revokedAt?: number;
}

export interface PreparedSessionCredentialInjection {
  readonly sessionId: string;
  readonly toolName: string;
  readonly url: string;
  readonly preview: SessionCredentialPreview;
  readonly matches: readonly ResolvedCredentialMatch[];
}

export type SessionCredentialPreparationResult =
  | {
      ok: true;
      prepared?: PreparedSessionCredentialInjection;
    }
  | {
      ok: false;
      error: string;
    };

export type SessionCredentialInjectionResult =
  | {
      ok: true;
      args: Record<string, unknown>;
      leases: readonly SessionCredentialLease[];
    }
  | {
      ok: false;
      error: string;
    };

export interface SessionCredentialLeaseEvent {
  readonly sessionId: string;
  readonly credentialId: string;
  readonly scope?: PolicyEvaluationScope;
  readonly lease: SessionCredentialLease;
}

export interface SessionCredentialRevokeEvent {
  readonly sessionId: string;
  readonly credentialId: string;
  readonly scope?: PolicyEvaluationScope;
  readonly lease: SessionCredentialLease;
  readonly reason: "session_reset" | "manual" | "shutdown" | "expired";
}

export interface SessionCredentialBrokerConfig {
  readonly policy: RuntimePolicyConfig;
  readonly logger?: Logger;
  readonly now?: () => number;
  readonly onLeaseIssued?: (
    event: SessionCredentialLeaseEvent,
  ) => void | Promise<void>;
  readonly onLeaseRevoked?: (
    event: SessionCredentialRevokeEvent,
  ) => void | Promise<void>;
}

function asNonEmptyStringArray(value: readonly string[] | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.map((entry) => entry.trim()).filter(Boolean))];
}

function matchDomain(hostname: string, pattern: string): boolean {
  const lower = hostname.toLowerCase();
  const normalizedPattern = pattern.trim().toLowerCase();
  if (!normalizedPattern) return false;
  if (normalizedPattern.startsWith("*.")) {
    const suffix = normalizedPattern.slice(1);
    return lower.endsWith(suffix) && lower.length > suffix.length;
  }
  return lower === normalizedPattern;
}

function defaultHeaderTemplates(): Record<string, string> {
  return { Authorization: "Bearer ${secret}" };
}

function normalizeHeaderTemplates(
  value: Record<string, string> | undefined,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  const source = value ?? defaultHeaderTemplates();
  for (const [key, template] of Object.entries(source)) {
    const headerName = key.trim();
    if (!headerName) continue;
    normalized[headerName] = template;
  }
  return normalized;
}

function extractCredentialTarget(
  toolName: string,
  args: Record<string, unknown>,
): CredentialTarget | undefined {
  if (
    toolName !== "system.httpGet" &&
    toolName !== "system.httpPost" &&
    toolName !== "system.httpFetch"
  ) {
    return undefined;
  }
  const url = typeof args.url === "string" ? args.url.trim() : "";
  if (!url) {
    return undefined;
  }
  return { toolName, url };
}

function formatCredentialError(
  credentialId: string,
  sourceEnvVar: string,
): string {
  return (
    `Session credential "${credentialId}" is unavailable because ` +
    `env.${sourceEnvVar} is not set.`
  );
}

export class SessionCredentialBroker {
  private readonly policy: RuntimePolicyConfig;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly onLeaseIssued;
  private readonly onLeaseRevoked;
  private readonly leases = new Map<string, SessionCredentialLease>();

  constructor(config: SessionCredentialBrokerConfig) {
    this.policy = config.policy;
    this.logger = config.logger ?? silentLogger;
    this.now = config.now ?? Date.now;
    this.onLeaseIssued = config.onLeaseIssued;
    this.onLeaseRevoked = config.onLeaseRevoked;
  }

  prepare(params: {
    sessionId: string;
    toolName: string;
    args: Record<string, unknown>;
    scope?: PolicyEvaluationScope;
  }): SessionCredentialPreparationResult {
    const target = extractCredentialTarget(params.toolName, params.args);
    if (!target) {
      return { ok: true };
    }

    let parsed: URL;
    try {
      parsed = new URL(target.url);
    } catch {
      return { ok: true };
    }

    const resolved = resolvePolicyContext(this.policy, params.scope);
    const credentialIds = asNonEmptyStringArray(
      resolved.policy.credentialAllowList,
    );
    if (credentialIds.length === 0) {
      return { ok: true };
    }

    const matches: ResolvedCredentialMatch[] = [];
    const headerNames = new Set<string>();
    const domains = new Set<string>();

    for (const credentialId of credentialIds) {
      const credential = this.policy.credentialCatalog?.[credentialId];
      if (!credential) {
        return {
          ok: false,
          error:
            `Session credential "${credentialId}" is referenced by policy but ` +
            "missing from policy.credentialCatalog.",
        };
      }
      const allowedTools = asNonEmptyStringArray(credential.allowedTools);
      if (
        allowedTools.length > 0 &&
        !allowedTools.includes(params.toolName)
      ) {
        continue;
      }
      const configuredDomains = asNonEmptyStringArray(credential.domains);
      if (
        configuredDomains.length === 0 ||
        !configuredDomains.some((pattern) =>
          matchDomain(parsed.hostname, pattern),
        )
      ) {
        continue;
      }
      if (
        typeof process.env[credential.sourceEnvVar] !== "string" ||
        process.env[credential.sourceEnvVar]!.trim().length === 0
      ) {
        return {
          ok: false,
          error: formatCredentialError(credentialId, credential.sourceEnvVar),
        };
      }
      matches.push({ credentialId, config: credential });
      configuredDomains.forEach((pattern) => domains.add(pattern));
      Object.keys(normalizeHeaderTemplates(credential.headerTemplates)).forEach(
        (headerName) => headerNames.add(headerName),
      );
    }

    if (matches.length === 0) {
      return { ok: true };
    }

    return {
      ok: true,
      prepared: {
        sessionId: params.sessionId,
        toolName: params.toolName,
        url: target.url,
        preview: {
          credentialIds: matches.map((match) => match.credentialId),
          headerNames: [...headerNames],
          domains: [...domains],
        },
        matches,
      },
    };
  }

  inject(params: {
    prepared: PreparedSessionCredentialInjection;
    args: Record<string, unknown>;
    scope?: PolicyEvaluationScope;
  }): SessionCredentialInjectionResult {
    const mergedHeaders: Record<string, string> = {
      ...(
        params.args.headers &&
        typeof params.args.headers === "object" &&
        !Array.isArray(params.args.headers)
          ? (params.args.headers as Record<string, string>)
          : {}
      ),
    };
    const leases: SessionCredentialLease[] = [];

    for (const match of params.prepared.matches) {
      const secret = process.env[match.config.sourceEnvVar];
      if (typeof secret !== "string" || secret.trim().length === 0) {
        return {
          ok: false,
          error: formatCredentialError(
            match.credentialId,
            match.config.sourceEnvVar,
          ),
        };
      }
      const lease = this.issueLease({
        sessionId: params.prepared.sessionId,
        credentialId: match.credentialId,
        config: match.config,
        scope: params.scope,
      });
      const headerTemplates = normalizeHeaderTemplates(
        match.config.headerTemplates,
      );
      for (const [headerName, template] of Object.entries(headerTemplates)) {
        mergedHeaders[headerName] = template.replaceAll("${secret}", secret);
      }
      leases.push(lease);
    }

    return {
      ok: true,
      args: { ...params.args, headers: mergedHeaders },
      leases,
    };
  }

  listLeases(sessionId: string): SessionCredentialLease[] {
    this.pruneExpiredLeases();
    return [...this.leases.values()]
      .filter((lease) => lease.sessionId === sessionId && lease.revokedAt === undefined)
      .map((lease) => ({ ...lease }));
  }

  async revoke(params: {
    sessionId: string;
    credentialId?: string;
    scope?: PolicyEvaluationScope;
    reason?: "session_reset" | "manual" | "shutdown";
  }): Promise<number> {
    const reason = params.reason ?? "manual";
    let revoked = 0;
    for (const [key, lease] of this.leases.entries()) {
      if (lease.sessionId !== params.sessionId) continue;
      if (params.credentialId && lease.credentialId !== params.credentialId) {
        continue;
      }
      if (lease.revokedAt !== undefined) continue;
      const revokedLease = {
        ...lease,
        revokedAt: this.now(),
      };
      this.leases.set(key, revokedLease);
      revoked += 1;
      await this.onLeaseRevoked?.({
        sessionId: params.sessionId,
        credentialId: revokedLease.credentialId,
        scope: params.scope,
        lease: revokedLease,
        reason,
      });
    }
    return revoked;
  }

  async revokeAll(reason: "shutdown" | "session_reset" = "shutdown"): Promise<void> {
    const activeLeases = [...this.leases.values()].filter(
      (lease) => lease.revokedAt === undefined,
    );
    for (const lease of activeLeases) {
      await this.revoke({
        sessionId: lease.sessionId,
        credentialId: lease.credentialId,
        reason,
      });
    }
  }

  private issueLease(params: {
    sessionId: string;
    credentialId: string;
    config: RuntimeSessionCredentialConfig;
    scope?: PolicyEvaluationScope;
  }): SessionCredentialLease {
    const key = `${params.sessionId}:${params.credentialId}`;
    const now = this.now();
    const existing = this.leases.get(key);
    if (
      existing &&
      existing.revokedAt === undefined &&
      existing.expiresAt > now
    ) {
      return existing;
    }

    const lease: SessionCredentialLease = {
      sessionId: params.sessionId,
      credentialId: params.credentialId,
      sourceEnvVar: params.config.sourceEnvVar,
      domains: asNonEmptyStringArray(params.config.domains),
      allowedTools: asNonEmptyStringArray(params.config.allowedTools),
      issuedAt: now,
      expiresAt:
        now +
        Math.max(
          1_000,
          Math.floor(params.config.ttlMs ?? DEFAULT_CREDENTIAL_TTL_MS),
        ),
    };
    this.leases.set(key, lease);
    void this.onLeaseIssued?.({
      sessionId: params.sessionId,
      credentialId: params.credentialId,
      scope: params.scope,
      lease,
    });
    this.logger.info?.("Issued session credential lease", {
      sessionId: params.sessionId,
      credentialId: params.credentialId,
      expiresAt: lease.expiresAt,
    });
    return lease;
  }

  private pruneExpiredLeases(): void {
    const now = this.now();
    for (const [key, lease] of this.leases.entries()) {
      if (lease.revokedAt !== undefined || lease.expiresAt > now) {
        continue;
      }
      const revokedLease = {
        ...lease,
        revokedAt: now,
      };
      this.leases.set(key, revokedLease);
      void this.onLeaseRevoked?.({
        sessionId: revokedLease.sessionId,
        credentialId: revokedLease.credentialId,
        lease: revokedLease,
        reason: "expired",
      });
    }
  }
}
