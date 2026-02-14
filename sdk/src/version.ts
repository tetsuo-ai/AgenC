import { PublicKey } from '@solana/web3.js';
import { type Program } from '@coral-xyz/anchor';
import { SEEDS } from './constants';
import { getAccount } from './anchor-utils';

export interface FeatureFlags {
  splTokenTasks: boolean;
  dependentTasks: boolean;
  rateLimiting: boolean;
  privateCompletion: boolean;
  symmetricSlashing: boolean;
  agentSuspension: boolean;
  speculationBonds: boolean;
  reputationGating: boolean;
}

export enum VersionStatus {
  Current = 'current',
  CompatibleOld = 'compatible_old',
  SdkTooOld = 'sdk_too_old',
  ProtocolTooOld = 'protocol_too_old',
  SdkBehind = 'sdk_behind',
}

export interface ProtocolVersionInfo {
  onChainVersion: number;
  onChainMinVersion: number;
  sdkVersion: number;
  sdkMinVersion: number;
  sdkPackageVersion: string;
  status: VersionStatus;
  compatible: boolean;
  warning: string | null;
  error: string | null;
  features: FeatureFlags;
}

export interface VersionCompatibilityOptions {
  sdkVersion?: number;
  sdkMinVersion?: number;
  sdkPackageVersion?: string;
}

/** Must match CURRENT_PROTOCOL_VERSION in programs/agenc-coordination/src/state.rs */
export const SDK_PROTOCOL_VERSION = 1;

/** Must match MIN_SUPPORTED_VERSION in programs/agenc-coordination/src/state.rs */
export const SDK_MIN_PROTOCOL_VERSION = 1;

/** Human-readable SDK package version. Keep in sync with sdk/src/index.ts VERSION. */
export const SDK_PACKAGE_VERSION = '1.3.0';

const FEATURE_REGISTRY: Record<number, Partial<FeatureFlags>> = {
  1: {
    splTokenTasks: true,
    dependentTasks: true,
    rateLimiting: true,
    privateCompletion: true,
    symmetricSlashing: true,
    agentSuspension: true,
    speculationBonds: true,
    reputationGating: true,
  },
};

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (value && typeof value === 'object' && 'toNumber' in value) {
    return (value as { toNumber: () => number }).toNumber();
  }
  return 0;
}

/**
 * Build feature flags by accumulating all known feature sets up to `version`.
 */
export function getFeaturesForVersion(version: number): FeatureFlags {
  const flags: FeatureFlags = {
    splTokenTasks: false,
    dependentTasks: false,
    rateLimiting: false,
    privateCompletion: false,
    symmetricSlashing: false,
    agentSuspension: false,
    speculationBonds: false,
    reputationGating: false,
  };

  if (version < 1) {
    return flags;
  }

  for (let v = 1; v <= version; v++) {
    const patch = FEATURE_REGISTRY[v];
    if (patch) {
      Object.assign(flags, patch);
    }
  }

  return flags;
}

/**
 * Check SDK/on-chain protocol version compatibility.
 *
 * @example
 * ```typescript
 * const info = await checkVersionCompatibility(program);
 * if (!info.compatible) {
 *   throw new Error(info.error ?? 'incompatible protocol version');
 * }
 * ```
 */
export async function checkVersionCompatibility(
  program: Program,
  options: VersionCompatibilityOptions = {},
): Promise<ProtocolVersionInfo> {
  const [protocolPda] = PublicKey.findProgramAddressSync([SEEDS.PROTOCOL], program.programId);

  const config = await getAccount(program, 'protocolConfig').fetch(protocolPda) as {
    protocolVersion?: unknown;
    protocol_version?: unknown;
    minSupportedVersion?: unknown;
    min_supported_version?: unknown;
  };

  const onChainVersion = toNumber(config.protocolVersion ?? config.protocol_version);
  const onChainMinVersion = toNumber(config.minSupportedVersion ?? config.min_supported_version);

  const sdkVersion = options.sdkVersion ?? SDK_PROTOCOL_VERSION;
  const sdkMinVersion = options.sdkMinVersion ?? SDK_MIN_PROTOCOL_VERSION;
  const sdkPackageVersion = options.sdkPackageVersion ?? SDK_PACKAGE_VERSION;

  let status: VersionStatus;
  let compatible: boolean;
  let warning: string | null = null;
  let error: string | null = null;

  if (onChainVersion === sdkVersion) {
    status = VersionStatus.Current;
    compatible = true;
  } else if (onChainVersion < sdkMinVersion) {
    status = VersionStatus.ProtocolTooOld;
    compatible = false;
    error = `On-chain protocol version ${onChainVersion} is below SDK minimum ${sdkMinVersion}. Protocol migration required.`;
  } else if (sdkVersion < onChainMinVersion) {
    status = VersionStatus.SdkTooOld;
    compatible = false;
    error = `SDK protocol version ${sdkVersion} is below on-chain minimum ${onChainMinVersion}. Upgrade the SDK.`;
  } else if (onChainVersion < sdkVersion) {
    status = VersionStatus.CompatibleOld;
    compatible = true;
    warning = `On-chain protocol version ${onChainVersion} is older than SDK target ${sdkVersion}. Some features may be unavailable.`;
  } else {
    status = VersionStatus.SdkBehind;
    compatible = true;
    warning = `On-chain protocol version ${onChainVersion} is newer than SDK target ${sdkVersion}. Consider upgrading SDK.`;
  }

  return {
    onChainVersion,
    onChainMinVersion,
    sdkVersion,
    sdkMinVersion,
    sdkPackageVersion,
    status,
    compatible,
    warning,
    error,
    features: getFeaturesForVersion(onChainVersion),
  };
}

/**
 * Require compatibility and throw when incompatible.
 *
 * @example
 * ```typescript
 * await requireVersionCompatibility(program);
 * ```
 */
export async function requireVersionCompatibility(
  program: Program,
  options: VersionCompatibilityOptions = {},
): Promise<ProtocolVersionInfo> {
  const info = await checkVersionCompatibility(program, options);
  if (!info.compatible) {
    throw new Error(info.error ?? 'Protocol version incompatible');
  }
  return info;
}
