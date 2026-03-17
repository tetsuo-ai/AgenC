/**
 * Feature wiring for the daemon: marketplace, social, and autonomous features.
 *
 * Extracted from daemon.ts to reduce file size.
 *
 * @module
 */

import type { Logger } from "../utils/logger.js";
import { toErrorMessage } from "../utils/async.js";
import type { GatewayConfig } from "./types.js";
import type { MemoryBackend } from "../memory/types.js";
import type { ChannelPlugin } from "./channel.js";
import type { ChatExecutor } from "../llm/chat-executor.js";
import type { ToolHandler, LLMProvider } from "../llm/types.js";
import type { Tool } from "../tools/types.js";
import { loadWallet } from "./wallet-loader.js";
import { WorkspaceLoader } from "./workspace-files.js";
import { deriveCuriosityInterestsFromWorkspaceFiles } from "../autonomous/curiosity-interests.js";
import {
  resolveTraceLoggingConfig,
} from "./daemon-trace.js";

// ============================================================================
// Context bag for feature wiring
// ============================================================================

export interface FeatureWiringContext {
  readonly logger: Logger;
  // Connection
  connectionManager: import("../connection/manager.js").ConnectionManager | null;
  // Marketplace
  marketplace: import("../marketplace/service-marketplace.js").ServiceMarketplace | null;
  // Social
  agentDiscovery: import("../social/discovery.js").AgentDiscovery | null;
  agentMessaging: import("../social/messaging.js").AgentMessaging | null;
  agentMessagingUnsubscribe: (() => void) | null;
  agentFeed: import("../social/feed.js").AgentFeed | null;
  reputationScorer: import("../social/reputation.js").ReputationScorer | null;
  collaborationProtocol: import("../social/collaboration.js").CollaborationProtocol | null;
  // Autonomous
  chatExecutor: ChatExecutor | null;
  memoryBackend: MemoryBackend | null;
  baseToolHandler: ToolHandler | null;
  approvalEngine: import("./approvals.js").ApprovalEngine | null;
  proactiveCommunicator: import("./proactive.js").ProactiveCommunicator | null;
  heartbeatScheduler: import("./heartbeat.js").HeartbeatScheduler | null;
  cronScheduler: import("./scheduler.js").CronScheduler | null;
  goalManager: import("../autonomous/goal-manager.js").GoalManager | null;
  desktopExecutor: import("../autonomous/desktop-executor.js").DesktopExecutor | null;
  mcpManager: import("../mcp-client/manager.js").MCPManager | null;
  // External channels for ProactiveCommunicator
  externalChannels: Map<string, ChannelPlugin>;
  // Gateway config
  gatewayLogging: GatewayConfig["logging"];
  // Workspace
  resolveActiveHostWorkspacePath: (config: GatewayConfig) => string;
  // LLM providers
  llmProviders: LLMProvider[];
  // Social message handler
  handleIncomingSocialMessage?: (message: import("../social/messaging-types.js").AgentMessage) => void;
}

// ============================================================================
// wireMarketplace
// ============================================================================

export async function wireMarketplace(
  config: GatewayConfig,
  ctx: FeatureWiringContext,
): Promise<void> {
  if (!config.marketplace?.enabled) return;

  try {
    const { TaskBidMarketplace } = await import("../marketplace/engine.js");
    const { ServiceMarketplace } =
      await import("../marketplace/service-marketplace.js");

    const bidMarketplace = new TaskBidMarketplace({
      antiSpam: config.marketplace.antiSpam,
      defaultPolicy: config.marketplace.defaultMatchingPolicy
        ? { policy: config.marketplace.defaultMatchingPolicy }
        : undefined,
      authorizedSelectorIds: config.marketplace.authorizedSelectorIds,
    });

    ctx.marketplace = new ServiceMarketplace({
      bidMarketplace,
    });

    ctx.logger.info(
      "Marketplace initialized (TaskBidMarketplace + ServiceMarketplace)",
    );
  } catch (err) {
    ctx.logger.warn?.("Marketplace initialization failed:", err);
  }
}

// ============================================================================
// wireSocial
// ============================================================================

