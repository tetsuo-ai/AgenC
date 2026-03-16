/**
 * Context curation, relevance scoring, and sensitive-data redaction for
 * sub-agent prompt construction.
 *
 * Extracted from SubAgentOrchestrator — pure data-processing helpers that
 * curate conversation history, memory entries, tool outputs, and dependency
 * artifacts into budget-constrained prompt sections.
 *
 * @module
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import type {
  PipelinePlannerContextHistoryEntry,
  PipelinePlannerContextMemoryEntry,
  PipelinePlannerContextToolOutputEntry,
} from "../workflow/pipeline.js";
import type { PipelinePlannerSubagentStep } from "../workflow/pipeline.js";
import type { PromptBudgetConfig } from "../llm/prompt-budget.js";
import { derivePromptBudgetPlan } from "../llm/prompt-budget.js";
import {
  type CuratedSection,
  type DependencyArtifactCandidate,
  type DependencyContextEntry,
  type SubagentPromptBudgetCaps,
  CONTEXT_TERM_MIN_LENGTH,
  CONTEXT_HISTORY_TAIL_PIN,
  FALLBACK_CONTEXT_HISTORY_CHARS,
  FALLBACK_CONTEXT_MEMORY_CHARS,
  FALLBACK_CONTEXT_TOOL_OUTPUT_CHARS,
  FALLBACK_SUBAGENT_TASK_PROMPT_CHARS,
  REDACTED_IMAGE_DATA_URL,
  REDACTED_PRIVATE_KEY_BLOCK,
  REDACTED_INTERNAL_URL,
  REDACTED_FILE_URL,
  REDACTED_BEARER_TOKEN,
  REDACTED_API_KEY,
  REDACTED_ABSOLUTE_PATH,
  PRIVATE_KEY_BLOCK_RE,
  IMAGE_DATA_URL_RE,
  BEARER_TOKEN_RE,
  API_KEY_ASSIGNMENT_RE,
  OPENAI_KEY_RE,
  INTERNAL_URL_RE,
  FILE_URL_RE,
  ABSOLUTE_PATH_RE,
  WORKSPACE_CONTEXT_CANDIDATE_PATH_RE,
  WORKSPACE_CONTEXT_SKIP_DIRS,
  WORKSPACE_CONTEXT_MAX_SCAN_FILES,
  WORKSPACE_CONTEXT_MAX_SCAN_DEPTH,
  WORKSPACE_CONTEXT_MAX_FILE_BYTES,
  WORKSPACE_CONTEXT_MAX_CONTENT_CHARS,
  WORKSPACE_CONTEXT_MIN_CANDIDATES,
  WORKSPACE_CONTEXT_MAX_CANDIDATES,
  RUST_GENERATED_ARTIFACT_PATH_RE,
  resolveAllowedMemorySources,
} from "./subagent-orchestrator-types.js";

/* ------------------------------------------------------------------ */
/*  Sensitive-data redaction                                            */
/* ------------------------------------------------------------------ */

export function redactSensitiveData(value: string): string {
  if (value.length === 0) return value;
  let redacted = value;
  redacted = redacted.replace(PRIVATE_KEY_BLOCK_RE, REDACTED_PRIVATE_KEY_BLOCK);
  redacted = redacted.replace(IMAGE_DATA_URL_RE, REDACTED_IMAGE_DATA_URL);
  redacted = redacted.replace(BEARER_TOKEN_RE, REDACTED_BEARER_TOKEN);
  redacted = redacted.replace(
    API_KEY_ASSIGNMENT_RE,
    (_match, key: string) => `${key}=<redacted>`,
  );
  redacted = redacted.replace(OPENAI_KEY_RE, REDACTED_API_KEY);
  redacted = redacted.replace(INTERNAL_URL_RE, REDACTED_INTERNAL_URL);
  redacted = redacted.replace(FILE_URL_RE, REDACTED_FILE_URL);
  redacted = redacted.replace(
    ABSOLUTE_PATH_RE,
    (_match, prefix: string) => `${prefix}${REDACTED_ABSOLUTE_PATH}`,
  );
  return redacted;
}

/* ------------------------------------------------------------------ */
/*  Term extraction & text relevance scoring                           */
/* ------------------------------------------------------------------ */

