import { PublicKey } from "@solana/web3.js";
import { SEEDS } from "../constants";

export function toFixedBytes(
  value: Uint8Array | number[],
  length: number,
  fieldName: string,
): Uint8Array {
  const bytes = value instanceof Uint8Array ? value : Uint8Array.from(value);
  if (bytes.length !== length) {
    throw new Error(
      `Invalid ${fieldName} length: ${bytes.length}. Expected ${length} bytes.`,
    );
  }
  return bytes;
}

export function deriveAgentPdaFromId(
  agentId: Uint8Array | number[],
  programId: PublicKey,
): PublicKey {
  const idBytes = toFixedBytes(agentId, 32, "agentId");
  const [pda] = PublicKey.findProgramAddressSync(
    [SEEDS.AGENT, idBytes],
    programId,
  );
  return pda;
}
