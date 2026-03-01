import type { LLMMessage, LLMTool } from "../llm/types.js";
import type { ChatToolRoutingSummary } from "../llm/chat-executor.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";

const TOKEN_RE = /[a-z0-9_]+/g;

const STOP_TERMS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "please",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "this",
  "to",
  "us",
  "we",
  "with",
  "you",
  "your",
]);

const DEFAULT_MANDATORY_TOOLS = [
  "system.bash",
  "desktop.bash",
  "system.readFile",
  "system.writeFile",
  "system.listDir",
];

const DEFAULT_FAMILY_CAPS: Record<string, number> = {
  system: 12,
  desktop: 10,
  playwright: 8,
  agenc: 8,
  wallet: 6,
  social: 6,
  default: 6,
};

const EXPLICIT_PIVOT_RE = /\b(instead|different|switch|forget that|new task|change of plan|another thing|start over|use .* now)\b/i;

const SHELL_TERMS = new Set([
  "bash",
  "shell",
  "terminal",
  "command",
  "script",
  "cli",
  "run",
  "execute",
]);

const BROWSER_TERMS = new Set([
  "browser",
  "page",
  "website",
  "navigate",
  "click",
  "type",
  "scroll",
  "tab",
  "vnc",
]);

const FILE_TERMS = new Set([
  "file",
  "files",
  "read",
  "write",
  "append",
  "directory",
  "folder",
  "path",
]);

const NETWORK_TERMS = new Set([
  "http",
  "https",
  "api",
  "request",
  "curl",
  "fetch",
  "endpoint",
  "url",
]);

interface NormalizedRoutingConfig {
  enabled: boolean;
  minToolsPerTurn: number;
  maxToolsPerTurn: number;
  maxExpandedToolsPerTurn: number;
  cacheTtlMs: number;
  minCacheConfidence: number;
  pivotSimilarityThreshold: number;
  pivotMissThreshold: number;
  mandatoryTools: string[];
  familyCaps: Readonly<Record<string, number>>;
}

interface IndexedTool {
  readonly name: string;
  readonly family: string;
  readonly keywords: ReadonlySet<string>;
  readonly descriptionTerms: ReadonlySet<string>;
  readonly schemaChars: number;
}

interface CachedIntentRoute {
  clusterKey: string;
  terms: string[];
  confidence: number;
  routedToolNames: string[];
  expandedToolNames: string[];
  missCount: number;
  expiresAt: number;
  updatedAt: number;
}

export interface ToolRoutingConfig {
  enabled?: boolean;
  minToolsPerTurn?: number;
  maxToolsPerTurn?: number;
  maxExpandedToolsPerTurn?: number;
  cacheTtlMs?: number;
  minCacheConfidence?: number;
  pivotSimilarityThreshold?: number;
  pivotMissThreshold?: number;
  mandatoryTools?: string[];
  familyCaps?: Record<string, number>;
}

export interface ToolRoutingDecision {
  readonly routedToolNames: readonly string[];
  readonly expandedToolNames: readonly string[];
  readonly diagnostics: {
    readonly cacheHit: boolean;
    readonly clusterKey: string;
    readonly confidence: number;
    readonly invalidatedReason?: string;
    readonly totalToolCount: number;
    readonly routedToolCount: number;
    readonly expandedToolCount: number;
    readonly schemaCharsFull: number;
    readonly schemaCharsRouted: number;
    readonly schemaCharsExpanded: number;
    readonly schemaCharsSaved: number;
  };
}

