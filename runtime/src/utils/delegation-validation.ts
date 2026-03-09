/**
 * Shared delegation result-contract and file-evidence validation helpers.
 *
 * Used by direct delegation, planner orchestration, verifier checks, and
 * final-response reconciliation to keep enforcement logic aligned.
 *
 * @module
 */

import type { LLMProviderEvidence } from "../llm/types.js";
import {
  PROVIDER_NATIVE_WEB_SEARCH_TOOL,
  isResearchLikeText,
  isProviderNativeToolName,
} from "../llm/provider-native-search.js";
import {
  extractExactOutputExpectation,
  matchesExactOutputExpectation,
  tryParseJsonObject,
} from "./delegated-contract-normalization.js";

export interface DelegationContractSpec {
  readonly task?: string;
  readonly objective?: string;
  readonly parentRequest?: string;
  readonly inputContract?: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly tools?: readonly string[];
  readonly requiredToolCapabilities?: readonly string[];
}

export interface DelegationValidationToolCall {
  readonly name?: string;
  readonly args?: unknown;
  readonly result?: string;
  readonly isError?: boolean;
}

export interface DelegationValidationProviderEvidence
  extends LLMProviderEvidence {}

export type DelegationOutputValidationCode =
  | "empty_output"
  | "empty_structured_payload"
  | "expected_json_object"
  | "acceptance_count_mismatch"
  | "acceptance_evidence_missing"
  | "missing_successful_tool_evidence"
  | "low_signal_browser_evidence"
  | "missing_file_mutation_evidence"
  | "missing_file_artifact_evidence";

export interface DelegationOutputValidationResult {
  readonly ok: boolean;
  readonly code?: DelegationOutputValidationCode;
  readonly error?: string;
  readonly parsedOutput?: Record<string, unknown>;
}

export interface DelegatedChildToolAllowlistRefinement {
  readonly allowedTools: readonly string[];
  readonly removedLowSignalBrowserTools: readonly string[];
  readonly blockedReason?: string;
}

export interface ResolvedDelegatedChildToolScope
  extends DelegatedChildToolAllowlistRefinement {
  readonly semanticFallback: readonly string[];
  readonly removedByPolicy: readonly string[];
  readonly removedAsDelegationTools: readonly string[];
  readonly removedAsUnknownTools: readonly string[];
  readonly allowsToollessExecution: boolean;
}

const EMPTY_DELEGATION_OUTPUT_VALUES = new Set(["null", "undefined", "{}", "[]"]);
const DELEGATION_FILE_ACTION_RE =
  /\b(create|write|edit|save|scaffold|implement(?:ation)?|generate|modify|patch|update|add|build)\b/i;
const DELEGATION_FILE_TARGET_RE =
  /\b(?:file|files|readme(?:\.md)?|docs?|documentation|markdown|index\.html|package\.json|tsconfig(?:\.json)?|vite\.config(?:\.[a-z]+)?|src\/|dist\/|docs\/|[a-z0-9_.-]+\.(?:html?|css|js|jsx|ts|tsx|json|md|txt|py|rs|go))\b/i;
const DELEGATION_CODE_TARGET_RE =
  /\b(?:game loop|rendering|movement|collision|scoring|score|hud|player|enemy|powerup|pathfinding|save\/load|settings|input|audio|map mutation|system|feature|module|component|class|function|logic|scene|entity|entities)\b/i;
const NARRATIVE_FILE_CLAIM_RE =
  /\b(created|wrote|saved|updated|implemented|scaffolded|generated)\b/i;
const FILE_ARTIFACT_RE =
  /(?:^|[\s`'"])(?:\/[^\s`'"]+|\.{1,2}\/[^\s`'"]+|[a-z0-9_.-]+\.[a-z0-9]{1,10})(?=$|[\s`'"])/i;
const EXPLICIT_FILE_ARTIFACT_RE =
  /(?:^|[\s`'"])(?:\/[^\s`'"]*?\.[a-z0-9]{1,10}|\.{1,2}\/[^\s`'"]*?\.[a-z0-9]{1,10}|[a-z0-9_.-]+\.[a-z0-9]{1,10})(?=$|[\s`'"])/i;
const LOCAL_FILE_REFERENCE_RE =
  /(?:^|[\s`'"])(?:\/[^\s`'"]+|\.{1,2}\/[^\s`'"]+|(?:[a-z0-9_.-]+\/)+[a-z0-9_.-]+|(?:ag(?:ent)?s|readme)\.md|[a-z0-9_.-]+\.(?:md|txt|json|js|jsx|ts|tsx|py|rs|go|toml|ya?ml|html?|css))(?=$|[\s`'"])/i;
const LOCAL_FILE_BROWSER_OVERRIDE_RE =
  /\b(?:localhost|127\.0\.0\.1|about:blank|browser|playwright|mcp\.browser|chromium|navigate|snapshot|click|type|hover|scroll|fill|select|console|network|playtest|qa|end-to-end|e2e|url|web(?:site|page)?)\b/i;
const NEGATED_BROWSER_REQUIREMENT_RE =
  /\b(?:no|non|without|avoid(?:ing)?|exclude(?:d|ing)?)\s+(?:any\s+|the\s+)?(?:browser(?:-grounded)?(?:\s+tools?)?|mcp\.browser|playwright)\b/gi;
const DO_NOT_USE_BROWSER_RE =
  /\bdo\s+not\s+use\s+(?:any\s+|the\s+)?(?:browser(?:-grounded)?(?:\s+tools?)?|mcp\.browser|playwright)\b/gi;
const ONLY_NON_BROWSER_TOOLS_RE = /\bonly\s+non-browser\s+tools?\b/gi;
const SHELL_FILE_WRITE_RE =
  /\b(?:cat|tee|touch|cp|mv|install)\b|(?:^|[^>])>{1,2}\s*\S/i;
const SHELL_SCAFFOLD_RE =
  /\b(?:npm\s+(?:create|init)|pnpm\s+(?:create|init)|yarn\s+create|bun\s+create|cargo\s+(?:new|init)|git\s+clone|npx\s+[a-z0-9_.@/-]*create[a-z0-9_.@/-]*)\b/i;
const TOOL_GROUNDED_TASK_RE =
  /\b(?:official docs?|primary sources?|browser tools?|mcp\.browser|playwright|verify|validated?|devlog|gameplay|localhost|console errors?|research|compare|reference|references|citation|framework|document(?:ation)?s?)\b/i;
