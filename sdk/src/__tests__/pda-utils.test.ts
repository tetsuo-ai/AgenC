import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, SEEDS } from "../constants";
import { deriveAgentPdaFromId, toFixedBytes } from "../utils/pda";

describe("pda utils", () => {
  it("toFixedBytes validates expected length", () => {
    const bytes = toFixedBytes(new Uint8Array(32).fill(1), 32, "agentId");
    expect(bytes).toHaveLength(32);
    expect(() => toFixedBytes(new Uint8Array(31), 32, "agentId")).toThrow(
      /Invalid agentId length/,
    );
  });

  it("deriveAgentPdaFromId matches manual PDA derivation", () => {
    const agentId = new Uint8Array(32).fill(9);
    const derived = deriveAgentPdaFromId(agentId, PROGRAM_ID);
    const [expected] = PublicKey.findProgramAddressSync(
      [SEEDS.AGENT, agentId],
      PROGRAM_ID,
    );
    expect(derived.equals(expected)).toBe(true);
  });
});
