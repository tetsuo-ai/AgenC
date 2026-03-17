import path from "node:path";

const DEFAULT_REWARD_LAMPORTS = 0.3 * 1_000_000_000;
const DEFAULT_ACCOUNT_FUNDING_LAMPORTS = 2 * 1_000_000_000;
const DEFAULT_OUTPUT = [11n, 22n, 33n, 44n];
const DEFAULT_OUTPUT_PATH = path.resolve(
  process.cwd(),
  "benchmarks/private-proof-e2e/latest.json",
);
const DEFAULT_MARKDOWN_PATH = path.resolve(
  process.cwd(),
  "benchmarks/private-proof-e2e/latest.md",
);
const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export interface CliOptions {
  rounds: number;
  outputPath: string;
  markdownPath: string;
  proverEndpoint: string;
  proverTimeoutMs?: number;
  proverHeaders: Record<string, string>;
  creatorKeypairPath?: string;
  workerKeypairPath?: string;
  stakeLamports?: number;
  rewardLamports: number;
  fundingLamports: number;
  output: bigint[];
  agentSecret: bigint;
  logLevel: "debug" | "info" | "warn" | "error";
}

interface ParsedCliValue {
  nextIndex: number;
  value: string;
}

const BENCHMARK_HELP_TEXT = [
  "Usage: benchmark-private-e2e [options]",
  "",
  "Required:",
  "  --prover-endpoint <url>        Remote prover endpoint (or set AGENC_PROVER_ENDPOINT)",
  "",
  "Options:",
  "  --rounds <int>                 Number of end-to-end rounds (default: 1)",
  "  --output <path>                JSON artifact path",
  "  --markdown-output <path>       Markdown summary path",
  "  --prover-timeout-ms <int>      Remote prover timeout",
  "  --header name=value            Repeatable remote prover header",
  "  --creator-keypair <path>       Reuse an existing creator wallet instead of funding a new one",
  "  --worker-keypair <path>        Reuse an existing worker wallet instead of funding a new one",
  "  --stake-lamports <int>         Optional agent stake override for low-budget smoke runs",
  "  --reward-lamports <int>        Reward escrowed into the task",
  "  --funding-lamports <int>       Funding per creator/worker account",
  "  --output-values a,b,c,d        Private task expected output values",
  "  --agent-secret <bigint>        Secret witness used for proof generation",
  "  --log-level <level>            debug | info | warn | error",
  "",
  "Environment:",
  "  ANCHOR_PROVIDER_URL            RPC URL (default anchor env)",
  "  ANCHOR_WALLET                  Wallet path (default anchor env)",
  "  AGENC_PROVER_ENDPOINT          Remote prover endpoint",
  "  AGENC_PROVER_API_KEY           Adds x-api-key header automatically",
  '  AGENC_PROVER_HEADERS_JSON      JSON object of additional headers, e.g. {"authorization":"Bearer ..."}',
  "",
  "Verifier prerequisites:",
  "  - a verifier-enabled validator or cluster with the router and verifier programs deployed",
  "  - initialized router PDA and verifier entry state for the trusted Groth16 selector",
].join("\n");

function resolveDefaultProverHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const apiKey = process.env.AGENC_PROVER_API_KEY;
  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }
  const headersJson = process.env.AGENC_PROVER_HEADERS_JSON;
  if (headersJson) {
    const parsed = JSON.parse(headersJson) as Record<string, unknown>;
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value.length > 0) {
        headers[key] = value;
      }
    }
  }
  return headers;
}

