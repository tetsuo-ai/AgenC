import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { inspect } from 'node:util';
import {
  CliFileConfig,
  CliLogLevel,
  CliLogger,
  CliOutputFormat,
  CliParseReport,
  CliRuntimeContext,
  CliStatusCode,
  CliValidationError,
  ParsedArgv,
  PluginInstallOptions,
  PluginListOptions,
  PluginReloadOptions,
  BaseCliOptions,
  ReplayBackfillOptions,
  ReplayCompareOptions,
  ReplayIncidentOptions,
  PluginToggleOptions,
  OnboardOptions,
  HealthOptions,
  DoctorOptions,
  SecurityOptions,
  SkillCommandOptions,
  SkillInfoOptions,
  SkillCreateOptions,
  SkillInstallOptions,
  SkillUninstallOptions,
  SkillToggleOptions,
} from './types.js';
import { validateConfigStrict } from '../types/config-migration.js';
import { runSecurityCommand } from './security.js';
import {
  runSkillListCommand,
  runSkillInfoCommand,
  runSkillValidateCommand,
  runSkillCreateCommand,
  runSkillInstallCommand,
  runSkillUninstallCommand,
  runSkillEnableCommand,
  runSkillDisableCommand,
} from './skills-cli.js';
import { runOnboardCommand } from './onboard.js';
import { runDoctorCommand, runHealthCommand } from './health.js';
import {
  runStartCommand,
  runStopCommand,
  runRestartCommand,
  runStatusCommand,
  runServiceInstallCommand,
} from './daemon.js';
import { getDefaultConfigPath } from '../gateway/config-watcher.js';
import { getDefaultPidPath } from '../gateway/daemon.js';
import type {
  DaemonStartOptions,
  DaemonStopOptions,
  DaemonStatusOptions,
  ServiceInstallOptions,
} from './types.js';
import {
  PluginCatalog,
  type PluginPrecedence,
  type PluginSlot,
} from '../skills/catalog.js';
import {
  createOnChainReplayBackfillFetcher,
  createReplayStore,
  parseLocalTrajectoryFile,
  summarizeReplayIncidentRecords,
} from './replay.js';
import {
  ReplayBackfillService,
  type ReplayTimelineRecord,
  type ReplayTimelineStore,
} from '../replay/index.js';
import {
  type ReplayComparisonResult,
  type ReplayComparisonStrictness,
  ReplayComparisonService,
} from '../eval/replay-comparison.js';
import {
  TrajectoryReplayEngine,
} from '../eval/replay.js';
import { type TrajectoryTrace } from '../eval/types.js';
import {
  applyQueryFilter,
  normalizeQuery,
  parseQueryDSL,
  type QueryDSL,
} from '../eval/query-dsl.js';
import { buildIncidentCase } from '../eval/incident-case.js';
import { buildEvidencePack, serializeEvidencePack } from '../eval/evidence-pack.js';
import {
  enforceRole,
  IncidentRoleViolationError,
  type IncidentCommandCategory,
  type OperatorRole,
} from '../policy/incident-roles.js';
import {
  InMemoryAuditTrail,
  computeInputHash,
  computeOutputHash,
} from '../policy/audit-trail.js';
import type { PluginManifest } from '../skills/manifest.js';
import { bigintReplacer, safeStringify } from '../tools/types.js';

