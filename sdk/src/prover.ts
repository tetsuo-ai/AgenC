/**
 * Real remote prover backend for AgenC SDK.
 *
 * Proof generation is intentionally remote-only. The repository no longer
 * ships or invokes a local RISC Zero prover binary.
 */

import {
  RISC0_SEAL_BYTES_LEN,
  RISC0_JOURNAL_LEN,
  RISC0_IMAGE_ID_LEN,
  HASH_SIZE,
  OUTPUT_FIELD_COUNT,
} from "./constants.js";
import { validateProverEndpoint } from "./validation.js";

export interface RemoteProverConfig {
  kind: "remote";
  /** HTTP(S) URL of the prover service. */
  endpoint: string;
  /** Timeout in milliseconds (default 300 000 = 5 min). */
  timeoutMs?: number;
  /** Optional headers (e.g. auth tokens). */
  headers?: Record<string, string>;
}

export type ProverConfig = RemoteProverConfig;

export interface ProverInput {
  taskPda: Uint8Array;
  agentAuthority: Uint8Array;
  constraintHash: Uint8Array;
  outputCommitment: Uint8Array;
  binding: Uint8Array;
  nullifier: Uint8Array;
  output: Uint8Array[];
  salt: Uint8Array;
  agentSecret: Uint8Array;
}

export class ProverError extends Error {
  override name = "ProverError" as const;
  constructor(
    message: string,
    public readonly backend: "remote",
    public readonly cause?: unknown,
  ) {
    super(message);
  }
}

const DEFAULT_TIMEOUT_MS = 300_000;
const FIELD_BYTE_LEN = HASH_SIZE;

function validateInputField(name: string, field: Uint8Array): void {
  if (field.length !== FIELD_BYTE_LEN) {
    throw new Error(
      `${name} must be exactly ${FIELD_BYTE_LEN} bytes, got ${field.length}`,
    );
  }
}

function validateOutputFields(output: Uint8Array[]): void {
  if (output.length !== OUTPUT_FIELD_COUNT) {
    throw new Error(
      `output must contain exactly ${OUTPUT_FIELD_COUNT} field elements, got ${output.length}`,
    );
  }

  output.forEach((field, index) => {
    validateInputField(`output[${index}]`, field);
  });
}

function validateProverInput(input: ProverInput): void {
  validateInputField("taskPda", input.taskPda);
  validateInputField("agentAuthority", input.agentAuthority);
  validateInputField("constraintHash", input.constraintHash);
  validateInputField("outputCommitment", input.outputCommitment);
  validateInputField("binding", input.binding);
  validateInputField("nullifier", input.nullifier);
  validateOutputFields(input.output);
  validateInputField("salt", input.salt);
  validateInputField("agentSecret", input.agentSecret);
}

interface RawProverOutput {
  seal_bytes?: unknown;
  journal?: unknown;
  image_id?: unknown;
}

function validateProverOutput(
  raw: RawProverOutput,
): { sealBytes: Buffer; journal: Buffer; imageId: Buffer } {
  if (!Array.isArray(raw.seal_bytes)) {
    throw new ProverError("prover output missing seal_bytes array", "remote");
  }
  if (!Array.isArray(raw.journal)) {
    throw new ProverError("prover output missing journal array", "remote");
  }
  if (!Array.isArray(raw.image_id)) {
    throw new ProverError("prover output missing image_id array", "remote");
  }

  const sealBytes = Buffer.from(raw.seal_bytes as number[]);
  const journal = Buffer.from(raw.journal as number[]);
  const imageId = Buffer.from(raw.image_id as number[]);

  if (sealBytes.length !== RISC0_SEAL_BYTES_LEN) {
    throw new ProverError(
      `seal_bytes must be ${RISC0_SEAL_BYTES_LEN} bytes, got ${sealBytes.length}`,
      "remote",
    );
  }
  if (journal.length !== RISC0_JOURNAL_LEN) {
    throw new ProverError(
      `journal must be ${RISC0_JOURNAL_LEN} bytes, got ${journal.length}`,
      "remote",
    );
  }
  if (imageId.length !== RISC0_IMAGE_ID_LEN) {
    throw new ProverError(
      `image_id must be ${RISC0_IMAGE_ID_LEN} bytes, got ${imageId.length}`,
      "remote",
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
    output: input.output.map((field) => Array.from(field)),
    salt: Array.from(input.salt),
    agent_secret: Array.from(input.agentSecret),
  });
}

async function proveRemote(
  input: ProverInput,
  config: RemoteProverConfig,
): Promise<{ sealBytes: Buffer; journal: Buffer; imageId: Buffer }> {
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
    return validateProverOutput(parsed);
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

export async function prove(
  input: ProverInput,
  config: ProverConfig,
): Promise<{ sealBytes: Buffer; journal: Buffer; imageId: Buffer }> {
  validateProverInput(input);
  return proveRemote(input, config);
}