const BROWSER_GROUNDED_TASK_RE =
  /\b(?:official docs?|primary sources?|browser tools?|browser-grounded|mcp\.browser|playwright|chromium|localhost|web(?:site|page)?|url|snapshot|navigate|research|compare|citation|framework|document(?:ation)?s?|validate|validation|playtest|qa|end-to-end|e2e)\b/i;
const ABOUT_BLANK_RE = /\babout:blank\b/i;
const NON_BLANK_BROWSER_TARGET_RE =
  /\b(?:https?:\/\/|file:\/\/|localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?)\S*/i;
const DOCUMENTATION_TASK_RE =
  /\b(?:readme|docs?|documentation|how[-\s]?to[-\s]?play|architecture summary|architecture docs?|playbook|writeup|guide)\b/i;
const IMPLEMENTATION_TASK_RE =
  /\b(?:implement|implementation|build|scaffold|create|edit|code|render|rendering|collision|score|hud|player|enemy|powerup|pathfinding|save\/load|settings|input|polish|ux|audio|movement|dash|map mutation)\b/i;
const VALIDATION_TASK_RE =
  /\b(?:validate|validation|verify|playtest|qa|chromium|browser|localhost|end-to-end|e2e|test|tests|build checks?)\b/i;
const SETUP_TASK_RE =
  /\b(?:scaffold|bootstrap|setup|initialize|initialise|npm\s+(?:create|init|install)|pnpm\s+(?:create|init|install|add)|yarn\s+(?:create|install|add)|bun\s+create|cargo\s+(?:new|init)|git\s+clone|npx\s+[a-z0-9_.@/-]*create[a-z0-9_.@/-]*)\b/i;
const LOW_SIGNAL_BROWSER_TOOL_NAMES = new Set([
  "mcp.browser.browser_tabs",
  "playwright.browser_tabs",
]);
const BROWSER_INTERACTION_TOOL_NAMES = new Set([
  "mcp.browser.browser_navigate",
  "mcp.browser.browser_snapshot",
  "mcp.browser.browser_click",
  "mcp.browser.browser_type",
  "mcp.browser.browser_fill_form",
  "mcp.browser.browser_select_option",
  "mcp.browser.browser_hover",
  "mcp.browser.browser_wait_for",
  "mcp.browser.browser_run_code",
  "mcp.browser.browser_evaluate",
  "mcp.browser.browser_network_requests",
  "mcp.browser.browser_console_messages",
  "playwright.browser_navigate",
  "playwright.browser_snapshot",
  "playwright.browser_click",
  "playwright.browser_type",
  "playwright.browser_fill_form",
  "playwright.browser_select_option",
  "playwright.browser_hover",
  "playwright.browser_wait_for",
  "playwright.browser_run_code",
  "playwright.browser_evaluate",
  "playwright.browser_network_requests",
  "playwright.browser_console_messages",
]);
const EXPLICIT_FILE_MUTATION_TOOL_NAMES = new Set([
  "system.writeFile",
  "system.appendFile",
  "mcp.neovim.vim_buffer_save",
  "mcp.neovim.vim_search_replace",
]);
const LOCAL_FILE_INSPECTION_TOOL_NAMES = new Set([
  "desktop.text_editor",
  "system.readFile",
  "system.listDir",
  "mcp.neovim.vim_edit",
  "mcp.neovim.vim_buffer_save",
  "mcp.neovim.vim_search_replace",
]);
const PREFERRED_PROVIDER_NATIVE_RESEARCH_TOOL_NAMES = new Set([
  PROVIDER_NATIVE_WEB_SEARCH_TOOL,
]);
const PREFERRED_RESEARCH_BROWSER_TOOL_NAMES = new Set([
  "mcp.browser.browser_navigate",
  "mcp.browser.browser_snapshot",
  "mcp.browser.browser_click",
  "mcp.browser.browser_type",
  "mcp.browser.browser_fill_form",
  "mcp.browser.browser_select_option",
  "mcp.browser.browser_hover",
  "mcp.browser.browser_wait_for",
  "mcp.browser.browser_navigate_back",
  "playwright.browser_navigate",
  "playwright.browser_snapshot",
  "playwright.browser_click",
  "playwright.browser_type",
  "playwright.browser_fill_form",
  "playwright.browser_select_option",
  "playwright.browser_hover",
  "playwright.browser_wait_for",
  "playwright.browser_navigate_back",
]);
const PREFERRED_VALIDATION_BROWSER_TOOL_NAMES = new Set([
  ...PREFERRED_RESEARCH_BROWSER_TOOL_NAMES,
  "mcp.browser.browser_console_messages",
  "mcp.browser.browser_network_requests",
  "playwright.browser_console_messages",
  "playwright.browser_network_requests",
]);
const PREFERRED_IMPLEMENTATION_EDITOR_TOOL_NAMES = new Set([
  "desktop.text_editor",
  "system.writeFile",
  "system.appendFile",
]);
const FALLBACK_IMPLEMENTATION_EDITOR_TOOL_NAMES = new Set([
  "mcp.neovim.vim_edit",
  "mcp.neovim.vim_buffer_save",
  "mcp.neovim.vim_search_replace",
]);
const PREFERRED_IMPLEMENTATION_SHELL_TOOL_NAMES = new Set([
  "desktop.bash",
  "system.bash",
]);
const INITIAL_BROWSER_NAVIGATION_TOOL_NAMES = [
  "mcp.browser.browser_navigate",
  "playwright.browser_navigate",
] as const;
const INITIAL_SETUP_TOOL_NAMES = [
  "desktop.bash",
  "system.bash",
] as const;
const INITIAL_FILE_MUTATION_TOOL_NAMES = [
  "desktop.text_editor",
  "system.writeFile",
  "system.appendFile",
  "mcp.neovim.vim_edit",
  "mcp.neovim.vim_search_replace",
  "mcp.neovim.vim_buffer_save",
] as const;
const INITIAL_FILE_INSPECTION_TOOL_NAMES = [
  "desktop.text_editor",
  "system.readFile",
  "mcp.neovim.vim_edit",
  "mcp.neovim.vim_buffer_save",
  "mcp.neovim.vim_search_replace",
] as const;
const CONTEXT_ONLY_CAPABILITY_RE =
  /\b(?:context|history|memory|conversation|recall|retrieve|retrieval|prior|previous)\b/i;

function normalizeToolNames(toolNames: readonly string[] | undefined): string[] {
  return [
    ...new Set(
      (toolNames ?? [])
        .map((toolName) => toolName.trim())
        .filter((toolName) => toolName.length > 0),
    ),
  ];
}