interface CliRunOptions {
  argv?: string[];
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

interface ReplayIncidentEventSummary {
  anomalyId: string;
  seq: number;
  slot: number;
  signature: string;
  sourceEventName: string;
  sourceEventType: string;
  taskPda?: string;
  disputePda?: string;
  timestampMs: number;
}

interface ReplayIncidentNarrative {
  lines: string[];
  anomalyIds: string[];
}

interface CliCommandDescriptor {
  name: string;
  description: string;
  commandOptions: Set<string>;
  run: (
    context: CliRuntimeContext,
    options: ReplayBackfillOptions | ReplayCompareOptions | ReplayIncidentOptions,
  ) => Promise<CliStatusCode>;
}

interface PluginCommandDescriptor {
  name: string;
  description: string;
  commandOptions: Set<string>;
  run: (
    context: CliRuntimeContext,
    options: PluginCommandOptions,
  ) => Promise<CliStatusCode>;
}

type ReplayCommand = 'backfill' | 'compare' | 'incident';
type PluginCommand = 'list' | 'install' | 'disable' | 'enable' | 'reload';

type CliCommandOptions =
  | ReplayBackfillOptions
  | ReplayCompareOptions
  | ReplayIncidentOptions;
type PluginCommandOptions =
  | PluginListOptions
  | PluginInstallOptions
  | PluginToggleOptions
  | PluginReloadOptions;

const DEFAULT_IDEMPOTENCY_WINDOW = 900;
const DEFAULT_OUTPUT_FORMAT: CliOutputFormat = 'json';
const DEFAULT_STORE_TYPE: 'memory' | 'sqlite' = 'sqlite';
const DEFAULT_LOG_LEVEL: CliLogLevel = 'warn';
const DEFAULT_CONFIG_PATH = '.agenc-runtime.json';

const GLOBAL_OPTIONS = new Set([
  'help',
  'h',
  'output',
  'output-format',
  'strict-mode',
  'role',
  'rpc',
  'program-id',
  'trace-id',
  'store-type',
  'sqlite-path',
  'idempotency-window',
  'log-level',
  'config',
]);

const COMMAND_OPTIONS: Record<ReplayCommand, Set<string>> = {
  backfill: new Set(['to-slot', 'page-size']),
  compare: new Set(['local-trace-path', 'task-pda', 'dispute-pda', 'redact-fields']),
  incident: new Set(['task-pda', 'dispute-pda', 'query', 'from-slot', 'to-slot', 'sealed', 'redact-fields']),
};
const PLUGIN_COMMAND_OPTIONS: Record<PluginCommand, Set<string>> = {
  list: new Set(),
  install: new Set(['manifest', 'precedence', 'slot']),
  disable: new Set(),
  enable: new Set(),
  reload: new Set(['manifest']),
};

const ONBOARD_COMMAND_OPTIONS = new Set(['non-interactive', 'force']);
const HEALTH_COMMAND_OPTIONS = new Set(['non-interactive', 'deep']);
const DOCTOR_COMMAND_OPTIONS = new Set(['non-interactive', 'deep', 'fix']);

const START_COMMAND_OPTIONS = new Set(['foreground', 'pid-path']);
const STOP_COMMAND_OPTIONS = new Set(['pid-path', 'timeout']);
const RESTART_COMMAND_OPTIONS = new Set([...START_COMMAND_OPTIONS, ...STOP_COMMAND_OPTIONS]);
const STATUS_COMMAND_OPTIONS = new Set(['pid-path', 'port']);
const SERVICE_COMMAND_OPTIONS = new Set(['macos']);

const COMMANDS: Record<ReplayCommand, CliCommandDescriptor> = {
  backfill: {
    name: 'backfill',
    description: 'Backfill replay timeline from on-chain history',
    commandOptions: COMMAND_OPTIONS.backfill,
    run: runReplayBackfillCommand,
  },
  compare: {
    name: 'compare',
    description: 'Compare replay projection against local trace',
    commandOptions: COMMAND_OPTIONS.compare,
    run: runReplayCompareCommand,
  },
  incident: {
    name: 'incident',
    description: 'Generate incident reconstruction summary',
    commandOptions: COMMAND_OPTIONS.incident,
    run: runReplayIncidentCommand,
  },
};
const PLUGIN_COMMANDS: Record<PluginCommand, PluginCommandDescriptor> = {
  list: {
    name: 'list',
    description: 'List plugin catalog entries',
    commandOptions: PLUGIN_COMMAND_OPTIONS.list,
    run: runPluginListCommand,
  },
  install: {
    name: 'install',
    description: 'Install a plugin from a manifest',
    commandOptions: PLUGIN_COMMAND_OPTIONS.install,
    run: runPluginInstallCommand,
  },
  disable: {
    name: 'disable',
    description: 'Disable a plugin by ID',
    commandOptions: PLUGIN_COMMAND_OPTIONS.disable,
    run: runPluginDisableCommand,
  },
  enable: {
    name: 'enable',
    description: 'Enable a plugin by ID',
    commandOptions: PLUGIN_COMMAND_OPTIONS.enable,
    run: runPluginEnableCommand,
  },
  reload: {
    name: 'reload',
    description: 'Reload a plugin and refresh manifest state',
    commandOptions: PLUGIN_COMMAND_OPTIONS.reload,
    run: runPluginReloadCommand,
  },
};

type SkillCommand = 'list' | 'info' | 'validate' | 'create' | 'install' | 'uninstall' | 'enable' | 'disable';

const SKILL_COMMAND_OPTIONS: Record<SkillCommand, Set<string>> = {
  list: new Set(),
  info: new Set(),
  validate: new Set(),
  create: new Set(),
  install: new Set(),
  uninstall: new Set(),
  enable: new Set(),
  disable: new Set(),
};

interface SkillCommandDescriptor {
  name: string;
  description: string;
  commandOptions: Set<string>;
  run: (
    context: CliRuntimeContext,
    options: SkillCommandOptions,
  ) => Promise<CliStatusCode>;
}

const SKILL_COMMANDS: Record<SkillCommand, SkillCommandDescriptor> = {
  list: {
    name: 'list',
    description: 'List all discovered skills',
    commandOptions: SKILL_COMMAND_OPTIONS.list,
    run: runSkillListCommand,
  },
  info: {
    name: 'info',
    description: 'Show detailed skill information',
    commandOptions: SKILL_COMMAND_OPTIONS.info,
    run: runSkillInfoCommand,
  },
  validate: {
    name: 'validate',
    description: 'Validate all discovered skills',
    commandOptions: SKILL_COMMAND_OPTIONS.validate,
    run: runSkillValidateCommand,
  },
  create: {
    name: 'create',
    description: 'Scaffold a new skill in ~/.agenc/skills/',
    commandOptions: SKILL_COMMAND_OPTIONS.create,
    run: runSkillCreateCommand,
  },
  install: {
    name: 'install',
    description: 'Install a skill from URL or local path',
    commandOptions: SKILL_COMMAND_OPTIONS.install,
    run: runSkillInstallCommand,
  },
  uninstall: {
    name: 'uninstall',
    description: 'Remove a user-level skill',
    commandOptions: SKILL_COMMAND_OPTIONS.uninstall,
    run: runSkillUninstallCommand,
  },
  enable: {
    name: 'enable',
    description: 'Enable a disabled skill',
    commandOptions: SKILL_COMMAND_OPTIONS.enable,
    run: runSkillEnableCommand,
  },
  disable: {
    name: 'disable',
    description: 'Disable a skill',
    commandOptions: SKILL_COMMAND_OPTIONS.disable,
    run: runSkillDisableCommand,
  },
};

function validateSkillCommand(name: string): name is SkillCommand {
  return name === 'list' || name === 'info' || name === 'validate'
    || name === 'create' || name === 'install' || name === 'uninstall'
    || name === 'enable' || name === 'disable';
}

const ERROR_CODES = {
  MISSING_ROOT_COMMAND: 'MISSING_ROOT_COMMAND',
  UNKNOWN_COMMAND: 'UNKNOWN_COMMAND',
  MISSING_REPLAY_COMMAND: 'MISSING_REPLAY_COMMAND',
  UNKNOWN_REPLAY_COMMAND: 'UNKNOWN_REPLAY_COMMAND',
  MISSING_PLUGIN_COMMAND: 'MISSING_PLUGIN_COMMAND',
  UNKNOWN_PLUGIN_COMMAND: 'UNKNOWN_PLUGIN_COMMAND',
  INVALID_OPTION: 'INVALID_OPTION',
  INVALID_VALUE: 'INVALID_VALUE',
  MISSING_REQUIRED_OPTION: 'MISSING_REQUIRED_OPTION',
  CONFIG_PARSE_ERROR: 'CONFIG_PARSE_ERROR',
  MISSING_TARGET: 'MISSING_TARGET',
  MISSING_SKILL_COMMAND: 'MISSING_SKILL_COMMAND',
  UNKNOWN_SKILL_COMMAND: 'UNKNOWN_SKILL_COMMAND',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

type ErrorCode = keyof typeof ERROR_CODES;

function createCliError(message: string, code: ErrorCode): CliValidationError {
  const error = new Error(message) as unknown as CliValidationError;
  error.code = code;
  return error;
}

function buildHelp(): string {
  return [
    'agenc-runtime [--help] [--config <path>]',
    'onboard [--help] [options]',
    'health [--help] [options]',
    'doctor [--help] [options]',
    'doctor security [--help] [options]',
    'start [--help] [options]',
    'stop [--help] [options]',
    'restart [--help] [options]',
    'status [--help] [options]',
    'service install [--help] [options]',
    'replay [--help] <command> [options]',
    'plugin [--help] <command> [options]',
    'skill [--help] <command> [options]',
    '',
    'Bootstrap commands:',
    '  onboard   Generate a runtime config file and run sanity checks',
    '  health    Report RPC, store, wallet, and config status',
    '  doctor    Run all health checks and provide remediation guidance',
    '  doctor security  Security posture checks',
    '',
    'Daemon commands:',
    '  start     Start the gateway daemon',
    '  stop      Stop the gateway daemon',
    '  restart   Restart the gateway daemon',
    '  status    Show daemon status',
    '  service install  Generate systemd/launchd service template',
    '',
    'Replay subcommands:',
    '  backfill   Backfill replay timeline from on-chain history',
    '  compare    Compare replay projection against local trace',
    '  incident   Reconstruct incident timeline and summarize',
    '',
    'Skill subcommands:',
    '  list                               List all discovered skills',
    '  info <name>                        Show detailed skill information',
    '  validate                           Validate all discovered skills',
    '  create <name>                      Scaffold a new skill in ~/.agenc/skills/',
    '  install <url-or-path>              Install a skill from URL or local path',
    '  uninstall <name>                   Remove a user-level skill',
    '  enable <name>                      Enable a disabled skill',
    '  disable <name>                     Disable a skill',
    '',
    'Plugin subcommands:',
    '  list                               List registered plugins',
    '  install --manifest <path> [--precedence workspace|user|builtin] [--slot memory|llm|proof|telemetry|custom]',
    '                                   Install or register a plugin',
    '  disable <pluginId>                 Disable a plugin',
    '  enable <pluginId>                  Enable a plugin',
    '  reload <pluginId> [--manifest <path>] Reload a plugin and optional manifest update',
    '',
    'Global options:',
    '  -h, --help                               Show this usage',
    '      --output, --output-format json|jsonl|table  Response output format',
    '      --strict-mode                         Enable strict validation',
    '      --role <role>                         Operator role (read|investigate|execute|admin)',
    '      --rpc                                 RPC endpoint',
    '      --program-id                          Program id',
    '      --trace-id                            Trace id',
    '      --store-type memory|sqlite             Replay event store',
    '      --sqlite-path <path>                  SQLite DB path (sqlite store)',
    '      --idempotency-window <seconds>        Default: 900',
    '      --log-level silent|error|warn|info|debug',
    '      --config <path>                       Config file path (default: .agenc-runtime.json)',
    '',
    'onboard options:',
    '      --non-interactive                     Skip interactive prompts (CI-friendly)',
    '      --force                               Overwrite existing config file',
    '',
    'health options:',
    '      --non-interactive                     Skip interactive prompts (CI-friendly)',
    '      --deep                                Run extended checks (latency, store integrity)',
    '',
    'doctor options:',
    '      --non-interactive                     Skip interactive prompts (CI-friendly)',
    '      --deep                                Run extended checks (latency, store integrity)',
    '      --fix                                 Attempt automatic remediation where possible',
    '',
    'start options:',
    '      --config <path>                           Gateway config file path',
    '      --foreground                              Run in foreground (systemd/Docker mode)',
    '      --pid-path <path>                         Custom PID file path',
    '',
    'stop options:',
    '      --pid-path <path>                         Custom PID file path',
    '      --timeout <ms>                            Shutdown timeout in ms (default: 30000)',
    '',
    'status options:',
    '      --pid-path <path>                         Custom PID file path',
    '      --port <port>                             Override control plane port',
    '',
    'service install options:',
    '      --macos                                   Generate launchd plist instead of systemd unit',
    '',
    'backfill options:',
    '      --to-slot <slot>                      Highest slot to scan (required)',
    '      --page-size <size>                    Number of events per page',
    '',
    'compare options:',
    '      --local-trace-path <path>              Path to local trajectory trace (required)',
    '      --task-pda <pda>                      Limit by task id',
    '      --dispute-pda <pda>                   Limit by dispute id',
    '      --redact-fields <fields>               Comma-separated output redaction keys',
    '',
    'incident options:',
    '      --task-pda <pda>                      Limit by task id',
    '      --dispute-pda <pda>                   Limit by dispute id',
    '      --query <dsl>                         Analyst query DSL filter string',
    '      --redact-fields <fields>               Comma-separated output redaction keys',
    '      --from-slot <slot>                    Replay incident from slot',
    '      --to-slot <slot>                      Replay incident to slot',
    '',
    'plugin options:',
    '      --manifest <path>                     Plugin manifest path (install/reload)',
    '      --precedence workspace|user|builtin  Plugin installation precedence',
    '      --slot memory|llm|proof|telemetry|custom Plugin slot claim',
    '',
    'Examples:',
    '  agenc-runtime start --config ~/.agenc/config.json',
    '  agenc-runtime start --foreground --config ~/.agenc/config.json',
    '  agenc-runtime stop',
    '  agenc-runtime restart --config ~/.agenc/config.json',
    '  agenc-runtime status',
    '  agenc-runtime service install',
    '  agenc-runtime service install --macos',
    '  agenc-runtime onboard --force',
    '  agenc-runtime health --deep',
    '  agenc-runtime doctor --deep --fix',
    '  agenc-runtime doctor security --deep --fix',
    '  agenc-runtime replay backfill --to-slot 12345 --page-size 500',
    '  agenc-runtime replay compare --local-trace-path ./trace.json --task-pda AGENTpda',
    '  agenc-runtime replay incident --task-pda AGENTpda --from-slot 100 --to-slot 200',
    '  agenc-runtime plugin install --manifest ./plugin.json --precedence workspace --slot llm',
    '  agenc-runtime plugin disable memory.plugin',
    '  agenc-runtime plugin list',
    '  agenc-runtime skill list',
    '  agenc-runtime skill info my-skill',
    '  agenc-runtime skill validate',
    '  agenc-runtime skill create my-new-skill',
    '  agenc-runtime skill install ./path/to/skill.md',
    '  agenc-runtime skill uninstall my-skill',
    '  agenc-runtime skill enable my-skill',
    '  agenc-runtime skill disable my-skill',
  ].join('\n');
}

export function parseArgv(argv: string[]): ParsedArgv {
  const positional: string[] = [];
  const flags: Record<string, string | number | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      positional.push(...argv.slice(index + 1));
      break;
    }

    if (!token.startsWith('-')) {
      positional.push(token);
      continue;
    }

    if (token === '-') {
      positional.push(token);
      continue;
    }

    if (token === '-h') {
      flags.h = true;
      continue;
    }

    if (!token.startsWith('--')) {
      // Single short option not in scope (keep deterministic error path by treating as positional for now)
      positional.push(token);
      continue;
    }

    const body = token.slice(2);
    if (!body) {
      continue;
    }

    const parts = body.split('=', 2);
    const rawName = parts[0];
    const rawValue = parts[1];
    if (parts.length === 2) {
      flags[rawName] = parseStringValue(rawValue);
      continue;
    }

    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('-')) {
      flags[rawName] = parseStringValue(next);
      index += 1;
      continue;
    }

    flags[rawName] = true;
  }

  return { positional, flags };
}

function parseStringValue(raw: string): string | number | boolean {
  const lowered = raw.toLowerCase();
  if (lowered === 'true') return true;
  if (lowered === 'false') return false;
  if (/^-?\d+$/.test(raw) && raw.length <= 15) {
    return Number.parseInt(raw, 10);
  }
  return raw;
}