function parsePositiveInt(raw: string, flag: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid ${flag} value: ${raw}`);
  }
  return parsed;
}

function parseNonNegativeInt(raw: string, flag: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`invalid ${flag} value: ${raw}`);
  }
  return parsed;
}

function parseOutput(raw: string): bigint[] {
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map(BigInt);
  if (values.length !== 4) {
    throw new Error("private proof benchmark output must contain exactly 4 values");
  }
  return values;
}

function parseLogLevel(raw: string): CliOptions["logLevel"] {
  if (!LOG_LEVELS.includes(raw as CliOptions["logLevel"])) {
    throw new Error(`invalid --log-level value: ${raw}`);
  }
  return raw as CliOptions["logLevel"];
}

function resolveDefaultOptions(): CliOptions {
  return {
    rounds: 1,
    outputPath: DEFAULT_OUTPUT_PATH,
    markdownPath: DEFAULT_MARKDOWN_PATH,
    proverEndpoint: process.env.AGENC_PROVER_ENDPOINT ?? "",
    proverTimeoutMs: process.env.AGENC_PROVER_TIMEOUT_MS
      ? parsePositiveInt(process.env.AGENC_PROVER_TIMEOUT_MS, "AGENC_PROVER_TIMEOUT_MS")
      : undefined,
    proverHeaders: resolveDefaultProverHeaders(),
    creatorKeypairPath: process.env.AGENC_BENCH_CREATOR_KEYPAIR_PATH
      ? path.resolve(process.cwd(), process.env.AGENC_BENCH_CREATOR_KEYPAIR_PATH)
      : undefined,
    workerKeypairPath: process.env.AGENC_BENCH_WORKER_KEYPAIR_PATH
      ? path.resolve(process.cwd(), process.env.AGENC_BENCH_WORKER_KEYPAIR_PATH)
      : undefined,
    stakeLamports: process.env.AGENC_BENCH_STAKE_LAMPORTS
      ? parsePositiveInt(
          process.env.AGENC_BENCH_STAKE_LAMPORTS,
          "AGENC_BENCH_STAKE_LAMPORTS",
        )
      : undefined,
    rewardLamports: parseNonNegativeInt(
      process.env.AGENC_BENCH_REWARD_LAMPORTS ?? String(DEFAULT_REWARD_LAMPORTS),
      "AGENC_BENCH_REWARD_LAMPORTS",
    ),
    fundingLamports: parseNonNegativeInt(
      process.env.AGENC_BENCH_ACCOUNT_FUNDING_LAMPORTS ??
        String(DEFAULT_ACCOUNT_FUNDING_LAMPORTS),
      "AGENC_BENCH_ACCOUNT_FUNDING_LAMPORTS",
    ),
    output: process.env.AGENC_BENCH_OUTPUT
      ? parseOutput(process.env.AGENC_BENCH_OUTPUT)
      : [...DEFAULT_OUTPUT],
    agentSecret: BigInt(process.env.AGENC_BENCH_AGENT_SECRET ?? "42"),
    logLevel: parseLogLevel(process.env.AGENC_BENCH_LOG_LEVEL ?? "info"),
  };
}

function readCliValue(argv: string[], index: number, flag: string): ParsedCliValue {
  const value = argv[index + 1];
  if (value === undefined) {
    throw new Error(`missing ${flag} value`);
  }
  return { nextIndex: index + 1, value };
}

function applyCliOption(options: CliOptions, flag: string, value: string): void {
  switch (flag) {
    case "--rounds":
      options.rounds = parsePositiveInt(value, flag);
      break;
    case "--output":
      options.outputPath = path.resolve(process.cwd(), value);
      break;
    case "--markdown-output":
      options.markdownPath = path.resolve(process.cwd(), value);
      break;
    case "--prover-endpoint":
      options.proverEndpoint = value;
      break;
    case "--prover-timeout-ms":
      options.proverTimeoutMs = parsePositiveInt(value, flag);
      break;
    case "--header": {
      const [key, ...valueParts] = value.split("=");
      const headerValue = valueParts.join("=");
      if (!key || !headerValue) {
        throw new Error(`invalid --header value: ${value}`);
      }
      options.proverHeaders[key] = headerValue;
      break;
    }
    case "--creator-keypair":
      options.creatorKeypairPath = path.resolve(process.cwd(), value);
      break;
    case "--worker-keypair":
      options.workerKeypairPath = path.resolve(process.cwd(), value);
      break;
    case "--stake-lamports":
      options.stakeLamports = parsePositiveInt(value, flag);
      break;
    case "--reward-lamports":
      options.rewardLamports = parseNonNegativeInt(value, flag);
      break;
    case "--funding-lamports":
      options.fundingLamports = parseNonNegativeInt(value, flag);
      break;
    case "--output-values":
      options.output = parseOutput(value);
      break;
    case "--agent-secret":
      options.agentSecret = BigInt(value);
      break;
    case "--log-level":
      options.logLevel = parseLogLevel(value);
      break;
    default:
      throw new Error(`unknown option: ${flag}`);
  }
}

function printHelpAndExit(): never {
  console.log(BENCHMARK_HELP_TEXT);
  process.exit(0);
}

export function parseBenchmarkCliArgs(argv: string[]): CliOptions {
  const options = resolveDefaultOptions();

  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === "--help") {
      printHelpAndExit();
    }

    const parsedValue = readCliValue(argv, index, arg);
    applyCliOption(options, arg, parsedValue.value);
    index = parsedValue.nextIndex + 1;
  }

  if (!options.proverEndpoint) {
    throw new Error(
      "missing remote prover endpoint: pass --prover-endpoint or set AGENC_PROVER_ENDPOINT",
    );
  }

  return options;
}
