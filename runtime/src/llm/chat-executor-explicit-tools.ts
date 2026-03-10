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
    const escapedToolName = escapeRegex(toolName);
    const imperativeToolRe = new RegExp(
      String.raw`\b(?:use|call|invoke|run)\s+\`?${escapedToolName}\`?\b`,
      "ig",
    );

    let match: RegExpExecArray | null;
    while ((match = imperativeToolRe.exec(messageText)) !== null) {
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