export async function wireSocial(
  config: GatewayConfig,
  ctx: FeatureWiringContext,
): Promise<void> {
  if (!config.social?.enabled) return;
  if (!ctx.connectionManager) {
    ctx.logger.warn?.("Social module requires connection config — skipping");
    return;
  }

  const connection = ctx.connectionManager.getConnection();

  const walletResult = await loadWallet(config);
  if (!walletResult) {
    ctx.logger.warn?.(
      "Social module keypair unavailable — write operations disabled",
    );
  }
  const keypair = walletResult?.keypair ?? null;
  const agentId = walletResult?.agentId ?? null;

  // Create program instance
  let program: import("@coral-xyz/anchor").Program<
    import("../types/agenc_coordination.js").AgencCoordination
  >;
  try {
    if (walletResult) {
      const { AnchorProvider } = await import("@coral-xyz/anchor");
      const provider = new AnchorProvider(
        connection,
        walletResult.wallet as any,
        {},
      );
      const { createProgram } = await import("../idl.js");
      program = createProgram(provider);
    } else {
      const { createReadOnlyProgram } = await import("../idl.js");
      program = createReadOnlyProgram(connection);
    }
  } catch (err) {
    ctx.logger.warn?.("Social module program creation failed:", err);
    return;
  }

  // 1. AgentDiscovery (read-only, no wallet needed)
  if (config.social.discoveryEnabled !== false) {
    try {
      const { AgentDiscovery } = await import("../social/discovery.js");
      ctx.agentDiscovery = new AgentDiscovery({
        program,
        logger: ctx.logger,
        cache: {
          ttlMs: config.social.discoveryCacheTtlMs ?? 60_000,
          maxEntries: config.social.discoveryCacheMaxEntries ?? 200,
        },
      });
      ctx.logger.info("Agent discovery initialized");
    } catch (err) {
      ctx.logger.warn?.("Agent discovery initialization failed:", err);
    }
  }

  // 2. AgentMessaging (needs wallet)
  if (keypair && agentId && config.social.messagingEnabled !== false) {
    try {
      const { AgentMessaging } = await import("../social/messaging.js");
      ctx.agentMessaging = new AgentMessaging({
        program,
        agentId,
        wallet: keypair,
        logger: ctx.logger,
        memoryBackend: ctx.memoryBackend ?? undefined,
        config: {
          defaultMode: config.social.messagingMode ?? "auto",
          offChainPort: config.social.messagingPort ?? 0,
        },
      });
      await ctx.agentMessaging.hydrateRecentMessages();
      if (config.social.messagingPort) {
        await ctx.agentMessaging.startListener(config.social.messagingPort);
      }
      if (ctx.handleIncomingSocialMessage) {
        ctx.agentMessagingUnsubscribe = ctx.agentMessaging.onMessage(
          (message) => {
            ctx.handleIncomingSocialMessage!(message);
          },
        );
      }
      ctx.logger.info("Agent messaging initialized");
    } catch (err) {
      ctx.logger.warn?.("Agent messaging initialization failed:", err);
    }
  }

  // 3. AgentFeed (needs wallet)
  if (keypair && agentId && config.social.feedEnabled !== false) {
    try {
      const { AgentFeed } = await import("../social/feed.js");
      ctx.agentFeed = new AgentFeed({
        program,
        agentId,
        wallet: keypair,
        config: { logger: ctx.logger },
      });
      ctx.logger.info("Agent feed initialized");
    } catch (err) {
      ctx.logger.warn?.("Agent feed initialization failed:", err);
    }
  }

  // 4. ReputationScorer (read-only)
  if (config.social.reputationEnabled !== false) {
    try {
      const { ReputationScorer } = await import("../social/reputation.js");
      ctx.reputationScorer = new ReputationScorer({
        program,
        logger: ctx.logger,
      });
      ctx.logger.info("Reputation scorer initialized");
    } catch (err) {
      ctx.logger.warn?.("Reputation scorer initialization failed:", err);
    }
  }

  // 5. CollaborationProtocol (needs all sub-components + wallet)
  if (
    config.social.collaborationEnabled !== false &&
    keypair &&
    agentId &&
    ctx.agentDiscovery &&
    ctx.agentMessaging &&
    ctx.agentFeed
  ) {
    try {
      const { CollaborationProtocol } =
        await import("../social/collaboration.js");
      const { TeamContractEngine } = await import("../team/engine.js");
      const teamEngine = new TeamContractEngine();
      ctx.collaborationProtocol = new CollaborationProtocol({
        program,
        agentId,
        wallet: keypair,
        feed: ctx.agentFeed,
        messaging: ctx.agentMessaging,
        discovery: ctx.agentDiscovery,
        teamEngine,
        config: { logger: ctx.logger },
      });
      ctx.logger.info("Collaboration protocol initialized");
    } catch (err) {
      ctx.logger.warn?.(
        "Collaboration protocol initialization failed:",
        err,
      );
    }
  }

  const wiredCount = [
    ctx.agentDiscovery,
    ctx.agentMessaging,
    ctx.agentFeed,
    ctx.reputationScorer,
    ctx.collaborationProtocol,
  ].filter(Boolean).length;
  ctx.logger.info(`Social module wired with ${wiredCount}/5 components`);
}

