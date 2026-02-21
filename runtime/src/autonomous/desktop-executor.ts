/**
 * Autonomous desktop executor for @agenc/runtime.
 *
 * Closes the see-think-act-verify loop: takes a goal, plans steps,
 * executes desktop tools via ChatExecutor, verifies with screenshots,
 * and repeats until done or stuck.
 *
 * Reuses existing infrastructure: ChatExecutor for tool-calling,
 * ApprovalEngine for safety gates, MemoryBackend for audit trail,
 * and ProactiveCommunicator for progress updates.
 *
 * @module
 */

import type { ChatExecutor, ToolCallRecord } from "../llm/chat-executor.js";
import type { ToolHandler, LLMProvider } from "../llm/types.js";
import type { Tool } from "../tools/types.js";
import type { MemoryBackend } from "../memory/types.js";
import type { ApprovalEngine } from "../gateway/approvals.js";
import type { ProactiveCommunicator } from "../gateway/proactive.js";
import type { GatewayMessage } from "../gateway/message.js";

// ============================================================================
// Types
// ============================================================================

export interface DesktopExecutorConfig {
  /** ChatExecutor for tool-calling (has the LLM + tool loop built-in). */
  chatExecutor: ChatExecutor;
  /** ToolHandler from the registry (includes Peekaboo + automator tools). */
  toolHandler: ToolHandler;
  /** Peekaboo screenshot tool (mcp.peekaboo.takeScreenshot). */
  screenshotTool: Tool;
  /** LLM provider for lightweight verification/classification. */
  llm: LLMProvider;
  /** Memory backend for audit trail + action history. */
  memory: MemoryBackend;
  /** Existing safety gate for tool approvals. */
  approvalEngine?: ApprovalEngine;
  /** Progress update broadcaster. */
  communicator?: ProactiveCommunicator;
  /** Maximum execution steps before aborting (default: 20). */
  maxSteps?: number;
  /** Maximum consecutive failures before marking as stuck (default: 3). */
  maxConsecutiveFailures?: number;
  /** Screenshot quality for verification captures (default: "medium"). */
  screenshotQuality?: "low" | "medium" | "high";
}

export type GoalStatus =
  | "planning"
  | "executing"
  | "completed"
  | "failed"
  | "stuck"
  | "cancelled";

export interface ExecutionStep {
  stepNumber: number;
  type: "plan" | "act" | "verify";
  description: string;
  toolCalls: ToolCallRecord[];
  verification?: {
    success: boolean;
    confidence: number;
    description: string;
  };
  durationMs: number;
}

export interface DesktopExecutorResult {
  goalId: string;
  success: boolean;
  status: GoalStatus;
  steps: ExecutionStep[];
  summary: string;
  durationMs: number;
}

// ============================================================================
// Internal helpers
// ============================================================================

const DESKTOP_EXECUTOR_SESSION = "desktop-executor";
let goalCounter = 0;

function generateGoalId(): string {
  return `goal-${Date.now()}-${++goalCounter}`;
}

/**
 * Build a minimal GatewayMessage for ChatExecutor consumption.
 */
function makeMessage(content: string, sessionId: string): GatewayMessage {
  return {
    id: `de-${Date.now()}`,
    channel: "desktop-executor",
    senderId: "desktop-executor",
    senderName: "Desktop Executor",
    sessionId,
    content,
    scope: "dm",
    attachments: [],
    timestamp: Date.now(),
  } as unknown as GatewayMessage;
}

/**
 * Parse verification JSON from LLM response.
 * Returns a safe default on malformed output.
 */
function parseVerification(raw: string): {
  success: boolean;
  confidence: number;
  description: string;
} {
  try {
    // Try to find JSON in the response
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        success: Boolean(parsed.success),
        confidence:
          typeof parsed.confidence === "number"
            ? Math.min(1, Math.max(0, parsed.confidence))
            : 0.5,
        description:
          typeof parsed.description === "string"
            ? parsed.description
            : "Verification result parsed",
      };
    }
  } catch {
    // Fall through to default
  }
  // Default: treat as failure if we can't parse
  return {
    success: false,
    confidence: 0,
    description: `Unable to parse verification: ${raw.slice(0, 200)}`,
  };
}

// ============================================================================
// DesktopExecutor
// ============================================================================

export class DesktopExecutor {
  private readonly chatExecutor: ChatExecutor;
  private readonly toolHandler: ToolHandler;
  private readonly screenshotTool: Tool;
  private readonly llm: LLMProvider;
  private readonly memory: MemoryBackend;
  private readonly approvalEngine?: ApprovalEngine;
  private readonly communicator?: ProactiveCommunicator;
  private readonly maxSteps: number;
  private readonly maxConsecutiveFailures: number;
  private readonly screenshotQuality: "low" | "medium" | "high";

