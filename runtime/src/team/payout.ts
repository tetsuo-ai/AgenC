/**
 * Deterministic payout computation for team contracts.
 *
 * @module
 */

import { TeamPayoutError } from "./errors.js";
import type {
  TeamCheckpointState,
  TeamPayoutResult,
  TeamTemplate,
} from "./types.js";

export interface TeamPayoutComputationInput {
  totalRewardLamports: bigint;
  template: TeamTemplate;
  checkpoints: Readonly<Record<string, TeamCheckpointState>>;
  roleAssignments: Readonly<Record<string, readonly string[]>>;
}

export function computeTeamPayout(
  input: TeamPayoutComputationInput,
): TeamPayoutResult {
  if (input.totalRewardLamports < 0n) {
    throw new TeamPayoutError("total reward must be non-negative");
  }

  const roleIds = input.template.roles
    .map((role) => role.id)
    .sort((a, b) => a.localeCompare(b));
  const checkpoints = Object.values(input.checkpoints);

  const failedRoles = new Set<string>();
  for (const checkpoint of checkpoints) {
    if (checkpoint.status === "failed") {
      failedRoles.add(checkpoint.roleId);
    }
  }

  const rolePayouts = initializeRoleMap(roleIds);
  let unallocatedLamports = 0n;

  switch (input.template.payout.mode) {
    case "fixed": {
      const bpsByRole = initializeNumericRoleMap(
        roleIds,
        input.template.payout.rolePayoutBps,
      );
      const sumBps = sumNumbers(Object.values(bpsByRole));
      if (sumBps !== 10_000) {
        throw new TeamPayoutError(
          `fixed role payout bps must sum to 10000 (received ${sumBps})`,
        );
      }
      for (const [roleId, bps] of Object.entries(bpsByRole)) {
        assertBps(bps, `fixed payout bps for role "${roleId}"`);
      }

      const allocated = allocateByRatio(
        input.totalRewardLamports,
        toBigIntMap(bpsByRole),
        10_000n,
      );
      mergeAmounts(rolePayouts, allocated);
      break;
    }

    case "weighted": {
      const weightsByRole = initializeNumericRoleMap(
        roleIds,
        input.template.payout.roleWeights,
      );
      const totalWeight = sumNumbers(Object.values(weightsByRole));
      if (totalWeight <= 0) {
        throw new TeamPayoutError(
          "weighted payout requires at least one positive role weight",
        );
      }
      for (const [roleId, weight] of Object.entries(weightsByRole)) {
        if (!Number.isInteger(weight) || weight < 0) {
          throw new TeamPayoutError(
            `role weight for "${roleId}" must be a non-negative integer`,
          );
        }
      }

      const allocated = allocateByWeights(
        input.totalRewardLamports,
        toBigIntMap(weightsByRole),
      );
      mergeAmounts(rolePayouts, allocated);
      break;
    }

    case "milestone": {
      const milestoneBps = input.template.payout.milestonePayoutBps;

      let realizedBps = 0;
      const realizedRoleBps = initializeRoleMap(roleIds, 0n);

      for (const checkpoint of checkpoints) {
        if (checkpoint.status !== "completed") continue;
        const bps = milestoneBps[checkpoint.id] ?? 0;
        assertBps(
          bps,
          `milestone payout bps for checkpoint "${checkpoint.id}"`,
        );
        realizedBps += bps;
        realizedRoleBps[checkpoint.roleId] += BigInt(bps);
      }

      if (realizedBps > 10_000) {
        throw new TeamPayoutError(
          `milestone payout bps cannot exceed 10000 (received ${realizedBps})`,
        );
      }

      if (realizedBps === 0) {
        unallocatedLamports = input.totalRewardLamports;
        break;
      }

      const accountedTotal =
        (input.totalRewardLamports * BigInt(realizedBps)) / 10_000n;
      unallocatedLamports = input.totalRewardLamports - accountedTotal;

      const allocated = allocateByRatio(
        accountedTotal,
        realizedRoleBps,
        BigInt(realizedBps),
      );
      mergeAmounts(rolePayouts, allocated);
      break;
    }
  }

  const rolePenalties = initializeRoleMap(roleIds);
  let penaltyPool = 0n;
  const roleFailurePenaltyBps =
    input.template.payout.roleFailurePenaltyBps ?? {};

  for (const roleId of roleIds) {
    const penaltyBps = roleFailurePenaltyBps[roleId] ?? 0;
    assertBps(penaltyBps, `failure penalty bps for role "${roleId}"`);

    if (!failedRoles.has(roleId) || penaltyBps === 0) {
      continue;
    }

    const penalty = (rolePayouts[roleId] * BigInt(penaltyBps)) / 10_000n;
    rolePenalties[roleId] = penalty;
    rolePayouts[roleId] -= penalty;
    penaltyPool += penalty;
  }

  let redistributedLamports = 0n;
  if (penaltyPool > 0n) {
    if (input.template.payout.redistributePenalties === false) {
      unallocatedLamports += penaltyPool;
    } else {
      const eligibleWeights = new Map<string, bigint>();
      for (const roleId of roleIds) {
        if (failedRoles.has(roleId)) continue;
        if (rolePayouts[roleId] <= 0n) continue;
        eligibleWeights.set(roleId, rolePayouts[roleId]);
      }

      if (eligibleWeights.size === 0) {
        unallocatedLamports += penaltyPool;
      } else {
        const redistributed = allocateByWeights(penaltyPool, eligibleWeights);
        for (const [roleId, amount] of redistributed.entries()) {
          rolePayouts[roleId] += amount;
          redistributedLamports += amount;
        }
      }
    }
  }

  const memberPayouts: Record<string, bigint> = {};

  for (const roleId of roleIds) {
    const roleAmount = rolePayouts[roleId];
    if (roleAmount === 0n) continue;

    const members = [...(input.roleAssignments[roleId] ?? [])].sort((a, b) =>
      a.localeCompare(b),
    );
    if (members.length === 0) {
      unallocatedLamports += roleAmount;
      continue;
    }

    const contributionWeights = new Map<string, bigint>();
    for (const memberId of members) {
      contributionWeights.set(memberId, 0n);
    }

    for (const checkpoint of checkpoints) {
      if (checkpoint.roleId !== roleId) continue;
      if (checkpoint.status !== "completed") continue;
      if (!checkpoint.completedBy) continue;

      if (contributionWeights.has(checkpoint.completedBy)) {
        contributionWeights.set(
          checkpoint.completedBy,
          (contributionWeights.get(checkpoint.completedBy) ?? 0n) + 1n,
        );
      }
    }

    const totalContribution = Array.from(contributionWeights.values()).reduce(
      (sum, value) => sum + value,
      0n,
    );

    const effectiveWeights = new Map<string, bigint>();
    if (totalContribution > 0n) {
      for (const memberId of members) {
        const weight = contributionWeights.get(memberId) ?? 0n;
        if (weight > 0n) {
          effectiveWeights.set(memberId, weight);
        }
      }
    } else {
      for (const memberId of members) {
        effectiveWeights.set(memberId, 1n);
      }
    }

    const memberAllocations = allocateByWeights(roleAmount, effectiveWeights);
    for (const [memberId, amount] of memberAllocations.entries()) {
      memberPayouts[memberId] = (memberPayouts[memberId] ?? 0n) + amount;
    }
  }

  return {
    mode: input.template.payout.mode,
    totalRewardLamports: input.totalRewardLamports,
    rolePayouts,
    memberPayouts,
    rolePenalties,
    redistributedLamports,
    unallocatedLamports,
  };
}

