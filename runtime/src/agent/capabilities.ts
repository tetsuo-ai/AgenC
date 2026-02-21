/**
 * Capability bitmask constants matching on-chain values
 * From: programs/agenc-coordination/src/state.rs (lines 16-27)
 */
export const Capability = {
  COMPUTE: 1n << 0n, // General computation
  INFERENCE: 1n << 1n, // ML inference
  STORAGE: 1n << 2n, // Data storage
  NETWORK: 1n << 3n, // Network relay
  SENSOR: 1n << 4n, // Sensor data collection
  ACTUATOR: 1n << 5n, // Physical actuation
  COORDINATOR: 1n << 6n, // Task coordination
  ARBITER: 1n << 7n, // Dispute resolution
  VALIDATOR: 1n << 8n, // Result validation
  AGGREGATOR: 1n << 9n, // Data aggregation
} as const;

export type CapabilityName = keyof typeof Capability;

/**
 * All capability values as an array
 */
export const ALL_CAPABILITIES = Object.values(Capability);

/**
 * All capability names as an array
 */
export const ALL_CAPABILITY_NAMES = Object.keys(Capability) as CapabilityName[];

/**
 * Combine multiple capabilities into a single bitmask
 * @example
 * const caps = combineCapabilities(Capability.COMPUTE, Capability.INFERENCE);
 */
export function combineCapabilities(...caps: bigint[]): bigint {
  return caps.reduce((acc, cap) => acc | cap, 0n);
}

/**
 * Check if agent has a specific capability
 */
export function hasCapability(agentCaps: bigint, required: bigint): boolean {
  return (agentCaps & required) === required;
}

/**
 * Check if agent has ALL required capabilities
 */
export function hasAllCapabilities(
  agentCaps: bigint,
  required: bigint[],
): boolean {
  return required.every((cap) => hasCapability(agentCaps, cap));
}

/**
 * Check if agent has ANY of the specified capabilities
 */
export function hasAnyCapability(agentCaps: bigint, caps: bigint[]): boolean {
  return caps.some((cap) => hasCapability(agentCaps, cap));
}

/**
 * Get list of capability names from bitmask
 */
export function getCapabilityNames(caps: bigint): CapabilityName[] {
  const names: CapabilityName[] = [];
  for (const [name, value] of Object.entries(Capability)) {
    if (hasCapability(caps, value)) {
      names.push(name as CapabilityName);
    }
  }
  return names;
}

/**
 * Parse capability names to bitmask
 * @example
 * const caps = parseCapabilities(['COMPUTE', 'INFERENCE']);
 */
export function parseCapabilities(names: CapabilityName[]): bigint {
  return combineCapabilities(...names.map((n) => Capability[n]));
}

/**
 * Format capabilities as human-readable string
 * @example
 * formatCapabilities(3n) // "COMPUTE, INFERENCE"
 */
export function formatCapabilities(caps: bigint): string {
  return getCapabilityNames(caps).join(", ") || "None";
}

/**
 * Count number of capabilities in bitmask
 */
export function countCapabilities(caps: bigint): number {
  return getCapabilityNames(caps).length;
}
