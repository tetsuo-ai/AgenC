import os from "node:os";
import path from "node:path";

export const DEFAULT_RPC_URL = "http://127.0.0.1:8899";
export const DEFAULT_PROGRAM_ID = "6UcJzbTEemBz3aY5wK5qKHGMD7bdRsmR4smND29gB2ab";
export const DEFAULT_OPERATOR_KEYPAIR = path.join(
  os.homedir(),
  ".config",
  "solana",
  "id.json",
);
export const DEFAULT_STATE_DIR = path.join(
  os.homedir(),
  ".agenc",
  "localnet-soak",
  "default",
);
export const DEFAULT_BASE_CONFIG = path.join(os.homedir(), ".agenc", "config.json");
export const DEFAULT_GATEWAY_BASE_PORT = 3101;
export const DEFAULT_MESSAGING_BASE_PORT = 4101;

export type CliOptions = {
  rpcUrl: string;
  programId: string;
  operatorKeypairPath: string;
  stateDir: string;
  baseConfigPath: string;
  gatewayBasePort: number;
  messagingBasePort: number;
  summaryPath: string;
};

export function renderBootstrapUsage(): string {
  return `Usage:
  npm run bootstrap --workspace=@tetsuo-ai/localnet-social-tools -- [options]

Options:
  --rpc-url <url>             Localnet RPC URL (default: ${DEFAULT_RPC_URL})
  --program-id <pubkey>       Program ID (default: ${DEFAULT_PROGRAM_ID})
  --operator-keypair <path>   Protocol authority wallet (default: ${DEFAULT_OPERATOR_KEYPAIR})
  --state-dir <path>          Local state directory (default: ${DEFAULT_STATE_DIR})
  --base-config <path>        Base daemon config to clone (default: ${DEFAULT_BASE_CONFIG})
  --gateway-base-port <n>     First daemon websocket port (default: ${DEFAULT_GATEWAY_BASE_PORT})
  --messaging-base-port <n>   First social messaging port (default: ${DEFAULT_MESSAGING_BASE_PORT})
  --summary-path <path>       Output summary path (default: <state-dir>/social/summary.json)
  --help                      Show this help
`;
}

export function parseBootstrapArgs(argv: string[]): CliOptions {
  const defaultSocialDir = path.join(DEFAULT_STATE_DIR, "social");
  const options: CliOptions = {
    rpcUrl: DEFAULT_RPC_URL,
    programId: DEFAULT_PROGRAM_ID,
    operatorKeypairPath: DEFAULT_OPERATOR_KEYPAIR,
    stateDir: DEFAULT_STATE_DIR,
    baseConfigPath: DEFAULT_BASE_CONFIG,
    gatewayBasePort: DEFAULT_GATEWAY_BASE_PORT,
    messagingBasePort: DEFAULT_MESSAGING_BASE_PORT,
    summaryPath: path.join(defaultSocialDir, "summary.json"),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      process.stdout.write(renderBootstrapUsage());
      process.exit(0);
    }
    if (arg === "--rpc-url" && argv[index + 1]) {
      options.rpcUrl = argv[++index]!;
      continue;
    }
    if (arg === "--program-id" && argv[index + 1]) {
      options.programId = argv[++index]!;
      continue;
    }
    if (arg === "--operator-keypair" && argv[index + 1]) {
      options.operatorKeypairPath = path.resolve(argv[++index]!);
      continue;
    }
    if (arg === "--state-dir" && argv[index + 1]) {
      options.stateDir = path.resolve(argv[++index]!);
      continue;
    }
    if (arg === "--base-config" && argv[index + 1]) {
      options.baseConfigPath = path.resolve(argv[++index]!);
      continue;
    }
    if (arg === "--gateway-base-port" && argv[index + 1]) {
      options.gatewayBasePort = Number.parseInt(argv[++index]!, 10);
      continue;
    }
    if (arg === "--messaging-base-port" && argv[index + 1]) {
      options.messagingBasePort = Number.parseInt(argv[++index]!, 10);
      continue;
    }
    if (arg === "--summary-path" && argv[index + 1]) {
      options.summaryPath = path.resolve(argv[++index]!);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isInteger(options.gatewayBasePort) || options.gatewayBasePort < 1) {
    throw new Error("gateway-base-port must be a positive integer");
  }
  if (!Number.isInteger(options.messagingBasePort) || options.messagingBasePort < 1) {
    throw new Error("messaging-base-port must be a positive integer");
  }

  const socialDir = path.join(options.stateDir, "social");
  if (options.summaryPath === path.join(DEFAULT_STATE_DIR, "social", "summary.json")) {
    options.summaryPath = path.join(socialDir, "summary.json");
  }

  return options;
}
