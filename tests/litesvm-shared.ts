import { PublicKey } from "@solana/web3.js";
import type { LiteSVM } from "litesvm";

export const BPF_LOADER_UPGRADEABLE_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

export interface Bs58Codec {
  encode: (input: Uint8Array | Buffer) => string;
  decode: (input: string) => Uint8Array;
}

export function resolveBs58Codec(moduleValue: unknown): Bs58Codec {
  const candidate = moduleValue as {
    encode?: (input: Uint8Array | Buffer) => string;
    decode?: (input: string) => Uint8Array;
    default?: {
      encode?: (input: Uint8Array | Buffer) => string;
      decode?: (input: string) => Uint8Array;
    };
  };
  if (typeof candidate.encode === "function" && typeof candidate.decode === "function") {
    return candidate as Bs58Codec;
  }
  const fallback = candidate.default;
  if (fallback && typeof fallback.encode === "function" && typeof fallback.decode === "function") {
    return fallback as Bs58Codec;
  }
  throw new Error("Unsupported bs58 module shape");
}

export function setupProgramDataAccount(
  svm: LiteSVM,
  programId: PublicKey,
  authority: PublicKey,
): void {
  const [programDataPda] = PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE_ID,
  );

  const data = new Uint8Array(45);
  const view = new DataView(data.buffer);
  view.setUint32(0, 3, true);
  view.setBigUint64(4, 0n, true);
  data[12] = 1;
  data.set(authority.toBytes(), 13);

  svm.setAccount(programDataPda, {
    lamports: 1_000_000_000,
    data,
    owner: BPF_LOADER_UPGRADEABLE_ID,
    executable: false,
  });
}

export function seedLiteSVMClock(
  svm: LiteSVM,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  slot: bigint = 1000n,
): void {
  const clock = svm.getClock();
  clock.unixTimestamp = BigInt(nowSeconds);
  clock.slot = slot;
  svm.setClock(clock);
}
