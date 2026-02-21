/**
 * Curiosity module — autonomous research heartbeat action.
 *
 * Periodically picks a topic from configured interests and uses the
 * ChatExecutor + HTTP/browser tools to research it. Stores findings
 * in memory with provenance tags. If notable, sends to channels
 * via ProactiveCommunicator.
 *
 * @module
 */

import type {
  HeartbeatAction,
  HeartbeatContext,
  HeartbeatResult,
} from "../gateway/heartbeat.js";
import type { ChatExecutor } from "../llm/chat-executor.js";
import type { ToolHandler } from "../llm/types.js";
import type { MemoryBackend } from "../memory/types.js";
import type { ProactiveCommunicator } from "../gateway/proactive.js";
import type { GoalManager } from "./goal-manager.js";

// ============================================================================
// Types
// ============================================================================

export interface CuriosityConfig {
  /** Topics the agent is curious about. */
  interests: string[];
  /** ChatExecutor for LLM-driven research. */
  chatExecutor: ChatExecutor;
  /** Tool handler for HTTP/browser tools. */
  toolHandler: ToolHandler;
  /** Memory backend for storing findings. */
  memory: MemoryBackend;
  /** System prompt for research context. */
  systemPrompt: string;
  /** Optional: broadcast notable findings to channels. */
  communicator?: ProactiveCommunicator;
  /** Channels to broadcast to (default: all default targets). */
  broadcastChannels?: string[];
  /** Max research sessions per heartbeat cycle (default: 1). */
  maxResearchPerCycle?: number;
  /** Optional: bridge noteworthy findings into the goal queue. */
  goalManager?: GoalManager;
}

// ============================================================================
// Prompts
// ============================================================================

const RESEARCH_PROMPT =
  "You are a curious AI researcher. Research the following topic and provide a concise summary " +
  "of the most interesting and recent findings. Focus on actionable insights, notable developments, " +
  "and unexpected connections. Be specific with facts and numbers.\n\n" +
  "Topic: ";

const EVALUATE_PROMPT =
  "Rate the following research findings on a scale of 1-10 for noteworthiness. " +
  "Return ONLY a JSON object: {\"score\": N, \"reason\": \"brief reason\"}\n\n" +
  "Findings:\n";

const NOTEWORTHY_THRESHOLD = 7;

// ============================================================================
// Action
// ============================================================================

export function createCuriosityAction(config: CuriosityConfig): HeartbeatAction {
  const {
    interests,
    chatExecutor,
    toolHandler,
    memory,
    systemPrompt,
    communicator,
    broadcastChannels,
  } = config;
  const maxResearch = config.maxResearchPerCycle ?? 1;

  let topicIndex = 0;

  return {
    name: "curiosity",
    enabled: true,
    async execute(context: HeartbeatContext): Promise<HeartbeatResult> {
      if (interests.length === 0) {
        return { hasOutput: false, quiet: true };
      }

      try {
        const findings: string[] = [];

        for (let i = 0; i < maxResearch && i < interests.length; i++) {
          const topic = interests[topicIndex % interests.length];
          topicIndex++;

          const sessionId = `curiosity:${Date.now()}`;

          // Research the topic using ChatExecutor with tools
          const result = await chatExecutor.execute({
            message: {
              sessionId,
              senderId: "curiosity-module",
              content: RESEARCH_PROMPT + topic,
              channel: "internal",
              scope: "system",
              timestamp: Date.now(),
            },
            history: [],
            systemPrompt,
            sessionId,
            toolHandler,
          });

          if (!result.content || result.content.length < 50) continue;

          // Store findings in memory
          try {
            await memory.addEntry({
              sessionId: "curiosity:findings",
              role: "assistant",
              content: `[CURIOSITY] Topic: ${topic}\n\n${result.content}`,
              metadata: {
                type: "curiosity",
                topic,
                toolCalls: result.toolCalls.length,
                timestamp: Date.now(),
              },
            });
          } catch {
            // non-critical
          }

          // Evaluate noteworthiness
          let isNoteworthy = false;
          try {
            const evalResult = await chatExecutor.execute({
              message: {
                sessionId: `curiosity-eval:${Date.now()}`,
                senderId: "curiosity-module",
                content: EVALUATE_PROMPT + result.content,
                channel: "internal",
                scope: "system",
                timestamp: Date.now(),
              },
              history: [],
              systemPrompt: "You are a concise evaluator. Return only valid JSON.",
              sessionId: `curiosity-eval:${Date.now()}`,
              toolHandler,
            });

            if (evalResult.content) {
              try {
                const parsed = JSON.parse(evalResult.content) as { score?: number };
                isNoteworthy = (parsed.score ?? 0) >= NOTEWORTHY_THRESHOLD;
              } catch {
                // parse failure — not noteworthy
              }
            }
          } catch {
            // eval failure — not noteworthy
          }

          // Broadcast if noteworthy
          if (isNoteworthy && communicator) {
            const briefSummary =
              result.content.length > 500
                ? result.content.slice(0, 500) + "..."
                : result.content;
            const broadcastMsg = `[Research Update] ${topic}\n\n${briefSummary}`;
            await communicator.broadcast(broadcastMsg, broadcastChannels);
          }

          // Bridge noteworthy findings into the goal queue
          if (isNoteworthy && config.goalManager) {
            const desc = `Research finding: ${result.content.slice(0, 200)}`;
            try {
              const active = await config.goalManager.getActiveGoals();
              if (!config.goalManager.isDuplicate(desc, active)) {
                await config.goalManager.addGoal({
                  title: `Explore: ${topic}`,
                  description: desc,
                  priority: "low",
                  source: "curiosity",
                  maxAttempts: 1,
                });
              }
            } catch {
              // non-critical — goal bridge failure shouldn't kill curiosity
            }
          }

          findings.push(`${topic}: ${result.content.slice(0, 200)}...`);
        }

        if (findings.length === 0) {
          return { hasOutput: false, quiet: true };
        }

        return {
          hasOutput: true,
          output: `Researched ${findings.length} topic(s):\n${findings.join("\n")}`,
          quiet: false,
        };
      } catch (err) {
        context.logger.error("Curiosity action failed:", err);
        return { hasOutput: false, quiet: true };
      }
    },
  };
}
