import { createHash } from "node:crypto";
import type { MemoryBackend } from "../../memory/types.js";
import type { Logger } from "../../utils/logger.js";
import { silentLogger } from "../../utils/logger.js";
import { KeyedAsyncQueue } from "../../utils/keyed-async-queue.js";

const WEBCHAT_SESSION_KEY_PREFIX = "webchat:session:";
const WEBCHAT_OWNER_INDEX_KEY_PREFIX = "webchat:owner:";

export interface PersistedWebChatSession {
  readonly version: 1;
  readonly sessionId: string;
  readonly ownerKey: string;
  readonly label: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastActiveAt: number;
  readonly messageCount: number;
  readonly metadata?: PersistedWebChatSessionMetadata;
}

export interface PersistedWebChatPolicyContext {
  readonly tenantId?: string;
  readonly projectId?: string;
}

export interface PersistedWebChatSessionMetadata {
  readonly policyContext?: PersistedWebChatPolicyContext;
}

export interface WebChatSessionStoreConfig {
  readonly memoryBackend: MemoryBackend;
  readonly logger?: Logger;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sessionKey(sessionId: string): string {
  return `${WEBCHAT_SESSION_KEY_PREFIX}${sessionId}`;
}

function ownerIndexKey(ownerKey: string): string {
  const ownerHash = createHash("sha256").update(ownerKey).digest("hex");
  return `${WEBCHAT_OWNER_INDEX_KEY_PREFIX}${ownerHash}`;
}

function coerceSession(value: unknown): PersistedWebChatSession | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (
    raw.version !== 1 ||
    typeof raw.sessionId !== "string" ||
    typeof raw.ownerKey !== "string" ||
    typeof raw.label !== "string" ||
    typeof raw.createdAt !== "number" ||
    typeof raw.updatedAt !== "number" ||
    typeof raw.lastActiveAt !== "number" ||
    typeof raw.messageCount !== "number"
  ) {
    return undefined;
  }
  return {
    version: 1,
    sessionId: raw.sessionId,
    ownerKey: raw.ownerKey,
    label: raw.label,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    lastActiveAt: raw.lastActiveAt,
    messageCount: raw.messageCount,
    ...(coerceSessionMetadata(raw.metadata)
      ? { metadata: coerceSessionMetadata(raw.metadata) }
      : {}),
  };
}

function coercePolicyContext(
  value: unknown,
): PersistedWebChatPolicyContext | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const tenantId =
    typeof raw.tenantId === "string" && raw.tenantId.trim().length > 0
      ? raw.tenantId.trim()
      : undefined;
  const projectId =
    typeof raw.projectId === "string" && raw.projectId.trim().length > 0
      ? raw.projectId.trim()
      : undefined;
  if (!tenantId && !projectId) {
    return undefined;
  }
  return {
    ...(tenantId ? { tenantId } : {}),
    ...(projectId ? { projectId } : {}),
  };
}

function coerceSessionMetadata(
  value: unknown,
): PersistedWebChatSessionMetadata | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const policyContext = coercePolicyContext(raw.policyContext);
  if (!policyContext) {
    return undefined;
  }
  return { policyContext };
}

