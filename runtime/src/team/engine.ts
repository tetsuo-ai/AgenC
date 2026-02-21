/**
 * Team contract lifecycle engine.
 *
 * @module
 */

import { hasCapability } from "../agent/capabilities.js";
import { InMemoryTeamAuditStore } from "./audit.js";
import type { TeamAuditStore } from "./audit.js";
import {
  TeamContractStateError,
  TeamContractValidationError,
  TeamPayoutError,
} from "./errors.js";
import { computeTeamPayout } from "./payout.js";
import type {
  RoleFailureAttribution,
  TeamAuditEvent,
  TeamCheckpointState,
  TeamContractSnapshot,
  TeamEngineHooks,
  TeamMember,
  TeamMemberInput,
  TeamPayoutResult,
  TeamTemplate,
} from "./types.js";
import { canonicalizeTeamId, validateTeamId } from "./types.js";
import { normalizeTeamTemplate, validateTeamTemplate } from "./validation.js";

export interface TeamContractEngineConfig {
  now?: () => number;
  hooks?: TeamEngineHooks;
  auditStore?: TeamAuditStore;
  maxAuditEventsPerContract?: number;
  requireSingleParentTopology?: boolean;
}

export interface CreateTeamContractInput {
  contractId: string;
  creatorId: string;
  template: TeamTemplate;
}

export interface JoinTeamContractInput {
  contractId: string;
  member: TeamMemberInput;
}

export interface AssignTeamRoleInput {
  contractId: string;
  memberId: string;
  roleId: string;
}

export interface CompleteTeamCheckpointInput {
  contractId: string;
  checkpointId: string;
  memberId: string;
  outputDigest?: string;
}

export interface FailTeamCheckpointInput {
  contractId: string;
  checkpointId: string;
  memberId: string;
  reason: string;
}

export interface FinalizeTeamPayoutInput {
  contractId: string;
  totalRewardLamports: bigint;
}

export interface CancelTeamContractInput {
  contractId: string;
  reason?: string;
}

interface TeamContractRecord {
  id: string;
  creatorId: string;
  template: TeamTemplate;
  status: TeamContractSnapshot["status"];
  members: Map<string, TeamMember>;
  roleAssignments: Map<string, string[]>;
  checkpoints: Map<string, TeamCheckpointState>;
  startedAt: number | null;
  completedAt: number | null;
  cancelledAt: number | null;
  finalizedPayout: Readonly<TeamPayoutResult> | null;
  auditSequence: number;
}

export class TeamContractEngine {
  private readonly contracts = new Map<string, TeamContractRecord>();
  private readonly now: () => number;
  private readonly hooks: TeamEngineHooks;
  private readonly auditStore: TeamAuditStore;
  private readonly requireSingleParentTopology: boolean;
  private inHook = false;

  constructor(config: TeamContractEngineConfig = {}) {
    this.now = config.now ?? Date.now;
    this.hooks = config.hooks ?? {};
    this.auditStore =
      config.auditStore ??
      new InMemoryTeamAuditStore({
        maxEventsPerContract: config.maxAuditEventsPerContract,
      });
    this.requireSingleParentTopology =
      config.requireSingleParentTopology ?? true;
  }

  createContract(input: CreateTeamContractInput): TeamContractSnapshot {
    this.assertNotInHook();

    const contractId = normalizeIdOrThrow(input.contractId, "contract id");
    const creatorId = normalizeIdOrThrow(input.creatorId, "creator id");

    if (this.contracts.has(contractId)) {
      throw new TeamContractStateError(
        `contract "${contractId}" already exists`,
      );
    }

    const normalizedTemplate = normalizeTeamTemplate(input.template);
    this.wrapValidationError(() => {
      validateTeamTemplate(normalizedTemplate, {
        requireSingleParent: this.requireSingleParentTopology,
      });
    });

    const checkpoints = new Map<string, TeamCheckpointState>();
    for (const checkpoint of normalizedTemplate.checkpoints) {
      checkpoints.set(checkpoint.id, {
        id: checkpoint.id,
        roleId: checkpoint.roleId,
        label: checkpoint.label,
        dependsOn: [...(checkpoint.dependsOn ?? [])],
        required: checkpoint.required ?? true,
        status: (checkpoint.dependsOn?.length ?? 0) === 0 ? "ready" : "pending",
        completedBy: null,
        completedAt: null,
        outputDigest: null,
        failedBy: null,
        failedAt: null,
        failureReason: null,
      });
    }

    const roleAssignments = new Map<string, string[]>();
    for (const role of normalizedTemplate.roles) {
      roleAssignments.set(role.id, []);
    }

    const record: TeamContractRecord = {
      id: contractId,
      creatorId,
      template: deepFreeze(cloneTemplate(normalizedTemplate)) as TeamTemplate,
      status: "draft",
      members: new Map<string, TeamMember>(),
      roleAssignments,
      checkpoints,
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      finalizedPayout: null,
      auditSequence: 1,
    };

    this.contracts.set(contractId, record);

    this.recordAuditEvent(record, "contract_created", {
      creatorId,
      templateId: normalizedTemplate.id,
      roleCount: normalizedTemplate.roles.length,
      checkpointCount: normalizedTemplate.checkpoints.length,
    });

    return this.toSnapshot(record);
  }

