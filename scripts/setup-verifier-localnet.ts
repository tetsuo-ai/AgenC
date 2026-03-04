/**
 * Initialize the Verifier Router and register the Groth16 verifier on localnet.
 *
 * This script is meant to run AFTER `setup-verifier-localnet.sh` has started
 * a solana-test-validator with the router and verifier programs pre-loaded.
 *
 * It calls:
 *   1. router.initialize() — creates the router PDA account
 *   2. router.add_verifier(selector) — registers the groth16 verifier
 *
 * Usage:
 *   npx tsx scripts/setup-verifier-localnet.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, Idl } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const ROUTER_PROGRAM_ID = new PublicKey("6JvFfBrvCcWgANKh1Eae9xDq4RC6cfJuBcf71rp2k9Y7");
const VERIFIER_PROGRAM_ID = new PublicKey("THq1qFYQoh7zgcjXoMXduDBqiZRCPeg3PvvMbrVQUge");
const GROTH16_SELECTOR: number[] = [0x52, 0x5a, 0x56, 0x4d]; // "RZVM"
const VERIFIER_ENTRY_DISCRIMINATOR = Buffer.from([
  102, 247, 148, 158, 33, 153, 100, 93,
]);
const VERIFIER_ENTRY_ACCOUNT_LEN = 8 + 4 + 32 + 1;

const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

function isExpectedVerifierEntryData(data: Buffer): boolean {
  if (data.length !== VERIFIER_ENTRY_ACCOUNT_LEN) {
    return false;
  }
  const discriminator = data.subarray(0, 8);
  if (!discriminator.equals(VERIFIER_ENTRY_DISCRIMINATOR)) {
    return false;
  }
  const selector = data.subarray(8, 12);
  if (!selector.equals(Buffer.from(GROTH16_SELECTOR))) {
    return false;
  }
  const verifierProgram = new PublicKey(data.subarray(12, 44));
  if (!verifierProgram.equals(VERIFIER_PROGRAM_ID)) {
    return false;
  }
  return data[44] === 0;
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // Load router IDL
  const idlPath = path.resolve(__dirname, "idl", "verifier_router.json");
  const idlJson = JSON.parse(fs.readFileSync(idlPath, "utf8")) as Idl;

  const routerProgram = new Program(idlJson, provider);

  // Derive router PDA
  const [routerPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("router")],
    ROUTER_PROGRAM_ID,
  );
  console.log("Router PDA:", routerPda.toBase58());

  // Derive verifier entry PDA
  const [verifierEntryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("verifier"), Buffer.from(GROTH16_SELECTOR)],
    ROUTER_PROGRAM_ID,
  );
  console.log("Verifier Entry PDA:", verifierEntryPda.toBase58());

  // Derive verifier program data account (BPF loader upgradeable)
  const [verifierProgramData] = PublicKey.findProgramAddressSync(
    [VERIFIER_PROGRAM_ID.toBuffer()],
    BPF_LOADER_UPGRADEABLE,
  );
  console.log("Verifier Program Data:", verifierProgramData.toBase58());

  // If prerequisites are already provisioned (real or mock mode), avoid
  // re-running router initialization on every test invocation.
  const [routerProgramInfo, verifierProgramInfo, routerPdaInfo, verifierEntryInfo] =
    await Promise.all([
      provider.connection.getAccountInfo(ROUTER_PROGRAM_ID),
      provider.connection.getAccountInfo(VERIFIER_PROGRAM_ID),
      provider.connection.getAccountInfo(routerPda),
      provider.connection.getAccountInfo(verifierEntryPda),
    ]);

  const routerProgramReady = Boolean(routerProgramInfo?.executable);
  const verifierProgramReady = Boolean(verifierProgramInfo?.executable);
  const routerPdaReady = Boolean(routerPdaInfo && routerPdaInfo.owner.equals(ROUTER_PROGRAM_ID));
  const verifierEntryReady = Boolean(
    verifierEntryInfo &&
      verifierEntryInfo.owner.equals(ROUTER_PROGRAM_ID) &&
      isExpectedVerifierEntryData(verifierEntryInfo.data),
  );

  if (routerProgramReady && verifierProgramReady && routerPdaReady && verifierEntryReady) {
    console.log("Verifier prerequisites already provisioned; skipping router bootstrap.");
    return;
  }

  // 1. Initialize the router
  console.log("\n--- Step 1: Initialize Router ---");
  try {
    const tx = await routerProgram.methods
      .initialize()
      .accountsPartial({
        router: routerPda,
        authority: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("Router initialized:", tx);
  } catch (e: unknown) {
    const msg = String(e);
    if (msg.includes("already in use")) {
      console.log("Router already initialized (skipping).");
    } else {
      throw e;
    }
  }

  // 2. Add the groth16 verifier
  console.log("\n--- Step 2: Add Groth16 Verifier ---");
  try {
    const tx = await routerProgram.methods
      .addVerifier(GROTH16_SELECTOR)
      .accountsPartial({
        router: routerPda,
        verifierEntry: verifierEntryPda,
        verifierProgramData,
        verifierProgram: VERIFIER_PROGRAM_ID,
        authority: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("Verifier added:", tx);
  } catch (e: unknown) {
    const msg = String(e);
    if (msg.includes("already in use")) {
      console.log("Verifier entry already exists (skipping).");
    } else {
      throw e;
    }
  }

  // Verify the setup
  console.log("\n--- Verification ---");
  const routerAccount = await routerProgram.account.verifierRouter.fetch(routerPda);
  console.log("Router owner:", (routerAccount as { ownership: { owner: PublicKey } }).ownership.owner?.toBase58());

  const verifierEntry = await routerProgram.account.verifierEntry.fetch(verifierEntryPda);
  const entry = verifierEntry as { selector: number[]; verifier: PublicKey; estopped: boolean };
  console.log("Verifier entry:", {
    selector: Buffer.from(entry.selector).toString("hex"),
    verifier: entry.verifier.toBase58(),
    estopped: entry.estopped,
  });

  console.log("\nVerifier localnet setup complete.");
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
