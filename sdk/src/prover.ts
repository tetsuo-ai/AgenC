/**
 * Real RISC Zero prover backends for AgenC SDK.
 *
 * Two backends are supported:
 * - `local-binary`: spawns the agenc-zkvm-host binary as a subprocess
 * - `remote`: HTTP POST to a prover endpoint
 *
 * The `prove()` function is an internal implementation detail — only types
 * and `ProverError` are re-exported from the SDK barrel.
 */

import { isAbsolute, basename } from "node:path";
import {
  RISC0_SEAL_BORSH_LEN,
  RISC0_JOURNAL_LEN,
  RISC0_IMAGE_ID_LEN,
  HASH_SIZE,
} from "./constants.js";
import { validateProverEndpoint } from "./validation.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LocalBinaryProverConfig {
  kind: "local-binary";
  /** Absolute path to the agenc-zkvm-host binary. */
  binaryPath: string;
  /** Timeout in milliseconds (default 300 000 = 5 min). */
  timeoutMs?: number;
}

export interface RemoteProverConfig {
  kind: "remote";
  /** HTTP(S) URL of the prover service. */
  endpoint: string;
  /** Timeout in milliseconds (default 300 000 = 5 min). */
  timeoutMs?: number;
  /** Optional headers (e.g. auth tokens). */
  headers?: Record<string, string>;
}

export type ProverConfig = LocalBinaryProverConfig | RemoteProverConfig;

export interface ProverInput {
  taskPda: Uint8Array;
  agentAuthority: Uint8Array;
  constraintHash: Uint8Array;
  outputCommitment: Uint8Array;
  binding: Uint8Array;
  nullifier: Uint8Array;
  modelCommitment: Uint8Array;
  inputCommitment: Uint8Array;
}

