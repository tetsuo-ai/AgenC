import type { LLMMessage, LLMTool } from "../llm/types.js";
import type { ChatToolRoutingSummary } from "../llm/chat-executor.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";
import {
  HIGH_SIGNAL_BROWSER_TOOL_NAMES,
  LOW_SIGNAL_BROWSER_TOOL_NAMES,
  PRIMARY_BROWSER_READ_TOOL_NAMES,
  PRIMARY_BROWSER_START_TOOL_NAMES,
} from "../utils/browser-tool-taxonomy.js";
import {
  createTypedArtifactTermSet,
  createTypedArtifactToolNameSet,
} from "../tools/system/typed-artifact-domains.js";

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
  "desktop.text_editor",
  "system.readFile",
  "system.writeFile",
  "system.listDir",
  // Keep delegation entrypoint always available so routed subsets
  // can still spawn child agents when the user asks for parallel delegation.
  "execute_with_agent",
];

const DEFAULT_FAMILY_CAPS: Record<string, number> = {
  system: 12,
  desktop: 10,
  playwright: 8,
  agenc: 8,
  wallet: 6,
  social: 6,
  "mcp.kitty": 9,
  "mcp.tmux": 8,
  "mcp.neovim": 8,
  "mcp.browser": 10,
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

const PROCESS_TERMS = new Set([
  "background",
  "daemon",
  "log",
  "logs",
  "monitor",
  "pid",
  "process",
  "server",
  "service",
  "status",
  "stop",
  "worker",
]);

const PROCESS_START_TOOL_NAMES = new Set([
  "desktop.process_start",
  "system.processStart",
  "system.serverStart",
]);

const PROCESS_STATUS_TOOL_NAMES = new Set([
  "desktop.process_status",
  "system.processStatus",
  "system.processResume",
  "system.processLogs",
  "system.serverStatus",
  "system.serverResume",
  "system.serverLogs",
]);

const PROCESS_STOP_TOOL_NAMES = new Set([
  "desktop.process_stop",
  "system.processStop",
  "system.serverStop",
]);

const PROCESS_START_TERMS = new Set([
  "background",
  "launch",
  "run",
  "server",
  "service",
  "spawn",
  "start",
  "worker",
]);

const PROCESS_STATUS_TERMS = new Set([
  "health",
  "log",
  "logs",
  "monitor",
  "output",
  "pid",
  "readiness",
  "ready",
  "running",
  "state",
  "status",
]);

const PROCESS_STOP_TERMS = new Set([
  "close",
  "exit",
  "kill",
  "quit",
  "stop",
  "terminate",
]);

const SERVER_TOOL_NAMES = new Set([
  "system.serverStart",
  "system.serverStatus",
  "system.serverResume",
  "system.serverStop",
  "system.serverLogs",
]);

const REMOTE_JOB_TOOL_NAMES = new Set([
  "system.remoteJobStart",
  "system.remoteJobStatus",
  "system.remoteJobResume",
  "system.remoteJobCancel",
  "system.remoteJobArtifacts",
]);

const RESEARCH_TOOL_NAMES = new Set([
  "system.researchStart",
  "system.researchStatus",
  "system.researchResume",
  "system.researchUpdate",
  "system.researchComplete",
  "system.researchBlock",
  "system.researchArtifacts",
  "system.researchStop",
]);

const SANDBOX_TOOL_NAMES = new Set([
  "system.sandboxStart",
  "system.sandboxStatus",
  "system.sandboxResume",
  "system.sandboxStop",
  "system.sandboxJobStart",
  "system.sandboxJobStatus",
  "system.sandboxJobResume",
  "system.sandboxJobStop",
  "system.sandboxJobLogs",
]);

const SQLITE_TOOL_NAMES = createTypedArtifactToolNameSet("sqlite");
const PDF_TOOL_NAMES = createTypedArtifactToolNameSet("pdf");
const SPREADSHEET_TOOL_NAMES = createTypedArtifactToolNameSet("spreadsheet");
const OFFICE_DOCUMENT_TOOL_NAMES = createTypedArtifactToolNameSet("office-document");
const EMAIL_MESSAGE_TOOL_NAMES = createTypedArtifactToolNameSet("email-message");
const CALENDAR_TOOL_NAMES = createTypedArtifactToolNameSet("calendar");

const REMOTE_JOB_TERMS = new Set([
  "callback",
  "callbacks",
  "job",
  "jobs",
  "mcp",
  "poll",
  "polling",
  "remote",
  "server",
  "webhook",
]);

const RESEARCH_TERMS = new Set([
  "analysis",
  "artifact",
  "artifacts",
  "citation",
  "citations",
  "notes",
  "report",
  "research",
  "resume",
  "source",
  "sources",
  "summary",
  "verify",
  "verifier",
]);

const SANDBOX_TERMS = new Set([
  "container",
  "docker",
  "environment",
  "execution",
  "exec",
  "isolated",
  "sandbox",
  "workspace",
]);

const SQLITE_TERMS = createTypedArtifactTermSet("sqlite", "routingTerms");
const DOCUMENT_TERMS = createTypedArtifactTermSet("pdf", "routingTerms");
const SPREADSHEET_TERMS = createTypedArtifactTermSet("spreadsheet", "routingTerms");
const OFFICE_DOCUMENT_TERMS = createTypedArtifactTermSet("office-document", "routingTerms");
const EMAIL_MESSAGE_TERMS = createTypedArtifactTermSet("email-message", "routingTerms");
const CALENDAR_TERMS = createTypedArtifactTermSet("calendar", "routingTerms");

const HARD_SQLITE_TERMS = createTypedArtifactTermSet("sqlite", "hardRoutingTerms");
const HARD_PDF_TERMS = createTypedArtifactTermSet("pdf", "hardRoutingTerms");
const HARD_SPREADSHEET_TERMS = createTypedArtifactTermSet("spreadsheet", "hardRoutingTerms");
const HARD_OFFICE_DOCUMENT_TERMS = createTypedArtifactTermSet("office-document", "hardRoutingTerms");
const HARD_EMAIL_MESSAGE_TERMS = createTypedArtifactTermSet("email-message", "hardRoutingTerms");
const HARD_CALENDAR_TERMS = createTypedArtifactTermSet("calendar", "hardRoutingTerms");

const DOOM_TERMS = new Set([
  "doom",
  "vizdoom",
  "defend_the_center",
  "freedoom",
]);

const TERMINAL_TERMS = new Set([
  "terminal",
  "kitty",
]);

const OPEN_ACTION_TERMS = new Set([
  "open",
  "launch",
  "start",
  "spawn",
  "create",
  "new",
]);

const CLOSE_ACTION_TERMS = new Set([
  "close",
  "quit",
  "exit",
  "dismiss",
  "kill",
  "terminate",
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

const TAB_MANAGEMENT_TERMS = new Set([
  "tab",
  "tabs",
  "window",
  "windows",
  "session",
  "sessions",
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

const MCP_TERMS = new Set([
  "mcp",
  "kitty",
  "tmux",
  "neovim",
  "nvim",
  "vim",
  "editor",
  "pane",
  "session",
  "window",
]);

const AGENC_PROTOCOL_INTENT_RE =
  /\b(?:agenc|on-?chain|solana|lamports?|stake|reputation|slashing|escrow|pda|devnet|mainnet|proof(?:s)?\s+of\s+completion|claim(?:able|ing)?\s+tasks?|agent\s+registration|register(?:ed|ing)?\s+(?:the\s+)?agent|capabilit(?:y|ies))\b/i;

const MARKETPLACE_PROTOCOL_INTENT_RE =
  /\b(?:marketplace|service\s+request|service\s+bids?|agent\s+marketplace)\b/i;

const SOCIAL_PROTOCOL_INTENT_RE =
  /\b(?:social(?:\.[a-z_]+)?|message(?:s|ing)?|inbox|feed|recipient|collaboration|reputation|agent\s+message|send\s+message|recent\s+messages?)\b/i;

const SOLANA_AUDIT_INTENT_RE =
  /\b(?:fender|anchor|solana\s+program|anchor\s+program|sealevel|program\s+audit|smart\s+contract\s+audit|rust\s+program|instruction\s+audit|account\s+validation|vulnerabilit(?:y|ies)|security\s+audit)\b/i;

const REQUIRED_MCP_FAMILY_BY_TERM: Record<string, string> = {
  kitty: "mcp.kitty",
  tmux: "mcp.tmux",
  neovim: "mcp.neovim",
  nvim: "mcp.neovim",
  vim: "mcp.neovim",
};

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

type TerminalIntent = "none" | "generic" | "open" | "close";

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

interface ExplicitToolMention {
  readonly toolName: string;
  readonly fullVariants: readonly string[];
  readonly shortVariants: readonly string[];
}

function isProtocolScopedTool(toolName: string): boolean {
  return toolName.startsWith("agenc.") ||
    toolName.startsWith("marketplace.") ||
    toolName.startsWith("social.") ||
    toolName.startsWith("wallet.") ||
    toolName.startsWith("mcp.solana-fender.");
}

function protectedToolIntentSatisfied(
  toolName: string,
  messageText: string,
  explicitToolMentions: ReadonlySet<string>,
): boolean {
  if (explicitToolMentions.has(toolName)) {
    return true;
  }
  if (toolName.startsWith("agenc.")) {
    return AGENC_PROTOCOL_INTENT_RE.test(messageText);
  }
  if (toolName.startsWith("marketplace.")) {
    return MARKETPLACE_PROTOCOL_INTENT_RE.test(messageText);
  }
  if (toolName.startsWith("social.")) {
    return SOCIAL_PROTOCOL_INTENT_RE.test(messageText);
  }
  if (toolName.startsWith("wallet.")) {
    return /\b(?:wallet|transfer|sign|signing|token|tokens|sol|lamports?|airdrop)\b/i
      .test(messageText);
  }
  if (toolName.startsWith("mcp.solana-fender.")) {
    return SOLANA_AUDIT_INTENT_RE.test(messageText);
  }
  return true;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toTerms(value: string): string[] {
  const lower = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
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

function normalizeToolMention(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
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
  const prefix = name.slice(0, firstDot).toLowerCase();
  // For MCP tools (mcp.kitty.launch, mcp.tmux.list-sessions, etc.),
  // use the first two segments as the family so each server gets its own cap.
  if (prefix === "mcp") {
    const secondDot = name.indexOf(".", firstDot + 1);
    if (secondDot > firstDot) {
      return name.slice(0, secondDot).toLowerCase();
    }
  }
  return prefix;
}

function requiredFamiliesForTerms(terms: readonly string[]): Set<string> {
  const required = new Set<string>();
  for (const term of terms) {
    const family = REQUIRED_MCP_FAMILY_BY_TERM[term];
    if (family) required.add(family);
  }
  return required;
}

function addToolSet(target: Set<string>, toolNames: ReadonlySet<string>): void {
  for (const toolName of toolNames) {
    target.add(toolName);
  }
}

function requiredToolNamesForTerms(terms: readonly string[]): Set<string> {
  const required = new Set<string>();
  if (terms.some((term) => HARD_SQLITE_TERMS.has(term))) {
    addToolSet(required, SQLITE_TOOL_NAMES);
  }
  if (terms.some((term) => HARD_PDF_TERMS.has(term))) {
    addToolSet(required, PDF_TOOL_NAMES);
  }
  if (terms.some((term) => HARD_SPREADSHEET_TERMS.has(term))) {
    addToolSet(required, SPREADSHEET_TOOL_NAMES);
  }
  if (terms.some((term) => HARD_OFFICE_DOCUMENT_TERMS.has(term))) {
    addToolSet(required, OFFICE_DOCUMENT_TOOL_NAMES);
  }
  if (terms.some((term) => HARD_EMAIL_MESSAGE_TERMS.has(term))) {
    addToolSet(required, EMAIL_MESSAGE_TOOL_NAMES);
  }
  if (terms.some((term) => HARD_CALENDAR_TERMS.has(term))) {
    addToolSet(required, CALENDAR_TOOL_NAMES);
  }
  return required;
}

function hasAllRequiredToolNames(
  toolNames: readonly string[],
  requiredToolNames: ReadonlySet<string>,
): boolean {
  if (requiredToolNames.size === 0) return true;
  const available = new Set(toolNames);
  for (const toolName of requiredToolNames) {
    if (!available.has(toolName)) {
      return false;
    }
  }
  return true;
}

function resolveTerminalIntent(terms: readonly string[]): TerminalIntent {
  const hasTerminalIntent = terms.some((term) => TERMINAL_TERMS.has(term));
  if (!hasTerminalIntent) return "none";

  if (terms.some((term) => CLOSE_ACTION_TERMS.has(term))) return "close";
  if (terms.some((term) => OPEN_ACTION_TERMS.has(term))) return "open";
  return "generic";
}

function hasAnyToolInFamily(toolNames: readonly string[], family: string): boolean {
  return toolNames.some((name) => familyFromToolName(name) === family);
}

function hasStrongCurrentIntent(terms: readonly string[]): boolean {
  return terms.some((term) =>
    PROCESS_TERMS.has(term) ||
    REMOTE_JOB_TERMS.has(term) ||
    RESEARCH_TERMS.has(term) ||
    SANDBOX_TERMS.has(term) ||
    SQLITE_TERMS.has(term) ||
    DOCUMENT_TERMS.has(term) ||
    SPREADSHEET_TERMS.has(term) ||
    OFFICE_DOCUMENT_TERMS.has(term) ||
    EMAIL_MESSAGE_TERMS.has(term) ||
    CALENDAR_TERMS.has(term) ||
    DOOM_TERMS.has(term) ||
    TERMINAL_TERMS.has(term) ||
    BROWSER_TERMS.has(term) ||
    MCP_TERMS.has(term)
  );
}

function normalizeToolCountBounds(
  config: ToolRoutingConfig | undefined,
): Pick<NormalizedRoutingConfig, "minToolsPerTurn" | "maxToolsPerTurn" | "maxExpandedToolsPerTurn"> {
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
  return {
    minToolsPerTurn,
    maxToolsPerTurn,
    maxExpandedToolsPerTurn,
  };
}

function normalizeCacheConfig(
  config: ToolRoutingConfig | undefined,
): Pick<NormalizedRoutingConfig, "cacheTtlMs" | "minCacheConfidence" | "pivotSimilarityThreshold" | "pivotMissThreshold"> {
  return {
    cacheTtlMs: clamp(
      Math.floor(config?.cacheTtlMs ?? 10 * 60_000),
      10_000,
      24 * 60 * 60_000,
    ),
    minCacheConfidence: clamp(
      typeof config?.minCacheConfidence === "number"
        ? config.minCacheConfidence
        : 0.5,
      0,
      1,
    ),
    pivotSimilarityThreshold: clamp(
      typeof config?.pivotSimilarityThreshold === "number"
        ? config.pivotSimilarityThreshold
        : 0.25,
      0,
      1,
    ),
    pivotMissThreshold: clamp(
      Math.floor(config?.pivotMissThreshold ?? 2),
      1,
      20,
    ),
  };
}

function normalizeMandatoryTools(
  config: ToolRoutingConfig | undefined,
): string[] {
  return Array.from(
    new Set([
      ...DEFAULT_MANDATORY_TOOLS,
      ...(config?.mandatoryTools ?? []),
    ]),
  );
}

function normalizeFamilyCaps(
  config: ToolRoutingConfig | undefined,
): Readonly<Record<string, number>> {
  const familyCaps: Record<string, number> = {
    ...DEFAULT_FAMILY_CAPS,
  };
  for (const [family, cap] of Object.entries(config?.familyCaps ?? {})) {
    if (!Number.isFinite(cap)) continue;
    familyCaps[family.toLowerCase()] = clamp(Math.floor(cap), 1, 128);
  }
  return familyCaps;
}

function normalizeConfig(config: ToolRoutingConfig | undefined): NormalizedRoutingConfig {
  const toolCountBounds = normalizeToolCountBounds(config);
  const cacheConfig = normalizeCacheConfig(config);

  return {
    enabled: config?.enabled ?? true,
    ...toolCountBounds,
    ...cacheConfig,
    mandatoryTools: normalizeMandatoryTools(config),
    familyCaps: normalizeFamilyCaps(config),
  };
}

export class ToolRouter {
  private readonly logger: Logger;
  private readonly config: NormalizedRoutingConfig;
  private readonly indexedTools: IndexedTool[];
  private readonly explicitMentions: ExplicitToolMention[];
  private readonly shortVariantOwners: Map<string, readonly string[]>;
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
    const shortVariantOwners = new Map<string, string[]>();
    this.explicitMentions = this.indexedTools.map((tool) => {
      const shortName = tool.name.slice(tool.name.lastIndexOf(".") + 1);
      const fullVariants = new Set<string>([
        tool.name.toLowerCase(),
        normalizeToolMention(tool.name),
      ]);
      const shortVariants = new Set<string>([
        shortName.toLowerCase(),
        normalizeToolMention(shortName),
      ]);
      for (const variant of shortVariants) {
        const owners = shortVariantOwners.get(variant) ?? [];
        owners.push(tool.name);
        shortVariantOwners.set(variant, owners);
      }
      return {
        toolName: tool.name,
        fullVariants: Array.from(fullVariants),
        shortVariants: Array.from(shortVariants),
      };
    });
    this.shortVariantOwners = new Map(
      Array.from(shortVariantOwners.entries()).map(([variant, owners]) => [
        variant,
        Array.from(new Set(owners)).sort(),
      ]),
    );
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

    const currentIntentTerms = toTerms(params.messageText);
    const intentTerms = this.extractIntentTerms(currentIntentTerms, params.history);
    const explicitToolMentions = this.extractExplicitToolMentions(params.messageText);
    const clusterKey = intentTerms.slice(0, 6).join("|") || "general";
    const now = Date.now();
    const cached = this.cache.get(params.sessionId);
    const requiredFamilies = requiredFamiliesForTerms(currentIntentTerms);
    const requiredToolNames = requiredToolNamesForTerms(currentIntentTerms);
    const terminalIntent = resolveTerminalIntent(currentIntentTerms);

    let invalidatedReason: string | undefined;
    if (cached) {
      const cachedTerminalIntent = resolveTerminalIntent(cached.terms);
      if (cached.missCount >= this.config.pivotMissThreshold) {
        invalidatedReason = "tool_miss_threshold";
      } else if (cached.expiresAt <= now) {
        invalidatedReason = "ttl_expired";
      } else if (EXPLICIT_PIVOT_RE.test(params.messageText)) {
        invalidatedReason = "explicit_redirect";
      } else if (
        terminalIntent !== "none" &&
        cachedTerminalIntent !== "none" &&
        terminalIntent !== cachedTerminalIntent
      ) {
        invalidatedReason = "terminal_action_shift";
      } else if (
        Array.from(requiredFamilies).some(
          (family) => !hasAnyToolInFamily(cached.routedToolNames, family),
        )
      ) {
        invalidatedReason = "missing_required_family";
      } else if (
        !hasAllRequiredToolNames(cached.routedToolNames, requiredToolNames)
      ) {
        invalidatedReason = "missing_required_tools";
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

    const scored = this.scoreTools(
      params.messageText,
      intentTerms,
      explicitToolMentions,
    );
    const routedToolNames = this.selectRoutedTools(
      scored,
      requiredFamilies,
      requiredToolNames,
      explicitToolMentions,
    );
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
    currentTerms: readonly string[],
    history: readonly LLMMessage[],
  ): string[] {
    const terms = new Set<string>(currentTerms);
    const shouldBlendHistory = currentTerms.length < 6 && !hasStrongCurrentIntent(currentTerms);

    if (!shouldBlendHistory) {
      return Array.from(terms).sort();
    }

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

  private extractExplicitToolMentions(messageText: string): Set<string> {
    const lowered = messageText.toLowerCase();
    const normalized = normalizeToolMention(messageText);
    const mentioned = new Set<string>();

    for (const candidate of this.explicitMentions) {
      for (const variant of candidate.fullVariants) {
        if (!variant) continue;
        if (
          lowered.includes(variant) ||
          normalized.includes(variant)
        ) {
          mentioned.add(candidate.toolName);
          break;
        }
      }
    }

    for (const candidate of this.explicitMentions) {
      if (mentioned.has(candidate.toolName)) continue;
      for (const variant of candidate.shortVariants) {
        if (!variant) continue;
        const owners = this.shortVariantOwners.get(variant) ?? [];
        if (owners.length !== 1 || owners[0] !== candidate.toolName) {
          continue;
        }
        if (
          lowered.includes(variant) ||
          normalized.includes(variant)
        ) {
          mentioned.add(candidate.toolName);
          break;
        }
      }
    }

    return mentioned;
  }

  private scoreTools(
    messageText: string,
    intentTerms: readonly string[],
    explicitToolMentions: ReadonlySet<string>,
  ): Array<{ tool: IndexedTool; score: number }> {
    const hasShellIntent = intentTerms.some((term) => SHELL_TERMS.has(term));
    const hasProcessIntent = intentTerms.some((term) => PROCESS_TERMS.has(term));
    const wantsProcessStart = intentTerms.some((term) => PROCESS_START_TERMS.has(term));
    const wantsProcessStatus = intentTerms.some((term) => PROCESS_STATUS_TERMS.has(term));
    const wantsProcessStop = intentTerms.some((term) => PROCESS_STOP_TERMS.has(term));
    const wantsBackgroundWorkflow = intentTerms.includes("background");
    const hasRemoteJobIntent = intentTerms.some((term) => REMOTE_JOB_TERMS.has(term));
    const hasResearchIntent = intentTerms.some((term) => RESEARCH_TERMS.has(term));
    const hasSandboxIntent = intentTerms.some((term) => SANDBOX_TERMS.has(term));
    const hasSqliteIntent = intentTerms.some((term) => SQLITE_TERMS.has(term));
    const hasDocumentIntent = intentTerms.some((term) => DOCUMENT_TERMS.has(term));
    const hasSpreadsheetIntent = intentTerms.some((term) =>
      SPREADSHEET_TERMS.has(term)
    );
    const hasOfficeDocumentIntent = intentTerms.some((term) =>
      OFFICE_DOCUMENT_TERMS.has(term)
    );
    const hasEmailMessageIntent = intentTerms.some((term) =>
      EMAIL_MESSAGE_TERMS.has(term)
    );
    const hasCalendarIntent = intentTerms.some((term) =>
      CALENDAR_TERMS.has(term)
    );
    const wantsTypedServer =
      explicitToolMentions.has("system.serverStart") ||
      (
        (intentTerms.includes("server") || intentTerms.includes("service")) &&
        (
          intentTerms.includes("health") ||
          intentTerms.includes("ready") ||
          intentTerms.includes("readiness") ||
          intentTerms.includes("http") ||
          intentTerms.includes("localhost") ||
          intentTerms.includes("local")
        )
      );
    const prefersDesktopProcessHandles =
      wantsBackgroundWorkflow &&
      !wantsTypedServer &&
      !explicitToolMentions.has("system.processStart") &&
      !explicitToolMentions.has("system.serverStart");
    const hasDoomIntent = intentTerms.some((term) => DOOM_TERMS.has(term));
    const wantsDoomStop = hasDoomIntent && wantsProcessStop;
    const hasBrowserIntent = intentTerms.some((term) => BROWSER_TERMS.has(term));
    const wantsResearchHandles =
      hasResearchIntent &&
      !hasBrowserIntent &&
      !hasRemoteJobIntent;
    const hasFileIntent = intentTerms.some((term) => FILE_TERMS.has(term));
    const hasNetworkIntent = intentTerms.some((term) => NETWORK_TERMS.has(term));
    const hasMCPIntent = intentTerms.some((term) => MCP_TERMS.has(term));
    const explicitTabIntent = intentTerms.some((term) => TAB_MANAGEMENT_TERMS.has(term));
    const requiredFamilies = requiredFamiliesForTerms(intentTerms);
    const terminalIntent = resolveTerminalIntent(intentTerms);

    const scored = this.indexedTools.map((tool) => {
      if (
        isProtocolScopedTool(tool.name) &&
        !protectedToolIntentSatisfied(tool.name, messageText, explicitToolMentions)
      ) {
        return { tool, score: Number.NEGATIVE_INFINITY };
      }

      let score = 0;

      for (const term of intentTerms) {
        if (tool.keywords.has(term)) score += 3;
        if (tool.descriptionTerms.has(term)) score += 1;
      }

      if (explicitToolMentions.has(tool.name)) {
        score += 40;
      }

      if (hasShellIntent && (tool.name === "system.bash" || tool.name === "desktop.bash")) {
        score += 4;
      }
      if (
        hasProcessIntent &&
        (
          tool.name.startsWith("desktop.process_") ||
          tool.name.startsWith("system.process") ||
          tool.name.startsWith("system.server")
        )
      ) {
        score += 10;
      }
      if (wantsTypedServer && SERVER_TOOL_NAMES.has(tool.name)) {
        score += 14;
      }
      if (hasRemoteJobIntent && REMOTE_JOB_TOOL_NAMES.has(tool.name)) {
        score += 14;
      }
      if (wantsResearchHandles && RESEARCH_TOOL_NAMES.has(tool.name)) {
        score += 14;
      }
      if (hasSqliteIntent && SQLITE_TOOL_NAMES.has(tool.name)) {
        score += 16;
      }
      if (hasDocumentIntent && PDF_TOOL_NAMES.has(tool.name)) {
        score += 16;
      }
      if (hasSpreadsheetIntent && SPREADSHEET_TOOL_NAMES.has(tool.name)) {
        score += 16;
      }
      if (hasOfficeDocumentIntent && OFFICE_DOCUMENT_TOOL_NAMES.has(tool.name)) {
        score += 16;
      }
      if (hasEmailMessageIntent && EMAIL_MESSAGE_TOOL_NAMES.has(tool.name)) {
        score += 16;
      }
      if (hasCalendarIntent && CALENDAR_TOOL_NAMES.has(tool.name)) {
        score += 16;
      }
      if (hasSandboxIntent && SANDBOX_TOOL_NAMES.has(tool.name)) {
        score += 18;
      } else if (
        hasSandboxIntent &&
        (
          tool.name.startsWith("system.process") ||
          tool.name.startsWith("system.server") ||
          tool.name.startsWith("desktop.process_")
        )
      ) {
        score -= 6;
      }
      if (prefersDesktopProcessHandles) {
        if (tool.name.startsWith("desktop.process_")) {
          score += 18;
        } else if (
          tool.name.startsWith("system.server") ||
          tool.name.startsWith("system.process")
        ) {
          score -= 6;
        }
      }
      if (wantsProcessStart && PROCESS_START_TOOL_NAMES.has(tool.name)) {
        score += 12;
      }
      if (wantsProcessStatus && PROCESS_STATUS_TOOL_NAMES.has(tool.name)) {
        score += 12;
      }
      if (wantsProcessStop && PROCESS_STOP_TOOL_NAMES.has(tool.name)) {
        score += 12;
      }
      if (hasDoomIntent && tool.name.startsWith("mcp.doom.")) {
        score += 10;
      }
      if (wantsDoomStop) {
        if (tool.name === "mcp.doom.stop_game") {
          score += 24;
        } else if (tool.name === "desktop.process_stop") {
          score -= 10;
        } else if (tool.name === "desktop.bash") {
          score -= 6;
        }
      }
      if (terminalIntent !== "none" && tool.family === "mcp.kitty") {
        score += 4;
      }
      if (terminalIntent === "open") {
        if (tool.name === "mcp.kitty.launch") {
          score += 18;
        } else if (tool.name === "mcp.kitty.close") {
          score -= 6;
        } else if (tool.name === "desktop.window_list") {
          score -= 2;
        }
      }
      if (terminalIntent === "close") {
        if (tool.name === "mcp.kitty.close") {
          score += 20;
        } else if (
          tool.name === "desktop.window_focus" ||
          tool.name === "desktop.keyboard_key"
        ) {
          score += 8;
        } else if (tool.name === "desktop.window_list") {
          score -= 3;
        } else if (tool.name === "mcp.kitty.launch" || tool.name === "mcp.kitty.send_text") {
          score -= 6;
        }
      }
      if (hasBrowserIntent) {
        if (
          tool.family === "playwright" ||
          tool.name.startsWith("system.browse") ||
          tool.name.startsWith("system.browserSession") ||
          tool.family === "mcp.browser"
        ) {
          score += 2;
        }
        if (HIGH_SIGNAL_BROWSER_TOOL_NAMES.has(tool.name)) {
          score += 5;
        }
        if (PRIMARY_BROWSER_START_TOOL_NAMES.has(tool.name)) {
          score += 8;
        } else if (PRIMARY_BROWSER_READ_TOOL_NAMES.has(tool.name)) {
          score += 2;
        }
        if (LOW_SIGNAL_BROWSER_TOOL_NAMES.has(tool.name)) {
          score += explicitTabIntent ? 8 : -4;
        }
      }
      if (hasMCPIntent && tool.family.startsWith("mcp.")) {
        score += 3;
      }
      if (requiredFamilies.has(tool.family)) {
        score += 6;
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
      if (
        hasFileIntent &&
        (
          SQLITE_TOOL_NAMES.has(tool.name) ||
          PDF_TOOL_NAMES.has(tool.name) ||
          SPREADSHEET_TOOL_NAMES.has(tool.name) ||
          OFFICE_DOCUMENT_TOOL_NAMES.has(tool.name)
        )
      ) {
        score += 4;
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
    requiredFamilies: ReadonlySet<string>,
    requiredToolNames: ReadonlySet<string>,
    explicitToolMentions: ReadonlySet<string>,
  ): string[] {
    const selected = new Set<string>();
    const familyCounts = new Map<string, number>();
    const hardPinnedToolNames = new Set<string>();

    for (const mandatoryTool of this.config.mandatoryTools) {
      if (!this.allToolNames.includes(mandatoryTool)) continue;
      selected.add(mandatoryTool);
      hardPinnedToolNames.add(mandatoryTool);
      const family = familyFromToolName(mandatoryTool);
      familyCounts.set(family, (familyCounts.get(family) ?? 0) + 1);
    }

    const maxTools = this.config.maxToolsPerTurn;
    const minTools = this.config.minToolsPerTurn;
    const requiredFamilySelections = new Map<string, IndexedTool>();
    for (const requiredFamily of requiredFamilies) {
      const bestRequired = scored.find((entry) => entry.tool.family === requiredFamily);
      if (!bestRequired) continue;
      requiredFamilySelections.set(requiredFamily, bestRequired.tool);
      hardPinnedToolNames.add(bestRequired.tool.name);
    }
    for (const requiredToolName of requiredToolNames) {
      if (this.allToolNames.includes(requiredToolName)) {
        hardPinnedToolNames.add(requiredToolName);
      }
    }
    for (const mentionedTool of explicitToolMentions) {
      if (this.allToolNames.includes(mentionedTool)) {
        hardPinnedToolNames.add(mentionedTool);
      }
    }
    const hardPinLimit = Math.min(
      this.config.maxExpandedToolsPerTurn,
      Math.max(maxTools, hardPinnedToolNames.size),
    );

    const tryAdd = (
      candidate: IndexedTool,
      options?: { readonly limit?: number; readonly ignoreFamilyCap?: boolean },
    ): void => {
      if (selected.has(candidate.name)) return;
      const limit = options?.limit ?? maxTools;
      if (selected.size >= limit) return;

      const familyCap = this.config.familyCaps[candidate.family] ??
        this.config.familyCaps.default ??
        DEFAULT_FAMILY_CAPS.default;
      const usedInFamily = familyCounts.get(candidate.family) ?? 0;
      if (!options?.ignoreFamilyCap && usedInFamily >= familyCap) return;

      selected.add(candidate.name);
      familyCounts.set(candidate.family, usedInFamily + 1);
    };

    for (const bestRequired of requiredFamilySelections.values()) {
      tryAdd(bestRequired, { limit: hardPinLimit });
    }

    for (const requiredToolName of requiredToolNames) {
      const explicitMatch = scored.find((entry) => entry.tool.name === requiredToolName);
      if (!explicitMatch) continue;
      tryAdd(explicitMatch.tool, {
        limit: hardPinLimit,
        ignoreFamilyCap: true,
      });
    }

    for (const mentionedTool of explicitToolMentions) {
      const explicitMatch = scored.find((entry) => entry.tool.name === mentionedTool);
      if (!explicitMatch) continue;
      tryAdd(explicitMatch.tool, {
        limit: hardPinLimit,
        ignoreFamilyCap: true,
      });
    }

    for (const entry of scored) {
      if (!Number.isFinite(entry.score)) continue;
      if (entry.score <= 0 && selected.size >= minTools) break;
      tryAdd(entry.tool);
    }

    if (selected.size < minTools) {
      for (const entry of scored) {
        if (selected.size >= minTools) break;
        if (selected.size >= maxTools) break;
        if (!Number.isFinite(entry.score)) continue;
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
      if (!Number.isFinite(entry.score)) continue;
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
