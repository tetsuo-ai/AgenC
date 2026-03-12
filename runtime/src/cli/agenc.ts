import type { Writable } from "node:stream";
import { parseArgv, runCli } from "./index.js";
import {
  runOperatorConsole,
  type OperatorConsoleDeps,
  type OperatorConsoleOptions,
} from "./operator-console.js";
import type { CliStatusCode } from "./types.js";

export interface AgencRunOptions {
  argv?: string[];
  stdout?: Writable;
  stderr?: Writable;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

interface AgencDeps {
  readonly runCli: typeof runCli;
  readonly runOperatorConsole: (
    options?: OperatorConsoleOptions,
    deps?: OperatorConsoleDeps,
  ) => Promise<CliStatusCode>;
}

const DEFAULT_DEPS: AgencDeps = {
  runCli,
  runOperatorConsole,
};

function buildHelp(): string {
  return [
    "agenc [console] [--config <path>] [--pid-path <path>] [--log-level <level>] [--yolo]",
    "agenc <runtime-command> [options]",
    "",
    "Default behavior:",
    "  With no subcommand, AgenC ensures the daemon is running and opens the operator console.",
    "",
    "Console options:",
    "      --config <path>      Config file path (default: ~/.agenc/config.json)",
    "      --pid-path <path>    PID file path override",
    "      --log-level <level>  Daemon startup log level",
    "      --yolo               Unsafe benchmark mode for delegated-agent flows",
    "",
    "Runtime passthrough:",
    "  Any explicit subcommand other than `console` is forwarded to agenc-runtime.",
    "",
    "Examples:",
    "  agenc",
    "  agenc --config ~/.agenc/config.json",
    "  agenc console --yolo",
    "  agenc status",
    "  agenc start --foreground",
    "  agenc-runtime --help",
  ].join("\n");
}

function parseOptionalString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function parseOptionalBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "0") {
      return false;
    }
  }
  return undefined;
}

function buildOperatorConsoleOptions(
  argv: AgencRunOptions["argv"],
  options: AgencRunOptions,
): OperatorConsoleOptions {
  const parsed = parseArgv(argv ?? []);
  return {
    configPath: parseOptionalString(parsed.flags.config),
    pidPath: parseOptionalString(parsed.flags["pid-path"]),
    logLevel: parseOptionalString(parsed.flags["log-level"]),
    yolo: parseOptionalBool(parsed.flags.yolo),
    cwd: options.cwd,
    env: options.env,
  };
}

function writeLine(stream: Writable, value: string): void {
  stream.write(`${value}\n`);
}

export async function runAgencCli(
  options: AgencRunOptions = {},
  deps: AgencDeps = DEFAULT_DEPS,
): Promise<CliStatusCode> {
  const argv = options.argv ?? process.argv.slice(2);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const parsed = parseArgv(argv);
  const command = parsed.positional[0];
  const helpRequested = parsed.flags.help === true || parsed.flags.h === true;

  if (command === undefined || command === "console" || command === "help") {
    if (helpRequested || command === "help") {
      writeLine(stdout, buildHelp());
      return 0;
    }

    if (command === "console" && parsed.positional.length > 1) {
      writeLine(stderr, "agenc console does not accept positional arguments");
      return 2;
    }

    return deps.runOperatorConsole(buildOperatorConsoleOptions(argv, options));
  }

  return deps.runCli({
    argv,
    stdout,
    stderr,
  });
}
