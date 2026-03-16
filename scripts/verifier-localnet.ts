import { PublicKey } from "@solana/web3.js";

export const ROUTER_PROGRAM_ID = new PublicKey(
  "E9ZiqfCdr6gGeB2UhBbkWnFP9vGnRYQwqnDsS1LM3NJZ",
);
export const VERIFIER_PROGRAM_ID = new PublicKey(
  "3ZrAHZKjk24AKgXFekpYeG7v3Rz7NucLXTB3zxGGTjsc",
);
export const GROTH16_SELECTOR = Buffer.from([0x52, 0x5a, 0x56, 0x4d]);
export const BPF_LOADER_UPGRADEABLE = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);
export const VERIFIER_ENTRY_DISCRIMINATOR = Buffer.from([
  102, 247, 148, 158, 33, 153, 100, 93,
]);
export const VERIFIER_ENTRY_ACCOUNT_LEN = 8 + 4 + 32 + 1;
const PROGRAM_DATA_ACCOUNT_TYPE = 3;
const PROGRAM_DATA_MIN_LEN = 4 + 8 + 1;
const PROGRAM_DATA_WITH_AUTHORITY_LEN = 4 + 8 + 1 + 32;

type AccountLike = {
  data: Buffer | Uint8Array;
  owner: PublicKey;
};

export function deriveRouterPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("router")],
    ROUTER_PROGRAM_ID,
  )[0];
}

export function deriveVerifierEntryPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("verifier"), GROTH16_SELECTOR],
    ROUTER_PROGRAM_ID,
  )[0];
}

export function deriveVerifierProgramDataPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [VERIFIER_PROGRAM_ID.toBuffer()],
    BPF_LOADER_UPGRADEABLE,
  )[0];
}

export function isExpectedVerifierEntryData(data: Buffer | Uint8Array): boolean {
  const bytes = Buffer.from(data);
  if (bytes.length !== VERIFIER_ENTRY_ACCOUNT_LEN) {
    return false;
  }

  const discriminator = bytes.subarray(0, 8);
  if (!discriminator.equals(VERIFIER_ENTRY_DISCRIMINATOR)) {
    return false;
  }

  const selector = bytes.subarray(8, 12);
  if (!selector.equals(GROTH16_SELECTOR)) {
    return false;
  }

  const verifierProgram = new PublicKey(bytes.subarray(12, 44));
  if (!verifierProgram.equals(VERIFIER_PROGRAM_ID)) {
    return false;
  }

  return bytes[44] === 0;
}

export function parseProgramDataAccount(
  data: Buffer | Uint8Array,
): { slot: bigint; upgradeAuthority: PublicKey | null } | null {
  const bytes = Buffer.from(data);
  if (bytes.length < PROGRAM_DATA_MIN_LEN) {
    return null;
  }

  if (bytes.readUInt32LE(0) !== PROGRAM_DATA_ACCOUNT_TYPE) {
    return null;
  }

  const slot = bytes.readBigUInt64LE(4);
  const upgradeAuthorityTag = bytes[12];
  if (upgradeAuthorityTag === 0) {
    return { slot, upgradeAuthority: null };
  }

  if (upgradeAuthorityTag !== 1 || bytes.length < PROGRAM_DATA_WITH_AUTHORITY_LEN) {
    return null;
  }

  return {
    slot,
    upgradeAuthority: new PublicKey(bytes.subarray(13, 45)),
  };
}

export function hasExpectedProgramDataAuthority(
  account: AccountLike | null,
  expectedAuthority: PublicKey,
): boolean {
  if (!account?.owner.equals(BPF_LOADER_UPGRADEABLE)) {
    return false;
  }

  const parsed = parseProgramDataAccount(account.data);
  return Boolean(parsed?.upgradeAuthority?.equals(expectedAuthority));
}
