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

export interface SecurityOptions extends BaseCliOptions {
  deep?: boolean;
  json?: boolean;
  fix?: boolean;
}

export interface CliValidationError extends Error {
  code: string;
}