  joinContract(input: JoinTeamContractInput): TeamContractSnapshot {
    this.assertNotInHook();
    const record = this.getContractRecordOrThrow(input.contractId);
    this.assertStatus(record, "draft", "join members");

    const member = normalizeMemberInput(input.member);
    if (record.members.has(member.id)) {
      throw new TeamContractStateError(
        `member "${member.id}" already exists in contract`,
      );
    }

    const memberRecord: TeamMember = {
      id: member.id,
      capabilities: member.capabilities,
      roles: [],
      active: true,
      joinedAt: this.now(),
      leftAt: null,
      metadata: cloneMetadata(member.metadata),
    };

    record.members.set(memberRecord.id, memberRecord);

    this.recordAuditEvent(record, "member_joined", {
      memberId: memberRecord.id,
      capabilityMask: memberRecord.capabilities.toString(),
    });

    for (const requestedRole of member.roles ?? []) {
      this.assignRoleInternal(record, memberRecord.id, requestedRole, true);
    }

    return this.toSnapshot(record);
  }

  leaveContract(contractId: string, memberId: string): TeamContractSnapshot {
    this.assertNotInHook();
    const record = this.getContractRecordOrThrow(contractId);
    this.assertStatus(record, "draft", "leave members");

    const canonicalMemberId = normalizeIdOrThrow(memberId, "member id");
    const member = record.members.get(canonicalMemberId);
    if (!member || !member.active) {
      throw new TeamContractStateError(
        `member "${canonicalMemberId}" is not active`,
      );
    }

    for (const roleId of member.roles) {
      const assignments = record.roleAssignments.get(roleId) ?? [];
      record.roleAssignments.set(
        roleId,
        assignments.filter((assigned) => assigned !== canonicalMemberId),
      );
    }

    member.active = false;
    member.leftAt = this.now();
    member.roles = [];

    this.recordAuditEvent(record, "member_left", {
      memberId: canonicalMemberId,
    });

    return this.toSnapshot(record);
  }

  assignRole(input: AssignTeamRoleInput): TeamContractSnapshot {
    this.assertNotInHook();
    const record = this.getContractRecordOrThrow(input.contractId);
    this.assertStatus(record, "draft", "assign roles");

    const memberId = normalizeIdOrThrow(input.memberId, "member id");
    const roleId = normalizeIdOrThrow(input.roleId, "role id");
    this.assignRoleInternal(record, memberId, roleId, true);

    return this.toSnapshot(record);
  }

  startRun(contractId: string): TeamContractSnapshot {
    this.assertNotInHook();
    const record = this.getContractRecordOrThrow(contractId);
    this.assertStatus(record, "draft", "start run");

    for (const role of record.template.roles) {
      const assignedCount = (record.roleAssignments.get(role.id) ?? []).length;
      const minMembers = role.minMembers ?? 1;
      const maxMembers = role.maxMembers ?? 1;

      if (assignedCount < minMembers) {
        throw new TeamContractStateError(
          `role "${role.id}" requires at least ${minMembers} members (assigned ${assignedCount})`,
        );
      }
      if (assignedCount > maxMembers) {
        throw new TeamContractStateError(
          `role "${role.id}" allows at most ${maxMembers} members (assigned ${assignedCount})`,
        );
      }
    }

    // Re-validate graph at run start to guarantee launch compatibility.
    this.wrapValidationError(() => {
      validateTeamTemplate(record.template, {
        requireSingleParent: this.requireSingleParentTopology,
      });
    });

    record.status = "active";
    record.startedAt = this.now();
    this.refreshCheckpointReadiness(record);

    this.recordAuditEvent(record, "run_started", {
      activeMembers: Array.from(record.members.values()).filter(
        (member) => member.active,
      ).length,
    });

    return this.toSnapshot(record);
  }