// ============================================================================
// wireAutonomousFeatures
// ============================================================================

/** Cron schedule expressions for autonomous features. */
const CRON_SCHEDULES = {
  CURIOSITY: "0 */2 * * *",
  SELF_LEARNING: "0 */6 * * *",
} as const;

export async function wireAutonomousFeatures(
  config: GatewayConfig,
  ctx: FeatureWiringContext,
): Promise<void> {
  const heartbeatConfig = (config as unknown as Record<string, unknown>)
    .heartbeat as { enabled?: boolean; intervalMs?: number } | undefined;
  if (heartbeatConfig?.enabled === false) return;
  if (!ctx.chatExecutor || !ctx.memoryBackend) return;

  const intervalMs = heartbeatConfig?.intervalMs ?? 300_000; // default 5 min

  // Build active channels map for ProactiveCommunicator
  const activeChannels = new Map(ctx.externalChannels);

  // ProactiveCommunicator works fine with no channels — it just won't broadcast.
  // Don't block autonomous features for channel-less configurations.

  try {
    const traceConfig = resolveTraceLoggingConfig(ctx.gatewayLogging);
    const traceProviderPayloads =
      traceConfig.enabled && traceConfig.includeProviderPayloads;
    const { ProactiveCommunicator: ProactiveComm } =
      await import("./proactive.js");
    const communicator = new ProactiveComm({
      channels: activeChannels,
      logger: ctx.logger,
      defaultTargets: {},
    });
    ctx.proactiveCommunicator = communicator;

    // Import autonomous action factories
    const [
      { createCuriosityAction },
      { createSelfLearningAction },
      { createMetaPlannerAction },
      { createProactiveCommsAction },
    ] = await Promise.all([
      import("../autonomous/curiosity.js"),
      import("../autonomous/self-learning.js"),
      import("../autonomous/meta-planner.js"),
      import("./heartbeat-actions.js"),
    ]);

    // Get a provider for actions that need direct LLM access
    const llm = ctx.llmProviders[0];
    if (!llm) {
      ctx.logger.warn?.("No LLM provider — skipping autonomous features");
      return;
    }

    // Create GoalManager early so actions can reference it
    const { GoalManager } = await import("../autonomous/goal-manager.js");
    ctx.goalManager = new GoalManager({ memory: ctx.memoryBackend! });
    const workspaceFiles = await new WorkspaceLoader(
      ctx.resolveActiveHostWorkspacePath(config),
    ).load();
    const curiosityInterests = deriveCuriosityInterestsFromWorkspaceFiles(
      workspaceFiles,
    );

    const curiosityAction = createCuriosityAction({
      interests: [...curiosityInterests],
      chatExecutor: ctx.chatExecutor!,
      toolHandler: ctx.baseToolHandler!,
      memory: ctx.memoryBackend!,
      systemPrompt: "You are an autonomous AI research agent.",
      communicator,
      goalManager: ctx.goalManager,
      traceProviderPayloads,
    });
    const selfLearningAction = createSelfLearningAction({
      llm,
      memory: ctx.memoryBackend!,
      traceProviderPayloads,
    });
    const metaPlannerAction = createMetaPlannerAction({
      llm,
      memory: ctx.memoryBackend!,
      traceProviderPayloads,
    });
    const proactiveCommsAction = createProactiveCommsAction({
      llm,
      memory: ctx.memoryBackend!,
      communicator,
      traceProviderPayloads,
    });

    // --- HeartbeatScheduler for short-cycle actions ---
    const { HeartbeatScheduler } = await import("./heartbeat.js");
    const heartbeatScheduler = new HeartbeatScheduler(
      { enabled: true, intervalMs, timeoutMs: 60_000 },
      { logger: ctx.logger },
    );
    heartbeatScheduler.registerAction(metaPlannerAction);
    heartbeatScheduler.registerAction(proactiveCommsAction);

    // Desktop awareness: register if Peekaboo MCP tools are available
    let setBridgeCallback:
      | ((cb: (text: string) => Promise<unknown>) => void)
      | null = null;
    if (ctx.mcpManager) {
      const screenshotTool = ctx.mcpManager
        .getToolsByServer("peekaboo")
        .find((t: Tool) => t.name.includes("takeScreenshot"));
      if (screenshotTool) {
        const { createDesktopAwarenessAction } =
          await import("../autonomous/desktop-awareness.js");
        const awarenessAction = createDesktopAwarenessAction({
          screenshotTool,
          llm,
          memory: ctx.memoryBackend!,
          traceProviderPayloads,
        });

        // Wrap awareness to pipe noteworthy output through goal bridge (attached below)
        let awarenessBridgeCallback:
          | ((text: string) => Promise<unknown>)
          | null = null;
        const daemonLogger = ctx.logger;
        const originalAwarenessExecute =
          awarenessAction.execute.bind(awarenessAction);
        const wrappedAwareness: typeof awarenessAction = {
          name: awarenessAction.name,
          enabled: awarenessAction.enabled,
          async execute(execCtx) {
            const result = await originalAwarenessExecute(execCtx);
            if (
              result.hasOutput &&
              result.output &&
              awarenessBridgeCallback
            ) {
              await awarenessBridgeCallback(result.output).catch((error) => {
                daemonLogger.debug("Awareness bridge callback failed", {
                  error: toErrorMessage(error),
                });
              });
            }
            return result;
          },
        };
        // Store setter in closure-accessible variable for GoalManager to connect
        setBridgeCallback = (cb) => {
          awarenessBridgeCallback = cb;
        };

        heartbeatScheduler.registerAction(wrappedAwareness);
        ctx.logger.info(
          "Desktop awareness action registered (Peekaboo available)",
        );
      }

      // Desktop executor: instantiate if Peekaboo + action tools available
      const peekabooTools = ctx.mcpManager.getToolsByServer("peekaboo");
      const screenshotToolForExec = peekabooTools.find((t: Tool) =>
        t.name.includes("takeScreenshot"),
      );
      const hasActionTools = peekabooTools.some(
        (t: Tool) => t.name.includes("click") || t.name.includes("type"),
      );

      if (screenshotToolForExec && hasActionTools) {
        const { DesktopExecutor } =
          await import("../autonomous/desktop-executor.js");
        ctx.desktopExecutor = new DesktopExecutor({
          chatExecutor: ctx.chatExecutor!,
          toolHandler: ctx.baseToolHandler!,
          screenshotTool: screenshotToolForExec,
          llm,
          memory: ctx.memoryBackend!,
          approvalEngine: ctx.approvalEngine ?? undefined,
          communicator,
          logger: ctx.logger,
          traceProviderPayloads,
        });
        ctx.logger.info(
          "Desktop executor ready (Peekaboo action tools available)",
        );
      }
    }

    // Wire awareness → goal bridge
    if (ctx.goalManager && setBridgeCallback) {
      const { createAwarenessGoalBridge } =
        await import("../autonomous/awareness-goal-bridge.js");
      setBridgeCallback(
        createAwarenessGoalBridge({
          goalManager: ctx.goalManager,
        }),
      );
      ctx.logger.info("Awareness → goal bridge connected");
    }

    // Bridge meta-planner goals into GoalManager
    {
      const goalManager = ctx.goalManager!;
      const memory = ctx.memoryBackend!;
      const originalMetaPlannerExecute =
        metaPlannerAction.execute.bind(metaPlannerAction);
      (
        metaPlannerAction as { execute: typeof metaPlannerAction.execute }
      ).execute = async function (execCtx) {
        const result = await originalMetaPlannerExecute(execCtx);
        if (result.hasOutput) {
          try {
            const goals =
              await memory.get<
                Array<{
                  description: string;
                  title: string;
                  priority: "critical" | "high" | "medium" | "low";
                  rationale: string;
                  status: string;
                }>
              >("goal:active");
            if (goals) {
              for (const g of goals.filter((g) => g.status === "proposed")) {
                const active = await goalManager.getActiveGoals();
                if (!goalManager.isDuplicate(g.description, active)) {
                  await goalManager.addGoal({
                    title: g.title,
                    description: g.description,
                    priority: g.priority,
                    source: "meta-planner",
                    maxAttempts: 2,
                    rationale: g.rationale,
                  });
                }
              }
            }
          } catch {
            // Silently ignore sync errors — meta-planner result still valid
          }
        }
        // Sync GoalManager state to a key meta-planner can see next cycle
        try {
          const managedActive = await goalManager.getActiveGoals();
          if (managedActive.length > 0) {
            await memory.set(
              "goal:managed-active",
              managedActive.map((g) => ({
                title: g.title,
                description: g.description,
                priority: g.priority,
                status: g.status,
                source: g.source,
              })),
            );
          }
        } catch {
          // non-critical
        }
        return result;
      };
    }

    // Goal executor: dequeue from GoalManager and execute via DesktopExecutor
    if (ctx.desktopExecutor && ctx.goalManager) {
      const { createGoalExecutorAction } =
        await import("../autonomous/goal-executor-action.js");
      heartbeatScheduler.registerAction(
        createGoalExecutorAction({
          goalManager: ctx.goalManager,
          desktopExecutor: ctx.desktopExecutor,
          memory: ctx.memoryBackend!,
          logger: ctx.logger,
        }),
      );
    }

    heartbeatScheduler.start();
    ctx.heartbeatScheduler = heartbeatScheduler;

    // --- CronScheduler for long-running research tasks ---
    const { CronScheduler } = await import("./scheduler.js");
    const cronScheduler = new CronScheduler({ logger: ctx.logger });

    // Curiosity research every 2 hours
    cronScheduler.addJob("curiosity", CRON_SCHEDULES.CURIOSITY, {
      name: curiosityAction.name,
      execute: async (jobCtx) => {
        if (!curiosityAction.enabled) return;
        const result = await curiosityAction.execute({
          logger: jobCtx.logger,
          sendToChannels: async () => {},
        });
        if (result.hasOutput && !result.quiet) {
          jobCtx.logger.info(`[cron:curiosity] ${result.output}`);
        }
      },
    });

    // Self-learning analysis every 6 hours
    cronScheduler.addJob("self-learning", CRON_SCHEDULES.SELF_LEARNING, {
      name: selfLearningAction.name,
      execute: async (jobCtx) => {
        if (!selfLearningAction.enabled) return;
        const result = await selfLearningAction.execute({
          logger: jobCtx.logger,
          sendToChannels: async () => {},
        });
        if (result.hasOutput && !result.quiet) {
          jobCtx.logger.info(`[cron:self-learning] ${result.output}`);
        }
      },
    });

    cronScheduler.start();
    ctx.cronScheduler = cronScheduler;

    ctx.logger.info(
      `Autonomous features wired: heartbeat (interval=${intervalMs}ms) + cron (curiosity @2h, self-learning @6h)`,
    );
  } catch (err) {
    ctx.logger.error("Failed to wire autonomous features:", err);
  }
}