export interface RouteToolParams {
  readonly sessionId: string;
  readonly messageText: string;
  readonly history: readonly LLMMessage[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toTerms(value: string): string[] {
  const lower = value.toLowerCase();
  const matches = lower.match(TOKEN_RE) ?? [];
  const unique = new Set<string>();
  for (const raw of matches) {
    const term = raw.trim();
    if (term.length < 2) continue;
    if (STOP_TERMS.has(term)) continue;
    unique.add(term);
  }
  return Array.from(unique);
}

function jaccardSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const aSet = new Set(a);
  const bSet = new Set(b);
  let intersection = 0;
  for (const term of aSet) {
    if (bSet.has(term)) intersection += 1;
  }
  const union = aSet.size + bSet.size - intersection;
  if (union <= 0) return 0;
  return intersection / union;
}

function familyFromToolName(name: string): string {
  const firstDot = name.indexOf(".");
  if (firstDot <= 0) return "default";
  return name.slice(0, firstDot).toLowerCase();
}

function normalizeConfig(config: ToolRoutingConfig | undefined): NormalizedRoutingConfig {
  const minToolsPerTurn = clamp(
    Math.floor(config?.minToolsPerTurn ?? 6),
    1,
    64,
  );
  const maxToolsPerTurn = clamp(
    Math.floor(config?.maxToolsPerTurn ?? 18),
    minToolsPerTurn,
    256,
  );
  const maxExpandedToolsPerTurn = clamp(
    Math.floor(config?.maxExpandedToolsPerTurn ?? Math.max(maxToolsPerTurn * 2, maxToolsPerTurn + 4)),
    maxToolsPerTurn,
    256,
  );
  const cacheTtlMs = clamp(
    Math.floor(config?.cacheTtlMs ?? 10 * 60_000),
    10_000,
    24 * 60 * 60_000,
  );
  const minCacheConfidence = clamp(
    typeof config?.minCacheConfidence === "number"
      ? config.minCacheConfidence
      : 0.5,
    0,
    1,
  );
  const pivotSimilarityThreshold = clamp(
    typeof config?.pivotSimilarityThreshold === "number"
      ? config.pivotSimilarityThreshold
      : 0.25,
    0,
    1,
  );
  const pivotMissThreshold = clamp(
    Math.floor(config?.pivotMissThreshold ?? 2),
    1,
    20,
  );

  const mandatoryTools = Array.from(
    new Set([
      ...DEFAULT_MANDATORY_TOOLS,
      ...(config?.mandatoryTools ?? []),
    ]),
  );

  const familyCaps: Record<string, number> = {
    ...DEFAULT_FAMILY_CAPS,
  };
  for (const [family, cap] of Object.entries(config?.familyCaps ?? {})) {
    if (!Number.isFinite(cap)) continue;
    familyCaps[family.toLowerCase()] = clamp(Math.floor(cap), 1, 128);
  }

  return {
    enabled: config?.enabled ?? true,
    minToolsPerTurn,
    maxToolsPerTurn,
    maxExpandedToolsPerTurn,
    cacheTtlMs,
    minCacheConfidence,
    pivotSimilarityThreshold,
    pivotMissThreshold,
    mandatoryTools,
    familyCaps,
  };
}

export class ToolRouter {
  private readonly logger: Logger;
  private readonly config: NormalizedRoutingConfig;
  private readonly indexedTools: IndexedTool[];
  private readonly allToolNames: string[];
  private readonly fullSchemaChars: number;
  private readonly cache = new Map<string, CachedIntentRoute>();

  constructor(
    tools: readonly LLMTool[],
    config?: ToolRoutingConfig,
    logger?: Logger,
  ) {
    this.logger = logger ?? silentLogger;
    this.config = normalizeConfig(config);
    this.indexedTools = tools.map((tool) => {
      const name = tool.function.name;
      const family = familyFromToolName(name);
      const nameTerms = toTerms(name.replaceAll(".", " ").replaceAll("_", " "));
      const descriptionTerms = toTerms(tool.function.description ?? "");
      return {
        name,
        family,
        keywords: new Set(nameTerms),
        descriptionTerms: new Set(descriptionTerms),
        schemaChars: JSON.stringify(tool).length,
      };
    });
    this.allToolNames = this.indexedTools.map((tool) => tool.name);
    this.fullSchemaChars = this.indexedTools.reduce(
      (sum, tool) => sum + tool.schemaChars,
      0,
    );
  }