  private _isRunning = false;
  private _cancelled = false;

  constructor(config: DesktopExecutorConfig) {
    this.chatExecutor = config.chatExecutor;
    this.toolHandler = config.toolHandler;
    this.screenshotTool = config.screenshotTool;
    this.llm = config.llm;
    this.memory = config.memory;
    this.approvalEngine = config.approvalEngine;
    this.communicator = config.communicator;
    this.maxSteps = config.maxSteps ?? 20;
    this.maxConsecutiveFailures = config.maxConsecutiveFailures ?? 3;
    this.screenshotQuality = config.screenshotQuality ?? "medium";
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  cancel(): void {
    this._cancelled = true;
  }

  async executeGoal(
    goal: string,
    source: "user" | "meta-planner" | "awareness" | "curiosity",
  ): Promise<DesktopExecutorResult> {
    if (this._isRunning) {
      return {
        goalId: "none",
        success: false,
        status: "failed",
        steps: [],
        summary: "Another goal is already executing",
        durationMs: 0,
      };
    }

    this._isRunning = true;
    this._cancelled = false;
    const goalId = generateGoalId();
    const sessionId = `${DESKTOP_EXECUTOR_SESSION}:${goalId}`;
    const startTime = Date.now();
    const steps: ExecutionStep[] = [];
    let status: GoalStatus = "planning";

    try {
      // ==================================================================
      // 1. PLAN — Screenshot desktop + ChatExecutor to generate plan
      // ==================================================================
      const planStart = Date.now();
      const screenshot = await this.screenshotTool.execute({
        quality: this.screenshotQuality,
      });

      const planPrompt =
        `You are an autonomous desktop executor. The user wants to achieve this goal:\n\n` +
        `"${goal}"\n\n` +
        `Current desktop state:\n${screenshot.content}\n\n` +
        `Generate a step-by-step plan to achieve this goal using desktop actions ` +
        `(click, type, scroll, etc.). Return ONLY a JSON array of step objects:\n` +
        `[{"action": "click|type|scroll|open|navigate", "description": "what to do"}]\n\n` +
        `Keep the plan concise (max 10 steps). If the goal is already achieved, return [].`;

      const planResult = await this.chatExecutor.execute({
        message: makeMessage(planPrompt, sessionId),
        history: [],
        systemPrompt:
          "You are an autonomous desktop action planner. Return only valid JSON.",
        sessionId,
        toolHandler: this.toolHandler,
      });

      // Parse plan steps
      let planSteps: Array<{ action: string; description: string }> = [];
      try {
        const jsonMatch = planResult.content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          planSteps = JSON.parse(jsonMatch[0]);
        }
      } catch {
        planSteps = [{ action: "execute", description: goal }];
      }

      steps.push({
        stepNumber: 0,
        type: "plan",
        description: `Generated plan with ${planSteps.length} steps`,
        toolCalls: [...planResult.toolCalls],
        durationMs: Date.now() - planStart,
      });

      // Store plan in memory
      await this.memory.addEntry({
        sessionId: DESKTOP_EXECUTOR_SESSION,
        role: "assistant",
        content: `[Plan @ ${new Date().toISOString()}] Goal: "${goal}" (${source}) — ${planSteps.length} steps. ID: ${goalId}`,
      });

      if (planSteps.length === 0) {
        status = "completed";
        return this.buildResult(
          goalId,
          true,
          status,
          steps,
          "Goal appears already achieved",
          startTime,
        );
      }

      // ==================================================================
      // 2. EXECUTE-VERIFY LOOP
      // ==================================================================
      status = "executing";
      let consecutiveFailures = 0;
      let stepNumber = 1;

      for (const planStep of planSteps) {
        if (this._cancelled) {
          status = "cancelled";
          break;
        }
        if (stepNumber > this.maxSteps) {
          status = "failed";
          break;
        }

        // a. CHECK APPROVAL (if engine available)
        if (this.approvalEngine) {
          const actionTool = this.inferToolName(planStep.action);
          const rule = this.approvalEngine.requiresApproval(actionTool, {
            action: planStep.action,
            description: planStep.description,
          });
          if (rule) {
            const request = this.approvalEngine.createRequest(
              actionTool,
              { action: planStep.action, description: planStep.description },
              sessionId,
              rule.description ?? `Desktop action: ${planStep.description}`,
              rule,
            );
            const response = await this.approvalEngine.requestApproval(request);
            if (response.disposition === "no") {
              steps.push({
                stepNumber,
                type: "act",
                description: `Skipped (denied): ${planStep.description}`,
                toolCalls: [],
                durationMs: 0,
              });
              stepNumber++;
              continue;
            }
          }
        }

        // b. ACT — ChatExecutor handles the tool calling
        const actStart = Date.now();
        const actPrompt =
          `Execute this desktop action:\n\n` +
          `Action: ${planStep.action}\n` +
          `Description: ${planStep.description}\n\n` +
          `Use the available desktop tools (click, type, scroll, etc.) to perform this action. ` +
          `Describe what you did.`;

        let actResult;
        try {
          actResult = await this.chatExecutor.execute({
            message: makeMessage(actPrompt, sessionId),
            history: [],
            systemPrompt:
              "You are a desktop automation agent. Execute the requested action using available tools.",
            sessionId,
            toolHandler: this.toolHandler,
          });
        } catch (err) {
          steps.push({
            stepNumber,
            type: "act",
            description: `Failed: ${planStep.description} — ${String(err)}`,
            toolCalls: [],
            durationMs: Date.now() - actStart,
          });
          consecutiveFailures++;
          if (consecutiveFailures >= this.maxConsecutiveFailures) {
            status = "stuck";
            break;
          }
          stepNumber++;
          continue;
        }

        steps.push({
          stepNumber,
          type: "act",
          description: `Executed: ${planStep.description}`,
          toolCalls: [...actResult.toolCalls],
          durationMs: Date.now() - actStart,
        });

        // c. VERIFY — Screenshot + LLM verification
        const verifyStart = Date.now();
        let verification;
        try {
          const verifyScreenshot = await this.screenshotTool.execute({
            quality: this.screenshotQuality,
          });

          const verifyPrompt =
            `I just performed this desktop action:\n` +
            `"${planStep.description}"\n\n` +
            `Here is the current desktop state:\n${verifyScreenshot.content}\n\n` +
            `Did the action succeed? Respond with JSON only:\n` +
            `{"success": true/false, "confidence": 0.0-1.0, "description": "what you observe"}`;

          const verifyResult = await this.llm.chat([
            { role: "user", content: verifyPrompt },
          ]);

          verification = parseVerification(verifyResult.content);
        } catch {
          verification = {
            success: false,
            confidence: 0,
            description: "Verification failed (screenshot or LLM error)",
          };
        }

        steps.push({
          stepNumber,
          type: "verify",
          description: verification.description,
          toolCalls: [],
          verification,
          durationMs: Date.now() - verifyStart,
        });

        if (verification.success) {
          consecutiveFailures = 0;
        } else {
          consecutiveFailures++;
          if (consecutiveFailures >= this.maxConsecutiveFailures) {
            status = "stuck";
            break;
          }
        }

        // d. PROGRESS — broadcast every 3 steps
        if (this.communicator && stepNumber % 3 === 0) {
          await this.communicator
            .broadcast(
              `Desktop executor progress: step ${stepNumber}/${planSteps.length} — ${planStep.description}`,
            )
            .catch(() => {});
        }

        stepNumber++;
      }

      // ==================================================================
      // 3. COMPLETE — Final status
      // ==================================================================
      if (status === "executing") {
        status = "completed";
      }

      const success = status === "completed";

      // Store result in memory
      await this.memory.addEntry({
        sessionId: DESKTOP_EXECUTOR_SESSION,
        role: "assistant",
        content: `[Result @ ${new Date().toISOString()}] Goal "${goal}" — ${status}. Steps: ${steps.length}. ID: ${goalId}`,
      });

      // Final progress broadcast
      if (this.communicator) {
        await this.communicator
          .broadcast(
            `Desktop goal ${success ? "completed" : status}: "${goal}"`,
          )
          .catch(() => {});
      }

      return this.buildResult(
        goalId,
        success,
        status,
        steps,
        `Goal "${goal}" ${status} after ${steps.length} steps`,
        startTime,
      );
    } catch (err) {
      status = "failed";

      // Store failure in memory
      await this.memory
        .addEntry({
          sessionId: DESKTOP_EXECUTOR_SESSION,
          role: "assistant",
          content: `[Error @ ${new Date().toISOString()}] Goal "${goal}" failed: ${String(err)}. ID: ${goalId}`,
        })
        .catch(() => {});

      return this.buildResult(
        goalId,
        false,
        status,
        steps,
        `Goal "${goal}" failed: ${String(err)}`,
        startTime,
      );
    } finally {
      this._isRunning = false;
    }
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private buildResult(
    goalId: string,
    success: boolean,
    status: GoalStatus,
    steps: ExecutionStep[],
    summary: string,
    startTime: number,
  ): DesktopExecutorResult {
    return {
      goalId,
      success,
      status,
      steps,
      summary,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Map high-level action names to tool name patterns for approval checks.
   */
  private inferToolName(action: string): string {
    const lower = action.toLowerCase();
    if (lower.includes("click")) return "mcp.peekaboo.click";
    if (lower.includes("type") || lower.includes("input"))
      return "mcp.peekaboo.type";
    if (lower.includes("scroll")) return "mcp.peekaboo.scroll";
    return `mcp.macos-automator.${lower}`;
  }
}
