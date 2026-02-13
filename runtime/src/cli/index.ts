import { inspect } from 'node:util';
import { ReplayBackfillOptions, ReplayCompareOptions, ReplayIncidentOptions } from './types.js';

export interface CliRuntimeContext {
  output: (value: unknown) => void;
  error: (value: unknown) => void;
}

export interface CliRunOptions {
  argv?: string[];
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export interface CliParseError extends Error {
  code: string;
}

type CliRunner = (context: CliRuntimeContext, options: Record<string, string | number | boolean>) => Promise<number>;

interface CliCommand {
  name: string;
  description: string;
  run: CliRunner;
}

const KNOWN_COMMANDS: Record<string, CliCommand> = {
  backfill: {
    name: 'backfill',
    description: 'Backfill replay timeline from on-chain history',
    run: runReplayBackfillCommand,
  },
  compare: {
    name: 'compare',
    description: 'Compare replay projection against a local trace',
    run: runReplayCompareCommand,
  },
  incident: {
    name: 'incident',
    description: 'Generate incident reconstruction summary',
    run: runReplayIncidentCommand,
  },
};

function buildHelp(): string {
  const commandLines = Object.values(KNOWN_COMMANDS)
    .map((command) => `  ${command.name.padEnd(10)} ${command.description}`)
    .join('\n');

  return [
    'agenc-runtime [--help] replay <command> [options]',
    '',
    'Replay subcommands:',
    commandLines,
    '',
    'Global options:',
    '  --help                  Show usage',
    '  --output json|jsonl|table',
    '  --strict-mode           Enable strict validation',
    '  --rpc                   RPC endpoint',
    '  --program-id            Program id',
    '  --trace-id              Trace id',
    '  --store-type memory|sqlite',
    '',
    'Common options (replay):',
    '  --idempotency-window    Retry window in seconds (default: 900)',
    '',
    'backfill:',
    '  --to-slot                Highest slot to scan',
    '  --page-size              Page size',
    '',
    'compare:',
    '  --local-trace            Local trace path',
    '  --task-pda               Limit by task id',
    '  --dispute-pda            Limit by dispute id',
    '',
    'incident:',
    '  --task-pda               Limit by task id',
    '  --dispute-pda            Limit by dispute id',
    '  --from-slot              Start slot',
    '  --to-slot                End slot',
  ].join('\n');
}

function parseArgv(argv: string[]): Record<string, string | number | boolean> {
  const parsed: Record<string, string | number | boolean> = {};
  const normalized = [...argv];

  for (let index = 0; index < normalized.length; index += 1) {
    const arg = normalized[index];
    if (!arg.startsWith('--')) {
      continue;
    }

    const withoutPrefix = arg.slice(2);
    const next = normalized[index + 1];

    const assignParts = withoutPrefix.split('=', 2);
    const key = assignParts[0];
    if (assignParts.length === 2) {
      parsed[key] = assignParts[1] ?? '';
      continue;
    }

    const boolValue = resolveBoolValue(next);
    if (boolValue !== null) {
      parsed[key] = boolValue;
      if (typeof boolValue !== 'boolean') {
        index += 1;
      }
      continue;
    }

    if (next && !next.startsWith('--')) {
      parsed[key] = next;
      index += 1;
      continue;
    }

    parsed[key] = true;
  }

  return parsed;
}

function resolveBoolValue(value: string | undefined): boolean | null {
  if (value === undefined) {
    return null;
  }

  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }

  return null;
}

function parseReplayCommand(argv: string[]): {
  command: 'backfill' | 'compare' | 'incident' | null;
  options: Record<string, string | number | boolean>;
} {
  const commandToken = argv[0];
  if (!commandToken) {
    return { command: null, options: {} };
  }

  if (!(commandToken in KNOWN_COMMANDS)) {
    return { command: null, options: {} };
  }

  const options = parseArgv(argv.slice(1));
  return {
    command: commandToken as 'backfill' | 'compare' | 'incident',
    options,
  };
}

function readNumber(value: string | number | boolean | undefined, fallback = 0): number {
  if (typeof value === 'boolean') {
    return fallback;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : fallback;
  }
  const asNumber = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(asNumber) ? asNumber : fallback;
}

async function runReplayBackfillCommand(context: CliRuntimeContext, args: Record<string, string | number | boolean>): Promise<number> {
  const options = makeBackfillOptions(args);
  context.output({
    command: 'replay backfill',
    status: 'stub',
    toSlot: options.toSlot,
    pageSize: options.pageSize,
    idempotencyWindow: options.idempotencyWindow,
    strictMode: options.strictMode,
  });
  return 0;
}

async function runReplayCompareCommand(context: CliRuntimeContext, args: Record<string, string | number | boolean>): Promise<number> {
  const options = makeCompareOptions(args);
  if (options.localTracePath === undefined) {
    throw createCliError(
      '--local-trace-path is required',
      'MISSING_LOCAL_TRACE',
    );
  }

  context.output({
    command: 'replay compare',
    status: 'stub',
    localTracePath: options.localTracePath,
    strictMode: options.strictMode,
    taskPda: options.taskPda,
    disputePda: options.disputePda,
  });
  return 0;
}

async function runReplayIncidentCommand(context: CliRuntimeContext, args: Record<string, string | number | boolean>): Promise<number> {
  const options = makeIncidentOptions(args);
  if (options.taskPda === undefined && options.disputePda === undefined) {
    throw createCliError(
      'incident command requires --task-pda or --dispute-pda',
      'MISSING_TARGET',
    );
  }

  context.output({
    command: 'replay incident',
    status: 'stub',
    taskPda: options.taskPda,
    disputePda: options.disputePda,
    fromSlot: options.fromSlot,
    toSlot: options.toSlot,
  });
  return 0;
}