export function extractTerms(value: string): string[] {
  const matches = value.toLowerCase().match(/[a-z0-9_.-]+/g) ?? [];
  const deduped = new Set<string>();
  for (const match of matches) {
    if (match.length < CONTEXT_TERM_MIN_LENGTH) continue;
    deduped.add(match);
  }
  return [...deduped];
}

export function buildRelevanceTerms(
  step: PipelinePlannerSubagentStep,
): Set<string> {
  const aggregate = [
    step.objective,
    step.inputContract,
    ...step.acceptanceCriteria,
    ...step.contextRequirements,
    ...step.requiredToolCapabilities,
  ].join(" ");
  return new Set(extractTerms(aggregate));
}

export function singularizeContextTerm(value: string): string {
  if (value.endsWith("ies") && value.length > 3) {
    return `${value.slice(0, -3)}y`;
  }
  if (value.endsWith("s") && value.length > CONTEXT_TERM_MIN_LENGTH) {
    return value.slice(0, -1);
  }
  return value;
}

export function expandContextQueryTerms(terms: ReadonlySet<string>): string[] {
  const expanded = new Set<string>();
  for (const term of terms) {
    const normalized = term.trim().toLowerCase();
    if (normalized.length < CONTEXT_TERM_MIN_LENGTH) continue;
    expanded.add(normalized);
    expanded.add(singularizeContextTerm(normalized));
    for (const fragment of normalized.split(/[._-]+/g)) {
      if (fragment.length < CONTEXT_TERM_MIN_LENGTH) continue;
      expanded.add(fragment);
      expanded.add(singularizeContextTerm(fragment));
    }
  }
  return [...expanded].filter((term) => term.length >= CONTEXT_TERM_MIN_LENGTH);
}

export function scoreText(text: string, terms: ReadonlySet<string>): number {
  if (terms.size === 0) return 0;
  const lower = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (lower.includes(term)) score++;
  }
  return score;
}

export function computeBm25Scores(
  documents: readonly { id: string; text: string }[],
  queryTerms: readonly string[],
): ReadonlyMap<string, number> {
  if (documents.length === 0 || queryTerms.length === 0) {
    return new Map();
  }

  const filteredQueryTerms = [...new Set(
    queryTerms
      .map((term) => term.trim().toLowerCase())
      .filter((term) => term.length >= CONTEXT_TERM_MIN_LENGTH),
  )];
  if (filteredQueryTerms.length === 0) {
    return new Map();
  }

  const stats = documents.map((document) => {
    const tokens = document.text.toLowerCase().match(/[a-z0-9_.-]+/g) ?? [];
    const termFrequencies = new Map<string, number>();
    for (const token of tokens) {
      if (token.length < CONTEXT_TERM_MIN_LENGTH) continue;
      termFrequencies.set(token, (termFrequencies.get(token) ?? 0) + 1);
    }
    return {
      id: document.id,
      length: Math.max(1, tokens.length),
      termFrequencies,
    };
  });

  const averageDocumentLength =
    stats.reduce((sum, document) => sum + document.length, 0) / stats.length;
  const documentFrequency = new Map<string, number>();
  for (const term of filteredQueryTerms) {
    documentFrequency.set(
      term,
      stats.reduce(
        (count, document) =>
          count + (document.termFrequencies.has(term) ? 1 : 0),
        0,
      ),
    );
  }

  const k1 = 1.2;
  const b = 0.75;
  const scores = new Map<string, number>();
  for (const document of stats) {
    let score = 0;
    for (const term of filteredQueryTerms) {
      const termFrequency = document.termFrequencies.get(term) ?? 0;
      if (termFrequency <= 0) continue;
      const docFrequency = documentFrequency.get(term) ?? 0;
      const idf = Math.log(
        1 + (stats.length - docFrequency + 0.5) / (docFrequency + 0.5),
      );
      const normalization =
        termFrequency +
        k1 * (1 - b + b * (document.length / Math.max(1, averageDocumentLength)));
      score += idf * ((termFrequency * (k1 + 1)) / Math.max(1e-9, normalization));
    }
    scores.set(document.id, score);
  }

  return scores;
}

/* ------------------------------------------------------------------ */
/*  Section capping & text truncation                                  */
/* ------------------------------------------------------------------ */

export function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 3) return value.slice(0, Math.max(0, maxChars));
  return value.slice(0, maxChars - 3) + "...";
}

