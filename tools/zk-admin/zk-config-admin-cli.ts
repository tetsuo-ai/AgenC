import os from "node:os";
import path from "node:path";
import process from "node:process";
import { PROGRAM_ID } from "@tetsuo-ai/sdk";

export type Command = "show" | "init" | "rotate";

export type CliOptions = {
  command: Command;
  rpcUrl: string;
  programId: string;
  authorityKeypairPath: string;
  imageId?: Uint8Array;
};

export const DEFAULT_RPC_URL =
  process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899";
export const DEFAULT_AUTHORITY_KEYPAIR =
  process.env.ANCHOR_WALLET ??
  path.join(os.homedir(), ".config", "solana", "id.json");

export function renderZkConfigUsage(): string {
  return `Usage:
  npm run zk:config --workspace=@tetsuo-ai/zk-admin-tools -- <show|init|rotate> [options]

Commands:
  show                      Print protocol/zk_config state
  init                      Create zk_config with the provided image ID
  rotate                    Update zk_config.active_image_id

Options:
  --rpc-url <url>           RPC URL (default: ${DEFAULT_RPC_URL})
  --program-id <pubkey>     Program ID (default: ${PROGRAM_ID.toBase58()})
  --authority-keypair <p>   Protocol authority keypair JSON
                            (default: ${DEFAULT_AUTHORITY_KEYPAIR})
  --image-id <value>        Required for init/rotate. Accepted formats:
                            - comma-separated bytes: "1, 2, 3, ..."
                            - JSON array: "[1,2,3,...]"
                            - hex string: "0x0102..."
  --help                    Show this help

Examples:
  npm run zk:config --workspace=@tetsuo-ai/zk-admin-tools -- show
  npm run zk:config --workspace=@tetsuo-ai/zk-admin-tools -- init --image-id "234, 105, ..."
  npm run zk:config --workspace=@tetsuo-ai/zk-admin-tools -- rotate --image-id "0xa3a2eb3cdea028b8b65f873527ef2a5834ab15820fdb8f11d81ab94d5e224414"
`;
}

function expandHome(filePath: string): string {
  if (filePath === "~") {
    return os.homedir();
  }
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

function parseByte(value: unknown): number {
  const byte =
    typeof value === "number"
      ? value
      : Number.parseInt(String(value).trim(), 10);
  if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
    throw new Error(`invalid image ID byte: ${String(value)}`);
  }
  return byte;
}

export function parseImageId(input: string): Uint8Array {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("image ID cannot be empty");
  }

  let values: number[];

  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new Error("JSON image ID must be an array");
    }
    values = parsed.map((value) => parseByte(value));
  } else if (/^(?:0x)?[0-9a-fA-F]{64}$/.test(trimmed)) {
    const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
    values = Array.from(Buffer.from(hex, "hex"));
  } else {
    values = trimmed
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => parseByte(part));
  }

  if (values.length !== 32) {
    throw new Error(`image ID must contain exactly 32 bytes, got ${values.length}`);
  }

  return Uint8Array.from(values);
}

export function parseZkConfigArgs(argv: string[]): CliOptions {
  if (argv.length === 0 || argv.includes("--help")) {
    process.stdout.write(renderZkConfigUsage());
    process.exit(0);
  }

  const [commandArg, ...rest] = argv;
  if (commandArg !== "show" && commandArg !== "init" && commandArg !== "rotate") {
    throw new Error(
      `Unknown command "${commandArg}". Expected show, init, or rotate.`,
    );
  }

  const options: CliOptions = {
    command: commandArg,
    rpcUrl: DEFAULT_RPC_URL,
    programId: PROGRAM_ID.toBase58(),
    authorityKeypairPath: path.resolve(expandHome(DEFAULT_AUTHORITY_KEYPAIR)),
  };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--rpc-url" && rest[index + 1]) {
      options.rpcUrl = rest[++index]!;
      continue;
    }
    if (arg === "--program-id" && rest[index + 1]) {
      options.programId = rest[++index]!;
      continue;
    }
    if (arg === "--authority-keypair" && rest[index + 1]) {
      options.authorityKeypairPath = path.resolve(expandHome(rest[++index]!));
      continue;
    }
    if (arg === "--image-id" && rest[index + 1]) {
      options.imageId = parseImageId(rest[++index]!);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if ((options.command === "init" || options.command === "rotate") && !options.imageId) {
    throw new Error(`${options.command} requires --image-id`);
  }

  return options;
}