function looksLikeExplicitDelegatedToolName(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  return normalized.includes(".") ||
    normalized.startsWith("browser") ||
    normalized.startsWith("playwright") ||
    normalized.startsWith("desktop") ||
    normalized.startsWith("system") ||
    normalized.startsWith("mcp");
}

function isContextOnlyCapabilityName(capability: string): boolean {
  if (looksLikeExplicitDelegatedToolName(capability)) return false;
  const normalized = capability.trim().replace(/[_-]+/g, " ");
  return CONTEXT_ONLY_CAPABILITY_RE.test(normalized);
}

function extractExplicitDelegatedToolNames(
  toolNames: readonly string[] | undefined,
): string[] {
  return normalizeToolNames(toolNames).filter(looksLikeExplicitDelegatedToolName);
}

function collectDelegationStepText(
  spec: DelegationContractSpec,
  options: {
    readonly includeParentRequest?: boolean;
  } = {},
): string {
  return [
    ...(options.includeParentRequest ? [spec.parentRequest] : []),
    spec.task,
    spec.objective,
    spec.inputContract,
    ...(spec.acceptanceCriteria ?? []),
    ...(spec.requiredToolCapabilities ?? []),
    ...(spec.tools ?? []),
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ");
}

function collectDelegationContextText(spec: DelegationContractSpec): string {
  return [spec.parentRequest]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ");
}

function collectDelegationPrimaryText(spec: DelegationContractSpec): string {
  return [spec.task, spec.objective]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ");
}

function stripNegativeBrowserLanguage(value: string): string {
  return value
    .replace(NEGATED_BROWSER_REQUIREMENT_RE, " ")
    .replace(DO_NOT_USE_BROWSER_RE, " ")
    .replace(ONLY_NON_BROWSER_TOOLS_RE, " ");
}

function hasPositiveBrowserGroundingCue(value: string): boolean {
  if (value.trim().length === 0) return false;
  return BROWSER_GROUNDED_TASK_RE.test(stripNegativeBrowserLanguage(value));
}

function hasExplicitBrowserInteractionCue(value: string): boolean {
  if (value.trim().length === 0) return false;
  return LOCAL_FILE_BROWSER_OVERRIDE_RE.test(stripNegativeBrowserLanguage(value));
}

function classifyDelegatedTaskIntent(
  spec: DelegationContractSpec,
): "research" | "implementation" | "validation" | "documentation" | "other" {
  const primary = collectDelegationPrimaryText(spec);
  const combined = primary.length > 0 ? primary : collectDelegationStepText(spec);
  if (isResearchLikeText(combined)) return "research";
  if (VALIDATION_TASK_RE.test(combined)) return "validation";
  if (DOCUMENTATION_TASK_RE.test(combined)) return "documentation";
  if (IMPLEMENTATION_TASK_RE.test(combined)) return "implementation";
  return "other";
}

function isSetupHeavyDelegatedTask(spec: DelegationContractSpec): boolean {
  return SETUP_TASK_RE.test(collectDelegationStepText(spec));
}

function isBrowserToolName(toolName: string): boolean {
  return toolName.startsWith("mcp.browser.") ||
    toolName.startsWith("playwright.");
}

function specTargetsLocalFiles(spec: DelegationContractSpec): boolean {
  const combined = collectDelegationStepText(spec);
  if (!LOCAL_FILE_REFERENCE_RE.test(combined)) return false;
  return !NON_BLANK_BROWSER_TARGET_RE.test(combined);
}

function pruneDelegatedToolsByIntent(
  spec: DelegationContractSpec,
  tools: readonly string[],
): string[] {
  const normalized = normalizeToolNames(tools);
  const taskIntent = classifyDelegatedTaskIntent(spec);
  const requireBrowser = specRequiresMeaningfulBrowserEvidence(spec);
  const requireFileMutation = specRequiresFileMutationEvidence(spec);
  const localFileInspectionTask = specTargetsLocalFiles(spec);
  const hasPreferredImplementationEditor = normalized.some((toolName) =>
    PREFERRED_IMPLEMENTATION_EDITOR_TOOL_NAMES.has(toolName)
  );
  const localFileInspectionTools = normalized.filter((toolName) =>
    LOCAL_FILE_INSPECTION_TOOL_NAMES.has(toolName)
  );

  const filtered = normalized.filter((toolName) => {
    if (
      localFileInspectionTask &&
      !requireBrowser &&
      localFileInspectionTools.length > 0
    ) {
      return LOCAL_FILE_INSPECTION_TOOL_NAMES.has(toolName);
    }

    if (taskIntent === "research") {
      if (PREFERRED_PROVIDER_NATIVE_RESEARCH_TOOL_NAMES.has(toolName)) {
        return true;
      }
      if (normalized.some((candidate) =>
        PREFERRED_PROVIDER_NATIVE_RESEARCH_TOOL_NAMES.has(candidate)
      )) {
        return false;
      }
      return PREFERRED_RESEARCH_BROWSER_TOOL_NAMES.has(toolName);
    }

    if (taskIntent === "validation") {
      return PREFERRED_IMPLEMENTATION_SHELL_TOOL_NAMES.has(toolName) ||
        PREFERRED_VALIDATION_BROWSER_TOOL_NAMES.has(toolName);
    }

    if (taskIntent === "implementation" || requireFileMutation) {
      if (PREFERRED_IMPLEMENTATION_SHELL_TOOL_NAMES.has(toolName)) return true;
      if (PREFERRED_IMPLEMENTATION_EDITOR_TOOL_NAMES.has(toolName)) return true;
      if (!hasPreferredImplementationEditor) {
        return FALLBACK_IMPLEMENTATION_EDITOR_TOOL_NAMES.has(toolName);
      }
      return false;
    }

    if (requireBrowser && isBrowserToolName(toolName)) {
      return PREFERRED_VALIDATION_BROWSER_TOOL_NAMES.has(toolName) ||
        PREFERRED_RESEARCH_BROWSER_TOOL_NAMES.has(toolName);
    }

    return true;
  });

  return filtered.length > 0 ? filtered : normalized;
}

function isDelegationToolNameLike(toolName: string): boolean {
  return toolName === "execute_with_agent" ||
    toolName.startsWith("subagent.") ||
    toolName.startsWith("agenc.subagent.");
}

export function extractDelegationTokens(value: string): string[] {
  const matches = value.toLowerCase().match(/[a-z0-9_.-]+/g) ?? [];
  const deduped = new Set<string>();
  for (const match of matches) {
    if (match.length < 4) continue;
    deduped.add(match);
  }
  return [...deduped];
}

function shouldSkipAcceptanceEvidenceCriterion(criterion: string): boolean {
  return (
    /\b(?:no|without|do not|don't|never)\b/i.test(criterion) ||
    /\b(?:single|one)\s+child\s+session\b/i.test(criterion) ||
    /\b(?:child|same)\s+session\s+only\b/i.test(criterion)
  );
}

export function specRequiresFileMutationEvidence(
  spec: DelegationContractSpec,
): boolean {
  const taskIntent = classifyDelegatedTaskIntent(spec);
  if (
    [...(spec.requiredToolCapabilities ?? []), ...(spec.tools ?? [])].some((toolName) =>
      EXPLICIT_FILE_MUTATION_TOOL_NAMES.has(toolName.trim())
    )
  ) {
    return true;
  }

  if (taskIntent === "research" || taskIntent === "validation") {
    return false;
  }

  const primary = collectDelegationPrimaryText(spec);
  const combined = collectDelegationStepText(spec);
  const hasFileAction = DELEGATION_FILE_ACTION_RE.test(combined);
  const hasExplicitFileTarget = DELEGATION_FILE_TARGET_RE.test(combined);
  const hasCodeTarget = DELEGATION_CODE_TARGET_RE.test(primary);

  if (taskIntent === "implementation") {
    return hasCodeTarget || hasExplicitFileTarget || primary.trim().length > 0;
  }

  if (taskIntent === "documentation") {
    return hasFileAction && hasExplicitFileTarget;
  }

  return hasFileAction && (hasExplicitFileTarget || hasCodeTarget);
}

export function contentHasFileArtifact(value: string): boolean {
  return FILE_ARTIFACT_RE.test(value);
}

export function contentHasExplicitFileArtifact(value: string): boolean {
  return EXPLICIT_FILE_ARTIFACT_RE.test(value);
}

export function hasNarrativeFileClaim(value: string): boolean {
  return NARRATIVE_FILE_CLAIM_RE.test(value);
}

export function hasStructuredFileArtifact(value: unknown, depth = 0): boolean {
  if (depth > 4 || value == null) return false;
  if (typeof value === "string") {
    return contentHasFileArtifact(value);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => hasStructuredFileArtifact(entry, depth + 1));
  }
  if (typeof value === "object") {
    return Object.values(value).some((entry) =>
      hasStructuredFileArtifact(entry, depth + 1)
    );
  }
  return false;
}

export function outputHasFileArtifactEvidence(
  output: string,
  parsed?: Record<string, unknown>,
): boolean {
  return contentHasFileArtifact(output) || hasStructuredFileArtifact(parsed);
}

export function hasShellFileMutationArgs(args: unknown): boolean {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return false;
  }

  const payload = args as {
    command?: unknown;
    args?: unknown;
  };
  const command = typeof payload.command === "string" ? payload.command.trim() : "";
  if (command.length > 0) {
    if (SHELL_FILE_WRITE_RE.test(command)) return true;
    if (SHELL_SCAFFOLD_RE.test(command)) return true;
    const normalizedCommand = command.toLowerCase();
    if (["touch", "cp", "mv", "tee", "install"].includes(normalizedCommand)) {
      return true;
    }
  }

  return Array.isArray(payload.args) &&
    payload.args.some((entry) =>
      typeof entry === "string" &&
      /\.(?:html?|css|js|ts|tsx|jsx|json|md|txt|py|rs|go|c|cpp|h)$/i.test(entry)
    );
}