export function applySectionCaps(
  lines: readonly string[],
  maxChars: number,
): CuratedSection {
  const cleaned = lines
    .map((line) => redactSensitiveData(line.trim()))
    .filter((line) => line.length > 0);
  if (cleaned.length === 0) {
    return {
      lines: [],
      selected: 0,
      available: 0,
      omitted: 0,
      truncated: false,
    };
  }

  const selected: string[] = [];
  let usedChars = 0;
  let truncated = false;
  for (const line of cleaned) {
    const remaining = maxChars - usedChars;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (line.length <= remaining) {
      selected.push(line);
      usedChars += line.length + 1;
      continue;
    }
    if (remaining >= 24) {
      selected.push(truncateText(line, remaining));
    }
    truncated = true;
    break;
  }
  const omitted = Math.max(0, cleaned.length - selected.length);
  if (omitted > 0) truncated = true;
  return {
    lines: selected,
    selected: selected.length,
    available: cleaned.length,
    omitted,
    truncated,
  };
}

/* ------------------------------------------------------------------ */
/*  Budget allocation                                                  */
/* ------------------------------------------------------------------ */

export function allocateContextGroupBudgets(
  totalChars: number,
  groups: readonly { key: string; active: boolean }[],
): Record<string, number> {
  const activeGroups = groups.filter((group) => group.active);
  const budgets: Record<string, number> = {};
  if (activeGroups.length === 0) {
    return budgets;
  }
  const base = Math.floor(totalChars / activeGroups.length);
  let remainder = totalChars - base * activeGroups.length;
  for (const group of activeGroups) {
    budgets[group.key] = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
  }
  return budgets;
}

export function resolveSubagentPromptBudgetCaps(
  promptBudget?: PromptBudgetConfig,
): SubagentPromptBudgetCaps {
  if (!promptBudget) {
    return {
      historyChars: FALLBACK_CONTEXT_HISTORY_CHARS,
      memoryChars: FALLBACK_CONTEXT_MEMORY_CHARS,
      toolOutputChars: FALLBACK_CONTEXT_TOOL_OUTPUT_CHARS,
      totalPromptChars: FALLBACK_SUBAGENT_TASK_PROMPT_CHARS,
    };
  }
  const plan = derivePromptBudgetPlan(promptBudget);
  return {
    historyChars: plan.caps.historyChars,
    memoryChars: plan.caps.memoryChars,
    toolOutputChars: plan.caps.toolChars,
    totalPromptChars:
      plan.caps.userChars +
      plan.caps.historyChars +
      plan.caps.memoryChars +
      plan.caps.toolChars +
      plan.caps.assistantRuntimeChars +
      plan.caps.otherChars,
  };
}

/* ------------------------------------------------------------------ */
/*  Section curation methods                                           */
/* ------------------------------------------------------------------ */

export function curateHistorySection(
  history: readonly PipelinePlannerContextHistoryEntry[],
  relevanceTerms: ReadonlySet<string>,
  maxChars: number,
): CuratedSection {
  if (history.length === 0) {
    return {
      lines: [],
      selected: 0,
      available: 0,
      omitted: 0,
      truncated: false,
    };
  }

  const lastIndex = history.length - 1;
  const pinned = new Set<number>();
  for (
    let index = Math.max(0, history.length - CONTEXT_HISTORY_TAIL_PIN);
    index <= lastIndex;
    index++
  ) {
    pinned.add(index);
  }

  const scored = history.map((entry, index) => {
    const score = scoreText(entry.content, relevanceTerms);
    return { entry, index, score };
  });
  const relevant = scored
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.index - a.index;
    });
  const filtered = (
    relevant.length > 0
      ? relevant
      : scored.filter((item) => pinned.has(item.index))
  ).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.index - a.index;
  });
  const selectedIndices = new Set<number>(
    (filtered.length > 0 ? filtered : scored.slice(-CONTEXT_HISTORY_TAIL_PIN))
      .map((item) => item.index),
  );
  const orderedLines = scored
    .filter((item) => selectedIndices.has(item.index))
    .sort((a, b) => a.index - b.index)
    .map(({ entry }) => {
      const prefix = entry.toolName
        ? `[${entry.role}:${entry.toolName}]`
        : `[${entry.role}]`;
      return `${prefix} ${redactSensitiveData(entry.content)}`;
    });
  const section = applySectionCaps(orderedLines, maxChars);
  return {
    ...section,
    available: history.length,
    omitted: Math.max(0, history.length - section.selected),
  };
}