function makeBackfillOptions(raw: Record<string, string | number | boolean>): ReplayBackfillOptions {
  const toSlot = readNumber(raw['to-slot'], Number.NaN);
  return {
    help: false,
    outputFormat: normalizeOutputFormat(raw.output),
    strictMode: Boolean(raw['strict-mode']),
    rpcUrl: normalizeOptionalString(raw.rpc),
    programId: normalizeOptionalString(raw['program-id']),
    storeType: normalizeStoreType(raw['store-type']),
    sqlitePath: normalizeOptionalString(raw['sqlite-path']),
    traceId: normalizeOptionalString(raw['trace-id']),
    idempotencyWindow: readNumber(raw['idempotency-window'], 900),
    toSlot,
    pageSize: raw['page-size'] === undefined
      ? undefined
      : readNumber(raw['page-size'], 100),
  };
}

function makeCompareOptions(raw: Record<string, string | number | boolean>): ReplayCompareOptions {
  return {
    help: false,
    outputFormat: normalizeOutputFormat(raw.output),
    strictMode: Boolean(raw['strict-mode']),
    rpcUrl: normalizeOptionalString(raw.rpc),
    programId: normalizeOptionalString(raw['program-id']),
    storeType: normalizeStoreType(raw['store-type']),
    sqlitePath: normalizeOptionalString(raw['sqlite-path']),
    traceId: normalizeOptionalString(raw['trace-id']),
    idempotencyWindow: readNumber(raw['idempotency-window'], 900),
    localTracePath: normalizeOptionalString(raw['local-trace-path']),
    taskPda: normalizeOptionalString(raw['task-pda']),
    disputePda: normalizeOptionalString(raw['dispute-pda']),
  };
}

function makeIncidentOptions(raw: Record<string, string | number | boolean>): ReplayIncidentOptions {
  return {
    help: false,
    outputFormat: normalizeOutputFormat(raw.output),
    strictMode: Boolean(raw['strict-mode']),
    rpcUrl: normalizeOptionalString(raw.rpc),
    programId: normalizeOptionalString(raw['program-id']),
    storeType: normalizeStoreType(raw['store-type']),
    sqlitePath: normalizeOptionalString(raw['sqlite-path']),
    traceId: normalizeOptionalString(raw['trace-id']),
    idempotencyWindow: readNumber(raw['idempotency-window'], 900),
    taskPda: normalizeOptionalString(raw['task-pda']),
    disputePda: normalizeOptionalString(raw['dispute-pda']),
    fromSlot: raw['from-slot'] === undefined
      ? undefined
      : readNumber(raw['from-slot']),
    toSlot: raw['to-slot'] === undefined
      ? undefined
      : readNumber(raw['to-slot']),
  };
}

function normalizeOutputFormat(value: string | number | boolean | undefined): 'json' | 'jsonl' | 'table' {
  if (typeof value === 'string' && (value === 'json' || value === 'jsonl' || value === 'table')) {
    return value;
  }
  return 'json';
}

function normalizeStoreType(value: string | number | boolean | undefined): 'memory' | 'sqlite' {
  if (value === 'sqlite' || value === 'memory') {
    return value;
  }
  return 'sqlite';
}

function normalizeOptionalString(value: string | number | boolean | undefined): string | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return undefined;
}

function createCliError(message: string, code: string): CliParseError {
  const error = new Error(message) as CliParseError;
  error.code = code;
  return error;
}

function runHelp(context: CliRuntimeContext): number {
  context.output({
    status: 'ok',
    usage: buildHelp(),
  });
  return 0;
}

function buildOutput(
  format: 'json' | 'jsonl' | 'table',
  value: unknown,
): string {
  if (format === 'jsonl') {
    if (Array.isArray(value)) {
      return value.map((entry) => JSON.stringify(entry)).join('\n');
    }
    return JSON.stringify(value);
  }

  if (format === 'table') {
    return inspect(value, { colors: false, depth: 5, compact: false, sorted: true });
  }

  return JSON.stringify(value, null, 2);
}

export async function runCli(options: CliRunOptions = {}): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  const output = (value: unknown) => stdout.write(`${String(value)}\n`);
  const errorOutput = (value: unknown) => stderr.write(`${String(value)}\n`);

  const context: CliRuntimeContext = {
    output: (value) => output(buildOutput('json', value)),
    error: (value) => errorOutput(buildOutput('json', value)),
  };

  const global = parseArgv(argv);
  const outputFormat = normalizeOutputFormat(global.output);
  const showHelp = global.help === true || global.h === true;
  context.output = (value) => output(buildOutput(outputFormat, value));

  if (showHelp || argv.length === 0) {
    return runHelp(context);
  }

  if (argv[0] !== 'replay') {
    context.error('unknown command');
    stderr.write(buildHelp());
    return 2;
  }

  const parsed = parseReplayCommand(argv.slice(1));
  if (!parsed.command) {
    context.error('unknown replay command');
    stderr.write(buildHelp());
    return 2;
  }

  const command = KNOWN_COMMANDS[parsed.command];
  if (global.help === true) {
    context.output(buildHelp());
    return 0;
  }

  try {
    return await command.run(context, {
      ...global,
      ...parsed.options,
      output: outputFormat,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    context.error({ code: 'CLI_ERROR', message });
    return 1;
  }
}