function mergeSessionMetadata(
  current: PersistedWebChatSessionMetadata | undefined,
  update: PersistedWebChatSessionMetadata | undefined,
): PersistedWebChatSessionMetadata | undefined {
  if (!current && !update) return undefined;
  const nextPolicyContext = update?.policyContext
    ? {
        ...(current?.policyContext ?? {}),
        ...update.policyContext,
      }
    : current?.policyContext;
  if (!nextPolicyContext) {
    return undefined;
  }
  return {
    policyContext: nextPolicyContext,
  };
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function buildLabel(
  current: PersistedWebChatSession | undefined,
  sender: "user" | "agent",
  content: string,
): string {
  if (current && current.label.trim().length > 0) {
    return current.label;
  }
  if (sender !== "user") {
    return "New conversation";
  }
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length > 0 ? compact.slice(0, 80) : "New conversation";
}

export class WebChatSessionStore {
  private readonly memoryBackend: MemoryBackend;
  private readonly logger: Logger;
  private readonly queue: KeyedAsyncQueue;

  constructor(config: WebChatSessionStoreConfig) {
    this.memoryBackend = config.memoryBackend;
    this.logger = config.logger ?? silentLogger;
    this.queue = new KeyedAsyncQueue({
      logger: this.logger,
      label: "WebChat session store",
    });
  }

  async loadSession(
    sessionId: string,
  ): Promise<PersistedWebChatSession | undefined> {
    const value = await this.memoryBackend.get(sessionKey(sessionId));
    return coerceSession(value);
  }

  async ensureSession(params: {
    sessionId: string;
    ownerKey: string;
    createdAt?: number;
    metadata?: PersistedWebChatSessionMetadata;
  }): Promise<PersistedWebChatSession> {
    const createdAt = params.createdAt ?? Date.now();
    return this.queue.run(params.sessionId, async () => {
      const existing = await this.loadSession(params.sessionId);
      if (existing) {
        if (existing.ownerKey !== params.ownerKey) {
          throw new Error("Session owner mismatch");
        }
        if (!params.metadata) {
          return existing;
        }
        const next: PersistedWebChatSession = {
          ...existing,
          metadata: mergeSessionMetadata(existing.metadata, params.metadata),
          updatedAt: createdAt,
        };
        await this.writeSession(next);
        return next;
      }

      const next: PersistedWebChatSession = {
        version: 1,
        sessionId: params.sessionId,
        ownerKey: params.ownerKey,
        label: "New conversation",
        createdAt,
        updatedAt: createdAt,
        lastActiveAt: createdAt,
        messageCount: 0,
        ...(params.metadata ? { metadata: params.metadata } : {}),
      };

      await this.writeSession(next);
      await this.addOwnerIndex(params.ownerKey, params.sessionId);
      return next;
    });
  }

  async recordActivity(params: {
    sessionId: string;
    ownerKey: string;
    sender: "user" | "agent";
    content: string;
    timestamp?: number;
    metadata?: PersistedWebChatSessionMetadata;
  }): Promise<PersistedWebChatSession> {
    const timestamp = params.timestamp ?? Date.now();
    return this.queue.run(params.sessionId, async () => {
      const current = await this.loadSession(params.sessionId);
      const ownerKey = current?.ownerKey ?? params.ownerKey;
      if (current && current.ownerKey !== params.ownerKey) {
        throw new Error("Session owner mismatch");
      }

      const next: PersistedWebChatSession = {
        version: 1,
        sessionId: params.sessionId,
        ownerKey,
        label: buildLabel(current, params.sender, params.content),
        createdAt: current?.createdAt ?? timestamp,
        updatedAt: timestamp,
        lastActiveAt: timestamp,
        messageCount: (current?.messageCount ?? 0) + 1,
        ...(mergeSessionMetadata(current?.metadata, params.metadata)
          ? {
              metadata: mergeSessionMetadata(
                current?.metadata,
                params.metadata,
              ),
            }
          : {}),
      };

      await this.writeSession(next);
      await this.addOwnerIndex(ownerKey, params.sessionId);
      return next;
    });
  }

  async listSessionsForOwner(
    ownerKey: string,
  ): Promise<readonly PersistedWebChatSession[]> {
    const ids = normalizeStringArray(
      await this.memoryBackend.get(ownerIndexKey(ownerKey)),
    );
    const sessions = await Promise.all(ids.map((id) => this.loadSession(id)));
    return sessions.filter(
      (session): session is PersistedWebChatSession =>
        session !== undefined && session.ownerKey === ownerKey,
    );
  }

  private async writeSession(session: PersistedWebChatSession): Promise<void> {
    await this.memoryBackend.set(sessionKey(session.sessionId), cloneJson(session));
  }

  private async addOwnerIndex(
    ownerKey: string,
    sessionId: string,
  ): Promise<void> {
    const key = ownerIndexKey(ownerKey);
    const current = normalizeStringArray(await this.memoryBackend.get(key));
    if (current.includes(sessionId)) return;
    current.push(sessionId);
    await this.memoryBackend.set(key, current);
  }
}