export function curateMemorySection(
  memory: readonly PipelinePlannerContextMemoryEntry[],
  contextRequirements: readonly string[],
  relevanceTerms: ReadonlySet<string>,
  maxChars: number,
): CuratedSection {
  if (memory.length === 0) {
    return {
      lines: [],
      selected: 0,
      available: 0,
      omitted: 0,
      truncated: false,
    };
  }
  const lowerRequirements = contextRequirements.map((term) =>
    term.toLowerCase()
  );
  const sourceHints = resolveAllowedMemorySources(lowerRequirements);
  if (sourceHints.size === 0) {
    return {
      lines: [],
      selected: 0,
      available: memory.length,
      omitted: memory.length,
      truncated: false,
    };
  }
  const eligible = memory.filter((entry) => sourceHints.has(entry.source));
  if (eligible.length === 0) {
    return {
      lines: [],
      selected: 0,
      available: memory.length,
      omitted: memory.length,
      truncated: false,
    };
  }

  const queryTerms = expandContextQueryTerms(relevanceTerms);
  const bm25Scores = computeBm25Scores(
    eligible.map((entry, index) => ({
      id: String(index),
      text: entry.content,
    })),
    queryTerms,
  );
  const queryTermSet = new Set(queryTerms);
  const candidates = eligible
    .map((entry, index) => ({
      entry,
      score:
        (bm25Scores.get(String(index)) ?? 0) +
        scoreText(entry.content, queryTermSet),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.entry.source.localeCompare(b.entry.source);
    });
  if (candidates.length === 0) {
    return {
      lines: [],
      selected: 0,
      available: memory.length,
      omitted: memory.length,
      truncated: false,
    };
  }
  const lines = candidates.map(
    ({ entry }) =>
      `[${entry.source}] ${redactSensitiveData(entry.content)}`,
  );
  const section = applySectionCaps(lines, maxChars);
  return {
    ...section,
    available: memory.length,
    omitted: Math.max(0, memory.length - section.selected),
  };
}

export function curateToolOutputSection(
  step: PipelinePlannerSubagentStep,
  toolOutputs: readonly PipelinePlannerContextToolOutputEntry[],
  dependencies: readonly { dependencyName: string; result: string | null }[],
  relevanceTerms: ReadonlySet<string>,
  requirementTerms: readonly string[],
  maxChars: number,
  summarizeDependencyResult: (result: string | null) => string,
): CuratedSection {
  const requiredCapabilities = new Set(
    step.requiredToolCapabilities.map((tool) => tool.toLowerCase()),
  );
  const requirementTermSet = new Set(
    requirementTerms.map((term) => term.toLowerCase()),
  );
  const dependencyLines = dependencies.map(
    ({ dependencyName, result }) =>
      `[dependency:${dependencyName}] ${redactSensitiveData(
        summarizeDependencyResult(result),
      )}`,
  );
  const historicalLines = toolOutputs
    .map((entry) => {
      const toolName = entry.toolName?.toLowerCase();
      const capabilityMatch =
        typeof toolName === "string" &&
        Array.from(requiredCapabilities).some((required) =>
          toolName === required ||
          toolName.startsWith(required) ||
          required.startsWith(toolName)
        );
      const requirementMatch = scoreText(entry.content, requirementTermSet) > 0;
      const relevanceMatch = scoreText(entry.content, relevanceTerms) > 0;
      if (!capabilityMatch && !requirementMatch && !relevanceMatch) return null;
      const prefix = entry.toolName
        ? `[tool:${entry.toolName}]`
        : "[tool]";
      return `${prefix} ${redactSensitiveData(entry.content)}`;
    })
    .filter((line): line is string => line !== null);

  const combined = [...dependencyLines, ...historicalLines];
  const section = applySectionCaps(combined, maxChars);
  return {
    ...section,
    available: dependencies.length + toolOutputs.length,
    omitted: Math.max(
      0,
      dependencies.length + toolOutputs.length - section.selected,
    ),
  };
}

export function curateDependencyArtifactSection(
  artifacts: readonly DependencyArtifactCandidate[],
  maxChars: number,
): CuratedSection {
  if (artifacts.length === 0 || maxChars <= 0) {
    return {
      lines: [],
      selected: 0,
      available: artifacts.length,
      omitted: artifacts.length,
      truncated: false,
    };
  }

  const prefixLengths = artifacts.map((artifact) =>
    `[artifact:${artifact.dependencyName}:${artifact.path}] `.length
  );
  const totalPrefixChars = prefixLengths.reduce((sum, value) => sum + value, 0);
  const previewBudget = Math.max(0, maxChars - totalPrefixChars);
  const weights = artifacts.map((artifact) =>
    artifact.score > 0 ? artifact.score : 1
  );
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const rawPreviewAllocations = weights.map((weight) =>
    totalWeight > 0 ? (previewBudget * weight) / totalWeight : 0
  );
  const previewAllocations = rawPreviewAllocations.map((value) =>
    Math.floor(value)
  );
  let remainder =
    previewBudget - previewAllocations.reduce((sum, value) => sum + value, 0);
  const fractionalOrder = rawPreviewAllocations
    .map((value, index) => ({ index, fractional: value - previewAllocations[index]! }))
    .sort((a, b) => b.fractional - a.fractional);
  for (const entry of fractionalOrder) {
    if (remainder <= 0) break;
    previewAllocations[entry.index] =
      (previewAllocations[entry.index] ?? 0) + 1;
    remainder -= 1;
  }
  const lines = artifacts.map((artifact, index) => {
    const prefix = `[artifact:${artifact.dependencyName}:${artifact.path}]`;
    const normalizedContent = artifact.content.trim().replace(/\s+/g, " ");
    const previewChars = previewAllocations[index] ?? 0;
    if (previewChars <= 0 || normalizedContent.length === 0) {
      return prefix;
    }
    return `${prefix} ${
      truncateText(normalizedContent, previewChars)
    }`;
  });
  const section = applySectionCaps(lines, maxChars);
  return {
    ...section,
    available: artifacts.length,
    omitted: Math.max(0, artifacts.length - section.selected),
  };
}

/* ------------------------------------------------------------------ */
/*  Dependency artifact collection                                     */
/* ------------------------------------------------------------------ */

export function normalizeDependencyArtifactPath(
  path: string,
  workspaceRoot?: string,
): string {
  const normalize = (value: string): string =>
    value
      .trim()
      .replace(/\\/g, "/")
      .replace(/\/{2,}/g, "/")
      .replace(/^\.\//, "")
      .replace(/\/$/, "");

  const normalizedPath = normalize(path);
  if (normalizedPath.length === 0) {
    return normalizedPath;
  }

  const normalizedWorkspaceRoot =
    typeof workspaceRoot === "string" && workspaceRoot.trim().length > 0
      ? normalize(workspaceRoot)
      : "";
  if (
    normalizedWorkspaceRoot.length > 0 &&
    (
      normalizedPath === normalizedWorkspaceRoot ||
      normalizedPath.startsWith(`${normalizedWorkspaceRoot}/`)
    )
  ) {
    return normalizedPath
      .slice(normalizedWorkspaceRoot.length)
      .replace(/^\/+/, "");
  }

  return normalizedPath;
}

export function isDependencyArtifactPathCandidate(path: string): boolean {
  const normalized = path.trim().toLowerCase();
  if (normalized.length === 0) return false;
  if (
    RUST_GENERATED_ARTIFACT_PATH_RE.test(normalized) ||
    normalized.includes("/node_modules/") ||
    normalized.startsWith("node_modules/") ||
    normalized.includes("/dist/") ||
    normalized.startsWith("dist/") ||
    normalized.endsWith(".tsbuildinfo")
  ) {
    return false;
  }
  return /\.(?:[cm]?[jt]sx?|json|md|txt|toml|lock|ya?ml)$/i.test(normalized);
}

export function extractDependencyArtifactsFromToolCall(
  toolCall: unknown,
): readonly { path: string; content: string }[] {
  if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) {
    return [];
  }

  const record = toolCall as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const args =
    typeof record.args === "object" &&
      record.args !== null &&
      !Array.isArray(record.args)
      ? record.args as Record<string, unknown>
      : undefined;
  const rawResult = typeof record.result === "string" ? record.result : "";

  if (
    (name === "system.writeFile" || name === "system.appendFile") &&
    args
  ) {
    const path = typeof args.path === "string" ? args.path : "";
    const content = typeof args.content === "string" ? args.content : "";
    return path.trim().length > 0 && content.trim().length > 0
      ? [{ path, content }]
      : [];
  }

  if (name === "system.readFile") {
    const path =
      (args && typeof args.path === "string" ? args.path : "").trim();
    let parsedResult: unknown;
    try {
      parsedResult = JSON.parse(rawResult);
    } catch {
      parsedResult = undefined;
    }
    if (
      parsedResult &&
      typeof parsedResult === "object" &&
      !Array.isArray(parsedResult)
    ) {
      const resultRecord = parsedResult as Record<string, unknown>;
      const resultPath =
        typeof resultRecord.path === "string" ? resultRecord.path : path;
      const content =
        typeof resultRecord.content === "string" ? resultRecord.content : "";
      return resultPath.trim().length > 0 && content.trim().length > 0
        ? [{ path: resultPath, content }]
        : [];
    }
    return [];
  }

  if (name !== "system.bash" || !args) {
    return [];
  }

  const command = typeof args.command === "string" ? args.command.trim() : "";
  const commandArgs = Array.isArray(args.args)
    ? args.args.filter((value): value is string => typeof value === "string")
    : [];
  if (command !== "cat" || commandArgs.length === 0) {
    return [];
  }

  let parsedResult: unknown;
  try {
    parsedResult = JSON.parse(rawResult);
  } catch {
    parsedResult = undefined;
  }
  if (
    !parsedResult ||
    typeof parsedResult !== "object" ||
    Array.isArray(parsedResult)
  ) {
    return [];
  }
  const stdout = (parsedResult as Record<string, unknown>).stdout;
  return typeof stdout === "string" && stdout.trim().length > 0
    ? [{ path: commandArgs[0]!, content: stdout }]
    : [];
}

export function collectDependencyArtifactCandidates(
  dependencies: readonly DependencyContextEntry[],
  queryTerms: ReadonlySet<string>,
  workspaceRoot?: string,
): readonly DependencyArtifactCandidate[] {
  if (dependencies.length === 0) return [];
  const candidates = new Map<string, DependencyArtifactCandidate>();
  let order = 0;

  dependencies.forEach(({ dependencyName, result, depth }) => {
    if (typeof result !== "string" || result.trim().length === 0) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return;
    }

    const record = parsed as Record<string, unknown>;
    const toolCalls = Array.isArray(record.toolCalls) ? record.toolCalls : [];
    for (const toolCall of toolCalls) {
      const extracted = extractDependencyArtifactsFromToolCall(toolCall);
      for (const artifact of extracted) {
        const normalizedPath = normalizeDependencyArtifactPath(
          artifact.path,
          workspaceRoot,
        );
        if (!isDependencyArtifactPathCandidate(normalizedPath)) {
          continue;
        }
        const content = artifact.content.trim();
        if (content.length === 0) continue;
        const candidate: DependencyArtifactCandidate = {
          dependencyName,
          path: normalizedPath,
          content,
          score: 0,
          order,
          depth,
        };
        order += 1;
        const previous = candidates.get(normalizedPath);
        if (
          !previous ||
          candidate.depth < previous.depth ||
          (
            candidate.depth === previous.depth &&
            candidate.order > previous.order
          )
        ) {
          candidates.set(normalizedPath, candidate);
        }
      }
    }
  });

  const uniqueCandidates = [...candidates.values()];
  if (uniqueCandidates.length === 0) {
    return [];
  }

  const bm25Scores = computeBm25Scores(
    uniqueCandidates.map((candidate) => ({
      id: candidate.path,
      text: `${candidate.path}\n${candidate.content}`,
    })),
    [...queryTerms],
  );

  return uniqueCandidates
    .map((candidate) => ({
      ...candidate,
      score: bm25Scores.get(candidate.path) ?? 0,
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.depth !== b.depth) return a.depth - b.depth;
      return a.order - b.order;
    });
}