  cancelContract(input: CancelTeamContractInput): TeamContractSnapshot {
    this.assertNotInHook();
    const record = this.getContractRecordOrThrow(input.contractId);

    if (record.status === "cancelled") {
      return this.toSnapshot(record);
    }

    if (record.status === "completed" || record.status === "failed") {
      throw new TeamContractStateError(
        `cannot cancel contract in terminal state "${record.status}"`,
      );
    }

    const now = this.now();
    record.status = "cancelled";
    record.cancelledAt = now;
    record.completedAt = now;

    this.recordAuditEvent(record, "contract_cancelled", {
      reason: input.reason ?? "cancelled",
    });

    return this.toSnapshot(record);
  }

  completeCheckpoint(input: CompleteTeamCheckpointInput): TeamContractSnapshot {
    this.assertNotInHook();
    const record = this.getContractRecordOrThrow(input.contractId);
    this.assertStatus(record, "active", "complete checkpoints");

    const checkpointId = normalizeIdOrThrow(
      input.checkpointId,
      "checkpoint id",
    );
    const memberId = normalizeIdOrThrow(input.memberId, "member id");

    const checkpoint = record.checkpoints.get(checkpointId);
    if (!checkpoint) {
      throw new TeamContractStateError(
        `checkpoint "${checkpointId}" not found`,
      );
    }

    if (checkpoint.status === "completed") {
      return this.toSnapshot(record);
    }
    if (checkpoint.status === "failed" || checkpoint.status === "blocked") {
      throw new TeamContractStateError(
        `checkpoint "${checkpointId}" cannot be completed from status "${checkpoint.status}"`,
      );
    }

    this.assertMemberCanActOnRole(record, memberId, checkpoint.roleId);

    if (!this.areDependenciesCompleted(record, checkpoint.dependsOn)) {
      throw new TeamContractStateError(
        `checkpoint "${checkpointId}" dependencies are not fully completed`,
      );
    }

    checkpoint.status = "completed";
    checkpoint.completedBy = memberId;
    checkpoint.completedAt = this.now();
    checkpoint.outputDigest = input.outputDigest?.trim() || null;

    this.refreshCheckpointReadiness(record);

    this.recordAuditEvent(record, "checkpoint_completed", {
      checkpointId,
      roleId: checkpoint.roleId,
      memberId,
    });

    if (this.areAllRequiredCheckpointsCompleted(record)) {
      record.status = "completed";
      record.completedAt = this.now();
    }

    return this.toSnapshot(record);
  }

  failCheckpoint(input: FailTeamCheckpointInput): TeamContractSnapshot {
    this.assertNotInHook();
    const record = this.getContractRecordOrThrow(input.contractId);
    this.assertStatus(record, "active", "fail checkpoints");

    const checkpointId = normalizeIdOrThrow(
      input.checkpointId,
      "checkpoint id",
    );
    const memberId = normalizeIdOrThrow(input.memberId, "member id");
    const reason = input.reason.trim();

    if (reason.length === 0) {
      throw new TeamContractValidationError("failure reason must not be empty");
    }

    const checkpoint = record.checkpoints.get(checkpointId);
    if (!checkpoint) {
      throw new TeamContractStateError(
        `checkpoint "${checkpointId}" not found`,
      );
    }

    if (checkpoint.status === "failed") {
      return this.toSnapshot(record);
    }
    if (checkpoint.status === "completed") {
      throw new TeamContractStateError(
        `checkpoint "${checkpointId}" is already completed`,
      );
    }

    this.assertMemberCanActOnRole(record, memberId, checkpoint.roleId);

    const failedAt = this.now();
    checkpoint.status = "failed";
    checkpoint.failedBy = memberId;
    checkpoint.failedAt = failedAt;
    checkpoint.failureReason = reason;

    this.blockDependentCheckpoints(record, checkpointId);

    if (checkpoint.required) {
      record.status = "failed";
      record.completedAt = failedAt;
    }

    const failure: RoleFailureAttribution = {
      contractId: record.id,
      roleId: checkpoint.roleId,
      checkpointId,
      memberId,
      reason,
      atMs: failedAt,
    };

    this.recordAuditEvent(record, "checkpoint_failed", {
      checkpointId,
      roleId: checkpoint.roleId,
      memberId,
      reason,
    });

    this.invokeHook(() => {
      this.hooks.onRoleFailure?.(failure);
    });

    return this.toSnapshot(record);
  }

