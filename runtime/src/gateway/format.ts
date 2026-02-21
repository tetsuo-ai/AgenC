/**
 * Channel-specific message formatting utilities.
 *
 * Different messaging platforms expect different markup:
 * - Telegram: HTML entities must be escaped
 * - Discord / Matrix / Slack: native Markdown or mrkdwn
 * - Signal / WhatsApp / iMessage: plain text (strip Markdown)
 *
 * @module
 */

// ============================================================================
// HTML escaping (Telegram)
// ============================================================================

/** Escape `&`, `<`, `>` for Telegram HTML parse mode. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ============================================================================
// Markdown stripping (plain-text channels)
// ============================================================================

/** Strip common Markdown formatting to produce plain text. */
export function stripMarkdown(text: string): string {
  return text
    // Code blocks: ```lang\n...\n``` → content only
    .replace(/```[\s\S]*?```/g, (m) => {
      const inner = m.slice(3, -3).replace(/^\w*\n/, "");
      return inner;
    })
    // Inline code: `foo` → foo
    .replace(/`([^`]+)`/g, "$1")
    // Bold+italic: ***text*** or ___text___
    .replace(/(\*{3}|_{3})(.+?)\1/g, "$2")
    // Bold: **text** or __text__
    .replace(/(\*{2}|_{2})(.+?)\1/g, "$2")
    // Italic: *text* or _text_
    .replace(/(\*|_)(.+?)\1/g, "$2")
    // Strikethrough: ~~text~~
    .replace(/~~(.+?)~~/g, "$1")
    // Links: [text](url) → text (url)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    // Images: ![alt](url) → alt
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    // Headers: # text → text
    .replace(/^#{1,6}\s+/gm, "")
    // Blockquotes: > text → text
    .replace(/^>\s?/gm, "")
    // Unordered list markers: - or * at start
    .replace(/^[\s]*[-*+]\s+/gm, "- ")
    // Horizontal rules
    .replace(/^[-*_]{3,}\s*$/gm, "");
}

// ============================================================================
// Channel formatter
// ============================================================================

/**
 * Format message content for a specific channel.
 *
 * | Channel    | Strategy                          |
 * |------------|-----------------------------------|
 * | telegram   | Escape HTML entities              |
 * | discord    | Pass through (native Markdown)    |
 * | matrix     | Pass through (native Markdown)    |
 * | slack      | Pass through (mrkdwn compatible)  |
 * | signal     | Strip Markdown to plain text      |
 * | whatsapp   | Strip Markdown to plain text      |
 * | imessage   | Strip Markdown to plain text      |
 * | (default)  | Pass through                      |
 */
export function formatForChannel(content: string, channelName: string): string {
  switch (channelName) {
    case "telegram":
      return escapeHtml(content);
    case "discord":
    case "matrix":
    case "slack":
      return content;
    case "signal":
    case "whatsapp":
    case "imessage":
      return stripMarkdown(content);
    default:
      return content;
  }
}