  route(params: RouteToolParams): ToolRoutingDecision {
    if (!this.config.enabled || this.indexedTools.length === 0) {
      return {
        routedToolNames: this.allToolNames,
        expandedToolNames: this.allToolNames,
        diagnostics: {
          cacheHit: false,
          clusterKey: "disabled",
          confidence: 1,
          invalidatedReason: this.config.enabled ? "no_tools" : "disabled",
          totalToolCount: this.allToolNames.length,
          routedToolCount: this.allToolNames.length,
          expandedToolCount: this.allToolNames.length,
          schemaCharsFull: this.fullSchemaChars,
          schemaCharsRouted: this.fullSchemaChars,
          schemaCharsExpanded: this.fullSchemaChars,
          schemaCharsSaved: 0,
        },
      };
    }

    const intentTerms = this.extractIntentTerms(params.messageText, params.history);
    const clusterKey = intentTerms.slice(0, 6).join("|") || "general";
    const now = Date.now();
    const cached = this.cache.get(params.sessionId);

    let invalidatedReason: string | undefined;
    if (cached) {
      if (cached.missCount >= this.config.pivotMissThreshold) {
        invalidatedReason = "tool_miss_threshold";
      } else if (cached.expiresAt <= now) {
        invalidatedReason = "ttl_expired";
      } else if (EXPLICIT_PIVOT_RE.test(params.messageText)) {
        invalidatedReason = "explicit_redirect";
      } else {
        const similarity = jaccardSimilarity(intentTerms, cached.terms);
        if (intentTerms.length > 0 && similarity < this.config.pivotSimilarityThreshold) {
          invalidatedReason = "domain_shift";
        }
      }

      if (
        !invalidatedReason &&
        cached.confidence >= this.config.minCacheConfidence
      ) {
        return this.buildDecision(
          cached.routedToolNames,
          cached.expandedToolNames,
          {
            cacheHit: true,
            clusterKey: cached.clusterKey,
            confidence: cached.confidence,
          },
        );
      }
    }

    const scored = this.scoreTools(intentTerms);
    const routedToolNames = this.selectRoutedTools(scored);
    const expandedToolNames = this.selectExpandedTools(scored, routedToolNames);
    const confidence = this.estimateConfidence(scored, intentTerms, routedToolNames);

    this.cache.set(params.sessionId, {
      clusterKey,
      terms: intentTerms,
      confidence,
      routedToolNames,
      expandedToolNames,
      missCount: 0,
      expiresAt: now + this.config.cacheTtlMs,
      updatedAt: now,
    });

    if (invalidatedReason) {
      this.logger.debug?.("tool routing cache invalidated", {
        sessionId: params.sessionId,
        reason: invalidatedReason,
      });
    }

    return this.buildDecision(
      routedToolNames,
      expandedToolNames,
      {
        cacheHit: false,
        clusterKey,
        confidence,
        invalidatedReason,
      },
    );
  }

  recordOutcome(
    sessionId: string,
    summary: ChatToolRoutingSummary | undefined,
  ): void {
    if (!summary) return;
    const cached = this.cache.get(sessionId);
    if (!cached) return;

    if (summary.routeMisses > 0) {
      cached.missCount += summary.routeMisses;
    } else {
      cached.missCount = Math.max(0, cached.missCount - 1);
    }

    if (summary.expanded) {
      cached.confidence = Math.min(cached.confidence, 0.49);
    }

    if (cached.missCount >= this.config.pivotMissThreshold) {
      cached.expiresAt = 0;
    }
    cached.updatedAt = Date.now();
  }

  resetSession(sessionId: string): void {
    this.cache.delete(sessionId);
  }

  clear(): void {
    this.cache.clear();
  }

  private extractIntentTerms(
    messageText: string,
    history: readonly LLMMessage[],
  ): string[] {
    const terms = new Set<string>(toTerms(messageText));

    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i];
      if (entry.role !== "user") continue;
      if (typeof entry.content !== "string") continue;
      for (const term of toTerms(entry.content).slice(0, 6)) {
        terms.add(term);
      }
      break;
    }