/* ------------------------------------------------------------------ */
/*  Workspace artifact collection                                      */
/* ------------------------------------------------------------------ */

export function isWorkspaceBootstrapArtifact(path: string): boolean {
  const normalized = path.trim().toLowerCase();
  return (
    normalized.endsWith("package.json") ||
    normalized.endsWith("index.html") ||
    normalized.endsWith("tsconfig.json") ||
    normalized.endsWith("vite.config.ts") ||
    normalized.endsWith("vite.config.js") ||
    normalized.endsWith("vitest.config.ts") ||
    normalized.endsWith("vitest.config.js") ||
    normalized.includes("/src/")
  );
}

export function collectWorkspaceArtifactPaths(
  directory: string,
  depth: number,
  collected: string[],
): string[] {
  if (
    depth > WORKSPACE_CONTEXT_MAX_SCAN_DEPTH ||
    collected.length >= WORKSPACE_CONTEXT_MAX_SCAN_FILES
  ) {
    return collected;
  }

  let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return collected;
  }

  for (const entry of entries) {
    if (collected.length >= WORKSPACE_CONTEXT_MAX_SCAN_FILES) {
      break;
    }
    if (WORKSPACE_CONTEXT_SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      collectWorkspaceArtifactPaths(
        absolutePath,
        depth + 1,
        collected,
      );
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (!WORKSPACE_CONTEXT_CANDIDATE_PATH_RE.test(entry.name)) {
      continue;
    }
    collected.push(absolutePath);
  }

  return collected;
}

