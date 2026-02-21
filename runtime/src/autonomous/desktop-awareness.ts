/**
 * Desktop awareness heartbeat action for @agenc/runtime.
 *
 * Periodically captures the desktop screen via Peekaboo MCP tools,
 * uses LLM to understand the current context, and stores observations
 * in memory for proactive assistance.
 *
 * @module
 */

import type { HeartbeatAction, HeartbeatContext, HeartbeatResult } from "../gateway/heartbeat.js";
import type { MemoryBackend } from "../memory/types.js";
import type { LLMProvider } from "../llm/types.js";
import type { Tool } from "../tools/types.js";

export interface DesktopAwarenessConfig {
  /** Whether desktop awareness is enabled. Default: true */
  enabled?: boolean;
  /** Peekaboo screenshot tool (mcp.peekaboo.takeScreenshot) */
  screenshotTool: Tool;
  /** LLM provider for interpreting screenshots */
  llm: LLMProvider;
  /** Memory backend for storing desktop context */
  memory: MemoryBackend;
  /** Screenshot quality. Default: 'low' */
  screenshotQuality?: "low" | "medium" | "high";
}

const DESKTOP_SESSION_ID = "desktop-awareness";

/**
 * Create a heartbeat action that monitors the desktop environment.
 *
 * On each execution:
 * 1. Captures a screenshot via Peekaboo MCP tool
 * 2. Sends the result to an LLM for interpretation
 * 3. Stores the context observation in memory
 * 4. Reports noteworthy events (error dialogs, stuck processes)
 */
export function createDesktopAwarenessAction(
  config: DesktopAwarenessConfig,
): HeartbeatAction {
  const { screenshotTool, llm, memory } = config;
  const quality = config.screenshotQuality ?? "low";

  return {
    name: "desktop-awareness",
    enabled: config.enabled !== false,

    async execute(context: HeartbeatContext): Promise<HeartbeatResult> {
      try {
        // 1. Capture screenshot via Peekaboo
        const screenshotResult = await screenshotTool.execute({ quality });

        if (screenshotResult.isError) {
          context.logger.warn?.(
            `Desktop awareness: screenshot failed — ${screenshotResult.content}`,
          );
          return { hasOutput: false, quiet: true };
        }

        // 2. Ask LLM to interpret the desktop context
        const analysisPrompt =
          "Analyze this desktop screenshot context. Describe:\n" +
          "1. What application is in focus?\n" +
          "2. What is the user currently doing?\n" +
          "3. Are there any error dialogs, warnings, or stuck processes?\n" +
          "4. Is there anything noteworthy that an AI assistant should proactively help with?\n\n" +
          "Be concise. If nothing noteworthy, just say 'Normal desktop activity.'\n\n" +
          `Screenshot data:\n${screenshotResult.content}`;

        const llmResult = await llm.chat([
          { role: "user", content: analysisPrompt },
        ]);

        const analysis = llmResult.content ?? "Unable to analyze desktop.";

        // 3. Store context in memory
        await memory.addEntry({
          sessionId: DESKTOP_SESSION_ID,
          role: "assistant",
          content: `[Desktop Context @ ${new Date().toISOString()}] ${analysis}`,
        });

        // 4. Check if something noteworthy was detected
        const isNoteworthy =
          analysis.toLowerCase().includes("error") ||
          analysis.toLowerCase().includes("warning") ||
          analysis.toLowerCase().includes("stuck") ||
          analysis.toLowerCase().includes("crash") ||
          analysis.toLowerCase().includes("should help");

        if (isNoteworthy) {
          return {
            hasOutput: true,
            output: `Desktop alert: ${analysis}`,
            quiet: false,
          };
        }

        return { hasOutput: false, quiet: true };
      } catch (error) {
        context.logger.error?.("Desktop awareness error:", error);
        return { hasOutput: false, quiet: true };
      }
    },
  };
}
