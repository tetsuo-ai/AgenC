/**
 * Shared validation and normalization for team contracts.
 *
 * @module
 */

import {
  canonicalizeTeamId,
  validateTeamId,
} from './types.js';
import type {
  TeamCheckpointTemplate,
  TeamPayoutConfig,
  TeamRoleTemplate,
  TeamTemplate,
} from './types.js';

export interface TeamTemplateValidationOptions {
  requireSingleParent?: boolean;
}

export function normalizeTeamTemplate(input: TeamTemplate): TeamTemplate {
  const id = normalizeIdOrThrow(input.id, 'template id');
  const name = input.name.trim();

  if (name.length === 0) {
    throw new Error('template name must not be empty');
  }

  const roleIds = new Set<string>();
  const roles: TeamRoleTemplate[] = input.roles.map((role) => {
    const normalizedId = normalizeIdOrThrow(role.id, 'role id');
    if (roleIds.has(normalizedId)) {
      throw new Error(`duplicate role id after normalization: "${normalizedId}"`);
    }
    roleIds.add(normalizedId);

    return {
      ...role,
      id: normalizedId,
      minMembers: role.minMembers ?? 1,
      maxMembers: role.maxMembers ?? 1,
    };
  }).sort((a, b) => a.id.localeCompare(b.id));

  const checkpointIds = new Set<string>();
  const checkpoints: TeamCheckpointTemplate[] = input.checkpoints.map((checkpoint) => {
    const normalizedId = normalizeIdOrThrow(checkpoint.id, 'checkpoint id');
    if (checkpointIds.has(normalizedId)) {
      throw new Error(`duplicate checkpoint id after normalization: "${normalizedId}"`);
    }
    checkpointIds.add(normalizedId);

    const normalizedDependsOn = (checkpoint.dependsOn ?? [])
      .map((dep) => normalizeIdOrThrow(dep, `dependency id for checkpoint "${normalizedId}"`));
    const dedupe = new Set<string>();
    for (const dependency of normalizedDependsOn) {
      if (dedupe.has(dependency)) {
        throw new Error(`duplicate dependency "${dependency}" on checkpoint "${normalizedId}"`);
      }
      dedupe.add(dependency);
    }

    return {
      ...checkpoint,
      id: normalizedId,
      roleId: normalizeIdOrThrow(checkpoint.roleId, `role id for checkpoint "${normalizedId}"`),
      label: checkpoint.label.trim(),
      dependsOn: normalizedDependsOn.sort((a, b) => a.localeCompare(b)),
      required: checkpoint.required ?? true,
    };
  }).sort((a, b) => a.id.localeCompare(b.id));

  const payout = normalizePayoutConfig(input.payout);

  return {
    ...input,
    id,
    name,
    roles,
    checkpoints,
    payout,
  };
}

export function validateTeamTemplate(
  template: TeamTemplate,
  options: TeamTemplateValidationOptions = {},
): void {
  const requireSingleParent = options.requireSingleParent ?? true;

  if (template.roles.length === 0) {
    throw new Error('template must define at least one role');
  }
  if (template.checkpoints.length === 0) {
    throw new Error('template must define at least one checkpoint');
  }

  const roleIds = new Set<string>();
  for (const role of template.roles) {
    if (roleIds.has(role.id)) {
      throw new Error(`duplicate role id: "${role.id}"`);
    }
    roleIds.add(role.id);

    if (!Number.isInteger(role.minMembers) || (role.minMembers ?? 0) < 0) {
      throw new Error(`invalid minMembers for role "${role.id}"`);
    }
    if (!Number.isInteger(role.maxMembers) || (role.maxMembers ?? 0) < 1) {
      throw new Error(`invalid maxMembers for role "${role.id}"`);
    }
    if ((role.minMembers ?? 0) > (role.maxMembers ?? 0)) {
      throw new Error(`minMembers cannot exceed maxMembers for role "${role.id}"`);
    }
  }

  const checkpointIds = new Set<string>();
  const incomingCount = new Map<string, number>();

  for (const checkpoint of template.checkpoints) {
    if (checkpointIds.has(checkpoint.id)) {
      throw new Error(`duplicate checkpoint id: "${checkpoint.id}"`);
    }
    checkpointIds.add(checkpoint.id);

    if (!roleIds.has(checkpoint.roleId)) {
      throw new Error(`checkpoint "${checkpoint.id}" references unknown role "${checkpoint.roleId}"`);
    }

    const deps = checkpoint.dependsOn ?? [];
    if (requireSingleParent && deps.length > 1) {
      throw new Error(`checkpoint "${checkpoint.id}" has multiple parents; single-parent topology required`);
    }
    for (const dependency of deps) {
      if (dependency === checkpoint.id) {
        throw new Error(`checkpoint "${checkpoint.id}" cannot depend on itself`);
      }
      if (!checkpointIds.has(dependency) && !template.checkpoints.some((c) => c.id === dependency)) {
        throw new Error(`checkpoint "${checkpoint.id}" depends on unknown checkpoint "${dependency}"`);
      }

      incomingCount.set(checkpoint.id, (incomingCount.get(checkpoint.id) ?? 0) + 1);
      if (requireSingleParent && (incomingCount.get(checkpoint.id) ?? 0) > 1) {
        throw new Error(`checkpoint "${checkpoint.id}" has multiple incoming dependencies`);
      }
    }

    if (checkpoint.label.length === 0) {
      throw new Error(`checkpoint "${checkpoint.id}" label must not be empty`);
    }
  }

  validateNoCycles(template.checkpoints);
  validatePayoutReferences(template);
}

