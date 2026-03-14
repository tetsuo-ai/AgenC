/**
 * Shared helpers for extracting explicitly requested tool names from a prompt.
 *
 * @module
 */

export function extractExplicitImperativeToolNames(
  messageText: string,
  allowedToolNames: readonly string[],
): readonly string[] {
  if (allowedToolNames.length === 0) return [];

  const matches: Array<{ toolName: string; index: number }> = [];
  for (const toolName of allowedToolNames) {
    const imperativeToolRe = buildImperativeToolReferenceRegex(toolName, "ig");

    let match: RegExpExecArray | null;
    while ((match = imperativeToolRe.exec(messageText)) !== null) {
      if (toolName !== "execute_with_agent" && isNestedDelegatedToolMatch(messageText, match.index)) {
        continue;
      }
      matches.push({ toolName, index: match.index });
    }
  }

  matches.sort((left, right) => left.index - right.index);
  const orderedToolNames: string[] = [];
  for (const match of matches) {
    if (orderedToolNames.includes(match.toolName)) continue;
    orderedToolNames.push(match.toolName);
  }
  return orderedToolNames;
}

export function buildImperativeToolReferenceRegex(
  toolName: string,
  flags = "i",
): RegExp {
  const escapedToolName = escapeRegex(toolName);
  return new RegExp(
    String.raw`\b(?:use|call|invoke|run)(?:\s+(?:the|exactly|only|just|single|one|first|then|again|directly)){0,4}\s+\`?${escapedToolName}\`?(?:\s+tool)?\b`,
    flags,
  );
}

function isNestedDelegatedToolMatch(messageText: string, matchIndex: number): boolean {
  const prefix = extractDirectivePrefix(messageText, matchIndex);
  if (prefix.length === 0) return false;
  if (NEGATED_TOOL_DIRECTIVE_PREFIX_RE.test(prefix.slice(-40))) {
    return true;
  }
  return DELEGATED_TOOL_CONTEXT_PREFIX_RE.test(prefix);
}

function extractDirectivePrefix(messageText: string, matchIndex: number): string {
  let start = 0;
  for (const boundary of [".", "?", "!", "\n", ";"]) {
    const candidate = messageText.lastIndexOf(boundary, matchIndex);
    if (candidate >= 0) {
      start = Math.max(start, candidate + 1);
    }
  }
  return messageText.slice(start, matchIndex).trim();
}

const DELEGATED_TOOL_CONTEXT_PREFIX_RE =
  /\b(?:in|inside|within)\s+the\s+(?:child|subagent)\b|\b(?:delegate|delegating|spawn|spawning|start|starting)\s+(?:a\s+)?(?:child|subagent)\b|\b(?:child|subagent)\s+(?:agent|task|session)\s+(?:that|which|to|should|must|will)\b|\b(?:continuation|child)\s+session\s+(?:that|which|to|should|must|will)\b/i;
const NEGATED_TOOL_DIRECTIVE_PREFIX_RE =
  /\b(?:must|should)\s+not\b|\bdo\s+not\b|\bdon't\b|\bnever\b/i;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