export class ProverError extends Error {
  override name = "ProverError" as const;
  constructor(
    message: string,
    public readonly backend: "local-binary" | "remote",
    public readonly cause?: unknown,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 300_000;
const FIELD_BYTE_LEN = HASH_SIZE; // 32

// ---------------------------------------------------------------------------
// Input / output helpers
// ---------------------------------------------------------------------------

function validateInputField(name: string, field: Uint8Array): void {
  if (field.length !== FIELD_BYTE_LEN) {
    throw new Error(
      `${name} must be exactly ${FIELD_BYTE_LEN} bytes, got ${field.length}`,
    );
  }
}

function validateProverInput(input: ProverInput): void {
  validateInputField("taskPda", input.taskPda);
  validateInputField("agentAuthority", input.agentAuthority);
  validateInputField("constraintHash", input.constraintHash);
  validateInputField("outputCommitment", input.outputCommitment);
  validateInputField("binding", input.binding);
  validateInputField("nullifier", input.nullifier);
  validateInputField("modelCommitment", input.modelCommitment);
  validateInputField("inputCommitment", input.inputCommitment);
}

interface RawProverOutput {
  seal_bytes?: unknown;
  journal?: unknown;
  image_id?: unknown;
}

function validateProverOutput(
  raw: RawProverOutput,
  backend: "local-binary" | "remote",
): { sealBytes: Buffer; journal: Buffer; imageId: Buffer } {
  if (!Array.isArray(raw.seal_bytes)) {
    throw new ProverError("prover output missing seal_bytes array", backend);
  }
  if (!Array.isArray(raw.journal)) {
    throw new ProverError("prover output missing journal array", backend);
  }
  if (!Array.isArray(raw.image_id)) {
    throw new ProverError("prover output missing image_id array", backend);
  }

  const sealBytes = Buffer.from(raw.seal_bytes as number[]);
  const journal = Buffer.from(raw.journal as number[]);
  const imageId = Buffer.from(raw.image_id as number[]);

  if (sealBytes.length !== RISC0_SEAL_BORSH_LEN) {
    throw new ProverError(
      `seal_bytes must be ${RISC0_SEAL_BORSH_LEN} bytes, got ${sealBytes.length}`,
      backend,
    );
  }
  if (journal.length !== RISC0_JOURNAL_LEN) {
    throw new ProverError(
      `journal must be ${RISC0_JOURNAL_LEN} bytes, got ${journal.length}`,
      backend,
    );
  }
  if (imageId.length !== RISC0_IMAGE_ID_LEN) {
    throw new ProverError(
      `image_id must be ${RISC0_IMAGE_ID_LEN} bytes, got ${imageId.length}`,
      backend,
    );
  }

  return { sealBytes, journal, imageId };
}

function buildInputJson(input: ProverInput): string {
  return JSON.stringify({
    task_pda: Array.from(input.taskPda),
    agent_authority: Array.from(input.agentAuthority),
    constraint_hash: Array.from(input.constraintHash),
    output_commitment: Array.from(input.outputCommitment),
    binding: Array.from(input.binding),
    nullifier: Array.from(input.nullifier),
    model_commitment: Array.from(input.modelCommitment),
    input_commitment: Array.from(input.inputCommitment),
  });
}

// ---------------------------------------------------------------------------
// Local binary backend
// ---------------------------------------------------------------------------

async function proveLocal(
  input: ProverInput,
  config: LocalBinaryProverConfig,
): Promise<{ sealBytes: Buffer; journal: Buffer; imageId: Buffer }> {
  const { spawn } = await import("node:child_process");

  // Security: Validate binary path to prevent arbitrary code execution.
  // Must be an absolute path to an existing, executable file named agenc-zkvm-host.
  if (!isAbsolute(config.binaryPath)) {
    throw new ProverError(
      "binaryPath must be an absolute path",
      "local-binary",
    );
  }
  if (config.binaryPath.includes("..")) {
    throw new ProverError(
      "binaryPath must not contain '..' segments",
      "local-binary",
    );
  }
  const binaryName = basename(config.binaryPath);
  if (!binaryName.startsWith("agenc-zkvm-host")) {
    throw new ProverError(
      `binaryPath must point to an agenc-zkvm-host binary, got '${binaryName}'`,
      "local-binary",
    );
  }

  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const inputJson = buildInputJson(input);

  return new Promise((resolve, reject) => {
    const child = spawn(config.binaryPath, ["prove", "--stdin"], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutMs,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err: Error) => {
      reject(
        new ProverError(
          `failed to spawn prover binary: ${err.message}`,
          "local-binary",
          err,
        ),
      );
    });

    child.on("close", (code: number | null) => {
      if (code !== 0) {
        reject(
          new ProverError(
            `prover exited with code ${code}: ${stderr.trim() || "(no stderr)"}`,
            "local-binary",
          ),
        );
        return;
      }

      try {
        const parsed = JSON.parse(stdout) as RawProverOutput;
        resolve(validateProverOutput(parsed, "local-binary"));
      } catch (err) {
        if (err instanceof ProverError) {
          reject(err);
        } else {
          reject(
            new ProverError(
              `failed to parse prover output: ${(err as Error).message}`,
              "local-binary",
              err,
            ),
          );
        }
      }
    });

    child.stdin.write(inputJson);
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Remote backend
// ---------------------------------------------------------------------------

async function proveRemote(
  input: ProverInput,
  config: RemoteProverConfig,
): Promise<{ sealBytes: Buffer; journal: Buffer; imageId: Buffer }> {
  // Security: Validate the remote endpoint before sending sensitive proof material.
  // Rejects non-HTTP protocols, embedded credentials, and dangerous characters.
  validateProverEndpoint(config.endpoint);

  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const url = config.endpoint.endsWith("/prove")
    ? config.endpoint
    : `${config.endpoint.replace(/\/+$/, "")}/prove`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...config.headers,
      },
      body: buildInputJson(input),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable body)");
      throw new ProverError(
        `prover returned HTTP ${response.status}: ${body}`,
        "remote",
      );
    }

    const parsed = (await response.json()) as RawProverOutput;
    return validateProverOutput(parsed, "remote");
  } catch (err) {
    if (err instanceof ProverError) throw err;
    if ((err as Error).name === "AbortError") {
      throw new ProverError(
        `prover request timed out after ${timeoutMs}ms`,
        "remote",
        err,
      );
    }
    throw new ProverError(
      `prover request failed: ${(err as Error).message}`,
      "remote",
      err,
    );
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function prove(
  input: ProverInput,
  config: ProverConfig,
): Promise<{ sealBytes: Buffer; journal: Buffer; imageId: Buffer }> {
  validateProverInput(input);

  switch (config.kind) {
    case "local-binary":
      return proveLocal(input, config);
    case "remote":
      return proveRemote(input, config);
    default:
      throw new Error(
        `unknown prover backend: ${(config as { kind: string }).kind}`,
      );
  }
}