function validateNoCycles(checkpoints: readonly TeamCheckpointTemplate[]): void {
  const adjacency = new Map<string, string[]>();
  for (const checkpoint of checkpoints) {
    adjacency.set(checkpoint.id, []);
  }
  for (const checkpoint of checkpoints) {
    for (const dependency of checkpoint.dependsOn ?? []) {
      adjacency.get(dependency)?.push(checkpoint.id);
    }
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const checkpoint of checkpoints) {
    color.set(checkpoint.id, WHITE);
  }

  function dfs(nodeId: string): boolean {
    color.set(nodeId, GRAY);
    for (const next of adjacency.get(nodeId) ?? []) {
      const nextColor = color.get(next) ?? WHITE;
      if (nextColor === GRAY) return true;
      if (nextColor === WHITE && dfs(next)) return true;
    }
    color.set(nodeId, BLACK);
    return false;
  }

  for (const checkpoint of checkpoints) {
    if ((color.get(checkpoint.id) ?? WHITE) === WHITE) {
      if (dfs(checkpoint.id)) {
        throw new Error('checkpoint dependency graph contains a cycle');
      }
    }
  }
}

function validatePayoutReferences(template: TeamTemplate): void {
  const roleIds = new Set(template.roles.map((role) => role.id));
  const checkpointIds = new Set(template.checkpoints.map((checkpoint) => checkpoint.id));

  for (const roleId of Object.keys(template.payout.roleFailurePenaltyBps ?? {})) {
    if (!roleIds.has(roleId)) {
      throw new Error(`failure penalty references unknown role "${roleId}"`);
    }
  }

  switch (template.payout.mode) {
    case 'fixed': {
      for (const roleId of Object.keys(template.payout.rolePayoutBps)) {
        if (!roleIds.has(roleId)) {
          throw new Error(`fixed payout references unknown role "${roleId}"`);
        }
      }
      break;
    }
    case 'weighted': {
      for (const roleId of Object.keys(template.payout.roleWeights)) {
        if (!roleIds.has(roleId)) {
          throw new Error(`weighted payout references unknown role "${roleId}"`);
        }
      }
      break;
    }
    case 'milestone': {
      for (const checkpointId of Object.keys(template.payout.milestonePayoutBps)) {
        if (!checkpointIds.has(checkpointId)) {
          throw new Error(`milestone payout references unknown checkpoint "${checkpointId}"`);
        }
      }
      break;
    }
  }
}

function normalizePayoutConfig(config: TeamPayoutConfig): TeamPayoutConfig {
  const roleFailurePenaltyBps = normalizeNumericRecord(
    config.roleFailurePenaltyBps,
    'role failure penalty',
  );

  switch (config.mode) {
    case 'fixed':
      return {
        ...config,
        roleFailurePenaltyBps,
        rolePayoutBps: normalizeRequiredNumericRecord(config.rolePayoutBps, 'fixed payout role bps'),
      };
    case 'weighted':
      return {
        ...config,
        roleFailurePenaltyBps,
        roleWeights: normalizeRequiredNumericRecord(config.roleWeights, 'role weight'),
      };
    case 'milestone':
      return {
        ...config,
        roleFailurePenaltyBps,
        milestonePayoutBps: normalizeRequiredNumericRecord(config.milestonePayoutBps, 'milestone payout bps'),
      };
  }
}

function normalizeRequiredNumericRecord(
  source: Record<string, number>,
  label: string,
): Record<string, number> {
  return normalizeNumericRecord(source, label) ?? {};
}


function normalizeNumericRecord(
  source: Record<string, number> | undefined,
  label: string,
): Record<string, number> | undefined {
  if (!source) return undefined;

  const seen = new Set<string>();
  const entries: Array<[string, number]> = [];

  for (const [rawKey, rawValue] of Object.entries(source)) {
    const key = normalizeIdOrThrow(rawKey, `${label} key`);
    if (seen.has(key)) {
      throw new Error(`duplicate ${label} key after normalization: "${key}"`);
    }
    seen.add(key);

    if (!Number.isFinite(rawValue) || !Number.isInteger(rawValue) || rawValue < 0) {
      throw new Error(`${label} value for "${key}" must be a non-negative integer`);
    }

    entries.push([key, rawValue]);
  }

  entries.sort((a, b) => a[0].localeCompare(b[0]));
  return Object.fromEntries(entries);
}

function normalizeIdOrThrow(raw: string, label: string): string {
  const normalized = canonicalizeTeamId(raw);
  const error = validateTeamId(normalized);
  if (error) {
    throw new Error(`${label} ${error}`);
  }
  return normalized;
}
