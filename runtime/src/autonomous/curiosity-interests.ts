import type { WorkspaceFiles } from "../gateway/workspace-files.js";

const INTEREST_HEADING_RE =
  /^#{1,6}\s*(?:interests?|topics?|focus(?:\s+areas?)?|areas?\s+of\s+interest|curiosity)\s*:?\s*$/i;
const BULLET_RE = /^\s*(?:[-*+]|(?:\d+)[.)])\s+(.+?)\s*$/;
const MAX_INTERESTS = 12;

function cleanInterest(value: string): string | null {
  const cleaned = value
    .trim()
    .replace(/^[-*+]\s+/, "")
    .replace(/^`+|`+$/g, "")
    .replace(/\*\*/g, "")
    .replace(/__+/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.,;:]+$/g, "")
    .trim();
  if (cleaned.length === 0) return null;
  if (cleaned.length > 80) return null;
  return cleaned;
}

function splitInlineInterests(line: string): readonly string[] {
  const normalized = line.trim();
  if (!/[;,]/.test(normalized)) return [];
  return normalized
    .split(/[;,]/)
    .map((entry) => cleanInterest(entry))
    .filter((entry): entry is string => entry !== null);
}

function extractExplicitInterests(markdown: string): readonly string[] {
  const interests: string[] = [];
  let inInterestSection = false;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }

    if (/^#{1,6}\s+/.test(line)) {
      inInterestSection = INTEREST_HEADING_RE.test(line);
      continue;
    }

    if (!inInterestSection) {
      continue;
    }

    const bulletMatch = line.match(BULLET_RE);
    if (bulletMatch?.[1]) {
      const cleaned = cleanInterest(bulletMatch[1]);
      if (cleaned) interests.push(cleaned);
      continue;
    }

    const inlineInterests = splitInlineInterests(line);
    if (inlineInterests.length > 0) {
      interests.push(...inlineInterests);
    }
  }

  return interests;
}

export function deriveCuriosityInterestsFromWorkspaceFiles(
  files: Pick<WorkspaceFiles, "user" | "agent" | "identity" | "soul">,
): readonly string[] {
  const orderedSources = [
    files.user,
    files.agent,
    files.identity,
    files.soul,
  ].filter((value): value is string => typeof value === "string");
  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const source of orderedSources) {
    for (const interest of extractExplicitInterests(source)) {
      const key = interest.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(interest);
      if (deduped.length >= MAX_INTERESTS) {
        return deduped;
      }
    }
  }

  return deduped;
}