function collectStringValues(value: unknown, depth = 0): string[] {
  if (depth > 4 || value == null) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectStringValues(entry, depth + 1));
  }
  if (typeof value === "object") {
    return Object.values(value).flatMap((entry) =>
      collectStringValues(entry, depth + 1)
    );
  }
  return [];
}

function getToolCallStringValues(
  toolCall: DelegationValidationToolCall,
): string[] {
  const values = collectStringValues(toolCall.args);
  if (typeof toolCall.result === "string" && toolCall.result.trim().length > 0) {
    const parsed = tryParseJsonObject(toolCall.result);
    if (parsed) {
      values.push(...collectStringValues(parsed));
    } else {
      values.push(toolCall.result);
    }
  }
  return values;
}

function hasToolCallFileArtifactEvidence(
  toolCall: DelegationValidationToolCall,
): boolean {
  if (typeof toolCall.name !== "string" || toolCall.name.trim().length === 0) {
    return false;
  }

  if (toolCall.name === "execute_with_agent") {
    if (typeof toolCall.result !== "string" || toolCall.result.trim().length === 0) {
      return false;
    }
    const parsedResult = tryParseJsonObject(toolCall.result);
    if (!parsedResult || parsedResult.success === false) return false;
    const output =
      typeof parsedResult.output === "string" ? parsedResult.output : "";
    return outputHasFileArtifactEvidence(output);
  }

  return getToolCallStringValues(toolCall).some((value) => contentHasFileArtifact(value));
}

export function hasToolCallFileMutationEvidence(
  toolCall: DelegationValidationToolCall,
): boolean {
  if (typeof toolCall.name !== "string" || toolCall.name.trim().length === 0) {
    return false;
  }

  const normalizedToolName = toolCall.name.trim();
  if (EXPLICIT_FILE_MUTATION_TOOL_NAMES.has(normalizedToolName)) {
    return true;
  }

  if (normalizedToolName === "desktop.text_editor") {
    const command =
      typeof toolCall.args === "object" &&
        toolCall.args !== null &&
        !Array.isArray(toolCall.args) &&
        typeof (toolCall.args as { command?: unknown }).command === "string"
        ? (toolCall.args as { command: string }).command.trim().toLowerCase()
        : "";
    return command === "create" ||
      command === "str_replace" ||
      command === "insert";
  }

  if (normalizedToolName === "execute_with_agent") {
    if (typeof toolCall.result !== "string" || toolCall.result.trim().length === 0) {
      return false;
    }
    const parsedResult = tryParseJsonObject(toolCall.result);
    if (!parsedResult || parsedResult.success === false) return false;
    const output =
      typeof parsedResult.output === "string" ? parsedResult.output : "";
    return outputHasFileArtifactEvidence(output);
  }

  return (
    (normalizedToolName === "system.bash" || normalizedToolName === "desktop.bash") &&
    hasShellFileMutationArgs(toolCall.args)
  );
}

export function hasAnyToolCallFileMutationEvidence(
  toolCalls: readonly DelegationValidationToolCall[],
): boolean {
  return toolCalls.some((toolCall) => hasToolCallFileMutationEvidence(toolCall));
}

