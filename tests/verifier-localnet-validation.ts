import { expect } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  BPF_LOADER_UPGRADEABLE,
  GROTH16_SELECTOR,
  VERIFIER_ENTRY_DISCRIMINATOR,
  VERIFIER_PROGRAM_ID,
  hasExpectedProgramDataAuthority,
  isExpectedVerifierEntryData,
  parseProgramDataAccount,
} from "../scripts/verifier-localnet";

function buildProgramDataAccount(authority: PublicKey | null): Buffer {
  const data = Buffer.alloc(authority ? 45 : 13);
  data.writeUInt32LE(3, 0);
  data.writeBigUInt64LE(0n, 4);
  data[12] = authority ? 1 : 0;
  if (authority) {
    authority.toBuffer().copy(data, 13);
  }
  return data;
}

function buildVerifierEntryData(overrides?: {
  selector?: Buffer;
  verifierProgram?: PublicKey;
  estopped?: number;
}): Buffer {
  const selector = overrides?.selector ?? GROTH16_SELECTOR;
  const verifierProgram = overrides?.verifierProgram ?? VERIFIER_PROGRAM_ID;
  const estopped = overrides?.estopped ?? 0;
  return Buffer.concat([
    VERIFIER_ENTRY_DISCRIMINATOR,
    selector,
    verifierProgram.toBuffer(),
    Buffer.from([estopped]),
  ]);
}

describe("verifier localnet helpers", () => {
  it("parses upgradeable ProgramData accounts with an authority", () => {
    const authority = Keypair.generate().publicKey;
    const parsed = parseProgramDataAccount(buildProgramDataAccount(authority));

    expect(parsed).to.not.equal(null);
    expect(parsed?.slot).to.equal(0n);
    expect(parsed?.upgradeAuthority?.equals(authority)).to.equal(true);
  });

  it("rejects ProgramData accounts with the wrong owner or authority", () => {
    const expectedAuthority = Keypair.generate().publicKey;
    const wrongAuthority = Keypair.generate().publicKey;
    const wrongOwner = Keypair.generate().publicKey;

    expect(
      hasExpectedProgramDataAuthority(
        {
          owner: BPF_LOADER_UPGRADEABLE,
          data: buildProgramDataAccount(wrongAuthority),
        },
        expectedAuthority,
      ),
    ).to.equal(false);

    expect(
      hasExpectedProgramDataAuthority(
        {
          owner: wrongOwner,
          data: buildProgramDataAccount(expectedAuthority),
        },
        expectedAuthority,
      ),
    ).to.equal(false);
  });

  it("accepts only the expected verifier entry layout", () => {
    expect(isExpectedVerifierEntryData(buildVerifierEntryData())).to.equal(true);

    expect(
      isExpectedVerifierEntryData(
        buildVerifierEntryData({
          selector: Buffer.from([0, 0, 0, 0]),
        }),
      ),
    ).to.equal(false);

    expect(
      isExpectedVerifierEntryData(
        buildVerifierEntryData({
          verifierProgram: Keypair.generate().publicKey,
        }),
      ),
    ).to.equal(false);

    expect(
      isExpectedVerifierEntryData(
        buildVerifierEntryData({
          estopped: 1,
        }),
      ),
    ).to.equal(false);
  });
});
