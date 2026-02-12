/**
 * Goal-to-workflow compiler.
 *
 * Compiles natural-language objectives into validated `WorkflowDefinition`
 * structures that can be submitted through `DAGOrchestrator`.
 *
 * @module
 */

import { Capability } from '../agent/capabilities.js';
import { hexToBytes } from '../utils/encoding.js';
import type { Logger } from '../utils/logger.js';
import { silentLogger } from '../utils/logger.js';
import { WorkflowValidationError } from './errors.js';
import type { WorkflowDefinition, TaskTemplate } from './types.js';
import { OnChainDependencyType } from './types.js';
import { topologicalSort, validateWorkflow } from './validation.js';

const DESCRIPTION_BYTES = 64;
const CONSTRAINT_HASH_BYTES = 32;

const CAPABILITY_BY_NAME: Readonly<Record<string, bigint>> = Object.freeze({
  COMPUTE: Capability.COMPUTE,
  INFERENCE: Capability.INFERENCE,
  STORAGE: Capability.STORAGE,
  NETWORK: Capability.NETWORK,
  SENSOR: Capability.SENSOR,
  ACTUATOR: Capability.ACTUATOR,
  COORDINATOR: Capability.COORDINATOR,
  ARBITER: Capability.ARBITER,
  VALIDATOR: Capability.VALIDATOR,
  AGGREGATOR: Capability.AGGREGATOR,
});

type CapabilityInput = bigint | number | string | readonly string[];
type LamportsInput = bigint | number | string;

/**
 * Input provided to a planner implementation.
 */
export interface GoalPlannerInput {
  objective: string;
  context?: string;
  constraints?: readonly string[];
  workflowId?: string;
}

/**
 * Single task draft returned by a planner.
 */
export interface PlannerTaskDraft {
  name?: string;
  description?: string;
  dependsOn?: string | null;
  dependencyType?: OnChainDependencyType | 'data' | 'ordering' | 'proof' | null;
  requiredCapabilities?: CapabilityInput;
  rewardAmount?: LamportsInput;
  maxWorkers?: number;
  deadline?: number;
  deadlineSecondsFromNow?: number;
  taskType?: number;
  minReputation?: number;
  constraintHashHex?: string | null;
}

/**
 * Workflow draft returned by a planner.
 */
export interface PlannerWorkflowDraft {
  workflowId?: string;
  confidence?: number;
  rationale?: string;
  tasks: ReadonlyArray<PlannerTaskDraft>;
}

/**
 * Planner interface used by the compiler.
 */
export interface GoalPlanner {
  plan(input: GoalPlannerInput): Promise<PlannerWorkflowDraft>;
}

/**
 * Compiler request.
 */
export interface GoalCompileRequest {
  objective: string;
  context?: string;
  constraints?: readonly string[];
  workflowId?: string;
  maxTasks?: number;
  budgetLamports?: LamportsInput;
  defaultRewardLamports?: LamportsInput;
  defaultMaxWorkers?: number;
  defaultDeadlineSeconds?: number;
  defaultTaskType?: number;
  defaultMinReputation?: number;
  defaultDependencyType?: OnChainDependencyType;
  defaultRequiredCapabilities?: CapabilityInput;
  allowProofDependencies?: boolean;
}

/**
 * Warning generated during normalization/compilation.
 */
export interface GoalCompileWarning {
  code:
    | 'task_name_generated'
    | 'task_name_sanitized'
    | 'task_name_deduped'
    | 'confidence_normalized'
    | 'confidence_out_of_range';
  message: string;
  taskName?: string;
}

/**
 * Dry-run estimate for the compiled workflow.
 */
export interface WorkflowDryRunEstimate {
  workflowId: string;
  taskCount: number;
  edgeCount: number;
  rootTaskCount: number;
  dependentTaskCount: number;
  privateTaskCount: number;
  totalRewardLamports: bigint;
  maxDependencyDepth: number;
  topologicalOrder: string[];
}

/**
 * Result of a goal compilation.
 */
export interface GoalCompileResult {
  definition: WorkflowDefinition;
  dryRun: WorkflowDryRunEstimate;
  plannerConfidence: number | null;
  plannerRationale?: string;
  warnings: GoalCompileWarning[];
}

/**
 * Compiler default values.
 */
