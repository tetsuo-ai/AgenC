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
  CliValidationError,
  ParsedArgv,
  ReplayBackfillOptions,
  ReplayCompareOptions,
  ReplayIncidentOptions,
} from './types.js';
import { validateConfigStrict } from '../types/config-migration.js';
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

type ReplayCommand = 'backfill' | 'compare' | 'incident';

type CliStatusCode = 0 | 1 | 2;

type CliCommandOptions =
  | ReplayBackfillOptions
  | ReplayCompareOptions
  | ReplayIncidentOptions;

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
  compare: new Set(['local-trace-path', 'task-pda', 'dispute-pda']),
  incident: new Set(['task-pda', 'dispute-pda', 'from-slot', 'to-slot']),
};

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

const ERROR_CODES = {
  MISSING_ROOT_COMMAND: 'MISSING_ROOT_COMMAND',
  UNKNOWN_COMMAND: 'UNKNOWN_COMMAND',
  MISSING_REPLAY_COMMAND: 'MISSING_REPLAY_COMMAND',
  UNKNOWN_REPLAY_COMMAND: 'UNKNOWN_REPLAY_COMMAND',
  INVALID_OPTION: 'INVALID_OPTION',
  INVALID_VALUE: 'INVALID_VALUE',
  MISSING_REQUIRED_OPTION: 'MISSING_REQUIRED_OPTION',
  CONFIG_PARSE_ERROR: 'CONFIG_PARSE_ERROR',
  MISSING_TARGET: 'MISSING_TARGET',
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
    'replay [--help] <command> [options]',
    '',
    'Replay subcommands:',
    '  backfill   Backfill replay timeline from on-chain history',
    '  compare    Compare replay projection against local trace',
    '  incident   Reconstruct incident timeline and summarize',
    '',
    'Global options:',
    '  -h, --help                               Show this usage',
    '      --output, --output-format json|jsonl|table  Response output format',
    '      --strict-mode                         Enable strict validation',
    '      --rpc                                 RPC endpoint',
    '      --program-id                          Program id',
    '      --trace-id                            Trace id',
    '      --store-type memory|sqlite             Replay event store',
    '      --sqlite-path <path>                  SQLite DB path (sqlite store)',
    '      --idempotency-window <seconds>        Default: 900',
    '      --log-level silent|error|warn|info|debug',
    '      --config <path>                       Config file path (default: .agenc-runtime.json)',
    '',
    'backfill options:',
    '      --to-slot <slot>                      Highest slot to scan (required)',
    '      --page-size <size>                    Number of events per page',
    '',
    'compare options:',
    '      --local-trace-path <path>              Path to local trajectory trace (required)',
    '      --task-pda <pda>                      Limit by task id',
    '      --dispute-pda <pda>                   Limit by dispute id',
    '',
    'incident options:',
    '      --task-pda <pda>                      Limit by task id',
    '      --dispute-pda <pda>                   Limit by dispute id',
    '      --from-slot <slot>                    Replay incident from slot',
    '      --to-slot <slot>                      Replay incident to slot',
    '',
    'Examples:',
    '  agenc-runtime replay backfill --to-slot 12345 --page-size 500',
    '  agenc-runtime replay compare --local-trace-path ./trace.json --task-pda AGENTpda',
    '  agenc-runtime replay incident --task-pda AGENTpda --from-slot 100 --to-slot 200',
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
  command: ReplayCommand,
): void {
  const commandOpts = COMMAND_OPTIONS[command];
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

function normalizeGlobalFlags(flags: ParsedArgv['flags'], fileConfig: CliFileConfig, envConfig: CliFileConfig): {
  outputFormat: CliOutputFormat;
  strictMode: boolean;
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

function validateReplayCommand(name: string): name is ReplayCommand {
  return name === 'backfill' || name === 'compare' || name === 'incident';
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

  return {
    ...global,
    localTracePath,
    taskPda: parseOptionalString(raw['task-pda']),
    disputePda: parseOptionalString(raw['dispute-pda']),
  };
}

function makeIncidentOptions(
  raw: Record<string, string | number | boolean>,
  global: Omit<ReplayIncidentOptions, 'taskPda' | 'disputePda' | 'fromSlot' | 'toSlot'>,
): ReplayIncidentOptions {
  const taskPda = parseOptionalString(raw['task-pda']);
  const disputePda = parseOptionalString(raw['dispute-pda']);
  const fromSlot = parseIntValue(raw['from-slot']);
  const toSlot = parseIntValue(raw['to-slot']);

  if (fromSlot !== undefined && fromSlot < 0) {
    throw createCliError('--from-slot must be non-negative', ERROR_CODES.INVALID_VALUE);
  }

  if (toSlot !== undefined && toSlot < 0) {
    throw createCliError('--to-slot must be non-negative', ERROR_CODES.INVALID_VALUE);
  }

  if (fromSlot !== undefined && toSlot !== undefined && toSlot < fromSlot) {
    throw createCliError('--to-slot must be greater than or equal to --from-slot', ERROR_CODES.INVALID_VALUE);
  }

  if (taskPda === undefined && disputePda === undefined) {
    throw createCliError('incident requires --task-pda or --dispute-pda', ERROR_CODES.MISSING_TARGET);
  }

  return {
    ...global,
    taskPda,
    disputePda,
    fromSlot,
    toSlot,
  };
}

function buildOutput(value: unknown, format: CliOutputFormat): string {
  if (format === 'jsonl') {
    if (Array.isArray(value)) {
      return value.map((entry) => JSON.stringify(entry)).join('\n');
    }
    return JSON.stringify(value);
  }

  if (format === 'table') {
    return inspect(value, {
      colors: false,
      compact: false,
      depth: 6,
      sorted: true,
    });
  }

  return JSON.stringify(value, null, 2);
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

  let report: CliParseReport;
  try {
    report = normalizeAndValidate(parsed);
  } catch (error) {
    const payload = buildErrorPayload(error);
    context.error(payload);
    return 2;
  }

  const commandDescriptor = COMMANDS[report.replayCommand];

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

  try {
    return await commandDescriptor.run(commandContext, report.options);
  } catch (error) {
    const payload = buildErrorPayload(error);
    commandContext.error(payload);
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

  context.output({
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
  });

  return 0;
}

async function runReplayIncidentCommand(
  context: CliRuntimeContext,
  args: CliCommandOptions,
): Promise<CliStatusCode> {
  const options = args as ReplayIncidentOptions;

  const store = createReplayStore({
    storeType: options.storeType,
    sqlitePath: options.sqlitePath,
  });
  const records = await queryIncidentRecords(store, {
    taskPda: options.taskPda,
    disputePda: options.disputePda,
    fromSlot: options.fromSlot,
    toSlot: options.toSlot,
  });
  const summary = summarizeReplayIncidentRecords(records, {
    taskPda: options.taskPda,
    disputePda: options.disputePda,
    fromSlot: options.fromSlot,
    toSlot: options.toSlot,
  });

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
  );

  context.output({
    status: 'ok',
    command: 'replay.incident',
    schema: 'replay.incident.output.v1',
    commandParams: {
      taskPda: options.taskPda,
      disputePda: options.disputePda,
      fromSlot: options.fromSlot,
      toSlot: options.toSlot,
      strictMode: options.strictMode,
      storeType: options.storeType,
      sqlitePath: options.sqlitePath,
    },
    summary: {
      ...summary,
      eventType: 'replay-incidents',
    },
    validation,
    narrative,
  });

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

function buildIncidentNarrative(
  events: ReplayIncidentEventSummary[],
  validation: { anomalyIds: string[]; eventValidation: { errors: string[]; warnings: string[] } },
): ReplayIncidentNarrative {
  const eventsLines = events.slice(0, 40).map((event, index) => {
    const anomaly = validation.anomalyIds[index];
    const marker = anomaly === undefined ? '' : ` | anomaly:${anomaly}`;
    return `${event.seq}/${event.slot}/${event.signature}: ${event.sourceEventName} (${event.sourceEventType})${marker}`;
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
