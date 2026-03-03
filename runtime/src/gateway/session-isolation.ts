/**
 * Session isolation manager — produces fully isolated runtime contexts
 * per workspace, each with dedicated memory, policy, tools, LLM, and auth.
 *
 * Gateway integration (wiring into Gateway.start() / message handling)
 * is deferred to Phase 7 routing issues.
 *
 * @module
 */

import type { Keypair, PublicKey } from "@solana/web3.js";
import type { MemoryBackend } from "../memory/types.js";
import { InMemoryBackend } from "../memory/in-memory/backend.js";
import { PolicyEngine } from "../policy/engine.js";
import type { RuntimePolicyConfig } from "../policy/types.js";
import { ToolRegistry } from "../tools/registry.js";
import type { Tool } from "../tools/types.js";
import type {
  LLMProvider,
  LLMResponse,
  LLMMessage,
  LLMChatOptions,
  StreamProgressCallback,
} from "../llm/types.js";
import type { MarkdownSkill } from "../skills/markdown/types.js";
import type { AgentWorkspace } from "./workspace.js";
import type { WorkspaceManager } from "./workspace.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";

// ============================================================================
// Types
// ============================================================================

export interface AuthState {
  readonly authenticated: boolean;
  readonly permissions: ReadonlySet<string>;
  readonly walletAddress?: PublicKey;
}

export interface IsolatedSessionContext {
  readonly workspaceId: string;
  readonly memoryBackend: MemoryBackend;
  readonly policyEngine: PolicyEngine;
  readonly toolRegistry: ToolRegistry;
  readonly llmProvider: LLMProvider;
  readonly skills: readonly MarkdownSkill[];
  readonly authState: AuthState;
  readonly keypair?: Keypair;
}

export interface SessionContextIdentity {
  readonly workspaceId: string;
  readonly parentSessionId?: string;
  readonly subagentSessionId?: string;
}

export interface SubAgentSessionIdentity extends SessionContextIdentity {
  readonly parentSessionId: string;
  readonly subagentSessionId: string;
}

type SessionContextRef = string | SessionContextIdentity;

export interface SessionIsolationManagerConfig {
  readonly workspaceManager: WorkspaceManager;
  readonly createMemoryBackend?: (workspace: AgentWorkspace) => MemoryBackend;
  readonly createPolicyEngine?: (workspace: AgentWorkspace) => PolicyEngine;
  readonly createLLMProvider?: (workspace: AgentWorkspace) => LLMProvider;
  readonly defaultLLMProvider?: LLMProvider;
  readonly defaultTools?: readonly Tool[];
  readonly defaultSkills?: readonly MarkdownSkill[];
  readonly resolveSkills?: (
    names: readonly string[],
  ) => Promise<readonly MarkdownSkill[]>;
  readonly resolveKeypair?: (workspaceId: string) => Keypair | undefined;
  readonly resolveAuth?: (workspace: AgentWorkspace) => AuthState;
  readonly logger?: Logger;
}

// ============================================================================
// NoopLLMProvider (internal — not exported)
// ============================================================================

class NoopLLMProvider implements LLMProvider {
  readonly name = "noop";
  private readonly workspaceId: string;

  constructor(workspaceId: string) {
    this.workspaceId = workspaceId;
  }

  async chat(
    _messages: LLMMessage[],
    _options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    throw new Error(
      `No LLM provider configured for workspace '${this.workspaceId}'`,
    );
  }

  async chatStream(
    _messages: LLMMessage[],
    _onChunk: StreamProgressCallback,
    _options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    throw new Error(
      `No LLM provider configured for workspace '${this.workspaceId}'`,
    );
  }

  async healthCheck(): Promise<boolean> {
    return false;
  }
}

function normalizeContextIdentity(
  context: SessionContextRef,
): SessionContextIdentity {
  if (typeof context === "string") {
    return { workspaceId: context };
  }
  return context;
}

function contextIdentityKey(context: SessionContextIdentity): string {
  if (!context.parentSessionId && !context.subagentSessionId) {
    return context.workspaceId;
  }
  return [
    `workspace=${context.workspaceId}`,
    `parent=${context.parentSessionId ?? "-"}`,
    `subagent=${context.subagentSessionId ?? "-"}`,
  ].join("|");
}

// ============================================================================
// SessionIsolationManager
// ============================================================================

export class SessionIsolationManager {
  private readonly contexts = new Map<string, IsolatedSessionContext>();
  private readonly pending = new Map<string, Promise<IsolatedSessionContext>>();
  private readonly config: SessionIsolationManagerConfig;
  private readonly logger: Logger;

  constructor(config: SessionIsolationManagerConfig) {
    this.config = config;
    this.logger = config.logger ?? silentLogger;
  }