  finalizePayout(input: FinalizeTeamPayoutInput): Readonly<TeamPayoutResult> {
    this.assertNotInHook();
    const record = this.getContractRecordOrThrow(input.contractId);

    if (record.status === "cancelled") {
      throw new TeamContractStateError(
        "cannot finalize payout for cancelled contract",
      );
    }

    if (record.finalizedPayout) {
      return record.finalizedPayout;
    }

    if (record.status === "draft") {
      throw new TeamContractStateError(
        "cannot finalize payout before run start",
      );
    }

    if (record.status === "active") {
      if (!this.areAllRequiredCheckpointsCompleted(record)) {
        throw new TeamContractStateError(
          "cannot finalize payout while required checkpoints remain incomplete",
        );
      }
      record.status = "completed";
      record.completedAt = this.now();
    }

    if (input.totalRewardLamports < 0n) {
      throw new TeamPayoutError("total reward must be non-negative");
    }

    const payout = computeTeamPayout({
      totalRewardLamports: input.totalRewardLamports,
      template: record.template,
      checkpoints: this.checkpointRecord(record),
      roleAssignments: this.roleAssignmentRecord(record),
    });

    record.finalizedPayout = deepFreeze(
      clonePayoutResult(payout),
    ) as Readonly<TeamPayoutResult>;

    this.recordAuditEvent(record, "payout_finalized", {
      totalRewardLamports: input.totalRewardLamports.toString(),
      unallocatedLamports: payout.unallocatedLamports.toString(),
    });

    return record.finalizedPayout;
  }

  getContract(contractId: string): TeamContractSnapshot | null {
    const id = normalizeIdOrThrow(contractId, "contract id");
    const record = this.contracts.get(id);
    return record ? this.toSnapshot(record) : null;
  }

  listAuditEvents(contractId: string): TeamAuditEvent[] {
    const id = normalizeIdOrThrow(contractId, "contract id");
    return this.auditStore.list(id);
  }

  private assignRoleInternal(
    record: TeamContractRecord,
    memberId: string,
    roleId: string,
    emitAudit: boolean,
  ): void {
    const member = record.members.get(memberId);
    if (!member || !member.active) {
      throw new TeamContractStateError(`member "${memberId}" is not active`);
    }

    const role = record.template.roles.find(
      (candidate) => candidate.id === roleId,
    );
    if (!role) {
      throw new TeamContractValidationError(`unknown role "${roleId}"`);
    }

    if (!hasCapability(member.capabilities, role.requiredCapabilities)) {
      throw new TeamContractValidationError(
        `member "${memberId}" does not satisfy required capabilities for role "${roleId}"`,
      );
    }

    const assigned = record.roleAssignments.get(roleId) ?? [];
    if (assigned.includes(memberId)) {
      return;
    }

    const maxMembers = role.maxMembers ?? 1;
    if (assigned.length >= maxMembers) {
      throw new TeamContractStateError(
        `role "${roleId}" is full (${assigned.length}/${maxMembers})`,
      );
    }

    assigned.push(memberId);
    assigned.sort((a, b) => a.localeCompare(b));
    record.roleAssignments.set(roleId, assigned);

    const memberRoles = [...member.roles, roleId].sort((a, b) =>
      a.localeCompare(b),
    );
    member.roles = uniqueSorted(memberRoles);

    if (emitAudit) {
      this.recordAuditEvent(record, "role_assigned", {
        memberId,
        roleId,
      });
    }
  }

  private assertMemberCanActOnRole(
    record: TeamContractRecord,
    memberId: string,
    roleId: string,
  ): void {
    const member = record.members.get(memberId);
    if (!member || !member.active) {
      throw new TeamContractStateError(`member "${memberId}" is not active`);
    }

    const assigned = record.roleAssignments.get(roleId) ?? [];
    if (!assigned.includes(memberId)) {
      throw new TeamContractStateError(
        `member "${memberId}" is not assigned to role "${roleId}"`,
      );
    }
  }

