/**
 * Heuristics for rejecting obviously overloaded delegated child objectives.
 *
 * Large "do everything" subagent prompts are a recurring failure mode: they
 * burn startup budget, timeout, then force the parent into bad fallbacks.
 * This guard prefers a fast explicit failure so the parent can decompose the
 * work into smaller child steps.
 *
 * @module
 */

export interface DelegationScopeSpec {
  readonly task?: string;
  readonly objective?: string;
  readonly inputContract?: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly requiredToolCapabilities?: readonly string[];
}

export type DelegationScopePhase =
  | "setup"
  | "implementation"
  | "validation"
  | "research"
  | "browser";

export interface DelegationDecompositionSuggestion {
  readonly phase: DelegationScopePhase;
  readonly name: string;
  readonly objective: string;
}

export interface DelegationDecompositionSignal {
  readonly code: "needs_decomposition";
  readonly reason: string;
  readonly phases: readonly DelegationScopePhase[];
  readonly suggestedSteps: readonly DelegationDecompositionSuggestion[];
  readonly guidance: string;
}

export interface DelegationScopeAssessment {
  readonly ok: boolean;
  readonly phases: readonly DelegationScopePhase[];
  readonly error?: string;
  readonly decomposition?: DelegationDecompositionSignal;
}

const SETUP_PHASE_RE =
  /\b(?:bootstrap\s+(?:the|a|new)|npm\s+(?:init|install)|pnpm\s+(?:install|add)|scaffold\s+(?:the|a|new)|workspace layout|yarn\s+(?:install|add))\b/i;
const IMPLEMENTATION_ACTION_TARGET_RE =
  /\b(?:author|build|code|create|edit|implement|scaffold|write)\b[^.!?\n]{0,80}\b(?:app|class|code|command|component|config(?:uration)?|directory|directories|entry files?|file|files|game loop|gameplay|helper|helpers|index\.html|main\.ts|manifest|module|package|package\.json|packages\/|routing|simulation engine|src\/|source files?|task|tasks|tsconfig|vite\.config|vitest\.config|workspace)\b/i;
const IMPLEMENTATION_ARTIFACT_RE =
  /\b(?:class|component|helper|helpers|index\.html|main\.ts|manifest|module|package\.json|packages\/|src\/|tsconfig|vite\.config|vitest\.config)\b/i;
const VALIDATION_PHASE_RE =
  /\b(?:verify\s+(?:the|that|all|each|every)|validate\s+(?:the|that|all|each)|qa\s+(?:the|pass|check)|console errors?|open localhost|run_cmd|how to play|known limitations)\b/i;
const RESEARCH_PHASE_RE =
  /\b(?:research\s+(?:the|how|what|which|available|existing|current)|compare\s+(?:options|approaches|frameworks|libraries)|official docs?\s+(?:for|on|about)|primary sources?|official sources?|citations?|devlog)\b/i;
const BROWSER_PHASE_RE =
  /\b(?:playwright|chromium|localhost|snapshot|navigate|click|tabs|browser\s+(?:automation|validation|session|tools?))\b/i;
const NEGATED_BROWSER_REQUIREMENT_RE =
  /\b(?:no|non|without|avoid(?:ing)?|exclude(?:d|ing)?)\s+(?:any\s+|the\s+)?(?:browser(?:-grounded)?(?:\s+tools?)?|browser\s+(?:automation|validation)|playwright|snapshot|navigate|click|tabs)\b/gi;
const DO_NOT_USE_BROWSER_RE =
  /\bdo\s+not\s+use\s+(?:any\s+|the\s+)?(?:browser(?:-grounded)?(?:\s+tools?)?|browser\s+(?:automation|validation)|playwright)\b/gi;
const BROAD_VALIDATION_SCOPE_RE =
  /\b(?:qa\s+(?:the|pass|check)|console errors?|open localhost|run_cmd|how to play|known limitations|critical flows?|manual validation|playtest)\b/i;
const FILE_REFERENCE_RE =
  /\b(?:src\/[a-z0-9_./-]+|[a-z0-9_.-]+\.(?:html?|css|js|jsx|ts|tsx|json|md|txt|py|rs|go))\b/gi;
const BROWSER_TOOL_CAPABILITY_RE =
  /\b(?:browser|playwright|chromium|snapshot|navigate|browseraction|browsersessionstart)\b/i;
const FILE_AUTHORING_CAPABILITY_RE =
  /\b(?:appendfile|desktop\.text_editor|file_system|react|system\.writefile|typescript)\b/i;

function stripNegativeBrowserLanguage(value: string): string {
  return value
    .replace(NEGATED_BROWSER_REQUIREMENT_RE, " ")
    .replace(DO_NOT_USE_BROWSER_RE, " ");
}

function hasPhase(
  phases: readonly DelegationScopePhase[],
  phase: DelegationScopePhase,
): boolean {
  return phases.includes(phase);
}

function hasIncompatibleDelegationPhaseMix(
  phases: readonly DelegationScopePhase[],
  hasBroadValidationScope: boolean,
): boolean {
  const hasResearch = hasPhase(phases, "research");
  const hasImplementation = hasPhase(phases, "implementation");
  const hasValidation = hasPhase(phases, "validation");
  const hasBrowser = hasPhase(phases, "browser");

  // Research children should not also implement or verify deliverables.
  if (hasResearch && (hasImplementation || hasValidation)) {
    return true;
  }

  // Implementation children can run bounded self-verification like focused
  // build/tests, but they should not also own broader QA/browser validation.
  if (hasImplementation && (hasBrowser || (hasValidation && hasBroadValidationScope))) {
    return true;
  }

  return false;
}