export function collectWorkspaceArtifactCandidates(
  workspaceRoot: string,
  queryTerms: ReadonlySet<string>,
  maxChars: number,
): readonly DependencyArtifactCandidate[] {
  const normalizedWorkspaceRoot = resolvePath(workspaceRoot);
  if (
    maxChars <= 0 ||
    !existsSync(normalizedWorkspaceRoot)
  ) {
    return [];
  }

  const candidatePaths = collectWorkspaceArtifactPaths(
    normalizedWorkspaceRoot,
    0,
    [],
  );
  if (candidatePaths.length === 0) {
    return [];
  }

  const documents: { id: string; text: string }[] = [];
  const byPath = new Map<string, DependencyArtifactCandidate>();
  for (const absolutePath of candidatePaths) {
    try {
      const stats = statSync(absolutePath);
      if (!stats.isFile() || stats.size > WORKSPACE_CONTEXT_MAX_FILE_BYTES) {
        continue;
      }
      const relativePath = normalizeDependencyArtifactPath(
        absolutePath,
        normalizedWorkspaceRoot,
      );
      if (!isDependencyArtifactPathCandidate(relativePath)) {
        continue;
      }
      const rawContent = readFileSync(absolutePath, "utf-8");
      const content = rawContent.trim();
      if (content.length === 0) continue;
      const truncatedContent = truncateText(
        content,
        WORKSPACE_CONTEXT_MAX_CONTENT_CHARS,
      );
      documents.push({
        id: relativePath,
        text: `${relativePath}\n${truncatedContent}`,
      });
      byPath.set(relativePath, {
        dependencyName: "workspace_context",
        path: relativePath,
        content: truncatedContent,
        score: 0,
        order: byPath.size,
        depth: 0,
      });
    } catch {
      // Best-effort prompt enrichment only.
    }
  }

  if (documents.length === 0) {
    return [];
  }

  const scores = computeBm25Scores(documents, [...queryTerms]);
  const scored = [...byPath.values()]
    .map((candidate) => ({
      ...candidate,
      score:
        (scores.get(candidate.path) ?? 0) +
        scoreText(candidate.path, queryTerms),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.path.localeCompare(b.path);
    });
  const positiveScoreCount = scored.filter((candidate) => candidate.score > 0).length;
  const targetCount = Math.max(
    WORKSPACE_CONTEXT_MIN_CANDIDATES,
    Math.min(
      WORKSPACE_CONTEXT_MAX_CANDIDATES,
      Math.floor(maxChars / 600),
    ),
  );
  const selected = positiveScoreCount > 0
    ? scored.slice(
      0,
      Math.min(
        WORKSPACE_CONTEXT_MAX_CANDIDATES,
        Math.max(targetCount, positiveScoreCount),
      ),
    )
    : (() => {
      const bootstrapCandidates = scored.filter((candidate) =>
        isWorkspaceBootstrapArtifact(candidate.path)
      );
      return (bootstrapCandidates.length > 0 ? bootstrapCandidates : scored).slice(
        0,
        targetCount,
      );
    })();

  return selected;
}