function hasAnyToolCallFileArtifactEvidence(
  toolCalls: readonly DelegationValidationToolCall[],
): boolean {
  return toolCalls.some((toolCall) => hasToolCallFileArtifactEvidence(toolCall));
}

export function hasUnsupportedNarrativeFileClaims(
  content: string,
  toolCalls: readonly DelegationValidationToolCall[],
): boolean {
  return (
    hasNarrativeFileClaim(content) &&
    contentHasExplicitFileArtifact(content) &&
    !hasAnyToolCallFileMutationEvidence(toolCalls)
  );
}

function singularizeToken(value: string): string {
  if (value.endsWith("ies") && value.length > 3) {
    return `${value.slice(0, -3)}y`;
  }
  if (value.endsWith("s") && value.length > 1) {
    return value.slice(0, -1);
  }
  return value;
}

function getCriterionArrayLength(
  parsed: Record<string, unknown>,
  collectionName: string,
): number | undefined {
  const normalizedCollection = collectionName.toLowerCase();
  const variants = new Set([
    normalizedCollection,
    singularizeToken(normalizedCollection),
  ]);
  for (const [key, value] of Object.entries(parsed)) {
    if (!Array.isArray(value)) continue;
    const normalizedKey = key.toLowerCase();
    if (
      variants.has(normalizedKey) ||
      variants.has(singularizeToken(normalizedKey))
    ) {
      return value.length;
    }
  }
  return undefined;
}

function validationFailure(
  code: DelegationOutputValidationCode,
  error: string,
  parsedOutput?: Record<string, unknown>,
): DelegationOutputValidationResult {
  return {
    ok: false,
    code,
    error,
    parsedOutput,
  };
}

function validateAcceptanceCriteriaCounts(
  acceptanceCriteria: readonly string[] | undefined,
  parsed: Record<string, unknown> | undefined,
): DelegationOutputValidationResult | undefined {
  if (!parsed || !acceptanceCriteria || acceptanceCriteria.length === 0) {
    return undefined;
  }

  for (const criterion of acceptanceCriteria) {
    const match =
      criterion.match(/\b(exactly|at least|at most)\s+(\d+)\s+([a-z0-9_.-]+)/i);
    if (!match) continue;

    const [, mode, rawCount, collectionName] = match;
    const expectedCount = Number.parseInt(rawCount, 10);
    const actualCount = getCriterionArrayLength(parsed, collectionName);
    if (actualCount === undefined) continue;

    const normalizedMode = mode.toLowerCase();
    const satisfied =
      (normalizedMode === "exactly" && actualCount === expectedCount) ||
      (normalizedMode === "at least" && actualCount >= expectedCount) ||
      (normalizedMode === "at most" && actualCount <= expectedCount);
    if (!satisfied) {
      return validationFailure(
        "acceptance_count_mismatch",
        `Acceptance criterion failed: expected ${normalizedMode} ` +
          `${expectedCount} ${collectionName}, got ${actualCount}`,
        parsed,
      );
    }
  }

  return undefined;
}

function validateBasicOutputContract(spec: {
  inputContract?: string;
  output: string;
}): DelegationOutputValidationResult {
  const trimmed = spec.output.trim();
  if (trimmed.length === 0) {
    return validationFailure(
      "empty_output",
      "Malformed result contract: empty output",
    );
  }

  const normalized = trimmed.toLowerCase();
  if (EMPTY_DELEGATION_OUTPUT_VALUES.has(normalized)) {
    return validationFailure(
      "empty_structured_payload",
      "Malformed result contract: empty structured payload",
    );
  }

  const expectsJson = spec.inputContract?.toLowerCase().includes("json") ?? false;
  const parsedOutput = expectsJson ? tryParseJsonObject(trimmed) : undefined;
  if (expectsJson && !parsedOutput) {
    return validationFailure(
      "expected_json_object",
      "Malformed result contract: expected JSON object output",
    );
  }

  return {
    ok: true,
    parsedOutput,
  };
}

function validateAcceptanceCriteriaEvidence(
  spec: DelegationContractSpec,
  output: string,
  parsedOutput: Record<string, unknown> | undefined,
  enforceAcceptanceEvidence: boolean,
): DelegationOutputValidationResult | undefined {
  const countFailure = validateAcceptanceCriteriaCounts(
    spec.acceptanceCriteria,
    parsedOutput,
  );
  if (countFailure) return countFailure;

  if (!enforceAcceptanceEvidence || (spec.acceptanceCriteria?.length ?? 0) === 0) {
    return undefined;
  }

  const remainingCriteria: string[] = [];
  for (const criterion of spec.acceptanceCriteria ?? []) {
    if (shouldSkipAcceptanceEvidenceCriterion(criterion)) {
      continue;
    }
    const expected = extractExactOutputExpectation(criterion);
    if (!expected) {
      remainingCriteria.push(criterion);
      continue;
    }
    if (!matchesExactOutputExpectation(expected, output)) {
      return validationFailure(
        "acceptance_evidence_missing",
        "Acceptance criteria not evidenced in child output",
        parsedOutput,
      );
    }
  }

  const outputLower = output.toLowerCase();
  const expectationTokens = remainingCriteria
    .flatMap((criterion) => extractDelegationTokens(criterion))
    .slice(0, 24);
  if (
    expectationTokens.length > 0 &&
    !expectationTokens.some((token) => outputLower.includes(token))
  ) {
    return validationFailure(
      "acceptance_evidence_missing",
      "Acceptance criteria not evidenced in child output",
      parsedOutput,
    );
  }

  return undefined;
}

function hasExplicitToolRequirement(spec: DelegationContractSpec): boolean {
  if ((spec.tools?.length ?? 0) > 0) return true;
  return (spec.requiredToolCapabilities ?? []).some(looksLikeExplicitDelegatedToolName);
}

export function specRequiresSuccessfulToolEvidence(
  spec: DelegationContractSpec,
): boolean {
  if (hasExplicitToolRequirement(spec)) return true;
  const stepText = collectDelegationStepText(spec);
  if (TOOL_GROUNDED_TASK_RE.test(stepText)) return true;
  const taskIntent = classifyDelegatedTaskIntent(spec);
  return (
    (taskIntent === "research" || taskIntent === "validation") &&
    TOOL_GROUNDED_TASK_RE.test(collectDelegationContextText(spec))
  );
}