  private refreshCheckpointReadiness(record: TeamContractRecord): void {
    let changed = true;

    // Iterate until stable because one update can unlock downstream checkpoints.
    while (changed) {
      changed = false;

      for (const checkpoint of record.checkpoints.values()) {
        if (
          checkpoint.status === "completed" ||
          checkpoint.status === "failed" ||
          checkpoint.status === "blocked"
        ) {
          continue;
        }

        const hasFailedDependency = checkpoint.dependsOn
          .map((depId) => record.checkpoints.get(depId))
          .some((dep) => dep?.status === "failed" || dep?.status === "blocked");

        if (hasFailedDependency) {
          checkpoint.status = "blocked";
          changed = true;
          continue;
        }

        const dependenciesComplete = checkpoint.dependsOn
          .map((depId) => record.checkpoints.get(depId))
          .every((dep) => dep?.status === "completed");

        const nextStatus = dependenciesComplete ? "ready" : "pending";
        if (checkpoint.status !== nextStatus) {
          checkpoint.status = nextStatus;
          changed = true;
        }
      }
    }
  }

  private areDependenciesCompleted(
    record: TeamContractRecord,
    dependencies: readonly string[],
  ): boolean {
    for (const dependencyId of dependencies) {
      const dependency = record.checkpoints.get(dependencyId);
      if (!dependency || dependency.status !== "completed") {
        return false;
      }
    }
    return true;
  }

  private areAllRequiredCheckpointsCompleted(
    record: TeamContractRecord,
  ): boolean {
    for (const checkpoint of record.checkpoints.values()) {
      if (!checkpoint.required) continue;
      if (checkpoint.status !== "completed") {
        return false;
      }
    }
    return true;
  }

  private blockDependentCheckpoints(
    record: TeamContractRecord,
    failedCheckpointId: string,
  ): void {
    const queue = [failedCheckpointId];
    const seen = new Set<string>(queue);

    while (queue.length > 0) {
      const current = queue.shift()!;

      for (const checkpoint of record.checkpoints.values()) {
        if (!checkpoint.dependsOn.includes(current)) continue;
        if (seen.has(checkpoint.id)) continue;

        seen.add(checkpoint.id);

        if (
          checkpoint.status !== "completed" &&
          checkpoint.status !== "failed"
        ) {
          checkpoint.status = "blocked";
        }

        queue.push(checkpoint.id);
      }
    }
  }

  private getContractRecordOrThrow(contractId: string): TeamContractRecord {
    const id = normalizeIdOrThrow(contractId, "contract id");
    const record = this.contracts.get(id);
    if (!record) {
      throw new TeamContractStateError(`contract "${id}" not found`);
    }
    return record;
  }

  private assertStatus(
    record: TeamContractRecord,
    expected: TeamContractRecord["status"],
    operation: string,
  ): void {
    if (record.status !== expected) {
      throw new TeamContractStateError(
        `cannot ${operation} while contract is in state "${record.status}"`,
      );
    }
  }

  private checkpointRecord(
    record: TeamContractRecord,
  ): Record<string, TeamCheckpointState> {
    const out: Record<string, TeamCheckpointState> = {};
    for (const checkpointId of Array.from(record.checkpoints.keys()).sort(
      (a, b) => a.localeCompare(b),
    )) {
      const checkpoint = record.checkpoints.get(checkpointId)!;
      out[checkpointId] = cloneCheckpoint(checkpoint);
    }
    return out;
  }

  private roleAssignmentRecord(
    record: TeamContractRecord,
  ): Record<string, readonly string[]> {
    const out: Record<string, readonly string[]> = {};
    for (const roleId of Array.from(record.roleAssignments.keys()).sort(
      (a, b) => a.localeCompare(b),
    )) {
      const members = record.roleAssignments.get(roleId) ?? [];
      out[roleId] = [...members].sort((a, b) => a.localeCompare(b));
    }
    return out;
  }

  private toSnapshot(record: TeamContractRecord): TeamContractSnapshot {
    const members = Array.from(record.members.values())
      .map((member) => cloneMember(member))
      .sort((a, b) => a.id.localeCompare(b.id));

    const snapshot: TeamContractSnapshot = {
      id: record.id,
      creatorId: record.creatorId,
      template: record.template,
      status: record.status,
      members,
      roleAssignments: this.roleAssignmentRecord(record),
      checkpoints: this.checkpointRecord(record),
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      cancelledAt: record.cancelledAt,
      finalizedPayout: record.finalizedPayout,
    };

    return deepFreeze(snapshot) as TeamContractSnapshot;
  }

