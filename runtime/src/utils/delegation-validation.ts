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
import {
  DELEGATION_MEANINGFUL_BROWSER_TOOL_NAMES,
  DELEGATION_MEANINGFUL_RESEARCH_TOOL_NAMES,
  INITIAL_RESEARCH_TOOL_NAMES,
  INITIAL_BROWSER_NAVIGATION_TOOL_NAMES,
  LOW_SIGNAL_BROWSER_TOOL_NAMES,
  PREFERRED_RESEARCH_BROWSER_TOOL_NAMES,
  PREFERRED_VALIDATION_BROWSER_TOOL_NAMES,
} from "./browser-tool-taxonomy.js";

export interface DelegationContractSpec {
  readonly task?: string;
  readonly objective?: string;
  readonly parentRequest?: string;
  readonly inputContract?: string;
  readonly acceptanceCriteria?: readonly string[];
  /**
   * Explicit tool requirements that are part of the delegated contract itself.
   *
   * Do not stuff policy-scoped allowlists into this field. Ambient child tool
   * availability is execution context, not contract semantics, and conflating
   * the two causes false validation requirements.
   */
  readonly tools?: readonly string[];
  readonly requiredToolCapabilities?: readonly string[];
  readonly contextRequirements?: readonly string[];
  readonly lastValidationCode?: DelegationOutputValidationCode;
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
  | "acceptance_probe_failed"
  | "forbidden_phase_action"
  | "blocked_phase_output"
  | "contradictory_completion_claim"
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
  /\b(?:file|files|readme(?:\.md)?|docs?|documentation|markdown|index\.html|package\.json|tsconfig(?:\.json)?|vite\.config(?:\.[a-z]+)?|src\/|dist\/|docs\/|demos?\/|tests?\/|__tests__\/|specs?\/|[a-z0-9_.-]+\.(?:html?|css|js|jsx|ts|tsx|json|md|txt|py|rs|go))(?=$|[\s,.;:!?)]|`|'|")/i;
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
const EXPLICIT_BROWSER_ENVIRONMENT_CUE_RE =
  /\b(?:localhost|127\.0\.0\.1|about:blank|browser(?:-grounded)?|playwright|mcp\.browser|chromium|playtest|url|website|web\s+site|webpage|web\s+page)\b/i;
const BROWSER_ACTION_CUE_RE =
  /\b(?:navigate(?:\s+(?:to|the\s+(?:browser|page|site)|page|site|url))|click(?:\s+(?:the\s+)?(?:page|button|link|tab|selector|element))|hover(?:\s+(?:over|on)\s+(?:the\s+)?(?:page|button|link|selector|element))|scroll(?:\s+(?:the\s+)?(?:page|browser|viewport))|fill(?:\s+(?:the\s+)?(?:form|input|field))|select(?:\s+(?:the\s+)?(?:option|dropdown))|console\s+errors?|network\s+requests?)\b/i;
const BROWSER_SNAPSHOT_CUE_RE =
  /\b(?:(?:browser|page|website|web\s+site|webpage|web\s+page|ui|visual)\s+snapshot|snapshot\s+(?:of|for)\s+(?:the\s+)?(?:browser|page|website|web\s+site|webpage|web\s+page|ui|visual)|mcp\.browser\.browser_snapshot|playwright\.browser_snapshot)\b/i;
const NEGATED_BROWSER_REQUIREMENT_RE =
  /\b(?:no|non|without|avoid(?:ing)?|exclude(?:d|ing)?)\s+(?:any\s+|the\s+)?(?:browser(?:-grounded)?(?:\s+tools?)?|mcp\.browser|playwright)\b/gi;
const DO_NOT_USE_BROWSER_RE =
  /\bdo\s+not\s+use\s+(?:any\s+|the\s+)?(?:browser(?:-grounded)?(?:\s+tools?)?|mcp\.browser|playwright)\b/gi;
const ONLY_NON_BROWSER_TOOLS_RE = /\bonly\s+non-browser\s+tools?\b/gi;
const SHELL_FILE_WRITE_RE =
  /\b(?:cat|tee|touch|cp|mv|install)\b|(?:^|[^>])>{1,2}\s*\S/i;
const SHELL_IN_PLACE_EDIT_RE =
  /\b(?:sed|perl|ruby)\b(?:(?![|;&\n]).)*\s-(?:[A-Za-z]*i|pi)(?:\b|=|['"])/i;
const SHELL_SCAFFOLD_RE =
  /\b(?:npm\s+(?:create|init)|pnpm\s+(?:create|init)|yarn\s+create|bun\s+create|cargo\s+(?:new|init)|git\s+clone|npx\s+[a-z0-9_.@/-]*create[a-z0-9_.@/-]*)\b/i;
const TOOL_GROUNDED_TASK_RE =
  /\b(?:official docs?|primary sources?|browser tools?|mcp\.browser|playwright|verify|validated?|devlog|gameplay|localhost|console errors?|research|compare|reference|references|citation|framework|document(?:ation)?s?)\b/i;
const BROWSER_GROUNDED_TASK_RE =
  /\b(?:official docs?|primary sources?|browser tools?|browser-grounded|mcp\.browser|playwright|chromium|localhost|website|web\s+site|webpage|web\s+page|url|navigate|research|compare|citation|framework|document(?:ation)?s?|validate|validation|playtest|qa|end-to-end|e2e)\b/i;
const ABOUT_BLANK_RE = /\babout:blank\b/i;
const NON_BLANK_BROWSER_TARGET_RE =
  /\b(?:https?:\/\/|file:\/\/|localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?)\S*/i;
const DOCUMENTATION_TASK_RE =
  /\b(?:readme|documentation|how[-\s]?to[-\s]?play|architecture summary|architecture docs?|playbook|writeup|guide)\b/i;
const IMPLEMENTATION_TASK_RE =
  /\b(?:implement|implementation|build|scaffold|create|edit|code|render|rendering|collision|score|hud|player|enemy|powerup|pathfinding|save\/load|settings|input|polish|ux|audio|movement|dash|map mutation)\b/i;
const VALIDATION_STRONG_TASK_RE =
  /\b(?:validate|validation|verify|verified|playtest|qa|end-to-end|e2e|test|tests|smoke test|acceptance test|build checks?)\b/i;
const VALIDATION_WEAK_TASK_RE = /\b(?:browser|chromium|localhost)\b/i;
const ACCEPTANCE_VERIFICATION_CUE_RE =
  /\b(?:compile|compiles|compiled|compiling|build(?:able|\s+checks?)?|test(?:able|s)?|verify|validated?|confirm|install(?:able|s|ed|ing)?|stdout|stderr|exit(?:\s+code|s)?)\b/i;
const ACCEPTANCE_BUILD_VERIFICATION_RE =
  /\b(?:compiles?|compiled|compiling|builds?|built|typechecks?|lints?|installs?)\b(?:\s+(?:cleanly|correctly|successfully|without errors?))?|\b(?:compile|build|typecheck|lint|install)\s+(?:cleanly|correctly|successfully|without errors?|passes?|succeeds?)\b/i;
const ACCEPTANCE_TEST_VERIFICATION_RE =
  /\b(?:tests?\s+(?:pass|passing|passed|run|runs|running|succeed|succeeds|succeeded)|(?:vitest|jest|pytest|mocha|ava)\s+(?:run|runs|passes?|succeeds?)|coverage(?:\s+(?:reported|generated|collected))?)\b/i;
const ACCEPTANCE_SCRIPT_DEFINITION_RE =
  /\bscripts?\b/i;
const ACCEPTANCE_SCRIPT_NAME_RE =
  /\b(?:build|test|coverage|dev|lint|typecheck|start|serve|preview)\b/i;
const ACCEPTANCE_SCRIPT_DEFINITION_VERB_RE =
  /\b(?:set|defined?|configured?|present|added?|included?|listed?|author(?:ed)?|wrote|created?)\b/i;
const ACCEPTANCE_CONFIG_DEFINITION_RE =
  /\b(?:package\.json|tsconfig(?:\.json)?|vite(?:\.config)?|vitest(?:\.config)?|jest(?:\.config)?|manifests?|configs?|configurations?)\b/i;
const ACCEPTANCE_CONFIG_DEFINITION_VERB_RE =
  /\b(?:present|exists?|defined?|configured?|added?|included?|listed?|declared?|valid|author(?:ed)?|wrote|created?)\b/i;
const ACCEPTANCE_CONFIG_FIELD_INVENTORY_RE =
  /\b(?:private|name|version|main|module|types|exports?|bin|scripts?|dependencies|devdependencies|devdeps?|peerdependencies|optionaldependencies|workspaces?|metadata|file:\.\.?\/|file:|local deps?)\b/i;
const ACCEPTANCE_DOCUMENTATION_DEFINITION_RE =
  /\b(?:readme(?:\.md)?|docs?|documentation|instructions?|usage|setup|quickstart|get(?:ting)?\s+started)\b/i;
const ACCEPTANCE_DOCUMENTATION_DEFINITION_VERB_RE =
  /\b(?:present|exists?|author(?:ed)?|wrote|created?|added?|included?|outlined?|section(?:s)?|placeholder(?:s)?|skeleton|template)\b/i;
const ACCEPTANCE_STRONG_VERIFICATION_CUE_RE =
  /\b(?:pass(?:es|ed|ing)?|succeed(?:s|ed|ing)?|run(?:s|ning)?|ran|verify|verified|validated?|confirm(?:ed|s)?|coverage|stdout|stderr|exit(?:\s+code|s)?|cleanly|correctly|successfully|without errors?)\b/i;
const ACCEPTANCE_BUILD_TEST_OUTCOME_RE =
  /\b(?:compiles?|compiled|compiling|builds|built|building|typechecks?|typechecked|lints?|linted|installs?|installed|installing)\b/i;
const ACCEPTANCE_EXPLICIT_EXECUTION_RE =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:install|test|run)\b|\b(?:vitest|jest|pytest|mocha|ava|tsc|vite)\s+(?:run|build|test)\b/i;
const HOST_BROWSER_VERIFICATION_CUE_RE =
  /\b(?:chrom(?:e|ium)|playwright|browser|page|selector|snapshot|console|network|headless|screenshot|e2e|end-to-end|web\s+flow|web\s+app|ui)\b/i;
const LOCALHOST_TARGET_CUE_RE =
  /\b(?:localhost|127\.0\.0\.1|baseurl|base-url|port\s+\d+)\b/i;
const NEGATIVE_PHASE_CONTRACT_RE =
  /\b(?:no|without|do not|don't|never|must not|should not)\b/i;
const AUTHOR_ONLY_PHASE_CONTRACT_RE =
  /\b(?:author only|file authoring only|scaffold only|placeholder(?:s)? only|skeleton(?:s)? only)\b/i;
const PHASE_INSTALL_TERM_RE =
  /\b(?:install|dependencies|npm\s+install|pnpm\s+install|yarn\s+install|bun\s+install)\b/i;
const PHASE_BUILD_TERM_RE = /\b(?:build|compile)\b/i;
const PHASE_TEST_TERM_RE = /\b(?:test|tests|vitest|jest|coverage)\b/i;
const PHASE_TYPECHECK_TERM_RE = /\b(?:typecheck|type-check|tsc)\b/i;
const PHASE_LINT_TERM_RE = /\b(?:lint|eslint)\b/i;
const WORKSPACE_PROTOCOL_RE = /\bworkspace:\*/i;
const SHELL_INSTALL_COMMAND_RE =
  /(?:^|[;&|]\s*)(?:npm|pnpm|yarn|bun)\s+install\b/i;
const SHELL_BUILD_COMMAND_RE =
  /(?:^|[;&|]\s*)(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build(?:\b|:)|vite\s+build\b|tsc\b)/i;
const SHELL_TEST_COMMAND_RE =
  /(?:^|[;&|]\s*)(?:(?:npm|pnpm|yarn|bun)\s+test\b|(?:vitest|jest|pytest|mocha|ava)\b)/i;
const SHELL_TYPECHECK_COMMAND_RE =
  /(?:^|[;&|]\s*)(?:(?:npm|pnpm|yarn|bun)\s+run\s+typecheck(?:\b|:)|tsc\b(?:\s+--noemit\b)?)/i;
const SHELL_LINT_COMMAND_RE =
  /(?:^|[;&|]\s*)(?:(?:npm|pnpm|yarn|bun)\s+run\s+lint(?:\b|:)|eslint\b)/i;
const OUTPUT_INSTALL_EXPLICIT_COMMAND_RE =
  /\b(?:npm|pnpm|yarn|bun)\s+install\b/i;
const OUTPUT_INSTALL_OUTCOME_CLAIM_RE =
  /\binstall(?:ed|ation)?\b[^.\n]{0,60}\b(?:succeed(?:ed|s)?|verified|confirmed|worked|complete(?:d)?|pass(?:ed|es)?)\b/i;
const OUTPUT_BUILD_EXPLICIT_COMMAND_RE =
  /\b(?:(?:npm|pnpm|yarn|bun)\s+run\s+build(?:\b|:)|vite\s+build\b|tsc\b(?:\s+--noemit\b)?)/i;
const OUTPUT_BUILD_OUTCOME_CLAIM_RE =
  /\b(?:build|compile|compiled|compiles?)\b[^.\n]{0,60}\b(?:succeed(?:ed|s)?|verified|confirmed|cleanly|without errors?|pass(?:ed|es)?)\b/i;
const OUTPUT_TEST_EXPLICIT_COMMAND_RE =
  /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|coverage|vitest|jest))(?:\b|:)|vitest\s+(?:run|--run)\b|jest\s+--runinband\b|pytest\b|mocha\b|ava\b)/i;
const OUTPUT_TEST_OUTCOME_CLAIM_RE =
  /\btests?\b[^.\n]{0,48}\b(?:pass(?:ed|es)?|succeed(?:ed|s)?|verified|confirmed)\b|\bcoverage\b[^.\n]{0,48}\b(?:reported|generated|collected|pass(?:ed|es)?)\b/i;
const OUTPUT_TYPECHECK_EXPLICIT_COMMAND_RE =
  /\b(?:(?:npm|pnpm|yarn|bun)\s+run\s+typecheck(?:\b|:)|tsc\b(?:\s+--noemit\b)?)/i;
const OUTPUT_TYPECHECK_OUTCOME_CLAIM_RE =
  /\btypechecks?\b[^.\n]{0,48}\b(?:succeed(?:ed|s)?|verified|confirmed|cleanly|without errors?|pass(?:ed|es)?)\b/i;
const OUTPUT_LINT_EXPLICIT_COMMAND_RE =
  /\b(?:(?:npm|pnpm|yarn|bun)\s+run\s+lint(?:\b|:)|eslint\b)/i;
const OUTPUT_LINT_OUTCOME_CLAIM_RE =
  /\blint(?:ed|ing)?\b[^.\n]{0,48}\b(?:succeed(?:ed|s)?|verified|confirmed|cleanly|without errors?|pass(?:ed|es)?)\b/i;
const OUTPUT_DEFINITION_CONTEXT_RE =
  /\b(?:package\.json|tsconfig(?:\.json)?|vite(?:\.config(?:\.[a-z]+)?)?|vitest(?:\.config(?:\.[a-z]+)?)?|jest(?:\.config(?:\.[a-z]+)?)?|eslint(?:\.config(?:\.[a-z]+)?)?|scripts?|devdeps?|devdependencies|dependencies|workspaces?|manifests?|configs?|configurations?|\.gitignore)\b/i;
const OUTPUT_DEFINITION_INSPECTION_VERB_RE =
  /\b(?:author(?:ed)?|wrote|created|added|configured?|defined?|declared?|listed?|included?|present|exists?|matched?|matches|confirm(?:ed|s)?|inspect(?:ed|ion)?|ground(?:ed|ing)?|reviewed?)\b/i;
const OUTPUT_EXECUTION_OUTCOME_CUE_RE =
  /\b(?:run|ran|execut(?:e|ed|ing)|pass(?:es|ed|ing)?|succeed(?:s|ed|ing)?|failed|failing|cleanly|successfully|without errors?|reported|generated|collected|exit(?:\s+code|s)?|stdout|stderr|timed out)\b/i;
const OUTPUT_AFFIRMATIVE_EXECUTION_CUE_RE =
  /\b(?:ran|execut(?:e|ed|ing)|perform(?:ed|ing)?|verified|validated?|confirm(?:ed|s|ing)?|pass(?:es|ed|ing)?|succeed(?:s|ed|ing)?|failed|failing|cleanly|successfully|without errors?|reported|generated|collected|timed out|exit(?:\s+code|s)?|stdout|stderr|built|compiled|installed|tested|typechecked|linted)\b/i;
const TOOLCALL_BUILD_EVIDENCE_RE =
  /\b(?:build|compiles?|compiled|compiling|typecheck|lint|install|tsc)\b/i;
const TOOLCALL_TEST_EVIDENCE_RE =
  /\b(?:test|tests|vitest|jest|pytest|mocha|ava|spec)\b/i;
const SETUP_TASK_RE =
  /\b(?:scaffold|bootstrap|setup|initialize|initialise|npm\s+(?:create|init|install)|pnpm\s+(?:create|init|install|add)|yarn\s+(?:create|install|add)|bun\s+create|cargo\s+(?:new|init)|git\s+clone|npx\s+[a-z0-9_.@/-]*create[a-z0-9_.@/-]*)\b/i;
const TEST_ARTIFACT_TARGET_RE =
  /\b(?:vitest|jest|mocha|ava|tap|tests?\/|__tests__\/|spec(?:s)?\/|[a-z0-9_.-]+\.test\.[a-z0-9]+|[a-z0-9_.-]+\.spec\.[a-z0-9]+)(?=$|[\s,.;:!?)]|`|'|")/i;
const DELEGATED_COMPLETION_CLAIM_RE =
  /\b(?:done|complete(?:d)?|finished|implemented|created|written|ready|passes?|passing|succeeds?|successful(?:ly)?|meets?(?: the)? acceptance criteria|matches?(?: the)? acceptance criteria)\b/i;
const DELEGATED_INCOMPLETE_WORK_CONTEXT_RE =
  /\bincomplete\b(?=[^.\n]{0,48}\b(?:implementation|work|phase|deliverable|coverage|logic|support|tests?|validation|integration|migration|module|component|feature|api|ui|fix(?:es)?|follow[- ]?up|todo|stub|remaining|missing|unsupported|unverified)\b)|\b(?:implementation|work|phase|deliverable|coverage|logic|support|tests?|validation|integration|migration|module|component|feature|api|ui|fix(?:es)?|follow[- ]?up|todo|stub|remaining|missing|unsupported|unverified)\b[^.\n]{0,24}\bincomplete\b/i;
const DELEGATED_UNRESOLVED_WORK_RE = new RegExp(
  [
    String.raw`\b(?:may|might|could|would)(?:\s+\w+){0,2}\s+need(?:ed)?\b`,
    String.raw`\b(?:need(?:ed|s)?|requires?)\s+(?:minor\s+)?(?:(?:impl(?:ementation)?|integration)\s+)?(?:tweaks?|fix(?:es)?|changes?|follow[- ]?ups?|adjustments?)\b`,
    String.raw`\b(?:mismatch(?:es)?|placeholder(?:s)?|stub(?:bed|bing|s)?|todo|fixme|not yet implemented|unimplemented|approximate|approximation|manual follow[- ]?up)\b`,
    String.raw`\b(?:acceptance\s+(?:criterion|criteria)|criterion|criteria)\b[^.\n]{0,64}\b(?:unmet|unsatisfied|not met|not satisfied|lacks?(?:\s+full)?\s+evidence|missing\s+evidence|not evidenced|failed)\b`,
    String.raw`\b(?:unmet|unsatisfied|not met|not satisfied)\b[^.\n]{0,32}\bacceptance\s+(?:criterion|criteria)\b`,
    String.raw`\black(?:ing|s)?(?:\s+full)?\s+evidence\b`,
    DELEGATED_INCOMPLETE_WORK_CONTEXT_RE.source,
    String.raw`\bpartial(?:ly)?\b(?=[^.\n]{0,40}\b(?:coverage|work|implementation|implemented|complete|completed|done|needed|missing|unsupported|unverified|incomplete|placeholder|stub|fix(?:es)?|follow[- ]?up|adjustments?)\b)`,
    String.raw`\b(?:omit(?:ted)?|skip(?:ped)?)\b[^.\n]{0,80}\b(?:due to|because|pending|until|blocked|blocking|mismatch|error|failure|issue|issues)\b`,
    String.raw`\bblocked(?:\s+on)?\b(?=[^.\n]{0,64}\b(?:verification|validation|finish|complete|completed|proceed|deliver|resolve|pending|issue|issues|dependency|dependencies|workspace)\b)`,
    String.raw`\bblocking\b(?=[^.\n]{0,48}\b(?:issue|issues|dependency|dependencies|verification|validation|completion|finish|complete|deliver)\b)`,
    String.raw`\b(?:cannot|can't|unable to|could not|did not)\b[^.\n]{0,64}\b(?:finish|complete|proceed|deliver|verify|validate|resolve|run|support|implement|fix)\b`,
  ].join("|"),
  "i",
);
const DELEGATED_CODE_ELISION_RE = new RegExp(
  [
    String.raw`\bfull\s+(?:implementation|component|logic|behavior|jsx|code|ui)\b[^.\n]{0,40}\bomitted\b`,
    String.raw`\brest\s+of\s+(?:the\s+)?(?:component|file|code|implementation|logic|jsx|behavior|ui|structure)\b[^.\n]{0,48}\b(?:remain(?:s)?\s+unchanged|unchanged|preserved)\b`,
    String.raw`\boriginal\s+(?:jsx|structure|behavior|logic|ui|component)\b[^.\n]{0,40}\bpreserved\b`,
  ].join("|"),
  "i",
);
const DELEGATED_BLOCKED_PHASE_RE = new RegExp(
  [
    String.raw`\b(?:phase|task|step|implementation|deliverable|work|result)\b[^.\n]{0,24}\bblocked\b`,
    String.raw`\bblocked(?:\s+on)?\b(?=[^.\n]{0,64}\b(?:phase|task|step|implementation|deliverable|work|verification|validation|completion|finish|complete|proceed|continue|deliver|finalize|ready)\b)`,
    String.raw`\b(?:cannot|can't|unable to|could not)\b[^.\n]{0,64}\b(?:finish|complete|proceed|continue|deliver|finalize|verify|validate)\b`,
    String.raw`\b(?:phase|task|step|implementation|deliverable|work|result)\b[^.\n]{0,40}\b(?:not complete|incomplete)\b`,
  ].join("|"),
  "i",
);
const DELEGATED_BENIGN_PHASE_TRANSITION_RE =
  /\bready for next phase\b|\bno sibling steps?\b|\bfinal deliverable synthesized\b/gi;
const DELEGATION_EXPECTED_PLACEHOLDER_RE =
  /\b(?:placeholder(?:s)?|stub(?:s)?|scaffold(?:ing)?|skeleton|boilerplate)\b/i;
const DELEGATED_ALLOWABLE_PLACEHOLDER_RE =
  /\b(?:placeholder(?:s)?|stub(?:bed|bing|s)?|todo|fixme|not yet implemented|unimplemented)\b/gi;
const RESOLVED_PLACEHOLDER_CUE_RE = new RegExp(
  [
    String.raw`\b(?:replace(?:d)?|overwrote?|rewrote?|filled in|completed)\b[^.\n]{0,48}\b(?:placeholder(?:s)?|stub(?:s)?|scaffold(?:ing)?|skeleton|boilerplate)\b`,
    String.raw`\b(?:placeholder(?:s)?|stub(?:s)?|scaffold(?:ing)?|skeleton|boilerplate)\b[^.\n]{0,48}\b(?:replace(?:d)?|overwrote?|rewrote?|filled in|completed)\b`,
  ].join("|"),
  "i",
);
const HISTORICAL_STATE_CUE_RE =
  /\b(?:inspect(?:ed|ion)?|initial|starting|existing|scaffold(?:ed|ing)?|prior|before|preexisting)\b/i;
const RESOLUTION_CUE_RE =
  /\b(?:overwrite|overwrote|replace(?:d)?|rewrote?|updated|implemented|filled in|completed)\b/i;
const CODE_LIKE_FILE_PATH_RE =
  /\.(?:[cm]?[jt]sx?|jsx?|py|rs|go|java|kt|c|cc|cpp|h|hpp|swift|rb|php)$/i;
const GENERATED_ARTIFACT_PATH_SEGMENT_RE =
  /(?:^|\/)(?:dist|build|coverage|out|\.next|\.nuxt)(?:\/|$)/i;
const GENERATED_ARTIFACT_FILE_RE =
  /\.(?:d\.[cm]?ts|map|tsbuildinfo)$/i;
const BENIGN_RUNTIME_MESSAGE_CONTEXT_RE =
  /\b(?:console\.(?:debug|info|log|warn|error)|logger\.(?:debug|info|log|warn|error)|toast(?:\.[a-z]+)?|set(?:Status|Message|Error)|statusText|helperText|label|title|aria-label)\b/i;
const EXPLICIT_FILE_MUTATION_TOOL_NAMES = new Set([
  "system.writeFile",
  "system.appendFile",
  "system.mkdir",
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
const VERIFICATION_EXECUTION_TOOL_NAMES = new Set([
  "system.bash",
  "desktop.bash",
  "system.processStart",
  "system.processStatus",
  "system.sandboxJobStart",
  "system.sandboxJobResume",
  "system.sandboxJobLogs",
]);
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
  "system.listDir",
  "mcp.neovim.vim_edit",
  "mcp.neovim.vim_buffer_save",
  "mcp.neovim.vim_search_replace",
] as const;
const CONTEXT_ONLY_CAPABILITY_RE =
  /\b(?:context|history|memory|conversation|recall|retrieve|retrieval|prior|previous)\b/i;
const FILE_READ_CAPABILITY_RE =
  /\b(?:file\s*read|read\s*file|file\s*inspect(?:ion)?|inspect(?:ion)?|list\s*(?:dir|directory)|directory\s*listing)\b/i;
const FILE_WRITE_CAPABILITY_RE =
  /\b(?:file\s*system\s*write|file\s*write|write\s*file|file\s*mutation|code\s*generation|edit\s*file|create\s*file)\b/i;
const SHELL_EXECUTION_CAPABILITY_RE =
  /\b(?:bash|shell|command\s*execution|run\s*command|workspace|process)\b/i;

function normalizeToolNames(toolNames: readonly string[] | undefined): string[] {
  return [
    ...new Set(
      (toolNames ?? [])
        .map((toolName) => toolName.trim())
        .filter((toolName) => toolName.length > 0),
    ),
  ];
}

function normalizeCapabilityName(value: string): string {
  return value.trim().replace(/[_-]+/g, " ").toLowerCase();
}

function isGenericFilesystemCapabilityName(capability: string): boolean {
  const normalized = capability.trim().toLowerCase();
  return normalized === "filesystem" || normalized === "file system";
}

function looksLikeExplicitDelegatedToolName(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  return normalized === "execute_with_agent" ||
    normalized === PROVIDER_NATIVE_WEB_SEARCH_TOOL ||
    normalized.includes(".") ||
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

function getDelegatedCapabilityProfile(spec: DelegationContractSpec): {
  readonly hasConstraints: boolean;
  readonly hasFileWrite: boolean;
  readonly hasShellExecution: boolean;
  readonly hasBrowserInteraction: boolean;
  readonly hasRecognizedConstraint: boolean;
  readonly isReadOnlyContract: boolean;
} {
  const requestedSource = normalizeToolNames([
    ...(spec.requiredToolCapabilities ?? []),
    ...(spec.tools ?? []),
  ]);
  const explicitTools = extractExplicitDelegatedToolNames(requestedSource);
  const semanticCapabilities = requestedSource
    .filter((toolName) => !looksLikeExplicitDelegatedToolName(toolName))
    .map((capability) => normalizeCapabilityName(capability));
  const hasFileWrite = explicitTools.some((toolName) =>
    EXPLICIT_FILE_MUTATION_TOOL_NAMES.has(toolName)
  ) ||
    semanticCapabilities.some((capability) =>
      FILE_WRITE_CAPABILITY_RE.test(capability) ||
      isGenericFilesystemCapabilityName(capability)
    );
  const hasShellExecution = explicitTools.some((toolName) =>
    PREFERRED_IMPLEMENTATION_SHELL_TOOL_NAMES.has(toolName) ||
    VERIFICATION_EXECUTION_TOOL_NAMES.has(toolName)
  ) ||
    semanticCapabilities.some((capability) =>
      SHELL_EXECUTION_CAPABILITY_RE.test(capability)
    );
  const hasBrowserInteraction = explicitTools.some((toolName) =>
    isBrowserToolName(toolName)
  );
  const hasRecognizedSemanticConstraint = semanticCapabilities.some((capability) =>
    isContextOnlyCapabilityName(capability) ||
    FILE_READ_CAPABILITY_RE.test(capability) ||
    FILE_WRITE_CAPABILITY_RE.test(capability) ||
    SHELL_EXECUTION_CAPABILITY_RE.test(capability) ||
    isGenericFilesystemCapabilityName(capability)
  );
  const hasRecognizedConstraint =
    explicitTools.length > 0 ||
    hasRecognizedSemanticConstraint;

  return {
    hasConstraints: requestedSource.length > 0,
    hasFileWrite,
    hasShellExecution,
    hasBrowserInteraction,
    hasRecognizedConstraint,
    isReadOnlyContract:
      requestedSource.length > 0 &&
      hasRecognizedConstraint &&
      !hasFileWrite &&
      !hasShellExecution &&
      !hasBrowserInteraction,
  };
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

function normalizeDelegationClassifierText(value: string): string {
  return value.replace(/[_-]+/g, " ");
}

function countPatternMatches(value: string, pattern: RegExp): number {
  if (value.length === 0) return 0;
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const matcher = new RegExp(pattern.source, flags);
  return value.match(matcher)?.length ?? 0;
}

function stripNegativeBrowserLanguage(value: string): string {
  return value
    .replace(NEGATED_BROWSER_REQUIREMENT_RE, " ")
    .replace(DO_NOT_USE_BROWSER_RE, " ")
    .replace(ONLY_NON_BROWSER_TOOLS_RE, " ");
}

function hasPositiveBrowserGroundingCue(value: string): boolean {
  if (value.trim().length === 0) return false;
  const normalized = stripNegativeBrowserLanguage(value);
  return BROWSER_GROUNDED_TASK_RE.test(normalized) ||
    BROWSER_SNAPSHOT_CUE_RE.test(normalized);
}

function hasExplicitBrowserInteractionCue(value: string): boolean {
  if (value.trim().length === 0) return false;
  const normalized = stripNegativeBrowserLanguage(value);
  return EXPLICIT_BROWSER_ENVIRONMENT_CUE_RE.test(normalized) ||
    BROWSER_ACTION_CUE_RE.test(normalized) ||
    BROWSER_SNAPSHOT_CUE_RE.test(normalized);
}

function classifyDelegatedTaskIntent(
  spec: DelegationContractSpec,
): "research" | "implementation" | "validation" | "documentation" | "other" {
  const primary = normalizeDelegationClassifierText(
    collectDelegationPrimaryText(spec),
  );
  const combined = primary.length > 0
    ? primary
    : normalizeDelegationClassifierText(collectDelegationStepText(spec));
  const fullStepText = normalizeDelegationClassifierText(
    collectDelegationStepText(spec),
  );
  const capabilityProfile = getDelegatedCapabilityProfile(spec);
  const hasFileAction = DELEGATION_FILE_ACTION_RE.test(fullStepText);
  const hasExplicitFileTarget = DELEGATION_FILE_TARGET_RE.test(fullStepText);
  const hasCodeTarget = DELEGATION_CODE_TARGET_RE.test(primary);
  const hasStrongImplementationCue =
    !capabilityProfile.isReadOnlyContract &&
    (
      IMPLEMENTATION_TASK_RE.test(combined) ||
      (hasFileAction &&
        (hasExplicitFileTarget || hasCodeTarget || primary.trim().length > 0)) ||
      isSetupHeavyDelegatedTask(spec)
    );
  const hasFileWriteCapability =
    capabilityProfile.hasFileWrite;
  const hasStrongValidationCue = VALIDATION_STRONG_TASK_RE.test(combined);
  const hasWeakValidationCue = VALIDATION_WEAK_TASK_RE.test(combined);
  const hasDocumentationCue = DOCUMENTATION_TASK_RE.test(combined);
  const scores = {
    research: isResearchLikeText(combined) ? 4 : 0,
    implementation: 0,
    validation: 0,
    documentation: hasDocumentationCue ? 8 : 0,
  };

  scores.implementation += countPatternMatches(combined, IMPLEMENTATION_TASK_RE) * 2;
  if (hasStrongImplementationCue) {
    scores.implementation += 3;
  }
  if (hasFileWriteCapability) {
    scores.implementation += 4;
  }
  if (hasStrongValidationCue) {
    scores.validation += countPatternMatches(combined, VALIDATION_STRONG_TASK_RE) * 2 + 2;
  }
  if (
    hasWeakValidationCue &&
    !hasFileWriteCapability &&
    !hasStrongImplementationCue &&
    !hasDocumentationCue
  ) {
    scores.validation += countPatternMatches(combined, VALIDATION_WEAK_TASK_RE);
  }

  if (scores.research > 0 && (hasFileWriteCapability || hasStrongImplementationCue)) {
    scores.research = Math.max(0, scores.research - 4);
  }
  if (scores.validation > 0 && (hasFileWriteCapability || hasStrongImplementationCue)) {
    scores.validation = Math.max(0, scores.validation - 3);
  }

  const ordered: Array<{
    intent: "research" | "implementation" | "validation" | "documentation";
    score: number;
  }> = [
    { intent: "implementation", score: scores.implementation },
    { intent: "validation", score: scores.validation },
    { intent: "documentation", score: scores.documentation },
    { intent: "research", score: scores.research },
  ];
  const winner = ordered.reduce((best, current) =>
    current.score > best.score ? current : best
  );
  if (winner.score > 0) {
    return winner.intent;
  }
  if (hasStrongValidationCue || hasWeakValidationCue) return "validation";
  if (hasDocumentationCue) return "documentation";
  if (hasStrongImplementationCue) return "implementation";
  if (isResearchLikeText(combined)) return "research";
  return "other";
}

function isSetupHeavyDelegatedTask(spec: DelegationContractSpec): boolean {
  return SETUP_TASK_RE.test(
    normalizeDelegationClassifierText(collectDelegationStepText(spec)),
  );
}

function isBrowserToolName(toolName: string): boolean {
  return toolName.startsWith("mcp.browser.") ||
    toolName.startsWith("playwright.");
}

function isHostBrowserToolName(toolName: string): boolean {
  return toolName === "system.browse" ||
    toolName === "system.browserAction" ||
    toolName.startsWith("system.browserSession");
}

function specTargetsLocalFiles(spec: DelegationContractSpec): boolean {
  const combined = collectDelegationStepText(spec);
  if (!LOCAL_FILE_REFERENCE_RE.test(combined)) return false;
  return !NON_BLANK_BROWSER_TARGET_RE.test(combined);
}

function hasAcceptanceVerificationCue(spec: DelegationContractSpec): boolean {
  return ACCEPTANCE_VERIFICATION_CUE_RE.test(
    normalizeDelegationClassifierText(collectDelegationStepText(spec)),
  );
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
  const setupHeavy = isSetupHeavyDelegatedTask(spec);
  const preferInspectionOnlyTools =
    localFileInspectionTask &&
    !requireBrowser &&
    !requireFileMutation &&
    !setupHeavy;
  const hasPreferredImplementationEditor = normalized.some((toolName) =>
    PREFERRED_IMPLEMENTATION_EDITOR_TOOL_NAMES.has(toolName)
  );
  const localFileInspectionTools = normalized.filter((toolName) =>
    LOCAL_FILE_INSPECTION_TOOL_NAMES.has(toolName)
  );

  const filtered = normalized.filter((toolName) => {
    if (
      preferInspectionOnlyTools &&
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

    if (taskIntent === "validation" && !requireFileMutation) {
      return PREFERRED_IMPLEMENTATION_SHELL_TOOL_NAMES.has(toolName) ||
        PREFERRED_VALIDATION_BROWSER_TOOL_NAMES.has(toolName);
    }

    if (taskIntent === "implementation" || requireFileMutation) {
      if (PREFERRED_IMPLEMENTATION_SHELL_TOOL_NAMES.has(toolName)) return true;
      if (PREFERRED_IMPLEMENTATION_EDITOR_TOOL_NAMES.has(toolName)) return true;
      if (
        requireBrowser &&
        PREFERRED_VALIDATION_BROWSER_TOOL_NAMES.has(toolName)
      ) {
        return true;
      }
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
  const capabilityProfile = getDelegatedCapabilityProfile(spec);
  const taskIntent = classifyDelegatedTaskIntent(spec);
  const setupHeavy = isSetupHeavyDelegatedTask(spec);
  if (capabilityProfile.isReadOnlyContract) {
    return false;
  }
  if (
    [...(spec.requiredToolCapabilities ?? []), ...(spec.tools ?? [])].some((toolName) =>
      EXPLICIT_FILE_MUTATION_TOOL_NAMES.has(toolName.trim())
    )
  ) {
    return true;
  }

  const primary = collectDelegationPrimaryText(spec);
  const combined = collectDelegationStepText(spec);
  const hasFileAction = DELEGATION_FILE_ACTION_RE.test(combined);
  const hasExplicitFileTarget = DELEGATION_FILE_TARGET_RE.test(combined);
  const hasCodeTarget = DELEGATION_CODE_TARGET_RE.test(primary);
  const hasTestArtifactTarget = TEST_ARTIFACT_TARGET_RE.test(combined);

  if (taskIntent === "research") {
    return false;
  }

  if (taskIntent === "validation") {
    return hasFileAction &&
      (hasExplicitFileTarget || hasCodeTarget || hasTestArtifactTarget);
  }

  if (taskIntent === "implementation") {
    return hasCodeTarget || hasExplicitFileTarget || primary.trim().length > 0;
  }

  if (taskIntent === "documentation") {
    return hasFileAction && hasExplicitFileTarget;
  }

  if (setupHeavy) {
    return true;
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
  const commandArgs = Array.isArray(payload.args)
    ? payload.args.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (command.length > 0) {
    if (SHELL_FILE_WRITE_RE.test(command)) return true;
    if (SHELL_IN_PLACE_EDIT_RE.test(command)) return true;
    if (SHELL_SCAFFOLD_RE.test(command)) return true;
    const normalizedCommand = command.toLowerCase();
    const commandBasename = normalizedCommand.split(/[\\/]/).pop() ?? normalizedCommand;
    if (["touch", "cp", "mv", "tee", "install"].includes(commandBasename)) {
      return true;
    }
    if (
      ["sed", "perl", "ruby"].includes(commandBasename) &&
      commandArgs.some((entry) => /^-(?:[A-Za-z]*i|pi)(?:$|=|['"])/i.test(entry))
    ) {
      return true;
    }
  }

  return commandArgs.some((entry) =>
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

function truncateValidationExcerpt(value: string, maxChars = 200): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length <= maxChars) return trimmed;
  if (maxChars <= 3) return trimmed.slice(0, Math.max(0, maxChars));
  return `${trimmed.slice(0, maxChars - 3)}...`;
}

function splitValidationSnippets(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/u))
    .map((snippet) => snippet.trim())
    .filter((snippet, index, snippets) =>
      snippet.length > 0 && snippets.indexOf(snippet) === index
    );
}

function stripNegativeExecutionClauses(value: string): string {
  return value
    .replace(
      /\b(?:no|without)\b[^.\n]{0,96}\b(?:run|ran|execut(?:e|ed|ing)|perform(?:ed|ing)?|pass(?:es|ed|ing)?|succeed(?:s|ed|ing)?|failed|failing|cleanly|successfully|reported|generated|collected|timed out|exit(?:\s+code|s)?|stdout|stderr|built|compiled|installed|tested|typechecked|linted)\b/gi,
      " ",
    )
    .replace(
      /\b(?:did\s+not|didn't|do\s+not|don't|never|must\s+not|should\s+not)\b[^.\n]{0,96}\b(?:run|execute|executed|perform|performed|pass|passed|succeed|succeeded|fail|failed|report(?:ed)?|generate(?:d)?|collect(?:ed)?|time(?:d)?\s*out|build|built|compile|compiled|install|installed|test(?:ed)?|typecheck(?:ed)?|lint(?:ed)?)\b/gi,
      " ",
    );
}

function stripQuotedStringLiterals(value: string): string {
  let output = "";
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;

  for (const char of value) {
    if (quote) {
      if (escaped) {
        escaped = false;
        output += " ";
        continue;
      }
      if (char === "\\") {
        escaped = true;
        output += " ";
        continue;
      }
      if (char === quote) {
        quote = undefined;
        output += char;
        continue;
      }
      output += char === "\t" ? "\t" : " ";
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      output += char;
      continue;
    }
    output += char;
  }

  return output;
}

function sanitizeHistoricalInspectionPlaceholderSnippet(
  snippet: string,
  fullText: string,
): string {
  if (!DELEGATION_EXPECTED_PLACEHOLDER_RE.test(snippet)) {
    return snippet;
  }
  if (
    !RESOLVED_PLACEHOLDER_CUE_RE.test(snippet) &&
    !(
      HISTORICAL_STATE_CUE_RE.test(snippet) &&
      RESOLUTION_CUE_RE.test(fullText)
    )
  ) {
    return snippet;
  }
  return snippet.replace(DELEGATED_ALLOWABLE_PLACEHOLDER_RE, " ");
}

function sanitizeFileEvidenceSnippetForUnresolvedWork(
  snippet: string,
  path?: string,
): string {
  if (!path || !CODE_LIKE_FILE_PATH_RE.test(path)) {
    return snippet;
  }
  if (!BENIGN_RUNTIME_MESSAGE_CONTEXT_RE.test(snippet)) {
    return snippet;
  }
  return stripQuotedStringLiterals(snippet);
}

function findActionableUnresolvedWorkExcerpt(input: {
  readonly value: string;
  readonly allowsExpectedPlaceholders: boolean;
  readonly source: "output" | "file";
  readonly path?: string;
}): string | undefined {
  const snippets = input.value
    .split(/\r?\n/u)
    .map((snippet) => snippet.trim())
    .filter((snippet) => snippet.length > 0);

  for (const snippet of snippets) {
    let normalized = snippet.replace(DELEGATED_BENIGN_PHASE_TRANSITION_RE, " ");
    if (input.source === "output") {
      normalized = sanitizeHistoricalInspectionPlaceholderSnippet(
        normalized,
        input.value,
      );
    } else {
      normalized = sanitizeFileEvidenceSnippetForUnresolvedWork(
        normalized,
        input.path,
      );
    }
    normalized = normalized.replace(
      input.allowsExpectedPlaceholders ? DELEGATED_ALLOWABLE_PLACEHOLDER_RE : /$^/,
      " ",
    );
    if (DELEGATED_UNRESOLVED_WORK_RE.test(normalized)) {
      return truncateValidationExcerpt(snippet);
    }
    if (!input.allowsExpectedPlaceholders &&
      DELEGATED_CODE_ELISION_RE.test(normalized)
    ) {
      return truncateValidationExcerpt(snippet);
    }
  }

  return undefined;
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

function getToolCallResultPath(
  toolCall: DelegationValidationToolCall,
): string | undefined {
  const parsedResult = tryParseJsonObject(toolCall.result ?? "");
  return typeof parsedResult?.path === "string" &&
      parsedResult.path.trim().length > 0
    ? parsedResult.path.trim()
    : undefined;
}

function extractToolCallObservedFileStateEvidence(
  toolCall: DelegationValidationToolCall,
): readonly {
  path?: string;
  content: string;
}[] {
  const name = typeof toolCall.name === "string" ? toolCall.name.trim() : "";
  if (name.length === 0) {
    return [];
  }

  if (
    typeof toolCall.args === "object" &&
    toolCall.args !== null &&
    !Array.isArray(toolCall.args)
  ) {
    const payload = toolCall.args as Record<string, unknown>;
    const argPath =
      typeof payload.path === "string" && payload.path.trim().length > 0
        ? payload.path.trim()
        : undefined;
    const resultPath = getToolCallResultPath(toolCall);
    const path = resultPath ?? argPath;
    if (name === "system.writeFile") {
      const content =
        typeof payload.content === "string" ? payload.content.trim() : "";
      return content.length > 0 ? [{ path, content }] : [];
    }
    if (name === "desktop.text_editor") {
      const command =
        typeof payload.command === "string"
          ? payload.command.trim().toLowerCase()
          : "";
      if (command === "create") {
        const content =
          typeof payload.content === "string" ? payload.content.trim() : "";
        return content.length > 0 ? [{ path, content }] : [];
      }
    }
    if (name === "system.readFile") {
      const parsedResult = tryParseJsonObject(toolCall.result ?? "");
      const content =
        typeof parsedResult?.content === "string"
          ? parsedResult.content.trim()
          : "";
      return content.length > 0 ? [{ path: resultPath, content }] : [];
    }
    if (name === "system.bash" || name === "desktop.bash") {
      const command =
        typeof payload.command === "string"
          ? payload.command.trim().toLowerCase()
          : "";
      const args = Array.isArray(payload.args)
        ? payload.args.filter((value): value is string => typeof value === "string")
        : [];
      if (command === "cat" && args.length > 0) {
        const parsedResult = tryParseJsonObject(toolCall.result ?? "");
        const stdout =
          typeof parsedResult?.stdout === "string"
            ? parsedResult.stdout.trim()
            : "";
        return stdout.length > 0
          ? [{ path: args[0]!.trim(), content: stdout }]
          : [];
      }
    }
  }

  return [];
}

function isGeneratedArtifactPath(path?: string): boolean {
  if (!path) return false;
  const normalizedPath = path.trim().replace(/\\/g, "/");
  if (normalizedPath.length === 0) return false;
  return GENERATED_ARTIFACT_PATH_SEGMENT_RE.test(normalizedPath) ||
    GENERATED_ARTIFACT_FILE_RE.test(normalizedPath);
}

function isSuccessfulBuildToolCall(
  toolCall: DelegationValidationToolCall,
): boolean {
  return !isToolCallFailure(toolCall) &&
    getToolCallVerificationCategories(toolCall).includes("build");
}

function collectLatestObservedFileStateEvidence(
  toolCalls: readonly DelegationValidationToolCall[],
): readonly {
  path?: string;
  content: string;
}[] {
  const latestByPath = new Map<string, {
    path?: string;
    content: string;
    sequence: number;
  }>();
  const pathlessEvidence: Array<{ path?: string; content: string }> = [];

  for (const [sequence, toolCall] of toolCalls.entries()) {
    if (isSuccessfulBuildToolCall(toolCall)) {
      for (const [normalizedPath, evidence] of latestByPath.entries()) {
        if (
          evidence.sequence < sequence &&
          isGeneratedArtifactPath(normalizedPath)
        ) {
          latestByPath.delete(normalizedPath);
        }
      }
    }
    for (const evidence of extractToolCallObservedFileStateEvidence(toolCall)) {
      const normalizedPath = evidence.path?.trim().replace(/\\/g, "/");
      if (normalizedPath && normalizedPath.length > 0) {
        latestByPath.delete(normalizedPath);
        latestByPath.set(normalizedPath, {
          path: normalizedPath,
          content: evidence.content,
          sequence,
        });
        continue;
      }
      pathlessEvidence.push(evidence);
    }
  }

  return [
    ...[...latestByPath.values()].map(({ path, content }) => ({ path, content })),
    ...pathlessEvidence,
  ];
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
  const explicitBrowserInteraction = hasExplicitBrowserInteractionCue(stepText);
  const explicitTools = normalizeToolNames([
    ...(spec.tools ?? []),
    ...(spec.requiredToolCapabilities ?? []),
  ]);
  const hasExplicitBrowserTool = explicitTools.some((capability) => {
    const canonical = capability.trim();
    const normalized = canonical.toLowerCase();
    return DELEGATION_MEANINGFUL_BROWSER_TOOL_NAMES.has(canonical) ||
      normalized.startsWith("mcp.browser.") ||
      normalized.startsWith("playwright.");
  });
  if (hasExplicitBrowserTool) {
    return true;
  }
  const taskIntent = classifyDelegatedTaskIntent(spec);
  const capabilityProfile = getDelegatedCapabilityProfile(spec);
  const localWorkspaceContract =
    capabilityProfile.hasFileWrite ||
    capabilityProfile.hasShellExecution ||
    specTargetsLocalFiles(spec);
  if (taskIntent !== "research" && localWorkspaceContract && !explicitBrowserInteraction) {
    return false;
  }
  const hasExplicitLocalFileInspectionTool = explicitTools.some((toolName) =>
    LOCAL_FILE_INSPECTION_TOOL_NAMES.has(toolName)
  );
  if (
    specTargetsLocalFiles(spec) &&
    !explicitBrowserInteraction &&
    (hasExplicitLocalFileInspectionTool || !hasExplicitBrowserTool)
  ) {
    return false;
  }
  if (hasPositiveBrowserGroundingCue(stepText)) return true;
  if (localWorkspaceContract && !explicitBrowserInteraction) {
    return false;
  }
  return taskIntent === "research" &&
    hasPositiveBrowserGroundingCue(collectDelegationContextText(spec));
}

function isMeaningfulBrowserToolName(name: string): boolean {
  return DELEGATION_MEANINGFUL_BROWSER_TOOL_NAMES.has(name) &&
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
  const meaningfulResearchTools = normalizedTools.filter((toolName) =>
    DELEGATION_MEANINGFUL_RESEARCH_TOOL_NAMES.has(toolName)
  );
  const hasProviderNativeResearchTool = taskIntent === "research" &&
    normalizedTools.some((toolName) => isProviderNativeToolName(toolName));
  const hasShellBasedValidationGrounding = taskIntent !== "research" &&
    normalizedTools.some((toolName) =>
      VERIFICATION_EXECUTION_TOOL_NAMES.has(toolName)
    );

  const hasSufficientGroundingTools = taskIntent === "research"
    ? meaningfulResearchTools.length > 0 || hasProviderNativeResearchTool
    : meaningfulBrowserTools.length > 0 || hasShellBasedValidationGrounding;

  if (!hasSufficientGroundingTools) {
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
  unsafeBenchmarkMode?: boolean;
}): ResolvedDelegatedChildToolScope {
  const requestedSource = normalizeToolNames(
    params.requestedTools ?? params.spec.requiredToolCapabilities,
  );
  const requested = extractExplicitDelegatedToolNames(requestedSource);
  const semanticCapabilities = requestedSource
    .filter((toolName) => !looksLikeExplicitDelegatedToolName(toolName))
    .map((capability) => normalizeCapabilityName(capability));
  const parentAllowedSet = new Set(normalizeToolNames(params.parentAllowedTools));
  const availableSet = new Set(normalizeToolNames(params.availableTools));
  const forbiddenSet = new Set(normalizeToolNames(params.forbiddenTools));

  const unsafeBenchmarkMode = params.unsafeBenchmarkMode === true;

  const removedByPolicy: string[] = [];
  const removedAsDelegationTools: string[] = [];
  const removedAsUnknownTools: string[] = [];
  const allowedTools: string[] = [];
  const explicitRequestedTools: string[] = [];
  const semanticFallback: string[] = [];
  const capabilityProfile = getDelegatedCapabilityProfile(params.spec);
  const taskIntent = classifyDelegatedTaskIntent(params.spec);
  const requireBrowser = specRequiresMeaningfulBrowserEvidence(params.spec);
  const requireFileMutation = specRequiresFileMutationEvidence(params.spec);
  const localFileInspectionTask = specTargetsLocalFiles(params.spec);
  const setupHeavy = isSetupHeavyDelegatedTask(params.spec);
  const contextOnlyCapabilityRequest =
    semanticCapabilities.length > 0 &&
    semanticCapabilities.every(isContextOnlyCapabilityName);
  const explicitBrowserToolRequested = requested.some((toolName) =>
    isBrowserToolName(toolName) || isHostBrowserToolName(toolName)
  );
  const allowImplicitBrowserFallback =
    requested.length === 0 || explicitBrowserToolRequested;

  const addCandidate = (
    toolName: string,
    options: {
      readonly removalBucket?: string[];
      readonly preserveExplicitRequest?: boolean;
    } = {},
  ): void => {
    const normalized = toolName.trim();
    if (normalized.length === 0) return;
    if (
      !unsafeBenchmarkMode &&
      params.enforceParentIntersection !== false &&
      parentAllowedSet.size > 0 &&
      !parentAllowedSet.has(normalized)
    ) {
      options.removalBucket?.push(normalized);
      return;
    }
    if (!unsafeBenchmarkMode && forbiddenSet.has(normalized)) {
      options.removalBucket?.push(normalized);
      return;
    }
    if (!unsafeBenchmarkMode && isDelegationToolNameLike(normalized)) {
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
    if (
      options.preserveExplicitRequest &&
      looksLikeExplicitDelegatedToolName(normalized) &&
      !explicitRequestedTools.includes(normalized)
    ) {
      explicitRequestedTools.push(normalized);
    }
    if (!allowedTools.includes(normalized)) {
      allowedTools.push(normalized);
    }
  };

  for (const toolName of requested) {
    addCandidate(toolName, {
      removalBucket: removedByPolicy,
      preserveExplicitRequest: true,
    });
  }

  const addRequestedSemanticTool = (toolName: string): void => {
    addCandidate(toolName, {
      removalBucket: removedByPolicy,
      preserveExplicitRequest: true,
    });
  };

  if (
    semanticCapabilities.some((capability) =>
      FILE_READ_CAPABILITY_RE.test(capability) ||
      isGenericFilesystemCapabilityName(capability)
    )
  ) {
    addRequestedSemanticTool("system.readFile");
    addRequestedSemanticTool("system.listDir");
  }
  if (
    semanticCapabilities.some((capability) =>
      FILE_WRITE_CAPABILITY_RE.test(capability) ||
      isGenericFilesystemCapabilityName(capability)
    )
  ) {
    addRequestedSemanticTool("system.writeFile");
    addRequestedSemanticTool("system.appendFile");
    addRequestedSemanticTool("system.mkdir");
  }
  if (semanticCapabilities.some((capability) => SHELL_EXECUTION_CAPABILITY_RE.test(capability))) {
    addRequestedSemanticTool("desktop.bash");
    addRequestedSemanticTool("system.bash");
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

  if (
    !capabilityProfile.isReadOnlyContract &&
    localFileInspectionTask &&
    !requireBrowser &&
    !requireFileMutation
  ) {
    addSemanticFallback("desktop.text_editor");
    addSemanticFallback("system.readFile");
    addSemanticFallback("mcp.neovim.vim_edit");
    addSemanticFallback("mcp.neovim.vim_buffer_save");
  }

  if (
    !capabilityProfile.isReadOnlyContract &&
    allowImplicitBrowserFallback &&
    (requireBrowser || (taskIntent === "research" && !localFileInspectionTask))
  ) {
    addSemanticFallback(PROVIDER_NATIVE_WEB_SEARCH_TOOL);
    addSemanticFallback("system.browse");
    addSemanticFallback("system.browserSessionStart");
    addSemanticFallback("system.browserAction");
    addSemanticFallback("system.browserSessionResume");
    addSemanticFallback("system.browserSessionStatus");
    addSemanticFallback("system.browserSessionArtifacts");
    addSemanticFallback("mcp.browser.browser_navigate");
    addSemanticFallback("mcp.browser.browser_snapshot");
    addSemanticFallback("mcp.browser.browser_run_code");
  }

  if (
    !capabilityProfile.isReadOnlyContract &&
    (requireFileMutation || taskIntent === "implementation" || setupHeavy)
  ) {
    addShellSemanticFallback();
    addSemanticFallback("system.mkdir");
    addSemanticFallback("system.writeFile");
    addSemanticFallback("system.appendFile");
    addSemanticFallback("desktop.text_editor");
    addSemanticFallback("mcp.neovim.vim_edit");
    addSemanticFallback("mcp.neovim.vim_buffer_save");
  }

  if (!capabilityProfile.isReadOnlyContract && taskIntent === "validation") {
    addShellSemanticFallback();
    if (allowImplicitBrowserFallback) {
      addSemanticFallback("system.browserSessionStart");
      addSemanticFallback("system.browserAction");
      addSemanticFallback("system.browserSessionResume");
      addSemanticFallback("system.browserSessionStatus");
      addSemanticFallback("system.browserSessionArtifacts");
      addSemanticFallback("mcp.browser.browser_navigate");
      addSemanticFallback("mcp.browser.browser_snapshot");
      addSemanticFallback("mcp.browser.browser_run_code");
    }
  }

  if (
    allowedTools.length === 0 &&
    !contextOnlyCapabilityRequest &&
    !capabilityProfile.isReadOnlyContract
  ) {
    addShellSemanticFallback();
  }

  if (unsafeBenchmarkMode) {
    addCandidate("execute_with_agent");
  }

  const refined = refineDelegatedChildToolAllowlist({
    spec: params.spec,
    tools: allowedTools,
  });
  const refinedExplicitRequestedTools = explicitRequestedTools.filter((toolName) =>
    refined.allowedTools.includes(toolName)
  );
  const profiledFallbackTools = pruneDelegatedToolsByIntent(
    params.spec,
    refined.allowedTools.filter((toolName) =>
      !refinedExplicitRequestedTools.includes(toolName)
    ),
  );
  const profiledAllowedTools = normalizeToolNames([
    ...refinedExplicitRequestedTools,
    ...profiledFallbackTools,
  ]);
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
  const shouldPrioritizeVerificationRetry =
    spec.lastValidationCode === "acceptance_evidence_missing" &&
    !requireBrowser &&
    hasAcceptanceVerificationCue(spec) &&
    (
      taskIntent === "implementation" ||
      taskIntent === "validation" ||
      requireFileMutation
    );

  if (shouldPrioritizeVerificationRetry) {
    const preferredVerificationTool = INITIAL_SETUP_TOOL_NAMES.find((toolName) =>
      normalizedTools.includes(toolName)
    );
    if (preferredVerificationTool) {
      return preferredVerificationTool;
    }
    const preferredShellTool = normalizedTools.find((toolName) =>
      PREFERRED_IMPLEMENTATION_SHELL_TOOL_NAMES.has(toolName)
    );
    if (preferredShellTool) {
      return preferredShellTool;
    }
  }

  if (requireFileMutation) {
    const preferredMutationTool = INITIAL_FILE_MUTATION_TOOL_NAMES.find((toolName) =>
      normalizedTools.includes(toolName)
    );
    if (preferredMutationTool) {
      return preferredMutationTool;
    }
  }

  if (setupHeavy) {
    return INITIAL_SETUP_TOOL_NAMES.find((toolName) =>
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
    const preferredResearchTool = taskIntent === "research"
      ? INITIAL_RESEARCH_TOOL_NAMES.find((toolName) =>
        normalizedTools.includes(toolName)
      )
      : undefined;
    if (preferredResearchTool) {
      return preferredResearchTool;
    }
    return INITIAL_BROWSER_NAVIGATION_TOOL_NAMES.find((toolName) =>
      normalizedTools.includes(toolName)
    );
  }

  return undefined;
}

export function resolveDelegatedInitialToolChoiceToolNames(
  spec: DelegationContractSpec,
  tools: readonly string[],
): readonly string[] {
  const normalizedTools = normalizeToolNames(tools);
  if (normalizedTools.length === 0) return [];

  const preferredToolName = resolveDelegatedInitialToolChoiceToolName(
    spec,
    normalizedTools,
  );
  if (!preferredToolName) return [];

  const taskIntent = classifyDelegatedTaskIntent(spec);
  const requireBrowser = specRequiresMeaningfulBrowserEvidence(spec);
  const requireFileMutation = specRequiresFileMutationEvidence(spec);
  const setupHeavy = isSetupHeavyDelegatedTask(spec);
  const localFileInspectionTask = specTargetsLocalFiles(spec);
  const verificationCue = hasAcceptanceVerificationCue(spec);
  const hasSystemTooling = normalizedTools.some((toolName) =>
    toolName.startsWith("system.")
  );
  const shouldPrioritizeVerificationRetry =
    spec.lastValidationCode === "acceptance_evidence_missing" &&
    !requireBrowser &&
    verificationCue &&
    (
      taskIntent === "implementation" ||
      taskIntent === "validation" ||
      requireFileMutation
    );

  if (requireBrowser || taskIntent === "research") {
    return [preferredToolName];
  }

  const shouldUseFlexibleInitialSubset =
    hasSystemTooling &&
    (
      setupHeavy ||
      verificationCue ||
      taskIntent === "validation" ||
      taskIntent === "implementation"
    );
  if (!shouldUseFlexibleInitialSubset) {
    return [preferredToolName];
  }

  const routedToolNames: string[] = [];
  const pushFirstAvailable = (candidates: readonly string[]) => {
    const toolName = candidates.find((candidate) =>
      normalizedTools.includes(candidate)
    );
    if (toolName && !routedToolNames.includes(toolName)) {
      routedToolNames.push(toolName);
    }
  };

  const inspectionCandidates = setupHeavy
    ? (["system.listDir", ...INITIAL_FILE_INSPECTION_TOOL_NAMES] as const)
    : INITIAL_FILE_INSPECTION_TOOL_NAMES;

  if (shouldPrioritizeVerificationRetry) {
    pushFirstAvailable(INITIAL_SETUP_TOOL_NAMES);
    if (localFileInspectionTask || setupHeavy) {
      pushFirstAvailable(inspectionCandidates);
    }
    if (requireFileMutation || taskIntent === "implementation") {
      pushFirstAvailable(INITIAL_FILE_MUTATION_TOOL_NAMES);
    }
  } else {
    if (
      taskIntent === "implementation" ||
      taskIntent === "validation" ||
      localFileInspectionTask ||
      setupHeavy
    ) {
      pushFirstAvailable(inspectionCandidates);
    }
    if (requireFileMutation || taskIntent === "implementation") {
      pushFirstAvailable(INITIAL_FILE_MUTATION_TOOL_NAMES);
    }
    if (
      setupHeavy ||
      verificationCue ||
      taskIntent === "validation" ||
      taskIntent === "implementation" ||
      spec.lastValidationCode === "acceptance_evidence_missing"
    ) {
      pushFirstAvailable(INITIAL_SETUP_TOOL_NAMES);
    }
  }

  if (!routedToolNames.includes(preferredToolName)) {
    routedToolNames.unshift(preferredToolName);
  }

  return routedToolNames;
}

export function resolveDelegatedCorrectionToolChoiceToolNames(
  spec: DelegationContractSpec,
  tools: readonly string[],
  validationCode: DelegationOutputValidationCode | undefined,
): readonly string[] {
  const normalizedTools = normalizeToolNames(tools);
  if (normalizedTools.length === 0) return [];

  if (validationCode === "forbidden_phase_action") {
    const correctionTools: string[] = [];
    const preferredInspectionTool = [
      "system.listDir",
      ...INITIAL_FILE_INSPECTION_TOOL_NAMES,
    ].find((toolName) => normalizedTools.includes(toolName));
    if (
      preferredInspectionTool &&
      !correctionTools.includes(preferredInspectionTool)
    ) {
      correctionTools.push(preferredInspectionTool);
    }
    const preferredMutationTool = INITIAL_FILE_MUTATION_TOOL_NAMES.find(
      (toolName) => normalizedTools.includes(toolName),
    );
    if (
      preferredMutationTool &&
      !correctionTools.includes(preferredMutationTool)
    ) {
      correctionTools.push(preferredMutationTool);
    }
    if (correctionTools.length > 0) {
      return correctionTools;
    }
    const preferredShellTool = normalizedTools.find((toolName) =>
      PREFERRED_IMPLEMENTATION_SHELL_TOOL_NAMES.has(toolName)
    );
    return preferredShellTool ? [preferredShellTool] : [];
  }

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

  if (validationCode === "low_signal_browser_evidence") {
    const taskIntent = classifyDelegatedTaskIntent(spec);
    const requireFileMutation = specRequiresFileMutationEvidence(spec);
    const correctionTools: string[] = [];
    const pushFirstAvailable = (candidates: readonly string[]) => {
      const toolName = candidates.find((candidate) =>
        normalizedTools.includes(candidate)
      );
      if (toolName && !correctionTools.includes(toolName)) {
        correctionTools.push(toolName);
      }
    };

    if (taskIntent === "research") {
      pushFirstAvailable([
        PROVIDER_NATIVE_WEB_SEARCH_TOOL,
        ...INITIAL_RESEARCH_TOOL_NAMES,
        ...PREFERRED_RESEARCH_BROWSER_TOOL_NAMES,
      ]);
      return correctionTools;
    }

    const hasMeaningfulBrowserTool = normalizedTools.some((toolName) =>
      isMeaningfulBrowserToolName(toolName)
    );
    if (!hasMeaningfulBrowserTool) {
      pushFirstAvailable(INITIAL_SETUP_TOOL_NAMES);
    }
    pushFirstAvailable([
      "system.browserAction",
      "system.browserSessionStart",
      "system.browserSessionResume",
      "mcp.browser.browser_navigate",
      "playwright.browser_navigate",
    ]);
    if (hasMeaningfulBrowserTool) {
      pushFirstAvailable(INITIAL_SETUP_TOOL_NAMES);
    }
    if (requireFileMutation || taskIntent === "implementation") {
      pushFirstAvailable(INITIAL_FILE_MUTATION_TOOL_NAMES);
    }
    if (correctionTools.length > 0) {
      return correctionTools;
    }
  }

  if (
    validationCode === "acceptance_evidence_missing" ||
    validationCode === "blocked_phase_output" ||
    validationCode === "contradictory_completion_claim"
  ) {
    const requireBrowser = specRequiresMeaningfulBrowserEvidence(spec);
    const requireFileMutation = specRequiresFileMutationEvidence(spec);
    const taskIntent = classifyDelegatedTaskIntent(spec);

    if (requireBrowser || taskIntent === "research") {
      if (taskIntent === "research") {
        const preferredTool = resolveDelegatedInitialToolChoiceToolName(
          spec,
          normalizedTools,
        );
        return preferredTool ? [preferredTool] : [];
      }
    }

    const localFileInspectionTask = specTargetsLocalFiles(spec);
    if (localFileInspectionTask && !requireFileMutation) {
      const inspectionTool = INITIAL_FILE_INSPECTION_TOOL_NAMES.find((toolName) =>
        normalizedTools.includes(toolName)
      );
      if (inspectionTool) {
        return [inspectionTool];
      }
    }

    const correctionTools: string[] = [];
    const pushFirstAvailable = (candidates: readonly string[]) => {
      const toolName = candidates.find((candidate) =>
        normalizedTools.includes(candidate)
      );
      if (toolName && !correctionTools.includes(toolName)) {
        correctionTools.push(toolName);
      }
    };
    const shouldPrioritizeVerification =
      validationCode === "acceptance_evidence_missing" &&
      hasAcceptanceVerificationCue(spec) &&
      (
        requireFileMutation ||
        taskIntent === "implementation" ||
        taskIntent === "validation"
      );
    const shouldPrioritizeBrowserEvidence =
      validationCode === "acceptance_evidence_missing" ||
      validationCode === "blocked_phase_output" ||
      taskIntent === "validation";

    if (requireBrowser) {
      const browserCorrectionCandidates = [
        ...INITIAL_BROWSER_NAVIGATION_TOOL_NAMES,
        ...Array.from(PREFERRED_VALIDATION_BROWSER_TOOL_NAMES).filter(
          (toolName) =>
            toolName !== "system.browse" &&
            !INITIAL_BROWSER_NAVIGATION_TOOL_NAMES.includes(
              toolName as (typeof INITIAL_BROWSER_NAVIGATION_TOOL_NAMES)[number],
            ),
        ),
        "system.browse",
      ];

      if (shouldPrioritizeBrowserEvidence) {
        pushFirstAvailable(browserCorrectionCandidates);
      }
      if (
        taskIntent === "implementation" ||
        taskIntent === "validation" ||
        hasAcceptanceVerificationCue(spec)
      ) {
        pushFirstAvailable(INITIAL_SETUP_TOOL_NAMES);
      }
      if (requireFileMutation || taskIntent === "implementation") {
        pushFirstAvailable(INITIAL_FILE_MUTATION_TOOL_NAMES);
      }
      if (!shouldPrioritizeBrowserEvidence) {
        pushFirstAvailable(browserCorrectionCandidates);
      }
      if (correctionTools.length > 0) {
        return correctionTools;
      }

      const preferredTool = resolveDelegatedInitialToolChoiceToolName(
        spec,
        normalizedTools,
      );
      return preferredTool ? [preferredTool] : [];
    }
    if (
      requireFileMutation ||
      taskIntent === "implementation" ||
      taskIntent === "validation" ||
      hasAcceptanceVerificationCue(spec)
    ) {
      const preferredVerificationTool = INITIAL_SETUP_TOOL_NAMES.find(
        (toolName) => normalizedTools.includes(toolName),
      );
      if (
        preferredVerificationTool &&
        shouldPrioritizeVerification &&
        !correctionTools.includes(preferredVerificationTool)
      ) {
        correctionTools.push(preferredVerificationTool);
      }
    }

    if (requireFileMutation || taskIntent === "implementation") {
      const preferredMutationTool = INITIAL_FILE_MUTATION_TOOL_NAMES.find(
        (toolName) => normalizedTools.includes(toolName),
      );
      if (
        preferredMutationTool &&
        !correctionTools.includes(preferredMutationTool)
      ) {
        correctionTools.push(preferredMutationTool);
      }
    }

    if (
      !shouldPrioritizeVerification &&
      (
        requireFileMutation ||
        taskIntent === "implementation" ||
        taskIntent === "validation" ||
        hasAcceptanceVerificationCue(spec)
      )
    ) {
      const preferredVerificationTool = INITIAL_SETUP_TOOL_NAMES.find(
        (toolName) => normalizedTools.includes(toolName),
      );
      if (
        preferredVerificationTool &&
        !correctionTools.includes(preferredVerificationTool)
      ) {
        correctionTools.push(preferredVerificationTool);
      }
    }

    if (correctionTools.length > 0) {
      return correctionTools;
    }

    if (
      requireFileMutation ||
      taskIntent === "implementation" ||
      taskIntent === "validation" ||
      hasAcceptanceVerificationCue(spec)
    ) {
      const preferredShellTool = normalizedTools.find((toolName) =>
        PREFERRED_IMPLEMENTATION_SHELL_TOOL_NAMES.has(toolName)
      );
      if (preferredShellTool) {
        return [preferredShellTool];
      }
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

export type AcceptanceVerificationCategory = "build" | "test";
type ForbiddenPhaseActionCategory =
  | "install"
  | "build"
  | "test"
  | "typecheck"
  | "lint"
  | "workspace_protocol";

function normalizeDefinitionCriterionForOutcomeCheck(
  criterion: string,
): string {
  return criterion.replace(/\bcoverage\b/gi, " ");
}

function normalizeDocumentationCriterionForOutcomeCheck(
  criterion: string,
): string {
  return normalizeDefinitionCriterionForOutcomeCheck(criterion)
    .replace(/\b(?:install|build|test|run)\b(?=[-/\s]*(?:instructions?|placeholders?|sections?|steps?|usage|setup))/gi, " ")
    .replace(/\b(?:install|build|test|run)(?:\/(?:install|build|test|run))+\b/gi, " ");
}

function isScriptDefinitionOnlyAcceptanceCriterion(
  criterion: string,
): boolean {
  if (!ACCEPTANCE_SCRIPT_DEFINITION_RE.test(criterion)) {
    return false;
  }
  if (!ACCEPTANCE_SCRIPT_NAME_RE.test(criterion)) {
    return false;
  }
  if (!ACCEPTANCE_SCRIPT_DEFINITION_VERB_RE.test(criterion)) {
    return false;
  }
  const normalizedOutcomeCheck =
    normalizeDefinitionCriterionForOutcomeCheck(criterion);
  if (
    ACCEPTANCE_STRONG_VERIFICATION_CUE_RE.test(normalizedOutcomeCheck) ||
    ACCEPTANCE_EXPLICIT_EXECUTION_RE.test(normalizedOutcomeCheck) ||
    ACCEPTANCE_BUILD_TEST_OUTCOME_RE.test(normalizedOutcomeCheck)
  ) {
    return false;
  }
  return true;
}

function isConfigDefinitionOnlyAcceptanceCriterion(
  criterion: string,
): boolean {
  if (!ACCEPTANCE_CONFIG_DEFINITION_RE.test(criterion)) {
    return false;
  }
  if (!ACCEPTANCE_CONFIG_DEFINITION_VERB_RE.test(criterion)) {
    return false;
  }
  const normalizedOutcomeCheck =
    normalizeDefinitionCriterionForOutcomeCheck(criterion);
  if (
    ACCEPTANCE_STRONG_VERIFICATION_CUE_RE.test(normalizedOutcomeCheck) ||
    ACCEPTANCE_EXPLICIT_EXECUTION_RE.test(normalizedOutcomeCheck) ||
    ACCEPTANCE_BUILD_TEST_OUTCOME_RE.test(normalizedOutcomeCheck)
  ) {
    return false;
  }
  return true;
}

function isManifestFieldInventoryOnlyAcceptanceCriterion(
  criterion: string,
): boolean {
  if (
    !ACCEPTANCE_CONFIG_DEFINITION_RE.test(criterion) &&
    !ACCEPTANCE_SCRIPT_DEFINITION_RE.test(criterion)
  ) {
    return false;
  }
  if (!ACCEPTANCE_CONFIG_FIELD_INVENTORY_RE.test(criterion)) {
    return false;
  }
  const normalizedOutcomeCheck =
    normalizeDefinitionCriterionForOutcomeCheck(criterion);
  if (
    ACCEPTANCE_STRONG_VERIFICATION_CUE_RE.test(normalizedOutcomeCheck) ||
    ACCEPTANCE_EXPLICIT_EXECUTION_RE.test(normalizedOutcomeCheck) ||
    ACCEPTANCE_BUILD_TEST_OUTCOME_RE.test(normalizedOutcomeCheck)
  ) {
    return false;
  }
  return true;
}

function isDocumentationDefinitionOnlyAcceptanceCriterion(
  criterion: string,
): boolean {
  if (!ACCEPTANCE_DOCUMENTATION_DEFINITION_RE.test(criterion)) {
    return false;
  }
  if (!ACCEPTANCE_DOCUMENTATION_DEFINITION_VERB_RE.test(criterion)) {
    return false;
  }
  const normalizedOutcomeCheck =
    normalizeDocumentationCriterionForOutcomeCheck(criterion);
  if (
    ACCEPTANCE_STRONG_VERIFICATION_CUE_RE.test(normalizedOutcomeCheck) ||
    ACCEPTANCE_EXPLICIT_EXECUTION_RE.test(normalizedOutcomeCheck) ||
    ACCEPTANCE_BUILD_TEST_OUTCOME_RE.test(normalizedOutcomeCheck)
  ) {
    return false;
  }
  return true;
}

function isNegativePhaseConstraintCriterion(
  criterion: string,
): boolean {
  const normalized = criterion.toLowerCase();
  const hasNegativeDirective =
    NEGATIVE_PHASE_CONTRACT_RE.test(normalized) ||
    AUTHOR_ONLY_PHASE_CONTRACT_RE.test(normalized);
  if (!hasNegativeDirective) {
    return false;
  }
  return PHASE_INSTALL_TERM_RE.test(normalized) ||
    PHASE_BUILD_TERM_RE.test(normalized) ||
    PHASE_TEST_TERM_RE.test(normalized) ||
    PHASE_TYPECHECK_TERM_RE.test(normalized) ||
    PHASE_LINT_TERM_RE.test(normalized) ||
    WORKSPACE_PROTOCOL_RE.test(normalized);
}

export function isDefinitionOnlyVerificationText(text: string): boolean {
  return isNegativePhaseConstraintCriterion(text) ||
    isScriptDefinitionOnlyAcceptanceCriterion(text) ||
    isConfigDefinitionOnlyAcceptanceCriterion(text) ||
    isManifestFieldInventoryOnlyAcceptanceCriterion(text) ||
    isDocumentationDefinitionOnlyAcceptanceCriterion(text);
}

export function getAcceptanceVerificationCategories(
  criterion: string,
): readonly AcceptanceVerificationCategory[] {
  if (isDefinitionOnlyVerificationText(criterion)) {
    return [];
  }
  const categories = new Set<AcceptanceVerificationCategory>();
  if (ACCEPTANCE_BUILD_VERIFICATION_RE.test(criterion)) {
    categories.add("build");
  }
  if (ACCEPTANCE_TEST_VERIFICATION_RE.test(criterion)) {
    categories.add("test");
  }
  return [...categories];
}

function getToolCallVerificationCategories(
  toolCall: DelegationValidationToolCall,
): readonly AcceptanceVerificationCategory[] {
  const toolName = toolCall.name?.trim();
  if (!toolName || !VERIFICATION_EXECUTION_TOOL_NAMES.has(toolName)) {
    return [];
  }
  const combined = [
    toolName,
    ...getToolCallStringValues(toolCall),
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ");
  if (combined.trim().length === 0) {
    return [];
  }

  const categories = new Set<AcceptanceVerificationCategory>();
  if (TOOLCALL_BUILD_EVIDENCE_RE.test(combined)) {
    categories.add("build");
  }
  if (TOOLCALL_TEST_EVIDENCE_RE.test(combined)) {
    categories.add("test");
  }
  return [...categories];
}

function getForbiddenPhaseCategoryLabel(
  category: ForbiddenPhaseActionCategory,
): string {
  switch (category) {
    case "install":
      return "dependency-install commands";
    case "build":
      return "build or compile commands";
    case "test":
      return "test or coverage commands";
    case "typecheck":
      return "typecheck commands";
    case "lint":
      return "lint commands";
    case "workspace_protocol":
      return "`workspace:*` dependency specifiers";
  }
}

function collectForbiddenPhaseActionCategories(
  spec: DelegationContractSpec,
): Set<ForbiddenPhaseActionCategory> {
  const categories = new Set<ForbiddenPhaseActionCategory>();
  const segments = [
    spec.task,
    spec.objective,
    spec.inputContract,
    ...(spec.acceptanceCriteria ?? []),
  ];

  for (const segment of segments) {
    if (typeof segment !== "string" || segment.trim().length === 0) continue;
    const normalized = segment.toLowerCase();
    const hasNegativeDirective = NEGATIVE_PHASE_CONTRACT_RE.test(normalized) ||
      AUTHOR_ONLY_PHASE_CONTRACT_RE.test(normalized);
    if (!hasNegativeDirective) continue;

    if (PHASE_INSTALL_TERM_RE.test(normalized)) categories.add("install");
    if (PHASE_BUILD_TERM_RE.test(normalized)) categories.add("build");
    if (PHASE_TEST_TERM_RE.test(normalized)) categories.add("test");
    if (PHASE_TYPECHECK_TERM_RE.test(normalized)) categories.add("typecheck");
    if (PHASE_LINT_TERM_RE.test(normalized)) categories.add("lint");
    if (WORKSPACE_PROTOCOL_RE.test(normalized)) {
      categories.add("workspace_protocol");
    }
  }

  return categories;
}

function normalizeExecCommandTokens(args: unknown): {
  readonly command: string;
  readonly argv: readonly string[];
} {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return { command: "", argv: [] };
  }
  const payload = args as {
    command?: unknown;
    args?: unknown;
  };
  const command =
    typeof payload.command === "string" ? payload.command.trim() : "";
  const argv = Array.isArray(payload.args)
    ? payload.args.filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : [];
  return { command, argv };
}

function matchesPackageManagerScript(
  argv: readonly string[],
  scriptCategory: "build" | "test" | "typecheck" | "lint",
): boolean {
  const command = argv[0]?.toLowerCase();
  const scriptName = argv[1]?.toLowerCase() ?? "";
  if (command !== "run") {
    return scriptCategory === "test" && command === "test";
  }

  switch (scriptCategory) {
    case "build":
      return /^(?:build|compile|bundle)(?::|$)/.test(scriptName);
    case "test":
      return /^(?:test|coverage|vitest|jest)(?::|$)/.test(scriptName);
    case "typecheck":
      return /^(?:typecheck|check-types?)(?::|$)|^tsc$/.test(scriptName);
    case "lint":
      return /^(?:lint|eslint)(?::|$)/.test(scriptName);
  }
}

function findForbiddenExecutionToolCallExcerpt(
  toolCall: DelegationValidationToolCall,
  category: Exclude<ForbiddenPhaseActionCategory, "workspace_protocol">,
): string | undefined {
  const name = toolCall.name?.trim();
  if (!name || !VERIFICATION_EXECUTION_TOOL_NAMES.has(name)) {
    return undefined;
  }

  const { command, argv } = normalizeExecCommandTokens(toolCall.args);
  const lowerCommand = command.toLowerCase();
  const lowerArgv = argv.map((entry) => entry.toLowerCase());
  const commandPreview = command.length > 0
    ? [command, ...argv].join(" ")
    : argv.join(" ");

  if (["npm", "pnpm", "yarn", "bun"].includes(lowerCommand)) {
    const matches =
      (category === "install" && lowerArgv[0] === "install") ||
      (category === "build" && matchesPackageManagerScript(lowerArgv, "build")) ||
      (category === "test" && matchesPackageManagerScript(lowerArgv, "test")) ||
      (category === "typecheck" &&
        matchesPackageManagerScript(lowerArgv, "typecheck")) ||
      (category === "lint" && matchesPackageManagerScript(lowerArgv, "lint"));
    if (matches) {
      return truncateValidationExcerpt(commandPreview);
    }
  }

  if (
    (category === "build" || category === "typecheck") &&
    lowerCommand === "tsc"
  ) {
    return truncateValidationExcerpt(commandPreview || "tsc");
  }
  if (category === "build" && lowerCommand === "vite" && lowerArgv[0] === "build") {
    return truncateValidationExcerpt(commandPreview);
  }
  if (
    category === "test" &&
    ["vitest", "jest", "pytest", "mocha", "ava"].includes(lowerCommand)
  ) {
    return truncateValidationExcerpt(commandPreview || lowerCommand);
  }
  if (category === "lint" && lowerCommand === "eslint") {
    return truncateValidationExcerpt(commandPreview || "eslint");
  }

  if (command.length > 0 && argv.length === 0) {
    const shellCommand = command.toLowerCase();
    const matches =
      (category === "install" && SHELL_INSTALL_COMMAND_RE.test(shellCommand)) ||
      (category === "build" && SHELL_BUILD_COMMAND_RE.test(shellCommand)) ||
      (category === "test" && SHELL_TEST_COMMAND_RE.test(shellCommand)) ||
      (category === "typecheck" &&
        SHELL_TYPECHECK_COMMAND_RE.test(shellCommand)) ||
      (category === "lint" && SHELL_LINT_COMMAND_RE.test(shellCommand));
    if (matches) {
      return truncateValidationExcerpt(command);
    }
  }

  return undefined;
}

function getForbiddenOutputClaimExcerpt(
  value: string,
  category: ForbiddenPhaseActionCategory,
): string | undefined {
  if (value.trim().length === 0) return undefined;
  for (const snippet of splitValidationSnippets(value)) {
    if (
      category === "workspace_protocol" &&
      WORKSPACE_PROTOCOL_RE.test(snippet) &&
      !isNegativeForbiddenOutputClaim(snippet, category)
    ) {
      return truncateValidationExcerpt(snippet);
    }
    if (category === "workspace_protocol" || isNegativeForbiddenOutputClaim(
      snippet,
      category,
    )) {
      continue;
    }

    const { explicitCommandRe, outcomeClaimRe } =
      getForbiddenOutputClaimPatterns(category);
    const explicitCommandMatch = explicitCommandRe.exec(snippet);
    if (explicitCommandMatch) {
      const withoutCommand = stripNegativeExecutionClauses(
        stripQuotedStringLiterals(
        `${snippet.slice(0, explicitCommandMatch.index)} ${
          snippet.slice(
            explicitCommandMatch.index + explicitCommandMatch[0].length,
          )
          }`,
        ),
      );
      if (OUTPUT_AFFIRMATIVE_EXECUTION_CUE_RE.test(withoutCommand)) {
        return truncateValidationExcerpt(snippet);
      }
    }

    if (
      outcomeClaimRe.test(snippet) &&
      !(
        OUTPUT_DEFINITION_CONTEXT_RE.test(snippet) &&
        OUTPUT_DEFINITION_INSPECTION_VERB_RE.test(snippet) &&
        !ACCEPTANCE_EXPLICIT_EXECUTION_RE.test(snippet) &&
        !OUTPUT_EXECUTION_OUTCOME_CUE_RE.test(snippet)
      )
    ) {
      return truncateValidationExcerpt(snippet);
    }
  }

  return undefined;
}

function getForbiddenOutputClaimSubjectPattern(
  category: Exclude<ForbiddenPhaseActionCategory, "workspace_protocol">,
): string {
  switch (category) {
    case "install":
      return "(?:npm\\s+install|pnpm\\s+install|yarn\\s+install|bun\\s+install|install|dependencies?)";
    case "build":
      return "(?:npm\\s+run\\s+build|vite\\s+build|build|compile)";
    case "test":
      return "(?:npm\\s+test|tests?|coverage|vitest|jest|pytest|mocha|ava)";
    case "typecheck":
      return "(?:npm\\s+run\\s+typecheck|typecheck|type-check|tsc)";
    case "lint":
      return "(?:npm\\s+run\\s+lint|lint|eslint)";
  }
}

function getForbiddenOutputClaimPatterns(
  category: Exclude<ForbiddenPhaseActionCategory, "workspace_protocol">,
): {
  readonly explicitCommandRe: RegExp;
  readonly outcomeClaimRe: RegExp;
} {
  switch (category) {
    case "install":
      return {
        explicitCommandRe: OUTPUT_INSTALL_EXPLICIT_COMMAND_RE,
        outcomeClaimRe: OUTPUT_INSTALL_OUTCOME_CLAIM_RE,
      };
    case "build":
      return {
        explicitCommandRe: OUTPUT_BUILD_EXPLICIT_COMMAND_RE,
        outcomeClaimRe: OUTPUT_BUILD_OUTCOME_CLAIM_RE,
      };
    case "test":
      return {
        explicitCommandRe: OUTPUT_TEST_EXPLICIT_COMMAND_RE,
        outcomeClaimRe: OUTPUT_TEST_OUTCOME_CLAIM_RE,
      };
    case "typecheck":
      return {
        explicitCommandRe: OUTPUT_TYPECHECK_EXPLICIT_COMMAND_RE,
        outcomeClaimRe: OUTPUT_TYPECHECK_OUTCOME_CLAIM_RE,
      };
    case "lint":
      return {
        explicitCommandRe: OUTPUT_LINT_EXPLICIT_COMMAND_RE,
        outcomeClaimRe: OUTPUT_LINT_OUTCOME_CLAIM_RE,
      };
  }
}

function isNegativeForbiddenOutputClaim(
  value: string,
  category: ForbiddenPhaseActionCategory,
): boolean {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length === 0 || !NEGATIVE_PHASE_CONTRACT_RE.test(normalized)) {
    if (category === "workspace_protocol") {
      return /\bworkspace:\*[^.\n]{0,32}\b(?:not used|avoided|excluded|forbidden|disallowed)\b/i
        .test(normalized);
    }
    return false;
  }

  if (category === "workspace_protocol") {
    const negativeWorkspaceProtocolRe = new RegExp(
      String.raw`\b(?:no|without|avoid(?:ing)?|exclude(?:d|ing)?|did\s+not|didn't|do\s+not|don't|never|must\s+not|should\s+not)\b[^.\n]{0,48}\bworkspace:\*|\bworkspace:\*[^.\n]{0,32}\b(?:not used|avoided|excluded|forbidden|disallowed)\b`,
      "i",
    );
    return negativeWorkspaceProtocolRe.test(normalized);
  }

  const subjectPattern = getForbiddenOutputClaimSubjectPattern(category);
  const negativePrefixRe = new RegExp(
    String.raw`\b(?:no|without)\b[^.\n]{0,72}\b${subjectPattern}\b[^.\n]{0,24}\b(?:run|ran|executed|performed|claimed|used|triggered)\b`,
    "i",
  );
  if (negativePrefixRe.test(normalized)) {
    return true;
  }

  const bareNegativeMentionRe = new RegExp(
    String.raw`\b(?:no|without)\b[^.\n]{0,48}\b${subjectPattern}\b`,
    "i",
  );
  if (bareNegativeMentionRe.test(normalized)) {
    return true;
  }

  const negativeVerbRe = new RegExp(
    String.raw`\b(?:did\s+not|didn't|do\s+not|don't|never|must\s+not|should\s+not)\b[^.\n]{0,24}\b(?:run|execute|executed|perform|performed|claim|claimed|use|used|trigger|triggered)\b[^.\n]{0,72}\b${subjectPattern}\b`,
    "i",
  );
  return negativeVerbRe.test(normalized);
}

function validateForbiddenPhaseActions(
  spec: DelegationContractSpec,
  output: string,
  parsedOutput: Record<string, unknown> | undefined,
  toolCalls: readonly DelegationValidationToolCall[] | undefined,
): DelegationOutputValidationResult | undefined {
  const forbiddenCategories = collectForbiddenPhaseActionCategories(spec);
  if (forbiddenCategories.size === 0) {
    return undefined;
  }

  if (Array.isArray(toolCalls)) {
    for (const category of forbiddenCategories) {
      if (category === "workspace_protocol") {
        const offendingMutation = toolCalls.find((toolCall) =>
          hasToolCallFileMutationEvidence(toolCall) &&
          collectStringValues(toolCall.args).some((value) =>
            WORKSPACE_PROTOCOL_RE.test(value)
          )
        );
        if (offendingMutation) {
          return validationFailure(
            "forbidden_phase_action",
            `Delegated phase contract forbids ${
              getForbiddenPhaseCategoryLabel(category)
            } in this phase, but a file mutation used them`,
            parsedOutput,
          );
        }
        continue;
      }

      const offendingToolCall = toolCalls.find((toolCall) =>
        findForbiddenExecutionToolCallExcerpt(toolCall, category) !== undefined
      );
      if (!offendingToolCall) continue;
      const excerpt = findForbiddenExecutionToolCallExcerpt(
        offendingToolCall,
        category,
      );
      return validationFailure(
        "forbidden_phase_action",
        `Delegated phase contract forbids ${
          getForbiddenPhaseCategoryLabel(category)
        } in this phase, but the child executed ${offendingToolCall.name}: ${
          excerpt ?? "command omitted"
        }`,
        parsedOutput,
      );
    }
  }

  const stringValues = [
    output,
    ...collectStringValues(parsedOutput),
  ]
    .map((value) => value.trim())
    .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);
  for (const category of forbiddenCategories) {
    const offendingOutput = stringValues.find((value) => {
      const sanitized = stripDelegationContractEchoes(value, spec);
      return sanitized.length > 0 &&
        getForbiddenOutputClaimExcerpt(sanitized, category) !== undefined;
    });
    if (!offendingOutput) continue;
    const excerpt = getForbiddenOutputClaimExcerpt(
      stripDelegationContractEchoes(offendingOutput, spec),
      category,
    );
    return validationFailure(
      "forbidden_phase_action",
      `Delegated phase contract forbids ${
        getForbiddenPhaseCategoryLabel(category)
      } in this phase, but the child output claimed them: ${
        excerpt ?? "claim omitted"
      }`,
      parsedOutput,
    );
  }

  return undefined;
}

function validateAcceptanceVerificationToolEvidence(
  spec: DelegationContractSpec,
  parsedOutput: Record<string, unknown> | undefined,
  toolCalls: readonly DelegationValidationToolCall[] | undefined,
): DelegationOutputValidationResult | undefined {
  if (!Array.isArray(toolCalls) || (spec.acceptanceCriteria?.length ?? 0) === 0) {
    return undefined;
  }

  const successfulCalls = toolCalls.filter((toolCall) => !isToolCallFailure(toolCall));
  for (const criterion of spec.acceptanceCriteria ?? []) {
    if (shouldSkipAcceptanceEvidenceCriterion(criterion)) {
      continue;
    }
    const categories = getAcceptanceVerificationCategories(criterion);
    if (categories.length === 0) {
      continue;
    }

    const hasMatchingSuccess = successfulCalls.some((toolCall) => {
      const toolCategories = getToolCallVerificationCategories(toolCall);
      return categories.some((category) => toolCategories.includes(category));
    });
    if (hasMatchingSuccess) {
      continue;
    }

    return validationFailure(
      "acceptance_evidence_missing",
      "Acceptance criterion required successful verification evidence but none was observed: " +
        truncateValidationExcerpt(criterion),
      parsedOutput,
    );
  }

  return undefined;
}

function stripDelegationContractEchoes(
  value: string,
  spec: DelegationContractSpec,
): string {
  let sanitized = value;
  const contractTexts = [
    spec.task,
    spec.objective,
    spec.inputContract,
    ...(spec.acceptanceCriteria ?? []),
    ...(spec.contextRequirements ?? []),
  ]
    .filter((entry): entry is string =>
      typeof entry === "string" && entry.trim().length > 0
    )
    .map((entry) => entry.trim())
    .filter((entry, index, entries) => entries.indexOf(entry) === index)
    .sort((a, b) => b.length - a.length);

  for (const contractText of contractTexts) {
    sanitized = sanitized.split(contractText).join(" ");
  }

  return sanitized.replace(/\s+/g, " ").trim();
}

function isMeaningfulBrowserToolCall(
  toolCall: DelegationValidationToolCall,
): boolean {
  const name = toolCall.name?.trim();
  if (!name || !DELEGATION_MEANINGFUL_BROWSER_TOOL_NAMES.has(name)) {
    return false;
  }
  if (LOW_SIGNAL_BROWSER_TOOL_NAMES.has(name)) {
    return false;
  }

  const values = getToolCallStringValues(toolCall);
  if (values.length === 0) {
    return name !== "mcp.browser.browser_navigate" &&
      name !== "playwright.browser_navigate" &&
      name !== "system.browserSessionStart" &&
      name !== "system.browserSessionResume" &&
      name !== "system.browserAction";
  }
  const combined = values.join(" ").toLowerCase();
  if (
    (name === "mcp.browser.browser_navigate" ||
      name === "playwright.browser_navigate" ||
      name === "system.browserSessionStart" ||
      name === "system.browserAction") &&
    !NON_BLANK_BROWSER_TARGET_RE.test(combined)
  ) {
    return false;
  }
  if (ABOUT_BLANK_RE.test(combined) && !NON_BLANK_BROWSER_TARGET_RE.test(combined)) {
    return false;
  }
  return true;
}

function isMeaningfulResearchToolCall(
  toolCall: DelegationValidationToolCall,
): boolean {
  const name = toolCall.name?.trim();
  if (!name || !DELEGATION_MEANINGFUL_RESEARCH_TOOL_NAMES.has(name)) {
    return false;
  }
  if (name === "system.browse") {
    const values = getToolCallStringValues(toolCall);
    if (values.length === 0) return false;
    const combined = values.join(" ").toLowerCase();
    return NON_BLANK_BROWSER_TARGET_RE.test(combined) &&
      !ABOUT_BLANK_RE.test(combined);
  }
  return isMeaningfulBrowserToolCall(toolCall);
}

function isMeaningfulHostBrowserValidationToolCall(
  spec: DelegationContractSpec,
  toolCall: DelegationValidationToolCall,
): boolean {
  const name = toolCall.name?.trim();
  if (!name || !VERIFICATION_EXECUTION_TOOL_NAMES.has(name)) {
    return false;
  }
  if (isToolCallFailure(toolCall)) {
    return false;
  }
  const values = getToolCallStringValues(toolCall);
  if (values.length === 0) {
    return false;
  }
  const combined = values.join(" ");
  const specText = collectDelegationStepText(spec);
  const hasBrowserCue = HOST_BROWSER_VERIFICATION_CUE_RE.test(combined);
  const hasTargetCue = NON_BLANK_BROWSER_TARGET_RE.test(combined) ||
    LOCALHOST_TARGET_CUE_RE.test(combined);
  const specHasBrowserCue = hasPositiveBrowserGroundingCue(specText) ||
    HOST_BROWSER_VERIFICATION_CUE_RE.test(specText);

  return hasBrowserCue && (hasTargetCue || specHasBrowserCue);
}

function getMeaningfulBrowserEvidenceFailureMessage(
  spec: DelegationContractSpec,
  successfulCalls: readonly DelegationValidationToolCall[],
  providerEvidence?: DelegationValidationProviderEvidence,
): string | undefined {
  if (!specRequiresMeaningfulBrowserEvidence(spec)) return undefined;
  const taskIntent = classifyDelegatedTaskIntent(spec);
  if (taskIntent === "research" && hasProviderCitationEvidence(providerEvidence)) {
    return undefined;
  }
  if (
    successfulCalls.some((toolCall) =>
      taskIntent === "research"
        ? isMeaningfulResearchToolCall(toolCall)
        : (
          isMeaningfulBrowserToolCall(toolCall) ||
          isMeaningfulHostBrowserValidationToolCall(spec, toolCall)
        )
    )
  ) {
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

function validateContradictoryCompletionClaim(
  spec: DelegationContractSpec,
  output: string,
  parsedOutput: Record<string, unknown> | undefined,
  toolCalls: readonly DelegationValidationToolCall[] | undefined,
): DelegationOutputValidationResult | undefined {
  const stringValues = [
    output,
    ...collectStringValues(parsedOutput),
  ]
    .map((value) => value.trim())
    .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);

  if (!stringValues.some((value) => DELEGATED_COMPLETION_CLAIM_RE.test(value))) {
    return undefined;
  }

  const allowsExpectedPlaceholders = specAllowsExpectedPlaceholders(spec);

  const unresolvedSnippet = stringValues
    .map((value) =>
      findActionableUnresolvedWorkExcerpt({
        value,
        allowsExpectedPlaceholders,
        source: "output",
      })
    )
    .find((value): value is string => typeof value === "string");
  if (!unresolvedSnippet) {
    if (Array.isArray(toolCalls)) {
      for (const evidence of collectLatestObservedFileStateEvidence(toolCalls)) {
        const evidenceSnippet = findActionableUnresolvedWorkExcerpt({
          value: evidence.content,
          allowsExpectedPlaceholders,
          source: "file",
          path: evidence.path,
        });
        if (!evidenceSnippet) {
          continue;
        }
        const pathPrefix = evidence.path ? `${evidence.path}: ` : "";
        return validationFailure(
          "contradictory_completion_claim",
          "Delegated task output claimed completion while file-mutation evidence still reported unresolved work: " +
            truncateValidationExcerpt(`${pathPrefix}${evidenceSnippet}`),
          parsedOutput,
        );
      }
    }
    return undefined;
  }

  return validationFailure(
    "contradictory_completion_claim",
    "Delegated task output claimed completion while still reporting unresolved work: " +
      truncateValidationExcerpt(unresolvedSnippet),
    parsedOutput,
  );
}

function validateBlockedPhaseOutput(
  spec: DelegationContractSpec,
  output: string,
  parsedOutput: Record<string, unknown> | undefined,
): DelegationOutputValidationResult | undefined {
  const stringValues = [
    output,
    ...collectStringValues(parsedOutput),
  ]
    .map((value) => value.trim())
    .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);

  const allowsExpectedPlaceholders = specAllowsExpectedPlaceholders(spec);

  const blockedSnippet = stringValues.find((value) => {
    const snippets = value
      .split(/\r?\n/u)
      .map((snippet) => snippet.trim())
      .filter((snippet) => snippet.length > 0);
    return snippets.some((snippet) => {
      const strippedContractEcho = stripDelegationContractEchoes(snippet, spec);
      const normalized = strippedContractEcho.replace(
        allowsExpectedPlaceholders ? DELEGATED_ALLOWABLE_PLACEHOLDER_RE : /$^/,
        " ",
      );
      return normalized.length > 0 && DELEGATED_BLOCKED_PHASE_RE.test(normalized);
    });
  });
  if (!blockedSnippet) {
    return undefined;
  }

  return validationFailure(
    "blocked_phase_output",
    "Delegated task output reported the phase as blocked or incomplete instead of completing it: " +
      truncateValidationExcerpt(blockedSnippet),
    parsedOutput,
  );
}

function specAllowsExpectedPlaceholders(
  spec: DelegationContractSpec,
): boolean {
  const segments = [
    spec.task,
    spec.objective,
    spec.inputContract,
    ...(spec.acceptanceCriteria ?? []),
  ];
  if (
    segments
      .filter((value): value is string =>
        typeof value === "string" && value.trim().length > 0
      )
      .some((value) => DELEGATION_EXPECTED_PLACEHOLDER_RE.test(value))
  ) {
    return true;
  }

  const forbiddenCategories = collectForbiddenPhaseActionCategories(spec);
  const forbidsExecutionInSetupPhase =
    forbiddenCategories.has("install") ||
    forbiddenCategories.has("build") ||
    forbiddenCategories.has("test") ||
    forbiddenCategories.has("typecheck") ||
    forbiddenCategories.has("lint");

  return forbidsExecutionInSetupPhase &&
    isSetupHeavyDelegatedTask(spec) &&
    segments
    .filter((value): value is string =>
      typeof value === "string" && value.trim().length > 0
    )
    .some((value) => DELEGATION_FILE_TARGET_RE.test(value));
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
  unsafeBenchmarkMode?: boolean;
}): DelegationOutputValidationResult {
  const {
    spec,
    output,
    toolCalls,
    providerEvidence,
    enforceAcceptanceEvidence = true,
    unsafeBenchmarkMode = false,
  } = params;
  const baseValidation = validateBasicOutputContract({
    inputContract: spec.inputContract,
    output,
  });
  if (!baseValidation.ok) return baseValidation;
  if (unsafeBenchmarkMode) return baseValidation;

  const parsedOutput = baseValidation.parsedOutput;
  const toolEvidenceFailure = validateSuccessfulToolEvidence(
    spec,
    parsedOutput,
    toolCalls,
    providerEvidence,
  );
  if (toolEvidenceFailure) return toolEvidenceFailure;

  const forbiddenPhaseActionFailure = validateForbiddenPhaseActions(
    spec,
    output,
    parsedOutput,
    toolCalls,
  );
  if (forbiddenPhaseActionFailure) return forbiddenPhaseActionFailure;

  const acceptanceVerificationFailure = validateAcceptanceVerificationToolEvidence(
    spec,
    parsedOutput,
    toolCalls,
  );
  const blockedPhaseFailure = validateBlockedPhaseOutput(
    spec,
    output,
    parsedOutput,
  );
  if (blockedPhaseFailure) return blockedPhaseFailure;

  const contradictoryCompletionFailure = validateContradictoryCompletionClaim(
    spec,
    output,
    parsedOutput,
    toolCalls,
  );
  if (contradictoryCompletionFailure) return contradictoryCompletionFailure;

  if (acceptanceVerificationFailure) return acceptanceVerificationFailure;

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