export interface GoalCompilerDefaults {
  maxTasks: number;
  defaultRewardLamports: bigint;
  defaultMaxWorkers: number;
  defaultDeadlineSeconds: number;
  defaultTaskType: number;
  defaultMinReputation: number;
  defaultDependencyType: OnChainDependencyType;
  defaultRequiredCapabilities: bigint;
  allowProofDependencies: boolean;
}

/**
 * GoalCompiler configuration.
 */
export interface GoalCompilerConfig {
  planner: GoalPlanner;
  defaults?: Partial<GoalCompilerDefaults>;
  logger?: Logger;
  now?: () => number;
}

interface ResolvedCompileOptions extends GoalCompilerDefaults {
  budgetLamports?: bigint;
}

interface NormalizedTaskInput {
  name: string;
  originalName?: string;
  draft: PlannerTaskDraft;
}

const DEFAULTS: GoalCompilerDefaults = {
  maxTasks: 25,
  defaultRewardLamports: 100_000_000n,
  defaultMaxWorkers: 1,
  defaultDeadlineSeconds: 3600,
  defaultTaskType: 0,
  defaultMinReputation: 0,
  defaultDependencyType: OnChainDependencyType.Data,
  defaultRequiredCapabilities: Capability.COMPUTE,
  allowProofDependencies: true,
};

/**
 * Compiles natural-language goals into validated workflow definitions.
 */
export class GoalCompiler {
  private readonly planner: GoalPlanner;
  private readonly logger: Logger;
  private readonly defaults: GoalCompilerDefaults;
  private readonly now: () => number;

  constructor(config: GoalCompilerConfig) {
    this.planner = config.planner;
    this.logger = config.logger ?? silentLogger;
    this.defaults = { ...DEFAULTS, ...config.defaults };
    this.now = config.now ?? (() => Date.now());
  }

  /**
   * Compile a goal into a workflow definition.
   */
  async compile(request: GoalCompileRequest): Promise<GoalCompileResult> {
    validateObjective(request.objective);
    const options = this.resolveOptions(request);

    const planned = await this.planner.plan({
      objective: request.objective.trim(),
      context: request.context,
      constraints: request.constraints,
      workflowId: request.workflowId,
    });

    const warnings: GoalCompileWarning[] = [];
    const workflowId =
      request.workflowId ??
      planned.workflowId?.trim() ??
      generateWorkflowId(request.objective, this.now());

    const normalizedTasks = normalizeTaskNames(planned.tasks, warnings);
    if (normalizedTasks.length === 0) {
      throw new WorkflowValidationError('Planner returned no tasks');
    }
    if (normalizedTasks.length > options.maxTasks) {
      throw new WorkflowValidationError(
        `Planner returned ${normalizedTasks.length} tasks, exceeding maxTasks=${options.maxTasks}`
      );
    }

    const { tasks, edges } = this.compileTasks(normalizedTasks, options);
    const definition: WorkflowDefinition = {
      id: workflowId,
      tasks,
      edges,
    };

    validateWorkflow(definition);
    const dryRun = estimateWorkflow(definition);

    if (
      options.budgetLamports !== undefined &&
      dryRun.totalRewardLamports > options.budgetLamports
    ) {
      throw new WorkflowValidationError(
        `Compiled reward total ${dryRun.totalRewardLamports} exceeds budget ${options.budgetLamports}`
      );
    }

    const plannerConfidence = normalizeConfidence(planned.confidence, warnings);

    this.logger.info(
      `Compiled goal "${request.objective.slice(0, 80)}" to workflow ${workflowId} (${dryRun.taskCount} tasks)`
    );

    return {
      definition,
      dryRun,
      plannerConfidence,
      plannerRationale: planned.rationale,
      warnings,
    };
  }