  private recordAuditEvent(
    record: TeamContractRecord,
    type: TeamAuditEvent["type"],
    payload: Record<string, unknown>,
  ): void {
    const event: TeamAuditEvent = {
      sequence: record.auditSequence,
      contractId: record.id,
      type,
      atMs: this.now(),
      payload,
    };

    record.auditSequence += 1;

    try {
      this.auditStore.append(event);
    } catch (error) {
      const err = toError(error);
      this.invokeHook(() => {
        this.hooks.onAuditError?.(err, event);
      });
    }
  }

  private invokeHook(callback: () => void): void {
    if (this.inHook) return;

    this.inHook = true;
    try {
      callback();
    } catch {
      // Hook errors are intentionally swallowed to keep engine deterministic.
    } finally {
      this.inHook = false;
    }
  }

  private assertNotInHook(): void {
    if (this.inHook) {
      throw new TeamContractStateError(
        "re-entrant engine mutation from hook is not allowed",
      );
    }
  }

  private wrapValidationError(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      throw new TeamContractValidationError(toError(error).message);
    }
  }
}

function normalizeMemberInput(input: TeamMemberInput): TeamMemberInput {
  const id = normalizeIdOrThrow(input.id, "member id");
  const roles = uniqueSorted(
    (input.roles ?? []).map((roleId) => normalizeIdOrThrow(roleId, "role id")),
  );

  if (typeof input.capabilities !== "bigint" || input.capabilities < 0n) {
    throw new TeamContractValidationError(
      "member capabilities must be a non-negative bigint",
    );
  }

  return {
    ...input,
    id,
    roles,
  };
}

function normalizeIdOrThrow(raw: string, label: string): string {
  const canonical = canonicalizeTeamId(raw);
  const validationError = validateTeamId(canonical);
  if (validationError) {
    throw new TeamContractValidationError(`${label} ${validationError}`);
  }
  return canonical;
}

function uniqueSorted(values: readonly string[]): string[] {
  const sorted = [...values].sort((a, b) => a.localeCompare(b));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1]) {
      throw new TeamContractValidationError(`duplicate value "${sorted[i]}"`);
    }
  }
  return sorted;
}

function cloneTemplate(template: TeamTemplate): TeamTemplate {
  return {
    ...template,
    roles: template.roles.map((role) => ({ ...role })),
    checkpoints: template.checkpoints.map((checkpoint) => ({
      ...checkpoint,
      dependsOn: [...(checkpoint.dependsOn ?? [])],
    })),
    payout: clonePayoutConfig(template.payout),
    metadata: cloneMetadata(template.metadata),
  };
}

function clonePayoutConfig(
  payout: TeamTemplate["payout"],
): TeamTemplate["payout"] {
  switch (payout.mode) {
    case "fixed":
      return {
        ...payout,
        rolePayoutBps: { ...payout.rolePayoutBps },
        roleFailurePenaltyBps: payout.roleFailurePenaltyBps
          ? { ...payout.roleFailurePenaltyBps }
          : undefined,
      };
    case "weighted":
      return {
        ...payout,
        roleWeights: { ...payout.roleWeights },
        roleFailurePenaltyBps: payout.roleFailurePenaltyBps
          ? { ...payout.roleFailurePenaltyBps }
          : undefined,
      };
    case "milestone":
      return {
        ...payout,
        milestonePayoutBps: { ...payout.milestonePayoutBps },
        roleFailurePenaltyBps: payout.roleFailurePenaltyBps
          ? { ...payout.roleFailurePenaltyBps }
          : undefined,
      };
  }
}

function cloneMember(member: TeamMember): TeamMember {
  return {
    ...member,
    roles: [...member.roles],
    metadata: cloneMetadata(member.metadata),
  };
}

function cloneCheckpoint(checkpoint: TeamCheckpointState): TeamCheckpointState {
  return {
    ...checkpoint,
    dependsOn: [...checkpoint.dependsOn],
  };
}

function clonePayoutResult(payout: TeamPayoutResult): TeamPayoutResult {
  return {
    ...payout,
    rolePayouts: { ...payout.rolePayouts },
    memberPayouts: { ...payout.memberPayouts },
    rolePenalties: { ...payout.rolePenalties },
  };
}

function cloneMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  return { ...metadata };
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Object.isFrozen(value)) {
    return value;
  }

  const propNames = Object.getOwnPropertyNames(value);
  for (const name of propNames) {
    const candidate = (value as Record<string, unknown>)[name];
    if (candidate && typeof candidate === "object") {
      deepFreeze(candidate);
    }
  }

  return Object.freeze(value);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export interface TeamContractEngineReadonlyView {
  getContract(contractId: string): TeamContractSnapshot | null;
}