export function specRequiresMeaningfulBrowserEvidence(
  spec: DelegationContractSpec,
): boolean {
  const stepText = collectDelegationStepText(spec);
  const explicitTools = normalizeToolNames([
    ...(spec.tools ?? []),
    ...(spec.requiredToolCapabilities ?? []),
  ]);
  const hasExplicitBrowserTool = explicitTools.some((capability) => {
    const normalized = capability.trim().toLowerCase();
    return normalized.startsWith("mcp.browser.") ||
      normalized.startsWith("playwright.");
  });
  if (hasExplicitBrowserTool) {
    return true;
  }
  const hasExplicitLocalFileInspectionTool = explicitTools.some((toolName) =>
    LOCAL_FILE_INSPECTION_TOOL_NAMES.has(toolName)
  );
  if (
    specTargetsLocalFiles(spec) &&
    !hasExplicitBrowserInteractionCue(stepText) &&
    (hasExplicitLocalFileInspectionTool || !hasExplicitBrowserTool)
  ) {
    return false;
  }
  const taskIntent = classifyDelegatedTaskIntent(spec);
  if (hasPositiveBrowserGroundingCue(stepText)) return true;
  return (
    (taskIntent === "research" || taskIntent === "validation") &&
    hasPositiveBrowserGroundingCue(collectDelegationContextText(spec))
  );
}

function isMeaningfulBrowserToolName(name: string): boolean {
  return BROWSER_INTERACTION_TOOL_NAMES.has(name) &&
    !LOW_SIGNAL_BROWSER_TOOL_NAMES.has(name);
}

export function refineDelegatedChildToolAllowlist(params: {
  spec: DelegationContractSpec;
  tools: readonly string[];
}): DelegatedChildToolAllowlistRefinement {
  const normalizedTools = normalizeToolNames(params.tools);
  if (!specRequiresMeaningfulBrowserEvidence(params.spec)) {
    return {
      allowedTools: normalizedTools,
      removedLowSignalBrowserTools: [],
    };
  }

  const meaningfulBrowserTools = normalizedTools.filter((toolName) =>
    isMeaningfulBrowserToolName(toolName)
  );
  const removedLowSignalBrowserTools = normalizedTools.filter((toolName) =>
    LOW_SIGNAL_BROWSER_TOOL_NAMES.has(toolName)
  );
  const taskIntent = classifyDelegatedTaskIntent(params.spec);
  const hasProviderNativeResearchTool = taskIntent === "research" &&
    normalizedTools.some((toolName) => isProviderNativeToolName(toolName));

  if (meaningfulBrowserTools.length === 0 && !hasProviderNativeResearchTool) {
    return {
      allowedTools: normalizedTools.filter((toolName) =>
        !LOW_SIGNAL_BROWSER_TOOL_NAMES.has(toolName)
      ),
      removedLowSignalBrowserTools,
      blockedReason:
        removedLowSignalBrowserTools.length > 0
          ? "Delegated task requires browser-grounded evidence but policy-scoped tools only allow low-signal browser state checks"
          : "Delegated task requires browser-grounded evidence but no meaningful browser interaction tools remain after policy scoping",
    };
  }

  return {
    allowedTools: normalizedTools.filter((toolName) =>
      !LOW_SIGNAL_BROWSER_TOOL_NAMES.has(toolName)
    ),
    removedLowSignalBrowserTools,
  };
}

export function resolveDelegatedChildToolScope(params: {
  spec: DelegationContractSpec;
  requestedTools?: readonly string[];
  parentAllowedTools?: readonly string[];
  availableTools?: readonly string[];
  forbiddenTools?: readonly string[];
  enforceParentIntersection?: boolean;
}): ResolvedDelegatedChildToolScope {
  const requested = normalizeToolNames(
    params.requestedTools ??
      extractExplicitDelegatedToolNames(params.spec.requiredToolCapabilities),
  );
  const parentAllowedSet = new Set(normalizeToolNames(params.parentAllowedTools));
  const availableSet = new Set(normalizeToolNames(params.availableTools));
  const forbiddenSet = new Set(normalizeToolNames(params.forbiddenTools));

  const removedByPolicy: string[] = [];
  const removedAsDelegationTools: string[] = [];
  const removedAsUnknownTools: string[] = [];
  const allowedTools: string[] = [];
  const semanticFallback: string[] = [];
  const taskIntent = classifyDelegatedTaskIntent(params.spec);
  const requireBrowser = specRequiresMeaningfulBrowserEvidence(params.spec);
  const requireFileMutation = specRequiresFileMutationEvidence(params.spec);
  const localFileInspectionTask = specTargetsLocalFiles(params.spec);
  const contextOnlyCapabilityRequest =
    requested.length > 0 && requested.every(isContextOnlyCapabilityName);

  const addCandidate = (
    toolName: string,
    removalBucket?: string[],
  ): void => {
    const normalized = toolName.trim();
    if (normalized.length === 0) return;
    if (
      params.enforceParentIntersection !== false &&
      parentAllowedSet.size > 0 &&
      !parentAllowedSet.has(normalized)
    ) {
      removalBucket?.push(normalized);
      return;
    }
    if (forbiddenSet.has(normalized)) {
      removalBucket?.push(normalized);
      return;
    }
    if (isDelegationToolNameLike(normalized)) {
      removedAsDelegationTools.push(normalized);
      return;
    }
    if (
      availableSet.size > 0 &&
      !availableSet.has(normalized) &&
      !isProviderNativeToolName(normalized)
    ) {
      removedAsUnknownTools.push(normalized);
      return;
    }
    if (!allowedTools.includes(normalized)) {
      allowedTools.push(normalized);
    }
  };

  for (const toolName of requested) {
    addCandidate(toolName, removedByPolicy);
  }

  const addSemanticFallback = (toolName: string): void => {
    if (!semanticFallback.includes(toolName)) {
      semanticFallback.push(toolName);
    }
    addCandidate(toolName);
  };

  const addShellSemanticFallback = (): void => {
    addSemanticFallback("desktop.bash");
    addSemanticFallback("system.bash");
  };

  if (localFileInspectionTask && !requireBrowser && !requireFileMutation) {
    addSemanticFallback("desktop.text_editor");
    addSemanticFallback("system.readFile");
    addSemanticFallback("mcp.neovim.vim_edit");
    addSemanticFallback("mcp.neovim.vim_buffer_save");
  }

  if ((requireBrowser || taskIntent === "research") && !localFileInspectionTask) {
    addSemanticFallback(PROVIDER_NATIVE_WEB_SEARCH_TOOL);
    addSemanticFallback("mcp.browser.browser_navigate");
    addSemanticFallback("mcp.browser.browser_snapshot");
    addSemanticFallback("mcp.browser.browser_run_code");
  }

  if (requireFileMutation || taskIntent === "implementation") {
    addShellSemanticFallback();
    addSemanticFallback("desktop.text_editor");
    addSemanticFallback("mcp.neovim.vim_edit");
    addSemanticFallback("mcp.neovim.vim_buffer_save");
  }

  if (taskIntent === "validation") {
    addShellSemanticFallback();
    addSemanticFallback("mcp.browser.browser_navigate");
    addSemanticFallback("mcp.browser.browser_snapshot");
    addSemanticFallback("mcp.browser.browser_run_code");
  }

  if (allowedTools.length === 0 && !contextOnlyCapabilityRequest) {
    addShellSemanticFallback();
  }

  const refined = refineDelegatedChildToolAllowlist({
    spec: params.spec,
    tools: allowedTools,
  });
  const profiledAllowedTools = pruneDelegatedToolsByIntent(
    params.spec,
    refined.allowedTools,
  );
  const profiledSemanticFallback = semanticFallback.filter((toolName) =>
    profiledAllowedTools.includes(toolName)
  );
  const allowsToollessExecution =
    profiledAllowedTools.length === 0 &&
    !specRequiresSuccessfulToolEvidence(params.spec) &&
    !refined.blockedReason;

  return {
    allowedTools: profiledAllowedTools,
    removedLowSignalBrowserTools: refined.removedLowSignalBrowserTools,
    blockedReason:
      refined.blockedReason ??
      (!allowsToollessExecution && profiledAllowedTools.length === 0
        ? "No permitted child tools remain after policy scoping"
        : undefined),
    semanticFallback: profiledSemanticFallback,
    removedByPolicy,
    removedAsDelegationTools,
    removedAsUnknownTools,
    allowsToollessExecution,
  };
}