  private resolveOptions(request: GoalCompileRequest): ResolvedCompileOptions {
    const maxTasks = parsePositiveInt(
      request.maxTasks ?? this.defaults.maxTasks,
      'maxTasks'
    );
    const defaultMaxWorkers = parsePositiveInt(
      request.defaultMaxWorkers ?? this.defaults.defaultMaxWorkers,
      'defaultMaxWorkers'
    );
    const defaultTaskType = parseTaskType(
      request.defaultTaskType ?? this.defaults.defaultTaskType,
      'defaultTaskType'
    );
    const defaultMinReputation = parseMinReputation(
      request.defaultMinReputation ?? this.defaults.defaultMinReputation,
      'defaultMinReputation'
    );
    const defaultDependencyType = parseDependencyType(
      request.defaultDependencyType ?? this.defaults.defaultDependencyType,
      'defaultDependencyType'
    );
    const defaultDeadlineSeconds = parseNonNegativeInt(
      request.defaultDeadlineSeconds ?? this.defaults.defaultDeadlineSeconds,
      'defaultDeadlineSeconds'
    );
    const defaultRewardLamports = parseLamports(
      request.defaultRewardLamports ?? this.defaults.defaultRewardLamports,
      'defaultRewardLamports'
    );
    const defaultRequiredCapabilities = parseCapabilities(
      request.defaultRequiredCapabilities ?? this.defaults.defaultRequiredCapabilities,
      'defaultRequiredCapabilities'
    );
    const allowProofDependencies =
      request.allowProofDependencies ?? this.defaults.allowProofDependencies;
    const budgetLamports =
      request.budgetLamports !== undefined
        ? parseLamports(request.budgetLamports, 'budgetLamports')
        : undefined;

    return {
      maxTasks,
      defaultRewardLamports,
      defaultMaxWorkers,
      defaultDeadlineSeconds,
      defaultTaskType,
      defaultMinReputation,
      defaultDependencyType,
      defaultRequiredCapabilities,
      allowProofDependencies,
      budgetLamports,
    };
  }

  private compileTasks(
    normalizedTasks: readonly NormalizedTaskInput[],
    options: ResolvedCompileOptions
  ): { tasks: TaskTemplate[]; edges: { from: string; to: string; dependencyType: OnChainDependencyType }[] } {
    const nameLookup = new Map<string, string>();
    for (const task of normalizedTasks) {
      nameLookup.set(task.name, task.name);
      if (task.originalName) {
        nameLookup.set(task.originalName.trim(), task.name);
        nameLookup.set(normalizeName(task.originalName), task.name);
      }
    }

    const nowSeconds = Math.floor(this.now() / 1000);
    const tasks: TaskTemplate[] = [];
    const edges: Array<{ from: string; to: string; dependencyType: OnChainDependencyType }> = [];

    for (const taskInput of normalizedTasks) {
      const draft = taskInput.draft;
      const description = encodeTaskDescription(draft.description, taskInput.name);
      const requiredCapabilities = parseCapabilities(
        draft.requiredCapabilities ?? options.defaultRequiredCapabilities,
        `requiredCapabilities for "${taskInput.name}"`
      );
      const rewardAmount = parseLamports(
        draft.rewardAmount ?? options.defaultRewardLamports,
        `rewardAmount for "${taskInput.name}"`
      );
      const maxWorkers = parsePositiveInt(
        draft.maxWorkers ?? options.defaultMaxWorkers,
        `maxWorkers for "${taskInput.name}"`
      );
      const taskType = parseTaskType(
        draft.taskType ?? options.defaultTaskType,
        `taskType for "${taskInput.name}"`
      );
      const minReputation = parseMinReputation(
        draft.minReputation ?? options.defaultMinReputation,
        `minReputation for "${taskInput.name}"`
      );

      const deadline =
        draft.deadline !== undefined
          ? parseNonNegativeInt(draft.deadline, `deadline for "${taskInput.name}"`)
          : nowSeconds +
            (draft.deadlineSecondsFromNow !== undefined
              ? parseNonNegativeInt(
                  draft.deadlineSecondsFromNow,
                  `deadlineSecondsFromNow for "${taskInput.name}"`
                )
              : options.defaultDeadlineSeconds);

      const constraintHash = parseConstraintHash(
        draft.constraintHashHex,
        `constraintHashHex for "${taskInput.name}"`
      );

      const taskTemplate: TaskTemplate = {
        name: taskInput.name,
        description,
        requiredCapabilities,
        rewardAmount,
        maxWorkers,
        deadline,
        taskType,
        minReputation,
        ...(constraintHash ? { constraintHash } : {}),
      };
      tasks.push(taskTemplate);

      if (draft.dependsOn) {
        const parentName = resolveParentName(draft.dependsOn, nameLookup, taskInput.name);
        const dependencyType = parseDependencyType(
          draft.dependencyType ?? options.defaultDependencyType,
          `dependencyType for "${taskInput.name}"`
        );
        if (
          dependencyType === OnChainDependencyType.Proof &&
          !options.allowProofDependencies
        ) {
          throw new WorkflowValidationError(
            `Proof dependency is disabled for "${taskInput.name}"`
          );
        }
        edges.push({
          from: parentName,
          to: taskInput.name,
          dependencyType,
        });
      }
    }

    return { tasks, edges };
  }
}

