const PROTOCOL_ROUTED_TOOL_PREFIXES = [
  "agenc.",
  "marketplace.",
  "social.",
  "wallet.",
  "mcp.solana-fender.",
] as const;

const DROPPED_HEADINGS = new Set([
  "# x",
  "# identity",
  "# capabilities",
  "# policy",
  "# reputation",
]);

const USER_PROTOCOL_LINE_RE = /^\s*-\s*(?:Network|Explorer):.*$/gim;
const TOOL_PROTOCOL_LINE_RE =
  /^\s*-\s*(?:\*\*)?(?:Task operations|Agent operations|Protocol queries)(?:\*\*)?(?:\s*:|\s*\().*$/gim;
const TOOL_PROTOCOL_RULE_RE =
  /^\s*-\s*(?:Always check task requirements before claiming|Verify escrow balance before attempting completion|Use `agenc\.[^`]+` to check current fee rates|Verify all on-chain state references with protocol queries).*(?:\r?\n)?/gim;
const AGENT_PROTOCOL_LINE_RE =
  /^\s*-\s*(?:Use available tools to query on-chain state before making decisions|Verify task requirements against your registered capabilities before claiming|Submit proofs promptly after task completion|Monitor your reputation score and avoid actions that risk slashing).*(?:\r?\n)?/gim;
const SOUL_PROTOCOL_LINE_RE =
  /^\s*-\s*Technically competent with Solana and zero-knowledge proofs.*(?:\r?\n)?/gim;

function normalizeHeading(line: string): string {
  return line.trim().toLowerCase();
}

function splitTopLevelSections(prompt: string): string[] {
  const lines = prompt.split(/\r?\n/);
  const sections: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (/^#\s+/.test(line) && current.length > 0) {
      sections.push(current.join("\n").trimEnd());
      current = [line];
      continue;
    }
    current.push(line);
  }

  if (current.length > 0) {
    sections.push(current.join("\n").trimEnd());
  }

  return sections.filter((section) => section.trim().length > 0);
}

function sanitizeAgentSection(section: string): string {
  return section
    .replace(
      /You are an AgenC protocol agent — a privacy-preserving AI agent coordinating tasks on Solana\./g,
      "You are a helpful AI assistant for local engineering and automation tasks.",
    )
    .replace(
      /A privacy-preserving AI agent on the AgenC protocol\./g,
      "A helpful AI assistant.",
    )
    .replace(
      /General-purpose task coordination agent on the AgenC protocol\.[^\n]*/g,
      "General-purpose assistant for local engineering and automation tasks.",
    )
    .replace(AGENT_PROTOCOL_LINE_RE, "")
    .trimEnd();
}

function sanitizeSoulSection(section: string): string {
  return section
    .replace(SOUL_PROTOCOL_LINE_RE, "- Technically competent\n")
    .trimEnd();
}

function sanitizeUserSection(section: string): string {
  return section.replace(USER_PROTOCOL_LINE_RE, "").trimEnd();
}

function sanitizeToolsSection(section: string): string {
  return section
    .replace(TOOL_PROTOCOL_LINE_RE, "")
    .replace(TOOL_PROTOCOL_RULE_RE, "")
    .trimEnd();
}

function sanitizeSection(section: string): string | null {
  const firstLine = section.split(/\r?\n/, 1)[0] ?? "";
  const heading = normalizeHeading(firstLine);
  if (DROPPED_HEADINGS.has(heading)) {
    return null;
  }
  if (heading === "# agent configuration") {
    return sanitizeAgentSection(section);
  }
  if (heading === "# soul") {
    return sanitizeSoulSection(section);
  }
  if (heading === "# user preferences") {
    return sanitizeUserSection(section);
  }
  if (heading === "# tool guidelines") {
    return sanitizeToolsSection(section);
  }
  return section.trimEnd();
}

export function hasProtocolToolRouting(
  routedToolNames: readonly string[] | undefined,
): boolean {
  return (routedToolNames ?? []).some((toolName) =>
    PROTOCOL_ROUTED_TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix))
  );
}

export function filterSystemPromptForToolRouting(params: {
  systemPrompt: string;
  routedToolNames?: readonly string[];
}): string {
  const { systemPrompt, routedToolNames } = params;
  if (
    systemPrompt.trim().length === 0 ||
    hasProtocolToolRouting(routedToolNames)
  ) {
    return systemPrompt;
  }

  const sections = splitTopLevelSections(systemPrompt);
  if (sections.length === 0) {
    return systemPrompt;
  }

  const filtered = sections
    .map((section) => sanitizeSection(section))
    .filter((section): section is string => section !== null)
    .map((section) => section.trim())
    .filter((section) => section.length > 0);

  const result = filtered.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  return result.length > 0 ? result : systemPrompt;
}