    return Array.from(terms).sort();
  }

  private scoreTools(intentTerms: readonly string[]): Array<{ tool: IndexedTool; score: number }> {
    const hasShellIntent = intentTerms.some((term) => SHELL_TERMS.has(term));
    const hasBrowserIntent = intentTerms.some((term) => BROWSER_TERMS.has(term));
    const hasFileIntent = intentTerms.some((term) => FILE_TERMS.has(term));
    const hasNetworkIntent = intentTerms.some((term) => NETWORK_TERMS.has(term));

    const scored = this.indexedTools.map((tool) => {
      let score = 0;

      for (const term of intentTerms) {
        if (tool.keywords.has(term)) score += 3;
        if (tool.descriptionTerms.has(term)) score += 1;
      }

      if (hasShellIntent && (tool.name === "system.bash" || tool.name === "desktop.bash")) {
        score += 4;
      }
      if (hasBrowserIntent) {
        if (
          tool.family === "desktop" ||
          tool.family === "playwright" ||
          tool.name.startsWith("system.browse")
        ) {
          score += 2;
        }
      }
      if (hasFileIntent && tool.family === "system") {
        if (
          tool.name.startsWith("system.read") ||
          tool.name.startsWith("system.write") ||
          tool.name.startsWith("system.list") ||
          tool.name.startsWith("system.stat") ||
          tool.name.startsWith("system.append")
        ) {
          score += 2;
        }
      }
      if (hasNetworkIntent && tool.name.startsWith("system.http")) {
        score += 2;
      }

      if (this.config.mandatoryTools.includes(tool.name)) {
        score += 1;
      }

      return { tool, score };
    });

    scored.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.tool.name.localeCompare(b.tool.name);
    });

    return scored;
  }

  private selectRoutedTools(
    scored: ReadonlyArray<{ tool: IndexedTool; score: number }>,
  ): string[] {
    const selected = new Set<string>();
    const familyCounts = new Map<string, number>();

    for (const mandatoryTool of this.config.mandatoryTools) {
      if (!this.allToolNames.includes(mandatoryTool)) continue;
      selected.add(mandatoryTool);
      const family = familyFromToolName(mandatoryTool);
      familyCounts.set(family, (familyCounts.get(family) ?? 0) + 1);
    }

    const maxTools = this.config.maxToolsPerTurn;
    const minTools = this.config.minToolsPerTurn;

    const tryAdd = (candidate: IndexedTool): void => {
      if (selected.has(candidate.name)) return;
      if (selected.size >= maxTools) return;

      const familyCap = this.config.familyCaps[candidate.family] ??
        this.config.familyCaps.default ??
        DEFAULT_FAMILY_CAPS.default;
      const usedInFamily = familyCounts.get(candidate.family) ?? 0;
      if (usedInFamily >= familyCap) return;

      selected.add(candidate.name);
      familyCounts.set(candidate.family, usedInFamily + 1);
    };

    for (const entry of scored) {
      if (entry.score <= 0 && selected.size >= minTools) break;
      tryAdd(entry.tool);
    }

    if (selected.size < minTools) {
      for (const entry of scored) {
        if (selected.size >= minTools) break;
        if (selected.size >= maxTools) break;
        if (selected.has(entry.tool.name)) continue;
        selected.add(entry.tool.name);
      }
    }

    if (selected.size === 0 && this.allToolNames.length > 0) {
      selected.add(this.allToolNames[0]);
    }

    return Array.from(selected);
  }

  private selectExpandedTools(
    scored: ReadonlyArray<{ tool: IndexedTool; score: number }>,
    routedToolNames: readonly string[],
  ): string[] {
    const selected = new Set(routedToolNames);
    const maxExpanded = this.config.maxExpandedToolsPerTurn;

    for (const entry of scored) {
      if (selected.size >= maxExpanded) break;
      selected.add(entry.tool.name);
    }

    if (selected.size < routedToolNames.length) {
      for (const name of routedToolNames) selected.add(name);
    }

    return Array.from(selected);
  }

  private estimateConfidence(
    scored: ReadonlyArray<{ tool: IndexedTool; score: number }>,
    intentTerms: readonly string[],
    routedToolNames: readonly string[],
  ): number {
    if (scored.length === 0 || routedToolNames.length === 0) return 0;
    if (intentTerms.length === 0) return 0.4;

    const topScore = scored[0]?.score ?? 0;
    const routedSet = new Set(routedToolNames);
    const matchedTerms = new Set<string>();

    for (const entry of scored) {
      if (!routedSet.has(entry.tool.name)) continue;
      for (const term of intentTerms) {
        if (entry.tool.keywords.has(term) || entry.tool.descriptionTerms.has(term)) {
          matchedTerms.add(term);
        }
      }
    }

    const termCoverage = matchedTerms.size / Math.max(1, intentTerms.length);
    return clamp(topScore / 10 + termCoverage * 0.5, 0, 1);
  }

  private buildDecision(
    routedToolNames: readonly string[],
    expandedToolNames: readonly string[],
    diagnostics: {
      cacheHit: boolean;
      clusterKey: string;
      confidence: number;
      invalidatedReason?: string;
    },
  ): ToolRoutingDecision {
    const routedSet = new Set(routedToolNames);
    const expandedSet = new Set(expandedToolNames);
    const schemaCharsRouted = this.indexedTools.reduce((sum, tool) => (
      routedSet.has(tool.name)
        ? sum + tool.schemaChars
        : sum
    ), 0);
    const schemaCharsExpanded = this.indexedTools.reduce((sum, tool) => (
      expandedSet.has(tool.name)
        ? sum + tool.schemaChars
        : sum
    ), 0);

    return {
      routedToolNames,
      expandedToolNames,
      diagnostics: {
        ...diagnostics,
        totalToolCount: this.indexedTools.length,
        routedToolCount: routedToolNames.length,
        expandedToolCount: expandedToolNames.length,
        schemaCharsFull: this.fullSchemaChars,
        schemaCharsRouted,
        schemaCharsExpanded,
        schemaCharsSaved: Math.max(0, this.fullSchemaChars - schemaCharsRouted),
      },
    };
  }
}