/**
 * Estimate workflow stats for dry-run reporting.
 */
export function estimateWorkflow(definition: WorkflowDefinition): WorkflowDryRunEstimate {
  const parentByChild = new Map<string, string>();
  for (const edge of definition.edges) {
    parentByChild.set(edge.to, edge.from);
  }

  const depthMemo = new Map<string, number>();
  const depthOf = (name: string): number => {
    const cached = depthMemo.get(name);
    if (cached !== undefined) return cached;
    const parent = parentByChild.get(name);
    const depth = parent ? depthOf(parent) + 1 : 0;
    depthMemo.set(name, depth);
    return depth;
  };

  let maxDepth = 0;
  let privateTaskCount = 0;
  let totalRewardLamports = 0n;

  for (const task of definition.tasks) {
    const depth = depthOf(task.name);
    if (depth > maxDepth) maxDepth = depth;
    if (task.constraintHash) privateTaskCount++;
    totalRewardLamports += task.rewardAmount;
  }

  const edgeCount = definition.edges.length;
  const taskCount = definition.tasks.length;
  const dependentTaskCount = edgeCount;
  const rootTaskCount = taskCount - dependentTaskCount;

  return {
    workflowId: definition.id,
    taskCount,
    edgeCount,
    rootTaskCount,
    dependentTaskCount,
    privateTaskCount,
    totalRewardLamports,
    maxDependencyDepth: maxDepth,
    topologicalOrder: topologicalSort(definition),
  };
}

function normalizeTaskNames(
  drafts: ReadonlyArray<PlannerTaskDraft>,
  warnings: GoalCompileWarning[]
): NormalizedTaskInput[] {
  if (!Array.isArray(drafts)) {
    throw new WorkflowValidationError('Planner returned invalid tasks array');
  }

  const used = new Set<string>();
  const out: NormalizedTaskInput[] = [];

  for (let i = 0; i < drafts.length; i++) {
    const draft = drafts[i];
    const originalName =
      typeof draft.name === 'string' && draft.name.trim().length > 0
        ? draft.name.trim()
        : undefined;

    let baseName = originalName ?? `task_${i + 1}`;
    if (!originalName) {
      warnings.push({
        code: 'task_name_generated',
        message: `Task ${i + 1} had no name; generated "${baseName}"`,
      });
    }

    const sanitized = normalizeName(baseName);
    if (sanitized !== baseName) {
      warnings.push({
        code: 'task_name_sanitized',
        message: `Task name "${baseName}" normalized to "${sanitized}"`,
        taskName: sanitized,
      });
    }
    baseName = sanitized;

    let name = baseName;
    let counter = 2;
    while (used.has(name)) {
      name = `${baseName}_${counter}`;
      counter += 1;
    }
    if (name !== baseName) {
      warnings.push({
        code: 'task_name_deduped',
        message: `Duplicate task name "${baseName}" renamed to "${name}"`,
        taskName: name,
      });
    }
    used.add(name);
    out.push({ name, originalName, draft });
  }

  return out;
}

function validateObjective(objective: string): void {
  if (typeof objective !== 'string' || objective.trim().length === 0) {
    throw new WorkflowValidationError('objective must be a non-empty string');
  }
}

function normalizeName(input: string): string {
  const trimmed = input.trim();
  const normalized = trimmed
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 64);
  return normalized.length > 0 ? normalized : 'task';
}

function resolveParentName(
  value: string,
  lookup: ReadonlyMap<string, string>,
  childName: string
): string {
  const direct = lookup.get(value.trim());
  const normalized = lookup.get(normalizeName(value));
  const parent = direct ?? normalized;
  if (!parent) {
    throw new WorkflowValidationError(
      `Task "${childName}" depends on unknown parent "${value}"`
    );
  }
  if (parent === childName) {
    throw new WorkflowValidationError(`Task "${childName}" cannot depend on itself`);
  }
  return parent;
}

function parseLamports(value: LamportsInput, field: string): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new WorkflowValidationError(`${field} must be >= 0`);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) {
      throw new WorkflowValidationError(`${field} must be a non-negative integer`);
    }
    return BigInt(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new WorkflowValidationError(`${field} must be an integer string`);
    }
    return BigInt(trimmed);
  }
  throw new WorkflowValidationError(`${field} has invalid value`);
}

function parsePositiveInt(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new WorkflowValidationError(`${field} must be a positive integer`);
  }
  return value;
}