function hasImplementationPhase(combined: string): boolean {
  return IMPLEMENTATION_ARTIFACT_RE.test(combined) ||
    IMPLEMENTATION_ACTION_TARGET_RE.test(combined);
}

function normalizeCapabilities(
  capabilities: readonly string[] | undefined,
): readonly string[] {
  return (capabilities ?? [])
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
}

function buildDecompositionSuggestions(
  phases: readonly DelegationScopePhase[],
): DelegationDecompositionSuggestion[] {
  if (phases.length === 0) {
    return [
      {
        phase: "implementation",
        name: "split_delegated_scope",
        objective:
          "Split the delegated objective into smaller phase-specific child tasks before retrying delegation.",
      },
    ];
  }
  const suggestions: DelegationDecompositionSuggestion[] = [];
  for (const phase of phases) {
    if (phase === "research") {
      suggestions.push({
        phase,
        name: "research_requirements",
        objective:
          "Research the required references or official docs and return only the findings needed for the parent task.",
      });
      continue;
    }
    if (phase === "setup") {
      suggestions.push({
        phase,
        name: "scaffold_environment",
        objective:
          "Scaffold the project or environment and install only the required dependencies.",
      });
      continue;
    }
    if (phase === "implementation") {
      suggestions.push({
        phase,
        name: "implement_core_scope",
        objective:
          "Implement the core code changes only, without setup, browser QA, or final verification work.",
      });
      continue;
    }
    if (phase === "browser") {
      suggestions.push({
        phase,
        name: "browser_validation",
        objective:
          "Use browser or Playwright tooling to validate the implemented behavior and capture only the runtime findings.",
      });
      continue;
    }
    suggestions.push({
      phase,
      name: "verify_acceptance",
      objective:
        "Run focused verification and return only the acceptance-check results for the parent task.",
    });
  }
  return suggestions;
}

export function buildDelegationDecompositionSignal(params: {
  phases: readonly DelegationScopePhase[];
  error: string;
}): DelegationDecompositionSignal {
  const suggestions = buildDecompositionSuggestions(params.phases);
  return {
    code: "needs_decomposition",
    reason: params.error,
    phases: params.phases,
    suggestedSteps: suggestions,
    guidance:
      "Re-plan at the parent level. Replace the single delegated objective with smaller steps that each cover one phase and have phase-specific acceptance criteria.",
  };
}

export function assessDelegationScope(
  spec: DelegationScopeSpec,
): DelegationScopeAssessment {
  const combined = [
    spec.task,
    spec.objective,
    spec.inputContract,
    ...(spec.acceptanceCriteria ?? []),
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ");
  const browserNormalized = stripNegativeBrowserLanguage(combined);
  const normalizedCapabilities = normalizeCapabilities(
    spec.requiredToolCapabilities,
  );
  const hasBrowserToolCapability = normalizedCapabilities.some((capability) =>
    BROWSER_TOOL_CAPABILITY_RE.test(capability)
  );
  const hasFileAuthoringCapability = normalizedCapabilities.some((capability) =>
    FILE_AUTHORING_CAPABILITY_RE.test(capability)
  );

  if (combined.length === 0) {
    return { ok: true, phases: [] };
  }

  const phases: DelegationScopePhase[] = [];
  if (SETUP_PHASE_RE.test(combined)) phases.push("setup");
  if (hasImplementationPhase(combined)) phases.push("implementation");
  if (VALIDATION_PHASE_RE.test(combined)) phases.push("validation");
  if (RESEARCH_PHASE_RE.test(combined)) phases.push("research");
  if (BROWSER_PHASE_RE.test(browserNormalized)) phases.push("browser");

  const fileReferenceCount = combined.match(FILE_REFERENCE_RE)?.length ?? 0;
  const clauseCount = combined.split(/\bthen\b|;/i).filter((part) =>
    part.trim().length > 0
  ).length;
  const acceptanceCount = spec.acceptanceCriteria?.length ?? 0;
  const incompatiblePhaseMix = hasIncompatibleDelegationPhaseMix(
    phases,
    BROAD_VALIDATION_SCOPE_RE.test(combined),
  );
  const browserValidationOnly =
    hasPhase(phases, "browser") &&
    hasPhase(phases, "validation") &&
    !hasFileAuthoringCapability &&
    hasBrowserToolCapability;
  const overloaded =
    (
      incompatiblePhaseMix &&
      !browserValidationOnly
    ) ||
    combined.length >= 4_000 ||
    (
      phases.length >= 4 &&
      (fileReferenceCount >= 10 || acceptanceCount >= 8 || clauseCount >= 8)
    );

  if (!overloaded) {
    return { ok: true, phases };
  }

  const error =
    `Delegated objective is overloaded (${phases.join(", ")}). ` +
    "Split it into smaller execute_with_agent steps that each handle one phase " +
    "(for example setup, implementation, verification, or research).";
  return {
    ok: false,
    phases,
    error,
    decomposition: buildDelegationDecompositionSignal({ phases, error }),
  };
}