  async getContext(context: SessionContextRef): Promise<IsolatedSessionContext> {
    const normalized = normalizeContextIdentity(context);
    const cacheKey = contextIdentityKey(normalized);

    const cached = this.contexts.get(cacheKey);
    if (cached) return cached;

    const inflight = this.pending.get(cacheKey);
    if (inflight) return inflight;

    const promise = this.createContext(normalized, cacheKey).finally(() => {
      this.pending.delete(cacheKey);
    });
    this.pending.set(cacheKey, promise);
    return promise;
  }

  async destroyContext(context: SessionContextRef): Promise<void> {
    const normalized = normalizeContextIdentity(context);
    const cacheKey = contextIdentityKey(normalized);
    const ctx = this.contexts.get(cacheKey);
    if (!ctx) return;

    await ctx.memoryBackend.close();
    this.contexts.delete(cacheKey);
    this.logger.info(
      `Session context destroyed for workspace '${normalized.workspaceId}' (${cacheKey})`,
    );
  }

  listActiveContexts(): string[] {
    return Array.from(this.contexts.keys());
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private async createContext(
    contextIdentity: SessionContextIdentity,
    cacheKey: string,
  ): Promise<IsolatedSessionContext> {
    const workspaceId = contextIdentity.workspaceId;
    const workspace = await this.config.workspaceManager.load(workspaceId);

    const memoryBackend = this.createMemory(workspace);
    const policyEngine = this.createPolicy(workspace);
    const toolRegistry = this.createTools(workspace, policyEngine);
    const llmProvider = this.createLLM(workspace);
    const skills = await this.resolveSkills(workspace);
    const keypair = this.config.resolveKeypair?.(workspaceId);
    const authState = this.resolveAuth(workspace, keypair);

    const ctx: IsolatedSessionContext = {
      workspaceId,
      memoryBackend,
      policyEngine,
      toolRegistry,
      llmProvider,
      skills,
      authState,
      keypair,
    };

    this.contexts.set(cacheKey, ctx);
    this.logger.info(
      `Session context created for workspace '${workspaceId}' (${cacheKey})`,
    );
    return ctx;
  }

  private createMemory(workspace: AgentWorkspace): MemoryBackend {
    if (this.config.createMemoryBackend) {
      return this.config.createMemoryBackend(workspace);
    }
    return new InMemoryBackend();
  }

  private createPolicy(workspace: AgentWorkspace): PolicyEngine {
    if (this.config.createPolicyEngine) {
      return this.config.createPolicyEngine(workspace);
    }

    const engine = new PolicyEngine({ logger: this.logger });

    if (workspace.toolPermissions?.length) {
      const allowList: string[] = [];
      const denyList: string[] = [];
      for (const perm of workspace.toolPermissions) {
        (perm.allow ? allowList : denyList).push(perm.tool);
      }
      const policyConfig: RuntimePolicyConfig = { enabled: true };
      if (allowList.length > 0) policyConfig.toolAllowList = allowList;
      if (denyList.length > 0) policyConfig.toolDenyList = denyList;
      engine.setPolicy(policyConfig);
    }

    return engine;
  }

  private createTools(
    workspace: AgentWorkspace,
    policyEngine: PolicyEngine,
  ): ToolRegistry {
    const registry = new ToolRegistry({ logger: this.logger, policyEngine });

    if (this.config.defaultTools) {
      const denied = new Set(
        (workspace.toolPermissions ?? [])
          .filter((p) => !p.allow)
          .map((p) => p.tool),
      );
      const allowed = this.config.defaultTools.filter(
        (t) => !denied.has(t.name),
      );
      registry.registerAll(allowed);
    }

    return registry;
  }

  private createLLM(workspace: AgentWorkspace): LLMProvider {
    if (this.config.createLLMProvider) {
      return this.config.createLLMProvider(workspace);
    }
    if (this.config.defaultLLMProvider) {
      return this.config.defaultLLMProvider;
    }
    return new NoopLLMProvider(workspace.id);
  }

  private async resolveSkills(
    workspace: AgentWorkspace,
  ): Promise<readonly MarkdownSkill[]> {
    if (workspace.skills.length > 0 && this.config.resolveSkills) {
      return this.config.resolveSkills(workspace.skills);
    }
    return this.config.defaultSkills ?? [];
  }

  private resolveAuth(workspace: AgentWorkspace, keypair?: Keypair): AuthState {
    if (this.config.resolveAuth) {
      return this.config.resolveAuth(workspace);
    }
    return {
      authenticated: false,
      permissions: new Set(),
      walletAddress: keypair?.publicKey,
    };
  }
}