function parseNonNegativeInt(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new WorkflowValidationError(`${field} must be a non-negative integer`);
  }
  return value;
}

function parseTaskType(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 2) {
    throw new WorkflowValidationError(`${field} must be 0, 1, or 2`);
  }
  return value;
}

function parseMinReputation(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new WorkflowValidationError(`${field} must be between 0 and 10000`);
  }
  return value;
}

function parseCapabilities(value: CapabilityInput, field: string): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new WorkflowValidationError(`${field} must be >= 0`);
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new WorkflowValidationError(`${field} must be a non-negative integer`);
    }
    return BigInt(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      return BigInt(trimmed);
    }
    const tokens = trimmed
      .split(/[,\s|]+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 0);
    if (tokens.length === 0) {
      throw new WorkflowValidationError(`${field} is empty`);
    }
    return parseCapabilityTokens(tokens, field);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      throw new WorkflowValidationError(`${field} cannot be an empty array`);
    }
    return parseCapabilityTokens(value, field);
  }
  throw new WorkflowValidationError(`${field} has invalid value`);
}

function parseCapabilityTokens(tokens: readonly string[], field: string): bigint {
  let mask = 0n;
  for (const token of tokens) {
    const normalized = token.toUpperCase();
    const capability = CAPABILITY_BY_NAME[normalized];
    if (capability === undefined) {
      throw new WorkflowValidationError(
        `${field} contains unknown capability "${token}"`
      );
    }
    mask |= capability;
  }
  return mask;
}

function parseDependencyType(
  value: PlannerTaskDraft['dependencyType'],
  field: string
): OnChainDependencyType {
  if (typeof value === 'number') {
    if (
      value === OnChainDependencyType.Data ||
      value === OnChainDependencyType.Ordering ||
      value === OnChainDependencyType.Proof
    ) {
      return value;
    }
    throw new WorkflowValidationError(
      `${field} must be Data (1), Ordering (2), or Proof (3)`
    );
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'data') return OnChainDependencyType.Data;
    if (normalized === 'ordering' || normalized === 'order') {
      return OnChainDependencyType.Ordering;
    }
    if (normalized === 'proof') return OnChainDependencyType.Proof;
    throw new WorkflowValidationError(
      `${field} must be "data", "ordering", or "proof"`
    );
  }
  throw new WorkflowValidationError(`${field} has invalid value`);
}

function parseConstraintHash(
  value: string | null | undefined,
  field: string
): Uint8Array | undefined {
  if (value === undefined || value === null) return undefined;
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(value);
  } catch {
    throw new WorkflowValidationError(`${field} must be a valid hex string`);
  }
  if (bytes.length !== CONSTRAINT_HASH_BYTES) {
    throw new WorkflowValidationError(
      `${field} must be ${CONSTRAINT_HASH_BYTES} bytes (64 hex chars)`
    );
  }
  return bytes;
}

function encodeTaskDescription(
  value: string | undefined,
  taskName: string
): Uint8Array {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new WorkflowValidationError(
      `Task "${taskName}" description must be a non-empty string`
    );
  }
  const encoded = new TextEncoder().encode(value.trim());
  if (encoded.length > DESCRIPTION_BYTES) {
    throw new WorkflowValidationError(
      `Task "${taskName}" description exceeds ${DESCRIPTION_BYTES} bytes`
    );
  }
  const out = new Uint8Array(DESCRIPTION_BYTES);
  out.set(encoded);
  return out;
}

function normalizeConfidence(
  value: number | undefined,
  warnings: GoalCompileWarning[]
): number | null {
  if (value === undefined) return null;
  if (!Number.isFinite(value) || value < 0) {
    warnings.push({
      code: 'confidence_out_of_range',
      message: `Planner confidence "${value}" ignored (expected 0..1 or 0..100)`,
    });
    return null;
  }
  if (value <= 1) return value;
  if (value <= 100) {
    warnings.push({
      code: 'confidence_normalized',
      message: `Planner confidence ${value} normalized to ${value / 100}`,
    });
    return value / 100;
  }
  warnings.push({
    code: 'confidence_out_of_range',
    message: `Planner confidence "${value}" ignored (expected 0..1 or 0..100)`,
  });
  return null;
}

function generateWorkflowId(objective: string, nowMs: number): string {
  const base = objective
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36);
  const prefix = base.length > 0 ? base : 'workflow';
  return `${prefix}-${Math.floor(nowMs / 1000)}`;
}