function normalizeBool(value: unknown, fallback = false): boolean {
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true' || value.toLowerCase() === '1') {
      return true;
    }
    if (value.toLowerCase() === 'false' || value.toLowerCase() === '0') {
      return false;
    }
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  return fallback;
}

function parseIntValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function parseOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeOutputFormat(value: unknown): CliOutputFormat {
  return value === 'jsonl' || value === 'table' || value === 'json'
    ? value
    : DEFAULT_OUTPUT_FORMAT;
}

function normalizeStoreType(value: unknown): 'memory' | 'sqlite' {
  return value === 'memory' || value === 'sqlite' ? value : DEFAULT_STORE_TYPE;
}

function normalizeLogLevel(value: unknown): CliLogLevel {
  return value === 'silent'
    || value === 'error'
    || value === 'warn'
    || value === 'info'
    || value === 'debug'
    ? value
    : DEFAULT_LOG_LEVEL;
}

function normalizeCommandFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true' || value === '1') return true;
    if (value.toLowerCase() === 'false' || value === '0') return false;
  }
  return false;
}

function parseCliConfig(value: Record<string, unknown>): CliFileConfig {
  const storeType = normalizeStoreType(value.storeType ?? value.store_type);
  const logLevel = normalizeLogLevel(value.logLevel ?? value.log_level ?? value.verbose);
  const outputFormat = normalizeOutputFormat(value.outputFormat ?? value.output_format);
  return {
    rpcUrl: parseOptionalString(value.rpcUrl ?? value.rpc_url),
    programId: parseOptionalString(value.programId ?? value.program_id),
    storeType,
    sqlitePath: parseOptionalString(value.sqlitePath ?? value.sqlite_path),
    traceId: parseOptionalString(value.traceId ?? value.trace_id),
    strictMode: normalizeBool(value.strictMode ?? value.strict_mode, false),
    idempotencyWindow: parseIntValue(value.idempotencyWindow ?? value.idempotency_window) ?? DEFAULT_IDEMPOTENCY_WINDOW,
    outputFormat,
    logLevel,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readEnvironmentConfig(): CliFileConfig {
  return {
    rpcUrl: parseOptionalString(process.env.AGENC_RUNTIME_RPC_URL),
    programId: parseOptionalString(process.env.AGENC_RUNTIME_PROGRAM_ID),
    storeType: process.env.AGENC_RUNTIME_STORE_TYPE === undefined
      ? undefined
      : normalizeStoreType(process.env.AGENC_RUNTIME_STORE_TYPE),
    sqlitePath: parseOptionalString(process.env.AGENC_RUNTIME_SQLITE_PATH),
    traceId: parseOptionalString(process.env.AGENC_RUNTIME_TRACE_ID),
    strictMode: process.env.AGENC_RUNTIME_STRICT_MODE === undefined
      ? undefined
      : normalizeBool(process.env.AGENC_RUNTIME_STRICT_MODE),
    idempotencyWindow: parseIntValue(process.env.AGENC_RUNTIME_IDEMPOTENCY_WINDOW),
    outputFormat: process.env.AGENC_RUNTIME_OUTPUT === undefined
      ? undefined
      : normalizeOutputFormat(process.env.AGENC_RUNTIME_OUTPUT),
    logLevel: process.env.AGENC_RUNTIME_LOG_LEVEL === undefined
      ? undefined
      : normalizeLogLevel(process.env.AGENC_RUNTIME_LOG_LEVEL),
  };
}

function resolveConfigPath(rawFlags: ParsedArgv['flags']): string {
  const explicit = parseOptionalString(rawFlags.config);
  const envPath = parseOptionalString(process.env.AGENC_RUNTIME_CONFIG);
  return resolve(process.cwd(), explicit ?? envPath ?? DEFAULT_CONFIG_PATH);
}

function loadFileConfig(configPath: string, strictModeEnabled = false): CliFileConfig {
  if (!existsSync(configPath)) {
    return {};
  }

  const raw = readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;

  if (!isRecord(parsed)) {
    return {};
  }

  const validation = validateConfigStrict(parsed, strictModeEnabled);
  if (!validation.valid) {
    throw createCliError(
      `Config validation failed: ${validation.errors.map(e => e.message).join('; ')}`,
      ERROR_CODES.CONFIG_PARSE_ERROR,
    );
  }

  return parseCliConfig(validation.migratedConfig);
}

function normalizeOptionAliases(name: string): string {
  if (name === 'output-format') return 'output';
  return name;
}

function isValidTopLevelOption(name: string): boolean {
  return GLOBAL_OPTIONS.has(name) || name === 'h';
}

function validateUnknownOptions(
  flags: ParsedArgv['flags'],
  command: ReplayCommand | PluginCommand,
): void {
  const commandOpts = command === 'backfill'
    || command === 'compare'
    || command === 'incident'
    ? COMMAND_OPTIONS[command]
    : PLUGIN_COMMAND_OPTIONS[command];
  for (const rawName of Object.keys(flags)) {
    const normalized = normalizeOptionAliases(rawName);
    if (rawName === 'h' || isValidTopLevelOption(normalized)) {
      continue;
    }
    if (commandOpts.has(rawName) || commandOpts.has(normalized)) {
      continue;
    }
    throw createCliError(`unknown option --${rawName}`, ERROR_CODES.INVALID_OPTION);
  }
}

function validateUnknownStandaloneOptions(
  flags: ParsedArgv['flags'],
  allowed: Set<string>,
): void {
  for (const rawName of Object.keys(flags)) {
    const normalized = normalizeOptionAliases(rawName);
    if (rawName === 'h' || isValidTopLevelOption(normalized)) {
      continue;
    }
    if (allowed.has(rawName) || allowed.has(normalized)) {
      continue;
    }
    throw createCliError(`unknown option --${rawName}`, ERROR_CODES.INVALID_OPTION);
  }
}

function normalizeGlobalFlags(flags: ParsedArgv['flags'], fileConfig: CliFileConfig, envConfig: CliFileConfig): {
  outputFormat: CliOutputFormat;
  strictMode: boolean;
  role?: OperatorRole;
  rpcUrl?: string;
  programId?: string;
  storeType: 'memory' | 'sqlite';
  sqlitePath?: string;
  traceId?: string;
  idempotencyWindow: number;
  help: boolean;
  logLevel: CliLogLevel;
} {
  const configStrictMode = fileConfig.strictMode;
  return {
    outputFormat: normalizeOutputFormat(
      flags.output ?? flags['output-format'] ?? envConfig.outputFormat ?? fileConfig.outputFormat,
    ),
    strictMode: normalizeBool(flags['strict-mode'], envConfig.strictMode ?? configStrictMode ?? false),
    role: parseOperatorRole(flags.role),
    rpcUrl: parseOptionalString(flags.rpc ?? fileConfig.rpcUrl ?? envConfig.rpcUrl),
    programId: parseOptionalString(flags['program-id'] ?? fileConfig.programId ?? envConfig.programId),
    storeType: normalizeStoreType(flags['store-type'] ?? envConfig.storeType ?? fileConfig.storeType),
    sqlitePath: parseOptionalString(flags['sqlite-path'] ?? fileConfig.sqlitePath ?? envConfig.sqlitePath),
    traceId: parseOptionalString(flags['trace-id'] ?? fileConfig.traceId ?? envConfig.traceId),
    idempotencyWindow: parseIntValue(flags['idempotency-window'])
      ?? fileConfig.idempotencyWindow
      ?? envConfig.idempotencyWindow
      ?? DEFAULT_IDEMPOTENCY_WINDOW,
    help: normalizeCommandFlag(flags.h) || normalizeCommandFlag(flags.help),
    logLevel: normalizeLogLevel(flags['log-level'] ?? envConfig.logLevel ?? fileConfig.logLevel),
  };
}

type PluginGlobalContext = Omit<ReturnType<typeof normalizeGlobalFlags>, 'logLevel'>;

function validateReplayCommand(name: string): name is ReplayCommand {
  return name === 'backfill' || name === 'compare' || name === 'incident';
}

function validatePluginCommand(name: string): name is PluginCommand {
  return name === 'list' || name === 'install' || name === 'disable' || name === 'enable' || name === 'reload';
}

function parseOperatorRole(value: unknown): OperatorRole | undefined {
  const raw = parseOptionalString(value);
  if (raw === undefined) {
    return undefined;
  }

  if (raw === 'read' || raw === 'investigate' || raw === 'execute' || raw === 'admin') {
    return raw;
  }

  throw createCliError('--role must be one of: read, investigate, execute, admin', ERROR_CODES.INVALID_VALUE);
}

function parsePluginPrecedence(value: unknown): PluginPrecedence {
  if (value === undefined) {
    return 'user';
  }
  if (value === 'workspace' || value === 'user' || value === 'builtin') {
    return value;
  }
  throw createCliError(
    '--precedence must be one of: workspace, user, builtin',
    ERROR_CODES.INVALID_VALUE,
  );
}

function parsePluginSlot(value: unknown): PluginSlot {
  if (
    value === 'memory'
    || value === 'llm'
    || value === 'proof'
    || value === 'telemetry'
    || value === 'custom'
  ) {
    return value;
  }
  throw createCliError(
    '--slot must be one of: memory, llm, proof, telemetry, custom',
    ERROR_CODES.INVALID_VALUE,
  );
}

function makePluginOptionsBase(
  global: PluginGlobalContext,
): BaseCliOptions {
  return {
    help: global.help,
    outputFormat: global.outputFormat,
    strictMode: global.strictMode,
    role: global.role,
    rpcUrl: global.rpcUrl,
    programId: global.programId,
    storeType: global.storeType,
    sqlitePath: global.sqlitePath,
    traceId: global.traceId,
    idempotencyWindow: global.idempotencyWindow,
  };
}

function makeBackfillOptions(raw: Record<string, string | number | boolean>, global: Omit<ReplayBackfillOptions, 'toSlot' | 'pageSize'>): ReplayBackfillOptions {
  const toSlot = parseIntValue(raw['to-slot']);
  const pageSize = parseIntValue(raw['page-size']);

  if (toSlot === undefined || toSlot <= 0) {
    throw createCliError('backfill requires --to-slot as a positive integer', ERROR_CODES.MISSING_REQUIRED_OPTION);
  }

  return {
    ...global,
    toSlot,
    pageSize: pageSize,
  };
}

function makeCompareOptions(raw: Record<string, string | number | boolean>, global: Omit<ReplayCompareOptions, 'localTracePath' | 'taskPda' | 'disputePda'>): ReplayCompareOptions {
  const localTracePath = parseOptionalString(raw['local-trace-path']);
  if (localTracePath === undefined) {
    throw createCliError('--local-trace-path is required for replay compare', ERROR_CODES.MISSING_REQUIRED_OPTION);
  }

  const redactFields = parseRedactFields(raw['redact-fields']);

  return {
    ...global,
    localTracePath,
    taskPda: parseOptionalString(raw['task-pda']),
    disputePda: parseOptionalString(raw['dispute-pda']),
    redactFields,
  };
}

function makeIncidentOptions(
  raw: Record<string, string | number | boolean>,
  global: Omit<ReplayIncidentOptions, 'taskPda' | 'disputePda' | 'query' | 'fromSlot' | 'toSlot'>,
): ReplayIncidentOptions {
  const taskPda = parseOptionalString(raw['task-pda']);
  const disputePda = parseOptionalString(raw['dispute-pda']);
  const query = parseOptionalString(raw.query);
  const fromSlot = parseIntValue(raw['from-slot']);
  const toSlot = parseIntValue(raw['to-slot']);
  const sealed = raw.sealed === undefined ? undefined : normalizeCommandFlag(raw.sealed);
  const redactFields = parseRedactFields(raw['redact-fields']);

  if (fromSlot !== undefined && fromSlot < 0) {
    throw createCliError('--from-slot must be non-negative', ERROR_CODES.INVALID_VALUE);
  }

  if (toSlot !== undefined && toSlot < 0) {
    throw createCliError('--to-slot must be non-negative', ERROR_CODES.INVALID_VALUE);
  }

  if (fromSlot !== undefined && toSlot !== undefined && toSlot < fromSlot) {
    throw createCliError('--to-slot must be greater than or equal to --from-slot', ERROR_CODES.INVALID_VALUE);
  }

  if (taskPda === undefined && disputePda === undefined && query === undefined) {
    throw createCliError('incident requires --task-pda, --dispute-pda, or --query', ERROR_CODES.MISSING_TARGET);
  }

  return {
    ...global,
    taskPda,
    disputePda,
    query,
    fromSlot,
    toSlot,
    sealed,
    redactFields,
  };
}

function makePluginListOptions(
  _raw: Record<string, string | number | boolean>,
  global: PluginGlobalContext,
): PluginListOptions {
  return {
    ...makePluginOptionsBase(global),
  };
}

function makePluginInstallOptions(
  raw: Record<string, string | number | boolean>,
  global: PluginGlobalContext,
): PluginInstallOptions {
  const manifestPath = parseOptionalString(raw.manifest);
  if (manifestPath === undefined) {
    throw createCliError('--manifest is required for plugin install', ERROR_CODES.MISSING_REQUIRED_OPTION);
  }
  const precedence = parseOptionalString(raw.precedence);
  const slot = parseOptionalString(raw.slot);

  return {
    ...makePluginOptionsBase(global),
    manifestPath,
    precedence: precedence === undefined ? undefined : parsePluginPrecedence(precedence),
    slot: slot === undefined ? undefined : parsePluginSlot(slot),
  };
}

function makePluginDisableOptions(
  pluginId: string | undefined,
  global: PluginGlobalContext,
): PluginToggleOptions {
  if (pluginId === undefined) {
    throw createCliError('--plugin-id is required for plugin disable', ERROR_CODES.MISSING_REQUIRED_OPTION);
  }

  return {
    ...makePluginOptionsBase(global),
    pluginId,
  };
}

function makePluginEnableOptions(
  pluginId: string | undefined,
  global: PluginGlobalContext,
): PluginToggleOptions {
  if (pluginId === undefined) {
    throw createCliError('--plugin-id is required for plugin enable', ERROR_CODES.MISSING_REQUIRED_OPTION);
  }

  return {
    ...makePluginOptionsBase(global),
    pluginId,
  };
}

function makePluginReloadOptions(
  pluginId: string | undefined,
  global: PluginGlobalContext,
  raw: Record<string, string | number | boolean>,
): PluginReloadOptions {
  if (pluginId === undefined) {
    throw createCliError('--plugin-id is required for plugin reload', ERROR_CODES.MISSING_REQUIRED_OPTION);
  }

  return {
    ...makePluginOptionsBase(global),
    pluginId,
    manifestPath: parseOptionalString(raw.manifest),
  };
}

function buildOutput(value: unknown, format: CliOutputFormat): string {
  if (format === 'jsonl') {
    if (Array.isArray(value)) {
      return value.map((entry) => safeStringify(entry)).join('\n');
    }
    return safeStringify(value);
  }

  if (format === 'table') {
    return inspect(value, {
      colors: false,
      compact: false,
      depth: 6,
      sorted: true,
    });
  }

  return JSON.stringify(value, bigintReplacer, 2);
}

function snakeToCamel(value: string): string {
  if (!value.includes('_')) {
    return value;
  }
  return value.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function parseRedactFields(raw: unknown): string[] {
  if (raw === undefined) {
    return [];
  }

  let input = raw;
  if (Array.isArray(raw)) {
    input = raw.join(',');
  } else if (typeof raw !== 'string') {
    return [];
  }

  return String(input)
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => snakeToCamel(entry));
}

function applyRedaction<T>(value: T, redactions: readonly string[]): T {
  if (redactions.length === 0) {
    return value;
  }

  const redactionSet = new Set(redactions);
  const transform = (input: unknown): unknown => {
    if (input === null || input === undefined || typeof input !== 'object') {
      return input;
    }

    if (Array.isArray(input)) {
      return input.map((entry) => transform(entry));
    }

    const output: Record<string, unknown> = {};
    const record = input as Record<string, unknown>;
    for (const [key, itemValue] of Object.entries(record)) {
      if (redactionSet.has(key)) {
        output[key] = '[REDACTED]';
      } else {
        output[key] = transform(itemValue);
      }
    }

    return output;
  };

  return transform(value) as T;
}

function createContext(
  output: NodeJS.WritableStream,
  errorOutput: NodeJS.WritableStream,
  outputFormat: CliOutputFormat,
  logLevel: CliLogLevel,
): CliRuntimeContext {
  const write = (stream: NodeJS.WritableStream) => (value: unknown) => {
    stream.write(`${String(buildOutput(value, outputFormat))}\n`);
  };

  const levels: CliLogLevel[] = ['silent', 'error', 'warn', 'info', 'debug'];
  const enabled = levels.indexOf(logLevel);

  const logger: CliLogger = {
    error: (message, fields) => {
      if (enabled >= levels.indexOf('error')) {
        const payload = fields ? { level: 'error', message, ...fields } : { level: 'error', message };
        write(errorOutput)(payload);
      }
    },
    warn: (message, fields) => {
      if (enabled >= levels.indexOf('warn')) {
        const payload = fields ? { level: 'warn', message, ...fields } : { level: 'warn', message };
        write(errorOutput)(payload);
      }
    },
    info: (message, fields) => {
      if (enabled >= levels.indexOf('info')) {
        const payload = fields ? { level: 'info', message, ...fields } : { level: 'info', message };
        write(errorOutput)(payload);
      }
    },
    debug: (message, fields) => {
      if (enabled >= levels.indexOf('debug')) {
        const payload = fields ? { level: 'debug', message, ...fields } : { level: 'debug', message };
        write(errorOutput)(payload);
      }
    },
  };

  return {
    logger,
    output: write(output),
    error: write(errorOutput),
    outputFormat,
  };
}

function buildErrorPayload(error: unknown): { status: 'error'; code: string; message: string } {
  if (error instanceof Error && 'code' in error && typeof (error as CliValidationError).code === 'string') {
    return {
      status: 'error',
      code: (error as CliValidationError).code,
      message: error.message,
    };
  }

  return {
    status: 'error',
    code: ERROR_CODES.INTERNAL_ERROR,
    message: error instanceof Error ? error.message : String(error),
  };
}

interface PluginParseReport {
  command: 'plugin';
  pluginCommand: PluginCommand;
  global: {
    help: boolean;
    strictMode: boolean;
    outputFormat: CliOutputFormat;
    role?: OperatorRole;
    rpcUrl?: string;
    programId?: string;
    storeType: 'memory' | 'sqlite';
    sqlitePath?: string;
    traceId?: string;
    idempotencyWindow: number;
  };
  options: PluginCommandOptions;
  outputFormat: CliOutputFormat;
}

function normalizeAndValidate(
  parsed: ParsedArgv,
): CliParseReport {
  const configPath = resolveConfigPath(parsed.flags);
  let fileConfig: CliFileConfig;
  try {
    fileConfig = loadFileConfig(configPath);
  } catch (error) {
    throw createCliError(`failed to parse config file ${configPath}: ${error instanceof Error ? error.message : String(error)}`, ERROR_CODES.CONFIG_PARSE_ERROR);
  }

  const envConfig = readEnvironmentConfig();

  if (parsed.positional.length === 0) {
    throw createCliError('missing replay command group', ERROR_CODES.MISSING_ROOT_COMMAND);
  }

  const root = parsed.positional[0];
  if (root !== 'replay') {
    throw createCliError(`unknown root command: ${root}`, ERROR_CODES.UNKNOWN_COMMAND);
  }

  const replayCommand = parsed.positional[1] as string | undefined;
  if (!replayCommand) {
    throw createCliError('missing replay subcommand', ERROR_CODES.MISSING_REPLAY_COMMAND);
  }
  if (!validateReplayCommand(replayCommand)) {
    throw createCliError(`unknown replay command: ${replayCommand}`, ERROR_CODES.UNKNOWN_REPLAY_COMMAND);
  }

  validateUnknownOptions(parsed.flags, replayCommand);

  const global = normalizeGlobalFlags(parsed.flags, fileConfig, envConfig);

  if (global.storeType === 'sqlite' && global.sqlitePath === undefined) {
    global.sqlitePath = fileConfig.sqlitePath ?? envConfig.sqlitePath;
  }

  const common = {
    help: global.help,
    outputFormat: global.outputFormat,
    strictMode: global.strictMode,
    role: global.role,
    rpcUrl: global.rpcUrl,
    programId: global.programId,
    storeType: global.storeType,
    sqlitePath: global.sqlitePath,
    traceId: global.traceId,
    idempotencyWindow: global.idempotencyWindow,
  };

  let options: CliCommandOptions;
  if (replayCommand === 'backfill') {
    options = makeBackfillOptions(parsed.flags, common as Omit<ReplayBackfillOptions, 'toSlot' | 'pageSize'>);
  } else if (replayCommand === 'compare') {
    options = makeCompareOptions(parsed.flags, common as Omit<ReplayCompareOptions, 'localTracePath' | 'taskPda' | 'disputePda'>);
  } else {
    options = makeIncidentOptions(parsed.flags, common as Omit<ReplayIncidentOptions, 'taskPda' | 'disputePda' | 'fromSlot' | 'toSlot'>);
  }

  return {
    command: 'replay',
    replayCommand,
    global: {
      help: global.help,
      strictMode: common.strictMode,
      outputFormat: common.outputFormat,
      role: common.role,
      rpcUrl: common.rpcUrl,
      programId: common.programId,
      storeType: common.storeType,
      sqlitePath: common.sqlitePath,
      traceId: common.traceId,
      idempotencyWindow: common.idempotencyWindow,
    },
    options,
    outputFormat: common.outputFormat,
  };
}

function normalizeAndValidatePluginCommand(
  parsed: ParsedArgv,
): PluginParseReport {
  const configPath = resolveConfigPath(parsed.flags);
  let fileConfig: CliFileConfig;
  try {
    fileConfig = loadFileConfig(configPath);
  } catch (error) {
    throw createCliError(`failed to parse config file ${configPath}: ${error instanceof Error ? error.message : String(error)}`, ERROR_CODES.CONFIG_PARSE_ERROR);
  }

  const envConfig = readEnvironmentConfig();

  if (parsed.positional.length === 0) {
    throw createCliError('missing plugin command group', ERROR_CODES.MISSING_ROOT_COMMAND);
  }

  const root = parsed.positional[0];
  if (root !== 'plugin') {
    throw createCliError(`unknown root command: ${root}`, ERROR_CODES.UNKNOWN_COMMAND);
  }

  const pluginCommand = parsed.positional[1] as string | undefined;
  if (!pluginCommand) {
    throw createCliError('missing plugin subcommand', ERROR_CODES.MISSING_PLUGIN_COMMAND);
  }
  if (!validatePluginCommand(pluginCommand)) {
    throw createCliError(`unknown plugin command: ${pluginCommand}`, ERROR_CODES.UNKNOWN_PLUGIN_COMMAND);
  }

  validateUnknownOptions(parsed.flags, pluginCommand);

  const global = normalizeGlobalFlags(parsed.flags, fileConfig, envConfig);

  if (global.storeType === 'sqlite' && global.sqlitePath === undefined) {
    global.sqlitePath = fileConfig.sqlitePath ?? envConfig.sqlitePath;
  }

  const common = {
    help: global.help,
    outputFormat: global.outputFormat,
    strictMode: global.strictMode,
    role: global.role,
    rpcUrl: global.rpcUrl,
    programId: global.programId,
    storeType: global.storeType,
    sqlitePath: global.sqlitePath,
    traceId: global.traceId,
    idempotencyWindow: global.idempotencyWindow,
  };

  const pluginId = parseOptionalString(parsed.positional[2]);
  let options: PluginCommandOptions;
  if (pluginCommand === 'list') {
    options = makePluginListOptions(parsed.flags, common);
  } else if (pluginCommand === 'install') {
    options = makePluginInstallOptions(parsed.flags, common);
  } else if (pluginCommand === 'disable') {
    options = makePluginDisableOptions(pluginId, common);
  } else if (pluginCommand === 'enable') {
    options = makePluginEnableOptions(pluginId, common);
  } else {
    options = makePluginReloadOptions(pluginId, common, parsed.flags);
  }

  return {
    command: 'plugin',
    pluginCommand,
    global: {
      help: common.help,
      strictMode: common.strictMode,
      outputFormat: common.outputFormat,
      role: common.role,
      rpcUrl: common.rpcUrl,
      programId: common.programId,
      storeType: common.storeType,
      sqlitePath: common.sqlitePath,
      traceId: common.traceId,
      idempotencyWindow: common.idempotencyWindow,
    },
    options,
    outputFormat: common.outputFormat,
  };
}

interface SkillParseReport {
  command: 'skill';
  skillCommand: SkillCommand;
  global: {
    help: boolean;
    strictMode: boolean;
    outputFormat: CliOutputFormat;
    role?: OperatorRole;
    rpcUrl?: string;
    programId?: string;
    storeType: 'memory' | 'sqlite';
    sqlitePath?: string;
    traceId?: string;
    idempotencyWindow: number;
  };
  options: SkillCommandOptions;
  outputFormat: CliOutputFormat;
}

function normalizeAndValidateSkillCommand(
  parsed: ParsedArgv,
): SkillParseReport {
  const configPath = resolveConfigPath(parsed.flags);
  let fileConfig: CliFileConfig;
  try {
    fileConfig = loadFileConfig(configPath);
  } catch (error) {
    throw createCliError(`failed to parse config file ${configPath}: ${error instanceof Error ? error.message : String(error)}`, ERROR_CODES.CONFIG_PARSE_ERROR);
  }

  const envConfig = readEnvironmentConfig();

  const skillCommand = parsed.positional[1] as string | undefined;
  if (!skillCommand) {
    throw createCliError('missing skill subcommand', ERROR_CODES.MISSING_SKILL_COMMAND);
  }
  if (!validateSkillCommand(skillCommand)) {
    throw createCliError(`unknown skill command: ${skillCommand}`, ERROR_CODES.UNKNOWN_SKILL_COMMAND);
  }

  validateUnknownStandaloneOptions(parsed.flags, SKILL_COMMAND_OPTIONS[skillCommand]);

  const global = normalizeGlobalFlags(parsed.flags, fileConfig, envConfig);

  const base: BaseCliOptions = {
    help: global.help,
    outputFormat: global.outputFormat,
    strictMode: global.strictMode,
    role: global.role,
    rpcUrl: global.rpcUrl,
    programId: global.programId,
    storeType: global.storeType,
    sqlitePath: global.sqlitePath,
    traceId: global.traceId,
    idempotencyWindow: global.idempotencyWindow,
  };

  let options: SkillCommandOptions;

  if (skillCommand === 'info' || skillCommand === 'enable' || skillCommand === 'disable' || skillCommand === 'uninstall' || skillCommand === 'create') {
    const target = parsed.positional[2];
    if (!target) {
      throw createCliError(`skill ${skillCommand} requires a name argument`, ERROR_CODES.MISSING_TARGET);
    }
    if (skillCommand === 'info') {
      options = { ...base, skillName: target } as SkillInfoOptions;
    } else if (skillCommand === 'create') {
      options = { ...base, skillName: target } as SkillCreateOptions;
    } else if (skillCommand === 'uninstall') {
      options = { ...base, skillName: target } as SkillUninstallOptions;
    } else {
      options = { ...base, skillName: target } as SkillToggleOptions;
    }
  } else if (skillCommand === 'install') {
    const source = parsed.positional[2];
    if (!source) {
      throw createCliError('skill install requires a source argument', ERROR_CODES.MISSING_TARGET);
    }
    options = { ...base, source } as SkillInstallOptions;
  } else {
    options = { ...base };
  }

  return {
    command: 'skill',
    skillCommand,
    global: {
      help: base.help,
      strictMode: base.strictMode,
      outputFormat: base.outputFormat,
      role: base.role,
      rpcUrl: base.rpcUrl,
      programId: base.programId,
      storeType: base.storeType,
      sqlitePath: base.sqlitePath,
      traceId: base.traceId,
      idempotencyWindow: base.idempotencyWindow,
    },
    options,
    outputFormat: base.outputFormat,
  };
}

export async function runCli(options: CliRunOptions = {}): Promise<CliStatusCode> {
  const argv = options.argv ?? process.argv.slice(2);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  const parsed = parseArgv(argv);
  const outputFormat = normalizeOutputFormat(parsed.flags.output ?? parsed.flags['output-format']);

  const context = createContext(stdout, stderr, outputFormat, normalizeLogLevel(process.env.AGENC_RUNTIME_LOG_LEVEL ?? DEFAULT_LOG_LEVEL));

  const showRootHelp = parsed.flags.help || parsed.flags.h || parsed.positional.length === 0;
  if (showRootHelp) {
    context.output(buildHelp());
    return 0;
  }

  if (parsed.positional[0] === 'onboard') {
    try {
      if (parsed.positional.length > 1) {
        throw createCliError('onboard does not accept positional arguments', ERROR_CODES.INVALID_VALUE);
      }

      validateUnknownStandaloneOptions(parsed.flags, ONBOARD_COMMAND_OPTIONS);

      const configPath = resolveConfigPath(parsed.flags);
      let fileConfig: CliFileConfig;
      try {
        fileConfig = loadFileConfig(configPath);
      } catch {
        fileConfig = {};
      }

      const envConfig = readEnvironmentConfig();
      const global = normalizeGlobalFlags(parsed.flags, fileConfig, envConfig);
      const onboardOpts: OnboardOptions = {
        ...global,
        configPath,
        nonInteractive: normalizeBool(parsed.flags['non-interactive'], false),
        force: normalizeBool(parsed.flags.force, false),
      };

      return await runOnboardCommand(context, onboardOpts);
    } catch (error) {
      const payload = buildErrorPayload(error);
      context.error(payload);
      const isUsageError = (payload.code === ERROR_CODES.INVALID_OPTION
        || payload.code === ERROR_CODES.INVALID_VALUE
        || payload.code === ERROR_CODES.MISSING_REQUIRED_OPTION
        || payload.code === ERROR_CODES.MISSING_TARGET
        || payload.code === ERROR_CODES.MISSING_ROOT_COMMAND
        || payload.code === ERROR_CODES.UNKNOWN_COMMAND)
        ? 2
        : 1;
      return isUsageError;
    }
  }

  if (parsed.positional[0] === 'health') {
    try {
      if (parsed.positional.length > 1) {
        throw createCliError('health does not accept positional arguments', ERROR_CODES.INVALID_VALUE);
      }

      validateUnknownStandaloneOptions(parsed.flags, HEALTH_COMMAND_OPTIONS);

      const configPath = resolveConfigPath(parsed.flags);
      let fileConfig: CliFileConfig;
      try {
        fileConfig = loadFileConfig(configPath);
      } catch {
        fileConfig = {};
      }

      const envConfig = readEnvironmentConfig();
      const global = normalizeGlobalFlags(parsed.flags, fileConfig, envConfig);
      const healthOpts: HealthOptions = {
        ...global,
        configPath,
        nonInteractive: normalizeBool(parsed.flags['non-interactive'], false),
        deep: normalizeBool(parsed.flags.deep, false),
      };

      return await runHealthCommand(context, healthOpts);
    } catch (error) {
      const payload = buildErrorPayload(error);
      context.error(payload);
      const isUsageError = (payload.code === ERROR_CODES.INVALID_OPTION
        || payload.code === ERROR_CODES.INVALID_VALUE
        || payload.code === ERROR_CODES.MISSING_REQUIRED_OPTION
        || payload.code === ERROR_CODES.MISSING_TARGET
        || payload.code === ERROR_CODES.MISSING_ROOT_COMMAND
        || payload.code === ERROR_CODES.UNKNOWN_COMMAND)
        ? 2
        : 1;
      return isUsageError;
    }
  }

  // Handle `doctor security` subcommand before replay routing
  if (parsed.positional[0] === 'doctor' && parsed.positional[1] === 'security') {
    const configPath = resolveConfigPath(parsed.flags);
    let fileConfig: CliFileConfig;
    try {
      fileConfig = loadFileConfig(configPath);
    } catch {
      fileConfig = {};
    }
    const envConfig = readEnvironmentConfig();
    const global = normalizeGlobalFlags(parsed.flags, fileConfig, envConfig);
    const securityOpts: SecurityOptions = {
      ...global,
      deep: normalizeBool(parsed.flags.deep, false),
      json: normalizeBool(parsed.flags.json, false),
      fix: normalizeBool(parsed.flags.fix, false),
    };
    try {
      return await runSecurityCommand(context, securityOpts);
    } catch (error) {
      const payload = buildErrorPayload(error);
      context.error(payload);
      return 1;
    }
  }

  if (parsed.positional[0] === 'doctor') {
    try {
      if (parsed.positional.length > 1) {
        throw createCliError(`unknown doctor subcommand: ${parsed.positional[1]}`, ERROR_CODES.UNKNOWN_COMMAND);
      }

      validateUnknownStandaloneOptions(parsed.flags, DOCTOR_COMMAND_OPTIONS);

      const configPath = resolveConfigPath(parsed.flags);
      let fileConfig: CliFileConfig;
      try {
        fileConfig = loadFileConfig(configPath);
      } catch {
        fileConfig = {};
      }

      const envConfig = readEnvironmentConfig();
      const global = normalizeGlobalFlags(parsed.flags, fileConfig, envConfig);
      const doctorOpts: DoctorOptions = {
        ...global,
        configPath,
        nonInteractive: normalizeBool(parsed.flags['non-interactive'], false),
        deep: normalizeBool(parsed.flags.deep, false),
        fix: normalizeBool(parsed.flags.fix, false),
      };

      return await runDoctorCommand(context, doctorOpts);
    } catch (error) {
      const payload = buildErrorPayload(error);
      context.error(payload);
      const isUsageError = (payload.code === ERROR_CODES.INVALID_OPTION
        || payload.code === ERROR_CODES.INVALID_VALUE
        || payload.code === ERROR_CODES.MISSING_REQUIRED_OPTION
        || payload.code === ERROR_CODES.MISSING_TARGET
        || payload.code === ERROR_CODES.MISSING_ROOT_COMMAND
        || payload.code === ERROR_CODES.UNKNOWN_COMMAND)
        ? 2
        : 1;
      return isUsageError;
    }
  }

  // Daemon commands: start, stop, restart, status, service install
  if (parsed.positional[0] === 'start') {
    try {
      validateUnknownStandaloneOptions(parsed.flags, START_COMMAND_OPTIONS);
      const configPath = parseOptionalString(parsed.flags.config)
        ?? process.env.AGENC_CONFIG
        ?? getDefaultConfigPath();
      const pidPath = parseOptionalString(parsed.flags['pid-path']) ?? getDefaultPidPath();
      const startOpts: DaemonStartOptions = {
        configPath,
        pidPath,
        foreground: normalizeBool(parsed.flags.foreground, false),
        logLevel: parseOptionalString(parsed.flags['log-level']),
      };
      return await runStartCommand(context, startOpts);
    } catch (error) {
      const payload = buildErrorPayload(error);
      context.error(payload);
      return payload.code === ERROR_CODES.INVALID_OPTION ? 2 : 1;
    }
  }

  if (parsed.positional[0] === 'stop') {
    try {
      validateUnknownStandaloneOptions(parsed.flags, STOP_COMMAND_OPTIONS);
      const pidPath = parseOptionalString(parsed.flags['pid-path']) ?? getDefaultPidPath();
      const stopOpts: DaemonStopOptions = {
        pidPath,
        timeout: parseIntValue(parsed.flags.timeout),
      };
      return await runStopCommand(context, stopOpts);
    } catch (error) {
      const payload = buildErrorPayload(error);
      context.error(payload);
      return payload.code === ERROR_CODES.INVALID_OPTION ? 2 : 1;
    }
  }

  if (parsed.positional[0] === 'restart') {
    try {
      validateUnknownStandaloneOptions(parsed.flags, RESTART_COMMAND_OPTIONS);
      const configPath = parseOptionalString(parsed.flags.config)
        ?? process.env.AGENC_CONFIG
        ?? getDefaultConfigPath();
      const pidPath = parseOptionalString(parsed.flags['pid-path']) ?? getDefaultPidPath();
      const startOpts: DaemonStartOptions = {
        configPath,
        pidPath,
        foreground: normalizeBool(parsed.flags.foreground, false),
        logLevel: parseOptionalString(parsed.flags['log-level']),
      };
      const stopOpts: DaemonStopOptions = {
        pidPath,
        timeout: parseIntValue(parsed.flags.timeout),
      };
      return await runRestartCommand(context, startOpts, stopOpts);
    } catch (error) {
      const payload = buildErrorPayload(error);
      context.error(payload);
      return payload.code === ERROR_CODES.INVALID_OPTION ? 2 : 1;
    }
  }

  if (parsed.positional[0] === 'status') {
    try {
      validateUnknownStandaloneOptions(parsed.flags, STATUS_COMMAND_OPTIONS);
      const pidPath = parseOptionalString(parsed.flags['pid-path']) ?? getDefaultPidPath();
      const statusOpts: DaemonStatusOptions = {
        pidPath,
        controlPlanePort: parseIntValue(parsed.flags.port),
      };
      return await runStatusCommand(context, statusOpts);
    } catch (error) {
      const payload = buildErrorPayload(error);
      context.error(payload);
      return payload.code === ERROR_CODES.INVALID_OPTION ? 2 : 1;
    }
  }

  if (parsed.positional[0] === 'service' && parsed.positional[1] === 'install') {
    try {
      validateUnknownStandaloneOptions(parsed.flags, SERVICE_COMMAND_OPTIONS);
      const serviceOpts: ServiceInstallOptions = {
        configPath: parseOptionalString(parsed.flags.config),
        macos: normalizeBool(parsed.flags.macos, false),
      };
      return await runServiceInstallCommand(context, serviceOpts);
    } catch (error) {
      const payload = buildErrorPayload(error);
      context.error(payload);
      return payload.code === ERROR_CODES.INVALID_OPTION ? 2 : 1;
    }
  }

  if (parsed.positional[0] === 'skill') {
    let skillReport: SkillParseReport;
    try {
      skillReport = normalizeAndValidateSkillCommand(parsed);
    } catch (error) {
      const payload = buildErrorPayload(error);
      context.error(payload);
      return 2;
    }

    const skillContext = createContext(
      stdout,
      stderr,
      skillReport.outputFormat,
      normalizeLogLevel(parsed.flags['log-level']),
    );

    if (skillReport.global.help) {
      skillContext.output(buildHelp());
      return 0;
    }

    const skillDescriptor = SKILL_COMMANDS[skillReport.skillCommand];
    try {
      return await skillDescriptor.run(skillContext, skillReport.options);
    } catch (error) {
      const payload = buildErrorPayload(error);
      skillContext.error(payload);
      return 1;
    }
  }

  let report: CliParseReport | PluginParseReport;
  try {
    if (parsed.positional[0] === 'plugin') {
      report = normalizeAndValidatePluginCommand(parsed);
    } else {
      report = normalizeAndValidate(parsed);
    }
  } catch (error) {
    const payload = buildErrorPayload(error);
    context.error(payload);
    return 2;
  }

  const commandContext = createContext(
    stdout,
    stderr,
    report.outputFormat,
    normalizeLogLevel(parsed.flags['log-level']),
  );

  if (report.global.help) {
    commandContext.output(buildHelp());
    return 0;
  }

  if (report.command === 'plugin') {
    const pluginCommand = PLUGIN_COMMANDS[report.pluginCommand];
    try {
      return await pluginCommand.run(
        commandContext,
        report.options,
      );
    } catch (error) {
      const payload = buildErrorPayload(error);
      commandContext.error(payload);
      const isUsageError = (payload.code === ERROR_CODES.INVALID_OPTION
        || payload.code === ERROR_CODES.INVALID_VALUE
        || payload.code === ERROR_CODES.MISSING_REQUIRED_OPTION
        || payload.code === ERROR_CODES.MISSING_TARGET
        || payload.code === ERROR_CODES.MISSING_PLUGIN_COMMAND
        || payload.code === ERROR_CODES.UNKNOWN_PLUGIN_COMMAND
        || payload.code === ERROR_CODES.MISSING_ROOT_COMMAND
        || payload.code === ERROR_CODES.UNKNOWN_COMMAND)
        ? 2
        : 1;
      return isUsageError;
    }
  }

  const commandDescriptor = COMMANDS[report.replayCommand];
  const role = report.options.role;
  const commandCategory: IncidentCommandCategory = report.replayCommand === 'backfill'
    ? 'replay.backfill'
    : report.replayCommand === 'compare'
      ? 'replay.compare'
      : 'replay.incident';

  const auditTrail = role ? new InMemoryAuditTrail() : null;
  let capturedOutput: unknown;
  let capturedError: unknown;

  if (role) {
    const originalOutput = commandContext.output;
    const originalError = commandContext.error;

    commandContext.output = (value) => {
      capturedOutput = value;
      originalOutput(value);
    };

    commandContext.error = (value) => {
      capturedError = value;
      originalError(value);
    };
  }

  try {
    if (role) {
      try {
        enforceRole(role, commandCategory);
      } catch (error) {
        if (error instanceof IncidentRoleViolationError) {
          throw createCliError(error.message, ERROR_CODES.INVALID_VALUE);
        }
        throw error;
      }
    }

    const status = await commandDescriptor.run(commandContext, report.options);

    if (role && auditTrail) {
      const outputValue = capturedOutput ?? { status };
      auditTrail.append({
        timestamp: new Date().toISOString(),
        actor: process.env.USER ?? 'unknown',
        role,
        action: commandCategory,
        inputHash: computeInputHash(report.options),
        outputHash: computeOutputHash(outputValue),
      });
    }

    return status;
  } catch (error) {
    const payload = buildErrorPayload(error);
    commandContext.error(payload);

    if (role && auditTrail) {
      const outputValue = capturedError ?? payload;
      auditTrail.append({
        timestamp: new Date().toISOString(),
        actor: process.env.USER ?? 'unknown',
        role,
        action: commandCategory,
        inputHash: computeInputHash(report.options),
        outputHash: computeOutputHash(outputValue),
      });
    }

    const isUsageError = (payload.code === ERROR_CODES.INVALID_OPTION
      || payload.code === ERROR_CODES.INVALID_VALUE
      || payload.code === ERROR_CODES.MISSING_REQUIRED_OPTION
      || payload.code === ERROR_CODES.MISSING_TARGET
      || payload.code === ERROR_CODES.MISSING_ROOT_COMMAND
      || payload.code === ERROR_CODES.UNKNOWN_COMMAND
      || payload.code === ERROR_CODES.MISSING_REPLAY_COMMAND
      || payload.code === ERROR_CODES.UNKNOWN_REPLAY_COMMAND)
      ? 2
      : 1;
    return isUsageError;
  }
}

async function runReplayBackfillCommand(
  context: CliRuntimeContext,
  args: CliCommandOptions,
): Promise<CliStatusCode> {
  const options = args as ReplayBackfillOptions;
  if (!options.rpcUrl) {
    throw createCliError('--rpc is required for replay backfill', ERROR_CODES.MISSING_REQUIRED_OPTION);
  }

  const store = createReplayStore({
    storeType: options.storeType,
    sqlitePath: options.sqlitePath,
  });

  const fetcher = createOnChainReplayBackfillFetcher({
    rpcUrl: options.rpcUrl,
    programId: options.programId,
  });

  const service = new ReplayBackfillService(store, {
    toSlot: options.toSlot,
    pageSize: options.pageSize,
    fetcher,
    tracePolicy: {
      traceId: options.traceId ?? DEFAULT_REPLAY_TRACE_ID,
      emitOtel: false,
      sampleRate: 1,
    },
  });

  const result = await service.runBackfill();
  const cursor = await store.getCursor();

  context.output({
    status: 'ok',
    command: 'replay.backfill',
    schema: 'replay.backfill.output.v1',
    mode: 'backfill',
    strictMode: options.strictMode,
    toSlot: options.toSlot,
    pageSize: options.pageSize,
    storeType: options.storeType,
    traceId: options.traceId,
    idempotencyWindow: options.idempotencyWindow,
    result: {
      processed: result.processed,
      duplicates: result.duplicates,
      cursor,
    },
  });

  return 0;
}

function loadPluginManifest(manifestPath: string): PluginManifest {
  const rawManifest = readFileSync(resolve(manifestPath), 'utf8');
  return JSON.parse(rawManifest) as PluginManifest;
}

async function runPluginListCommand(
  context: CliRuntimeContext,
  _args: PluginCommandOptions,
): Promise<CliStatusCode> {
  const catalog = new PluginCatalog();
  context.output({
    status: 'ok',
    command: 'plugin.list',
    schema: 'plugin.list.output.v1',
    plugins: catalog.list(),
  });
  return 0;
}

async function runPluginInstallCommand(
  context: CliRuntimeContext,
  args: PluginCommandOptions,
): Promise<CliStatusCode> {
  const pluginArgs = args as PluginInstallOptions;
  const manifest = loadPluginManifest(pluginArgs.manifestPath);
  const catalog = new PluginCatalog();
  const result = catalog.install(manifest, pluginArgs.precedence ?? 'user', {
    slot: pluginArgs.slot,
    sourcePath: pluginArgs.manifestPath,
  });

  context.output({
    status: 'ok',
    command: 'plugin.install',
    schema: 'plugin.operation.output.v1',
    result,
  });

  return result.success ? 0 : 1;
}

async function runPluginDisableCommand(
  context: CliRuntimeContext,
  args: PluginCommandOptions,
): Promise<CliStatusCode> {
  const pluginArgs = args as PluginToggleOptions;
  const catalog = new PluginCatalog();
  const result = catalog.disable(pluginArgs.pluginId);
  context.output({
    status: 'ok',
    command: 'plugin.disable',
    schema: 'plugin.operation.output.v1',
    result,
  });
  return result.success ? 0 : 1;
}

async function runPluginEnableCommand(
  context: CliRuntimeContext,
  args: PluginCommandOptions,
): Promise<CliStatusCode> {
  const pluginArgs = args as PluginToggleOptions;
  const catalog = new PluginCatalog();
  const result = catalog.enable(pluginArgs.pluginId);
  context.output({
    status: 'ok',
    command: 'plugin.enable',
    schema: 'plugin.operation.output.v1',
    result,
  });
  return result.success ? 0 : 1;
}

async function runPluginReloadCommand(
  context: CliRuntimeContext,
  args: PluginCommandOptions,
): Promise<CliStatusCode> {
  const pluginArgs = args as PluginReloadOptions;
  const catalog = new PluginCatalog();
  const manifest = pluginArgs.manifestPath === undefined
    ? undefined
    : loadPluginManifest(pluginArgs.manifestPath);
  const result = catalog.reload(pluginArgs.pluginId, manifest);
  context.output({
    status: 'ok',
    command: 'plugin.reload',
    schema: 'plugin.operation.output.v1',
    result,
  });
  return result.success ? 0 : 1;
}

async function runReplayCompareCommand(
  context: CliRuntimeContext,
  args: CliCommandOptions,
): Promise<CliStatusCode> {
  const options = args as ReplayCompareOptions;
  const store = createReplayStore({
    storeType: options.storeType,
    sqlitePath: options.sqlitePath,
  });
  const localTrace = await parseLocalTrajectoryFile(options.localTracePath ?? '');

  const projected = await store.query({
    taskPda: options.taskPda,
    disputePda: options.disputePda,
  });
  const strictness = options.strictMode ? 'strict' : 'lenient';
  const comparison = await runReplayComparison({
    projected,
    localTrace,
    strictness,
  });

  context.output(applyRedaction(
    {
      status: 'ok',
      command: 'replay.compare',
      schema: 'replay.compare.output.v1',
      localTracePath: options.localTracePath,
      taskPda: options.taskPda,
      disputePda: options.disputePda,
      strictness,
      strictMode: options.strictMode,
      storeType: options.storeType,
      result: buildReplayCompareResult(comparison),
    },
    options.redactFields ?? [],
  ));

  return 0;
}

async function runReplayIncidentCommand(
  context: CliRuntimeContext,
  args: CliCommandOptions,
): Promise<CliStatusCode> {
  const options = args as ReplayIncidentOptions;

  let queryDsl: QueryDSL = {};
  if (options.query !== undefined) {
    try {
      queryDsl = parseQueryDSL(options.query);
    } catch (error) {
      throw createCliError(
        error instanceof Error ? error.message : String(error),
        ERROR_CODES.INVALID_VALUE,
      );
    }
  }

  if (options.taskPda !== undefined) {
    if (queryDsl.taskPda !== undefined && queryDsl.taskPda !== options.taskPda) {
      throw createCliError('conflicting task PDA filters between --task-pda and --query', ERROR_CODES.INVALID_VALUE);
    }
    queryDsl.taskPda = queryDsl.taskPda ?? options.taskPda;
  }

  if (options.disputePda !== undefined) {
    if (queryDsl.disputePda !== undefined && queryDsl.disputePda !== options.disputePda) {
      throw createCliError('conflicting dispute PDA filters between --dispute-pda and --query', ERROR_CODES.INVALID_VALUE);
    }
    queryDsl.disputePda = queryDsl.disputePda ?? options.disputePda;
  }

  if (options.fromSlot !== undefined || options.toSlot !== undefined) {
    const from = queryDsl.slotRange?.from ?? options.fromSlot;
    const to = queryDsl.slotRange?.to ?? options.toSlot;

    if (options.fromSlot !== undefined && queryDsl.slotRange?.from !== undefined && options.fromSlot !== queryDsl.slotRange.from) {
      throw createCliError('conflicting from-slot filters between --from-slot and --query', ERROR_CODES.INVALID_VALUE);
    }

    if (options.toSlot !== undefined && queryDsl.slotRange?.to !== undefined && options.toSlot !== queryDsl.slotRange.to) {
      throw createCliError('conflicting to-slot filters between --to-slot and --query', ERROR_CODES.INVALID_VALUE);
    }

    queryDsl.slotRange = { from, to };
  }

  if (queryDsl.taskPda === undefined && queryDsl.disputePda === undefined) {
    throw createCliError('incident requires --task-pda, --dispute-pda, or --query', ERROR_CODES.MISSING_TARGET);
  }

  if (queryDsl.slotRange?.from !== undefined && queryDsl.slotRange?.to !== undefined && queryDsl.slotRange.to < queryDsl.slotRange.from) {
    throw createCliError('--to-slot must be greater than or equal to --from-slot', ERROR_CODES.INVALID_VALUE);
  }

  const normalizedQuery = normalizeQuery(queryDsl);
  const incidentFilters = {
    taskPda: queryDsl.taskPda,
    disputePda: queryDsl.disputePda,
    fromSlot: queryDsl.slotRange?.from,
    toSlot: queryDsl.slotRange?.to,
  };

  const store = createReplayStore({
    storeType: options.storeType,
    sqlitePath: options.sqlitePath,
  });
  const records = applyQueryFilter(
    await queryIncidentRecords(store, incidentFilters),
    queryDsl,
  );
  const summary = summarizeReplayIncidentRecords(records, incidentFilters);

  const validation = summarizeIncidentValidation(records, options.strictMode);
  const narrative = buildIncidentNarrative(
    summary.events.map((entry) => ({
      anomalyId: buildIncidentEventAnomalyId(entry),
      seq: entry.seq,
      slot: entry.slot,
      signature: entry.signature,
      sourceEventName: entry.sourceEventName,
      sourceEventType: entry.sourceEventType,
      taskPda: entry.taskPda,
      disputePda: entry.disputePda,
      timestampMs: entry.timestampMs,
    })),
    validation,
    new Set(options.redactFields ?? []),
  );

  const evidencePack = options.sealed === true
    ? (() => {
      const events = records.map((record) => ({
        seq: record.seq,
        type: record.type,
        taskPda: record.taskPda,
        timestampMs: record.timestampMs,
        payload: record.payload,
        slot: record.slot,
        signature: record.signature,
        sourceEventName: record.sourceEventName,
        sourceEventSequence: record.sourceEventSequence,
      }));

      const incidentCase = buildIncidentCase({
        events,
        window: {
          fromSlot: incidentFilters.fromSlot,
          toSlot: incidentFilters.toSlot,
        },
      });

      const pack = buildEvidencePack({
        incidentCase,
        events,
        seed: 0,
        queryHash: normalizedQuery.hash,
        sealed: true,
        redactionPolicy: {
          stripFields: ['payload.onchain.trace'],
          redactActors: true,
        },
      });

      return {
        manifest: pack.manifest,
        files: serializeEvidencePack(pack),
      };
    })()
    : undefined;

  const payload = {
    status: 'ok',
    command: 'replay.incident',
    schema: 'replay.incident.output.v1',
    commandParams: {
      taskPda: incidentFilters.taskPda,
      disputePda: incidentFilters.disputePda,
      query: options.query,
      fromSlot: incidentFilters.fromSlot,
      toSlot: incidentFilters.toSlot,
      strictMode: options.strictMode,
      storeType: options.storeType,
      sqlitePath: options.sqlitePath,
      sealed: options.sealed,
    },
    summary: {
      ...summary,
      eventType: 'replay-incidents',
    },
    validation,
    narrative,
    ...(evidencePack ? { evidencePack } : {}),
  };

  context.output(applyRedaction(payload, options.redactFields ?? []));

  return 0;
}

function buildIncidentEventAnomalyId(entry: {
  seq: number;
  slot: number;
  signature: string;
  sourceEventName: string;
  sourceEventType: string;
  taskPda?: string;
  disputePda?: string;
  timestampMs: number;
}): string {
  const seed = `${entry.seq}|${entry.slot}|${entry.signature}|${entry.sourceEventName}|${entry.sourceEventType}|${entry.taskPda ?? ''}|${entry.disputePda ?? ''}|${entry.timestampMs}`;
  return createHash('sha1').update(seed).digest('hex').slice(0, 16);
}

async function queryIncidentRecords(
  store: ReplayTimelineStore,
  filters: {
    taskPda?: string;
    disputePda?: string;
    fromSlot?: number;
    toSlot?: number;
  },
): Promise<ReadonlyArray<ReplayTimelineRecord>> {
  return store.query({
    taskPda: filters.taskPda,
    disputePda: filters.disputePda,
    fromSlot: filters.fromSlot,
    toSlot: filters.toSlot,
  });
}

function buildReplayCompareResult(comparison: ReplayComparisonResult): {
  status: ReplayComparisonResult['status'];
  strictness: ReplayComparisonStrictness;
  localEventCount: number;
  projectedEventCount: number;
  mismatchCount: number;
  matchRate: number;
  anomalyIds: string[];
  topAnomalies: Array<{
    anomalyId: string;
    code: string;
    severity: string;
    message: string;
    sourceEventName?: string;
    signature?: string;
    seq?: number;
  }>;
  hashes: {
    local: string;
    projected: string;
  };
  localSummary: ReplayComparisonResult['localReplay'];
  projectedSummary: ReplayComparisonResult['projectedReplay'];
} {
  return {
    status: comparison.status,
    strictness: comparison.strictness,
    localEventCount: comparison.localEventCount,
    projectedEventCount: comparison.projectedEventCount,
    mismatchCount: comparison.mismatchCount,
    matchRate: comparison.matchRate,
    anomalyIds: comparison.anomalies.map((anomaly, index) => {
      const sourceContext = anomaly.context;
      const seed = `${anomaly.code}|${sourceContext.sourceEventName ?? ''}|${sourceContext.seq ?? index}|${sourceContext.sourceEventSequence ?? ''}`;
      return createHash('sha1').update(seed).digest('hex').slice(0, 16);
    }),
    topAnomalies: comparison.anomalies.slice(0, 50).map((anomaly, index) => {
      const sourceContext = anomaly.context;
      const anomalySeed = `${anomaly.code}|${sourceContext.taskPda ?? ''}|${sourceContext.seq ?? index}`;
      return {
        anomalyId: createHash('sha1').update(anomalySeed).digest('hex').slice(0, 16),
        code: anomaly.code,
        severity: anomaly.severity,
        message: anomaly.message,
        sourceEventName: sourceContext.sourceEventName,
        signature: sourceContext.signature,
        seq: sourceContext.seq,
      };
    }),
    hashes: {
      local: comparison.localReplay.deterministicHash,
      projected: comparison.projectedReplay.deterministicHash,
    },
    localSummary: comparison.localReplay,
    projectedSummary: comparison.projectedReplay,
  };
}

async function runReplayComparison(input: {
  projected: ReadonlyArray<ReplayTimelineRecord>;
  localTrace: TrajectoryTrace;
  strictness: ReplayComparisonStrictness;
}): Promise<ReplayComparisonResult> {
  const comparison = new ReplayComparisonService();
  return comparison.compare({
    projected: input.projected,
    localTrace: input.localTrace,
    options: { strictness: input.strictness },
  });
}

function buildProjectedIncidentTrace(
  records: readonly ReplayTimelineRecord[],
  seed: string,
): TrajectoryTrace {
  const events = records
    .map((record) => ({
      seq: record.seq,
      type: record.type,
      taskPda: record.taskPda,
      timestampMs: record.timestampMs,
      payload: record.payload,
    }))
    .sort((left, right) => {
      if (left.seq !== right.seq) {
        return left.seq - right.seq;
      }
      if (left.timestampMs !== right.timestampMs) {
        return left.timestampMs - right.timestampMs;
      }
      return left.taskPda?.localeCompare(right.taskPda ?? '') ?? 0;
    });

  return {
    schemaVersion: 1,
    traceId: seed,
    seed: 0,
    createdAtMs: Date.now(),
    events,
  };
}

function summarizeIncidentValidation(
  records: readonly ReplayTimelineRecord[],
  strictMode: boolean,
): {
  strictMode: boolean;
  eventValidation: {
    errors: string[];
    warnings: string[];
    replayTaskCount: number;
  };
  anomalyIds: string[];
} {
  const projectedTrace = buildProjectedIncidentTrace(records, `incident-${records.length}-${strictMode ? 'strict' : 'lenient'}`);
  const replayResult = new TrajectoryReplayEngine({
    strictMode,
  }).replay(projectedTrace);

  const anomalyIds = [
    ...replayResult.errors,
    ...replayResult.warnings,
  ].map((entry, index) => createHash('sha1').update(entry).update(String(index)).digest('hex').slice(0, 16));

  return {
    strictMode,
    eventValidation: {
      errors: replayResult.errors,
      warnings: replayResult.warnings,
      replayTaskCount: Object.keys(replayResult.tasks).length,
    },
    anomalyIds,
  };
}

function redactField<T>(redactions: ReadonlySet<string>, key: string, value: T): T | string {
  return redactions.has(key) ? '[REDACTED]' : value;
}

function buildIncidentNarrative(
  events: ReplayIncidentEventSummary[],
  validation: { anomalyIds: string[]; eventValidation: { errors: string[]; warnings: string[] } },
  redactions: ReadonlySet<string>,
): ReplayIncidentNarrative {
  const eventsLines = events.slice(0, 40).map((event, index) => {
    const anomaly = validation.anomalyIds[index];
    const marker = anomaly === undefined ? '' : ` | anomaly:${anomaly}`;
    const seq = redactField(redactions, 'seq', event.seq);
    const slot = redactField(redactions, 'slot', event.slot);
    const signature = redactField(redactions, 'signature', event.signature);
    const sourceEventName = redactField(redactions, 'sourceEventName', event.sourceEventName);
    const sourceEventType = redactField(redactions, 'sourceEventType', event.sourceEventType);
    return `${seq}/${slot}/${signature}: ${sourceEventName} (${sourceEventType})${marker}`;
  });

  const messages = [...validation.eventValidation.errors, ...validation.eventValidation.warnings]
    .slice(0, 20)
    .map((entry) => `validation:${entry}`);

  return {
    lines: [...eventsLines, ...messages],
    anomalyIds: validation.anomalyIds.slice(0, 40),
  };
}

const DEFAULT_REPLAY_TRACE_ID = 'replay-cli-command';

export type { ParsedArgv };
