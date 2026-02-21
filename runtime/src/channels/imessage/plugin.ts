/**
 * iMessage channel plugin (macOS only).
 *
 * Uses AppleScript via `osascript` to read from and send messages through
 * the macOS Messages.app. No npm dependencies required.
 *
 * Follows the SignalChannel pattern (child_process, no external library).
 *
 * @module
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BaseChannelPlugin } from "../../gateway/channel.js";
import type { OutboundMessage } from "../../gateway/message.js";
import type { IMessageChannelConfig } from "./types.js";

const execFileAsync = promisify(execFile);

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_MESSAGES_PER_POLL = 10;
const EXEC_TIMEOUT_MS = 15_000;

// ============================================================================
// AppleScript templates
// ============================================================================

/**
 * Read recent messages from Messages.app.
 * Returns tab-separated lines: guid \t sender \t text \t date
 */
function buildReadScript(maxMessages: number): string {
  return `
tell application "Messages"
  set output to ""
  set chatList to chats
  repeat with aChat in chatList
    set msgList to messages of aChat
    set msgCount to count of msgList
    set startIdx to 1
    if msgCount > ${maxMessages} then set startIdx to msgCount - ${maxMessages} + 1
    repeat with i from startIdx to msgCount
      set aMsg to item i of msgList
      try
        set msgId to id of aMsg
        set msgSender to handle of aMsg
        set msgText to text of aMsg
        set msgDate to date of aMsg
        set output to output & msgId & tab & msgSender & tab & msgText & tab & (msgDate as string) & linefeed
      end try
    end repeat
  end repeat
  return output
end tell`.trim();
}

function buildSendScript(buddyId: string, text: string): string {
  const escapedText = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `
tell application "Messages"
  set targetService to 1st account whose service type = iMessage
  set targetBuddy to participant "${buddyId}" of targetService
  send "${escapedText}" to targetBuddy
end tell`.trim();
}

// ============================================================================
// Plugin
// ============================================================================

interface ParsedMessage {
  id: string;
  sender: string;
  text: string;
  date: string;
}

export class IMessageChannel extends BaseChannelPlugin {
  readonly name = "imessage";

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastSeenIds = new Set<string>();
  private healthy = false;
  private config: IMessageChannelConfig = {};
  private sessionMap = new Map<string, string>(); // sessionId → buddyId

  async start(): Promise<void> {
    if (process.platform !== "darwin") {
      this.context.logger.warn("iMessage channel requires macOS — skipping");
      return;
    }

    this.config = this.context.config as unknown as IMessageChannelConfig;
    const interval = this.config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

    // Initial snapshot — mark existing messages as seen so we don't replay history
    try {
      const messages = await this.readMessages();
      for (const msg of messages) {
        this.lastSeenIds.add(msg.id);
      }
      this.healthy = true;
      this.context.logger.info(`iMessage channel started (${messages.length} existing messages marked as seen)`);
    } catch (err) {
      this.context.logger.error("iMessage initial read failed:", err);
      this.healthy = false;
    }

    this.pollTimer = setInterval(() => {
      void this.poll();
    }, interval);
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.lastSeenIds.clear();
    this.sessionMap.clear();
    this.healthy = false;
  }

  async send(message: OutboundMessage): Promise<void> {
    const buddyId = this.sessionMap.get(message.sessionId);
    if (!buddyId) {
      this.context.logger.warn(`iMessage: unknown session ${message.sessionId}`);
      return;
    }

    try {
      const script = buildSendScript(buddyId, message.content);
      await execFileAsync("osascript", ["-e", script], { timeout: EXEC_TIMEOUT_MS });
    } catch (err) {
      this.context.logger.error(`iMessage send failed to ${buddyId}:`, err);
    }
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  // ============================================================================
  // Polling
  // ============================================================================

  private async poll(): Promise<void> {
    try {
      const messages = await this.readMessages();
      const newMessages = messages.filter((m) => !this.lastSeenIds.has(m.id));

      for (const msg of newMessages) {
        this.lastSeenIds.add(msg.id);

        // Check allowlist
        if (this.config.allowedContacts && this.config.allowedContacts.length > 0) {
          if (!this.config.allowedContacts.includes(msg.sender)) continue;
        }

        if (!msg.text.trim()) continue;

        const sessionId = `imessage:${msg.sender}`;
        this.sessionMap.set(sessionId, msg.sender);

        await this.context.onMessage({
          sessionId,
          senderId: msg.sender,
          content: msg.text,
          channel: "imessage",
          scope: "dm",
          timestamp: Date.now(),
        });
      }

      if (!this.healthy) {
        this.healthy = true;
        this.context.logger.info("iMessage channel recovered");
      }
    } catch (err) {
      if (this.healthy) {
        this.context.logger.error("iMessage poll failed:", err);
        this.healthy = false;
      }
    }
  }

  private async readMessages(): Promise<ParsedMessage[]> {
    const maxMessages = this.config.maxMessagesPerPoll ?? DEFAULT_MAX_MESSAGES_PER_POLL;
    const script = buildReadScript(maxMessages);

    const { stdout } = await execFileAsync("osascript", ["-e", script], {
      timeout: EXEC_TIMEOUT_MS,
    });

    const lines = stdout.trim().split("\n").filter(Boolean);
    const messages: ParsedMessage[] = [];

    for (const line of lines) {
      const parts = line.split("\t");
      if (parts.length >= 3) {
        messages.push({
          id: parts[0],
          sender: parts[1],
          text: parts[2],
          date: parts[3] ?? "",
        });
      }
    }

    return messages;
  }
}
