import type { PluginPrecedence, PluginSlot } from '../skills/catalog.js';
import type { OperatorRole } from '../policy/incident-roles.js';

export type CliOutputFormat = 'json' | 'jsonl' | 'table';

export interface CliReplayOutput<TPayload = unknown> {
  format: CliOutputFormat;
  payload: TPayload;
}

export type CliLogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

export interface CliLogger {
  error: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  info: (message: string, fields?: Record<string, unknown>) => void;
  debug: (message: string, fields?: Record<string, unknown>) => void;
}

export interface CliRuntimeContext {
  logger: CliLogger;
  output: (value: unknown) => void;
  error: (value: unknown) => void;
  outputFormat: CliOutputFormat;
}

export interface BaseCliOptions {
  help: boolean;
  outputFormat: CliOutputFormat;
  strictMode: boolean;
  role?: OperatorRole;
  rpcUrl?: string;
  programId?: string;
  storeType: 'memory' | 'sqlite';
  sqlitePath?: string;
  traceId?: string;
  idempotencyWindow: number;
}

export interface ReplayBackfillOptions extends BaseCliOptions {
  toSlot: number;
  pageSize?: number;
}

export interface ReplayCompareOptions extends BaseCliOptions {
  localTracePath?: string;
  taskPda?: string;
  disputePda?: string;
  redactFields?: string[];
}

export interface ReplayIncidentOptions extends BaseCliOptions {
  taskPda?: string;
  disputePda?: string;
  query?: string;
  fromSlot?: number;
  toSlot?: number;
  sealed?: boolean;
  redactFields?: string[];
}

export interface PluginListOptions extends BaseCliOptions {}

export interface PluginInstallOptions extends BaseCliOptions {
  manifestPath: string;
  precedence?: PluginPrecedence;
  slot?: PluginSlot;
}

export interface PluginToggleOptions extends BaseCliOptions {
  pluginId: string;
}

export interface PluginReloadOptions extends BaseCliOptions {
  pluginId: string;
  manifestPath?: string;
}

export interface SkillListOptions extends BaseCliOptions {}
export interface SkillInfoOptions extends BaseCliOptions { skillName: string; }
export interface SkillValidateOptions extends BaseCliOptions {}
export interface SkillCreateOptions extends BaseCliOptions { skillName: string; }
export interface SkillInstallOptions extends BaseCliOptions { source: string; }
export interface SkillUninstallOptions extends BaseCliOptions { skillName: string; }
export interface SkillToggleOptions extends BaseCliOptions { skillName: string; }

export interface RegistrySearchOptions extends BaseCliOptions { query: string; tags?: string[]; limit?: number; }
export interface RegistryInstallOptions extends BaseCliOptions { skillId: string; }
export interface RegistryPublishOptions extends BaseCliOptions { skillPath: string; tags?: string[]; priceLamports?: string; }
export interface RegistryRateOptions extends BaseCliOptions { skillId: string; rating: number; review?: string; }
export interface RegistryVerifyOptions extends BaseCliOptions { skillId: string; localPath?: string; }
export interface RegistryImportOpenclawOptions extends BaseCliOptions { source: string; }

export type SkillCommandOptions =
  | SkillListOptions
  | SkillInfoOptions
  | SkillValidateOptions
  | SkillCreateOptions
  | SkillInstallOptions
  | SkillUninstallOptions
  | SkillToggleOptions
  | RegistrySearchOptions
  | RegistryInstallOptions
  | RegistryPublishOptions
  | RegistryRateOptions
  | RegistryVerifyOptions
  | RegistryImportOpenclawOptions;

export interface CliUsage {
  command: string;
  description: string;
}

export interface ParsedCliArguments {
  command: 'replay' | null;
  replayCommand: 'backfill' | 'compare' | 'incident' | null;
  positional: string[];
  options: Record<string, string | number | boolean>;
  outputFormat: CliOutputFormat;
}

export interface CliParseReport {
  command: 'replay';
  replayCommand: 'backfill' | 'compare' | 'incident';
  global: BaseCliOptions;
  options: ReplayBackfillOptions | ReplayCompareOptions | ReplayIncidentOptions;
  outputFormat: CliOutputFormat;
}

export interface ParsedArgv {
  positional: string[];
  flags: Record<string, string | number | boolean>;
}

export interface CliFileConfig {
  configVersion?: string;
  rpcUrl?: string;
  programId?: string;
  storeType?: 'memory' | 'sqlite';
  sqlitePath?: string;
  traceId?: string;
  strictMode?: boolean;
  idempotencyWindow?: number;
  outputFormat?: CliOutputFormat;
  logLevel?: CliLogLevel;
}

export interface OnboardOptions extends BaseCliOptions {
  /** If true, skip interactive prompts (default false). */
  nonInteractive?: boolean;
  /** Force overwrite existing config. */
  force?: boolean;
  /** Config file path override for onboard output. */
  configPath?: string;
}

export interface HealthOptions extends BaseCliOptions {
  /** If true, skip interactive prompts. */
  nonInteractive?: boolean;
  /** Run extended checks (slower but more thorough). */
  deep?: boolean;
  /** Config file path override for health output. */
  configPath?: string;
}

export interface DoctorOptions extends BaseCliOptions {
  nonInteractive?: boolean;
  deep?: boolean;
  /** Attempt automatic fixes where possible. */
  fix?: boolean;
  /** Config file path override for doctor output. */
  configPath?: string;
}

export interface SecurityOptions extends BaseCliOptions {
  deep?: boolean;
  json?: boolean;
  fix?: boolean;
}

export type CliStatusCode = 0 | 1 | 2;

export interface DaemonStartOptions {
  configPath: string;
  pidPath: string;
  foreground?: boolean;
  logLevel?: string;
}

export interface DaemonStopOptions {
  pidPath: string;
  timeout?: number;
}

export interface DaemonStatusOptions {
  pidPath: string;
  controlPlanePort?: number;
}

export interface ServiceInstallOptions {
  configPath?: string;
  macos?: boolean;
}

export interface WizardOptions extends BaseCliOptions {
  nonInteractive?: boolean;
  force?: boolean;
  configPath?: string;
}

export interface ConfigValidateOptions extends BaseCliOptions {
  configPath?: string;
}

export interface ConfigShowOptions extends BaseCliOptions {
  configPath?: string;
}

export interface SessionsListOptions {
  pidPath: string;
  controlPlanePort?: number;
}

export interface SessionsKillOptions {
  pidPath: string;
  sessionId: string;
  controlPlanePort?: number;
}

export interface LogsOptions {
  pidPath: string;
  sessionId?: string;
  follow?: boolean;
  lines?: number;
}

export interface CliValidationError extends Error {
  code: string;
}
