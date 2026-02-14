import type { ReplayPolicy } from './replay.js';

export type RiskLevel = 'low' | 'medium' | 'high';

export interface ToolRiskCaps {
  maxWindowSlots: number;
  maxEventCount: number;
  timeoutMs: number;
  maxPayloadBytes: number;
}

export interface ToolRiskProfile {
  toolName: string;
  riskLevel: RiskLevel;
  rationale: string;
  mutatesState: boolean;
  readsSensitiveData: boolean;
  defaultCaps: ToolRiskCaps;
}

const DEFAULT_TOOL_CAPS: ToolRiskCaps = {
  maxWindowSlots: 2_000_000,
  maxEventCount: 250_000,
  timeoutMs: 180_000,
  maxPayloadBytes: 120_000,
};

export const REPLAY_TOOL_RISK_PROFILES: Record<string, ToolRiskProfile> = {
  agenc_replay_backfill: {
    toolName: 'agenc_replay_backfill',
    riskLevel: 'high',
    rationale: 'Fetches on-chain transactions and writes to replay store. High RPC cost and store mutation.',
    mutatesState: true,
    readsSensitiveData: false,
    defaultCaps: DEFAULT_TOOL_CAPS,
  },
  agenc_replay_compare: {
    toolName: 'agenc_replay_compare',
    riskLevel: 'medium',
    rationale: 'Reads from store and local filesystem. Comparison logic is CPU-bound.',
    mutatesState: false,
    readsSensitiveData: true,
    defaultCaps: DEFAULT_TOOL_CAPS,
  },
  agenc_replay_incident: {
    toolName: 'agenc_replay_incident',
    riskLevel: 'medium',
    rationale: 'Reads from store and replays events. May expose sensitive event payloads.',
    mutatesState: false,
    readsSensitiveData: true,
    defaultCaps: DEFAULT_TOOL_CAPS,
  },
  agenc_replay_status: {
    toolName: 'agenc_replay_status',
    riskLevel: 'low',
    rationale: 'Read-only aggregate query. Minimal resource usage.',
    mutatesState: false,
    readsSensitiveData: false,
    defaultCaps: {
      maxWindowSlots: 0,
      maxEventCount: 250_000,
      timeoutMs: 30_000,
      maxPayloadBytes: 50_000,
    },
  },
};

export function getToolRiskProfile(toolName: string): ToolRiskProfile {
  return REPLAY_TOOL_RISK_PROFILES[toolName] ?? {
    toolName,
    riskLevel: 'high',
    rationale: 'Unknown tool — defaulting to high risk',
    mutatesState: true,
    readsSensitiveData: true,
    defaultCaps: {
      maxWindowSlots: 500_000,
      maxEventCount: 50_000,
      timeoutMs: 60_000,
      maxPayloadBytes: 50_000,
    },
  };
}

export interface ReplayRiskConfig {
  globalPolicy: ReplayPolicy;
  toolOverrides?: Record<string, Partial<ToolRiskCaps>>;
}

export function resolveToolCaps(toolName: string, config: ReplayRiskConfig): ToolRiskCaps {
  const profile = getToolRiskProfile(toolName);
  const override = config.toolOverrides?.[toolName] ?? {};

  return {
    maxWindowSlots: override.maxWindowSlots
      ?? (config.globalPolicy.maxSlotWindow > 0 ? config.globalPolicy.maxSlotWindow : profile.defaultCaps.maxWindowSlots),
    maxEventCount: override.maxEventCount
      ?? (config.globalPolicy.maxEventCount > 0 ? config.globalPolicy.maxEventCount : profile.defaultCaps.maxEventCount),
    timeoutMs: override.timeoutMs
      ?? (config.globalPolicy.maxToolRuntimeMs > 0 ? config.globalPolicy.maxToolRuntimeMs : profile.defaultCaps.timeoutMs),
    maxPayloadBytes: override.maxPayloadBytes ?? profile.defaultCaps.maxPayloadBytes,
  };
}

function parsePositiveInt(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

export function loadToolCapsFromEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, Partial<ToolRiskCaps>> {
  const overrides: Record<string, Partial<ToolRiskCaps>> = {};
  const tools = ['backfill', 'compare', 'incident', 'status'];
  const fields: Array<[string, keyof ToolRiskCaps]> = [
    ['MAX_WINDOW_SLOTS', 'maxWindowSlots'],
    ['MAX_EVENT_COUNT', 'maxEventCount'],
    ['TIMEOUT_MS', 'timeoutMs'],
    ['MAX_PAYLOAD_BYTES', 'maxPayloadBytes'],
  ];

  for (const tool of tools) {
    const toolName = `agenc_replay_${tool}`;
    const prefix = `MCP_REPLAY_CAPS_${tool.toUpperCase()}_`;
    for (const [envSuffix, field] of fields) {
      const parsed = parsePositiveInt(env[`${prefix}${envSuffix}`]);
      if (parsed !== null) {
        if (!overrides[toolName]) {
          overrides[toolName] = {};
        }
        overrides[toolName][field] = parsed;
      }
    }
  }

  return overrides;
}