function initializeRoleMap(
  roleIds: readonly string[],
  initial = 0n,
): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  for (const roleId of roleIds) {
    out[roleId] = initial;
  }
  return out;
}

function initializeNumericRoleMap(
  roleIds: readonly string[],
  source: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const roleId of roleIds) {
    out[roleId] = source[roleId] ?? 0;
  }
  return out;
}

function mergeAmounts(
  target: Record<string, bigint>,
  delta: Map<string, bigint>,
): void {
  for (const [key, value] of delta.entries()) {
    target[key] = (target[key] ?? 0n) + value;
  }
}

function toBigIntMap(source: Record<string, number>): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const [key, value] of Object.entries(source)) {
    out.set(key, BigInt(value));
  }
  return out;
}

function allocateByRatio(
  total: bigint,
  numerators: Record<string, bigint> | Map<string, bigint>,
  denominator: bigint,
): Map<string, bigint> {
  if (denominator <= 0n) {
    throw new TeamPayoutError("allocation denominator must be positive");
  }

  const map =
    numerators instanceof Map
      ? new Map(numerators)
      : new Map(Object.entries(numerators));

  return allocate(total, map, denominator);
}

function allocateByWeights(
  total: bigint,
  weights: Map<string, bigint>,
): Map<string, bigint> {
  const totalWeight = Array.from(weights.values()).reduce(
    (sum, weight) => sum + weight,
    0n,
  );
  if (totalWeight <= 0n) {
    throw new TeamPayoutError(
      "allocation requires at least one positive weight",
    );
  }
  return allocate(total, weights, totalWeight);
}

function allocate(
  total: bigint,
  weights: Map<string, bigint>,
  denominator: bigint,
): Map<string, bigint> {
  const keys = Array.from(weights.keys()).sort((a, b) => a.localeCompare(b));

  for (const key of keys) {
    const value = weights.get(key) ?? 0n;
    if (value < 0n) {
      throw new TeamPayoutError(
        `allocation weight for "${key}" must be non-negative`,
      );
    }
  }

  const result = new Map<string, bigint>();
  const remainders: Array<{ key: string; remainder: bigint }> = [];

  let allocated = 0n;
  for (const key of keys) {
    const numerator = total * (weights.get(key) ?? 0n);
    const base = numerator / denominator;
    const remainder = numerator % denominator;
    result.set(key, base);
    allocated += base;
    remainders.push({ key, remainder });
  }

  let leftover = total - allocated;
  if (leftover < 0n) {
    throw new TeamPayoutError(
      "allocation overflow: allocated amount exceeds total",
    );
  }

  remainders.sort((a, b) => {
    if (a.remainder === b.remainder) {
      return a.key.localeCompare(b.key);
    }
    return a.remainder > b.remainder ? -1 : 1;
  });

  const extraSlots = Number(leftover);
  for (let i = 0; i < extraSlots; i++) {
    const slot = remainders[i];
    if (!slot || slot.remainder === 0n) break;
    result.set(slot.key, (result.get(slot.key) ?? 0n) + 1n);
    leftover -= 1n;
  }

  return result;
}

function assertBps(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new TeamPayoutError(
      `${label} must be an integer between 0 and 10000`,
    );
  }
}

function sumNumbers(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}
