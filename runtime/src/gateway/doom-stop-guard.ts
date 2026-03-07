/**
 * Deterministic guardrails for Doom stop requests in interactive chat turns.
 *
 * @module
 */

const CONDITIONAL_STOP_RE =
  /\b(?:until|when|after)\s+(?:i|you)\s+(?:say|tell)\s+(?:me\s+)?(?:to\s+)?stop\b/i;
const DIRECT_STOP_PREFIX_RE =
  /^(?:please\s+|can\s+you\s+|could\s+you\s+|will\s+you\s+|would\s+you\s+)?(?:stop|close|quit|exit|kill|terminate|shut\s+down)\b[\s\S]*\b(?:doom|vizdoom)\b(?:[\s.!?]|$)/i;
const DIRECT_STOP_SUBJECT_RE =
  /^(?:please\s+)?(?:doom|vizdoom)\b(?:\s+now|\s+please)?[\s,:-]*(?:stop|close|quit|exit|kill|terminate|shut\s+down)\b(?:[\s.!?]|$)/i;

export function isDoomStopRequest(messageText: string): boolean {
  const text = messageText.trim();
  if (!text) return false;
  if (CONDITIONAL_STOP_RE.test(text)) return false;
  return DIRECT_STOP_PREFIX_RE.test(text) || DIRECT_STOP_SUBJECT_RE.test(text);
}

export function blockUntilDoomStopTool(
  toolName: string,
  stopIssued: boolean,
): string | undefined {
  if (stopIssued) return undefined;
  if (toolName === "mcp.doom.stop_game") return undefined;
  return JSON.stringify({
    error:
      "This is a Doom stop request. Call `mcp.doom.stop_game` directly before any other tools. " +
      "Do not inspect or kill ViZDoom with `desktop.process_stop`, `desktop.bash`, `kill`, `pkill`, or `sudo`.",
  });
}