export function resolveDelegatedInitialToolChoiceToolName(
  spec: DelegationContractSpec,
  tools: readonly string[],
): string | undefined {
  const normalizedTools = normalizeToolNames(tools);
  const taskIntent = classifyDelegatedTaskIntent(spec);
  const requireBrowser = specRequiresMeaningfulBrowserEvidence(spec);
  const requireFileMutation = specRequiresFileMutationEvidence(spec);
  const setupHeavy = isSetupHeavyDelegatedTask(spec);
  const localFileInspectionTask = specTargetsLocalFiles(spec);

  if (setupHeavy) {
    return INITIAL_SETUP_TOOL_NAMES.find((toolName) =>
      normalizedTools.includes(toolName)
    );
  }

  if (
    (taskIntent === "implementation" || requireFileMutation) &&
    taskIntent !== "validation"
  ) {
    return INITIAL_FILE_MUTATION_TOOL_NAMES.find((toolName) =>
      normalizedTools.includes(toolName)
    );
  }

  if (localFileInspectionTask && !requireBrowser) {
    return INITIAL_FILE_INSPECTION_TOOL_NAMES.find((toolName) =>
      normalizedTools.includes(toolName)
    );
  }

  if (taskIntent === "research" || taskIntent === "validation" || requireBrowser) {
    const preferredProviderResearchTool = normalizedTools.find((toolName) =>
      PREFERRED_PROVIDER_NATIVE_RESEARCH_TOOL_NAMES.has(toolName)
    );
    if (taskIntent === "research" && preferredProviderResearchTool) {
      return preferredProviderResearchTool;
    }
    return INITIAL_BROWSER_NAVIGATION_TOOL_NAMES.find((toolName) =>
      normalizedTools.includes(toolName)
    );
  }

  if (requireFileMutation) {
    return INITIAL_FILE_MUTATION_TOOL_NAMES.find((toolName) =>
      normalizedTools.includes(toolName)
    );
  }

  return undefined;
}

export function resolveDelegatedCorrectionToolChoiceToolNames(
  spec: DelegationContractSpec,
  tools: readonly string[],
  validationCode: DelegationOutputValidationCode | undefined,
): readonly string[] {
  const normalizedTools = normalizeToolNames(tools);
  if (normalizedTools.length === 0) return [];

  if (validationCode === "missing_file_mutation_evidence") {
    const preferredEditor = normalizedTools.find((toolName) =>
      PREFERRED_IMPLEMENTATION_EDITOR_TOOL_NAMES.has(toolName)
    );
    if (preferredEditor) {
      return [preferredEditor];
    }
    const systemFileWriteTool = normalizedTools.find((toolName) =>
      EXPLICIT_FILE_MUTATION_TOOL_NAMES.has(toolName)
    );
    if (systemFileWriteTool) {
      return [systemFileWriteTool];
    }
    const neovimPair = normalizedTools.filter((toolName) =>
      FALLBACK_IMPLEMENTATION_EDITOR_TOOL_NAMES.has(toolName)
    );
    if (neovimPair.length > 0) {
      return neovimPair;
    }
    const shellTools = normalizedTools.filter((toolName) =>
      PREFERRED_IMPLEMENTATION_SHELL_TOOL_NAMES.has(toolName)
    );
    if (shellTools.length > 0) {
      return shellTools;
    }
  }

  const preferredTool = resolveDelegatedInitialToolChoiceToolName(
    spec,
    normalizedTools,
  );
  return preferredTool ? [preferredTool] : [];
}

function isToolCallFailure(toolCall: DelegationValidationToolCall): boolean {
  if (toolCall.isError === true) return true;
  if (typeof toolCall.result !== "string" || toolCall.result.trim().length === 0) {
    return false;
  }
  const parsed = tryParseJsonObject(toolCall.result);
  if (!parsed) {
    return /\b(?:timed out|timeout|tool not found|permission denied|failed)\b/i.test(
      toolCall.result,
    );
  }
  if (parsed.success === false) return true;
  if (typeof parsed.error === "string" && parsed.error.trim().length > 0) {
    return true;
  }
  if (
    typeof parsed.exitCode === "number" &&
    Number.isFinite(parsed.exitCode) &&
    parsed.exitCode !== 0
  ) {
    return true;
  }
  return false;
}

