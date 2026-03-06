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
  /\b(?:scaffold|bootstrap|mkdir|npm\s+(?:init|install)|pnpm\s+(?:install|add)|yarn\s+(?:install|add)|dependency|dependencies)\b/i;
const IMPLEMENTATION_PHASE_RE =
  /\b(?:create|edit|write|implement|code|class|module|component|game loop|src\/|index\.html|package\.json|tsconfig|vite\.config)\b/i;
const VALIDATION_PHASE_RE =
  /\b(?:verify|validate|qa|console errors?|open localhost|run_cmd|how to play|known limitations|run tests?|build checks?)\b/i;
const RESEARCH_PHASE_RE =
  /\b(?:research|compare|official docs?|primary sources?|sources?|devlog)\b/i;
const BROWSER_PHASE_RE =
  /\b(?:playwright|browser|snapshot|navigate|click|tabs)\b/i;
const FILE_REFERENCE_RE =
  /\b(?:src\/[a-z0-9_./-]+|[a-z0-9_.-]+\.(?:html?|css|js|jsx|ts|tsx|json|md|txt|py|rs|go))\b/gi;

function hasPhase(
  phases: readonly DelegationScopePhase[],
  phase: DelegationScopePhase,
): boolean {
  return phases.includes(phase);
}

function hasIncompatibleDelegationPhaseMix(
  phases: readonly DelegationScopePhase[],
): boolean {
  const hasResearch = hasPhase(phases, "research");
  const hasImplementation = hasPhase(phases, "implementation");
  const hasValidation = hasPhase(phases, "validation");
  const hasBrowser = hasPhase(phases, "browser");

  // Research children should not also implement or verify deliverables.
  if (hasResearch && (hasImplementation || hasValidation)) {
    return true;
  }

  // Implementation children should not also own browser/QA work.
  if (hasImplementation && (hasValidation || hasBrowser)) {
    return true;
  }

  return false;
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

  if (combined.length === 0) {
    return { ok: true, phases: [] };
  }

  const phases: DelegationScopePhase[] = [];
  if (SETUP_PHASE_RE.test(combined)) phases.push("setup");
  if (IMPLEMENTATION_PHASE_RE.test(combined)) phases.push("implementation");
  if (VALIDATION_PHASE_RE.test(combined)) phases.push("validation");
  if (RESEARCH_PHASE_RE.test(combined)) phases.push("research");
  if (BROWSER_PHASE_RE.test(combined)) phases.push("browser");

  const fileReferenceCount = combined.match(FILE_REFERENCE_RE)?.length ?? 0;
  const clauseCount = combined.split(/\bthen\b|;/i).filter((part) =>
    part.trim().length > 0
  ).length;
  const acceptanceCount = spec.acceptanceCriteria?.length ?? 0;
  const incompatiblePhaseMix = hasIncompatibleDelegationPhaseMix(phases);
  const overloaded =
    incompatiblePhaseMix ||
    combined.length >= 2_000 ||
    (
      phases.length >= 3 &&
      (fileReferenceCount >= 6 || acceptanceCount >= 5 || clauseCount >= 6)
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
