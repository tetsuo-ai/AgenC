export interface SimulationIdentity {
  readonly simulationId: string | null;
  readonly lineageId?: string | null;
  readonly parentSimulationId?: string | null;
}

export interface SimulationIdentityFields {
  readonly simulation_id: string | null;
  readonly lineage_id: string | null;
  readonly parent_simulation_id: string | null;
}

export function createSimulationIdentity(
  identity: Partial<SimulationIdentity> = {},
): SimulationIdentity {
  return {
    simulationId: identity.simulationId ?? null,
    lineageId: identity.lineageId ?? null,
    parentSimulationId: identity.parentSimulationId ?? null,
  };
}

export function toSimulationIdentityFields(
  identity: Partial<SimulationIdentity>,
): SimulationIdentityFields {
  const normalized = createSimulationIdentity(identity);
  return {
    simulation_id: normalized.simulationId,
    lineage_id: normalized.lineageId ?? null,
    parent_simulation_id: normalized.parentSimulationId ?? null,
  };
}

export function withSimulationIdentity<T extends Record<string, unknown>>(
  payload: T,
  identity: Partial<SimulationIdentity>,
): T & SimulationIdentityFields {
  return {
    ...payload,
    ...toSimulationIdentityFields(identity),
  };
}