function isMeaningfulBrowserToolCall(
  toolCall: DelegationValidationToolCall,
): boolean {
  const name = toolCall.name?.trim();
  if (!name || !BROWSER_INTERACTION_TOOL_NAMES.has(name)) {
    return false;
  }
  if (LOW_SIGNAL_BROWSER_TOOL_NAMES.has(name)) {
    return false;
  }

  const values = getToolCallStringValues(toolCall);
  if (values.length === 0) {
    return name !== "mcp.browser.browser_navigate" &&
      name !== "playwright.browser_navigate";
  }
  const combined = values.join(" ").toLowerCase();
  if (
    (name === "mcp.browser.browser_navigate" ||
      name === "playwright.browser_navigate") &&
    !NON_BLANK_BROWSER_TARGET_RE.test(combined)
  ) {
    return false;
  }
  if (ABOUT_BLANK_RE.test(combined) && !NON_BLANK_BROWSER_TARGET_RE.test(combined)) {
    return false;
  }
  return true;
}

function getMeaningfulBrowserEvidenceFailureMessage(
  spec: DelegationContractSpec,
  successfulCalls: readonly DelegationValidationToolCall[],
  providerEvidence?: DelegationValidationProviderEvidence,
): string | undefined {
  if (!specRequiresMeaningfulBrowserEvidence(spec)) return undefined;
  if (
    classifyDelegatedTaskIntent(spec) === "research" &&
    hasProviderCitationEvidence(providerEvidence)
  ) {
    return undefined;
  }
  if (successfulCalls.some((toolCall) => isMeaningfulBrowserToolCall(toolCall))) {
    return undefined;
  }
  return "Delegated task required browser-grounded evidence but child only used low-signal browser state checks";
}

function hasProviderCitationEvidence(
  providerEvidence: DelegationValidationProviderEvidence | undefined,
): boolean {
  return (providerEvidence?.citations ?? []).some((citation) =>
    typeof citation === "string" && citation.trim().length > 0
  );
}

function getSuccessfulToolEvidenceFailure(
  toolCalls: readonly DelegationValidationToolCall[] | undefined,
  spec?: DelegationContractSpec,
  providerEvidence?: DelegationValidationProviderEvidence,
): {
  code: "missing_successful_tool_evidence" | "low_signal_browser_evidence";
  message: string;
} | undefined {
  if (
    spec &&
    classifyDelegatedTaskIntent(spec) === "research" &&
    hasProviderCitationEvidence(providerEvidence)
  ) {
    return undefined;
  }
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return {
      code: "missing_successful_tool_evidence",
      message:
        "Delegated task required successful tool-grounded evidence but child reported no tool calls",
    };
  }
  const successfulCalls = toolCalls.filter((toolCall) => !isToolCallFailure(toolCall));
  if (successfulCalls.length === 0) {
    return {
      code: "missing_successful_tool_evidence",
      message:
        "Delegated task required successful tool-grounded evidence but all child tool calls failed",
    };
  }
  if (spec) {
    const browserEvidenceFailure = getMeaningfulBrowserEvidenceFailureMessage(
      spec,
      successfulCalls,
      providerEvidence,
    );
    if (browserEvidenceFailure) {
      return {
        code: "low_signal_browser_evidence",
        message: browserEvidenceFailure,
      };
    }
  }
  return undefined;
}

function validateSuccessfulToolEvidence(
  spec: DelegationContractSpec,
  parsedOutput: Record<string, unknown> | undefined,
  toolCalls: readonly DelegationValidationToolCall[] | undefined,
  providerEvidence: DelegationValidationProviderEvidence | undefined,
): DelegationOutputValidationResult | undefined {
  if (!specRequiresSuccessfulToolEvidence(spec) || !Array.isArray(toolCalls)) {
    if (
      specRequiresSuccessfulToolEvidence(spec) &&
      classifyDelegatedTaskIntent(spec) === "research" &&
      hasProviderCitationEvidence(providerEvidence)
    ) {
      return undefined;
    }
    return undefined;
  }
  const failure = getSuccessfulToolEvidenceFailure(
    toolCalls,
    spec,
    providerEvidence,
  );
  if (failure) {
    return validationFailure(
      failure.code,
      failure.message,
      parsedOutput,
    );
  }
  return undefined;
}

export function getMissingSuccessfulToolEvidenceMessage(
  toolCalls: readonly DelegationValidationToolCall[] | undefined,
  spec?: DelegationContractSpec,
  providerEvidence?: DelegationValidationProviderEvidence,
): string | undefined {
  return getSuccessfulToolEvidenceFailure(
    toolCalls,
    spec,
    providerEvidence,
  )?.message;
}

function validateFileMutationEvidence(
  spec: DelegationContractSpec,
  output: string,
  parsedOutput: Record<string, unknown> | undefined,
  toolCalls: readonly DelegationValidationToolCall[] | undefined,
): DelegationOutputValidationResult | undefined {
  if (!specRequiresFileMutationEvidence(spec) || !Array.isArray(toolCalls)) {
    return undefined;
  }

  if (!hasAnyToolCallFileMutationEvidence(toolCalls)) {
    return validationFailure(
      "missing_file_mutation_evidence",
      "Delegated task required file creation/edit evidence but child used no file mutation tools",
      parsedOutput,
    );
  }

  if (!outputHasFileArtifactEvidence(output, parsedOutput)) {
    if (hasAnyToolCallFileArtifactEvidence(toolCalls)) {
      return undefined;
    }
    return validationFailure(
      "missing_file_artifact_evidence",
      "Delegated task required file artifact evidence but child output did not identify any files",
      parsedOutput,
    );
  }

  return undefined;
}

export function validateDelegatedOutputContract(params: {
  spec: DelegationContractSpec;
  output: string;
  toolCalls?: readonly DelegationValidationToolCall[];
  providerEvidence?: DelegationValidationProviderEvidence;
  enforceAcceptanceEvidence?: boolean;
}): DelegationOutputValidationResult {
  const {
    spec,
    output,
    toolCalls,
    providerEvidence,
    enforceAcceptanceEvidence = true,
  } = params;
  const baseValidation = validateBasicOutputContract({
    inputContract: spec.inputContract,
    output,
  });
  if (!baseValidation.ok) return baseValidation;

  const parsedOutput = baseValidation.parsedOutput;
  const toolEvidenceFailure = validateSuccessfulToolEvidence(
    spec,
    parsedOutput,
    toolCalls,
    providerEvidence,
  );
  if (toolEvidenceFailure) return toolEvidenceFailure;

  const fileEvidenceFailure = validateFileMutationEvidence(
    spec,
    output,
    parsedOutput,
    toolCalls,
  );
  if (fileEvidenceFailure) return fileEvidenceFailure;

  const acceptanceFailure = validateAcceptanceCriteriaEvidence(
    spec,
    output,
    parsedOutput,
    enforceAcceptanceEvidence,
  );
  if (acceptanceFailure) return acceptanceFailure;

  return baseValidation;
}
