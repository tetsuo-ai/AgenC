/**
 * Initialize the Verifier Router and register the Groth16 verifier on localnet.
 *
 * This script is meant to run AFTER `setup-verifier-localnet.sh --mode real` has started
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
import {
  GROTH16_SELECTOR,
  ROUTER_PROGRAM_ID,
  VERIFIER_PROGRAM_ID,
  deriveRouterPda,
  deriveVerifierEntryPda,
  deriveVerifierProgramDataPda,
  hasExpectedProgramDataAuthority,
  isExpectedVerifierEntryData,
} from "./verifier-localnet";

type RouterAccounts = {
  verifierRouter: { fetch(address: PublicKey): Promise<unknown> };
  verifierEntry: { fetch(address: PublicKey): Promise<unknown> };
};

type RouterProgramContext = {
  routerAccounts: RouterAccounts;
  routerProgram: Program<Idl>;
};

type VerifierState = {
  routerPdaInfo: anchor.web3.AccountInfo<Buffer> | null;
  routerPdaReady: boolean;
  verifierEntryInfo: anchor.web3.AccountInfo<Buffer> | null;
  verifierEntryPda: PublicKey;
  verifierEntryReady: boolean;
  verifierProgramData: PublicKey;
  verifierProgramDataReady: boolean;
  routerPda: PublicKey;
};

function loadRouterProgram(provider: anchor.AnchorProvider): RouterProgramContext {
  const idlPath = path.resolve(__dirname, "idl", "verifier_router.json");
  const idlJson = JSON.parse(fs.readFileSync(idlPath, "utf8")) as Idl;
  const routerProgram = new Program(idlJson, provider);
  const routerAccounts = routerProgram.account as unknown as RouterAccounts;
  return { routerAccounts, routerProgram };
}

function deriveVerifierAddresses() {
  const routerPda = deriveRouterPda();
  const verifierEntryPda = deriveVerifierEntryPda();
  const verifierProgramData = deriveVerifierProgramDataPda();
  return { routerPda, verifierEntryPda, verifierProgramData };
}

function logVerifierAddresses(state: {
  routerPda: PublicKey;
  verifierEntryPda: PublicKey;
  verifierProgramData: PublicKey;
}) {
  console.log("Router PDA:", state.routerPda.toBase58());
  console.log("Verifier Entry PDA:", state.verifierEntryPda.toBase58());
  console.log("Verifier Program Data:", state.verifierProgramData.toBase58());
}

async function fetchVerifierState(
  provider: anchor.AnchorProvider,
  addresses: ReturnType<typeof deriveVerifierAddresses>,
): Promise<VerifierState> {
  const [verifierProgramDataInfo, routerPdaInfo, verifierEntryInfo] =
    await Promise.all([
      provider.connection.getAccountInfo(addresses.verifierProgramData),
      provider.connection.getAccountInfo(addresses.routerPda),
      provider.connection.getAccountInfo(addresses.verifierEntryPda),
    ]);

  const verifierProgramDataReady = hasExpectedProgramDataAuthority(
    verifierProgramDataInfo,
    addresses.routerPda,
  );
  const routerPdaReady = Boolean(
    routerPdaInfo?.owner.equals(ROUTER_PROGRAM_ID),
  );
  const verifierEntryReady = Boolean(
    verifierEntryInfo?.owner.equals(ROUTER_PROGRAM_ID) &&
      isExpectedVerifierEntryData(verifierEntryInfo.data),
  );

  return {
    routerPda: addresses.routerPda,
    routerPdaInfo,
    routerPdaReady,
    verifierEntryInfo,
    verifierEntryPda: addresses.verifierEntryPda,
    verifierEntryReady,
    verifierProgramData: addresses.verifierProgramData,
    verifierProgramDataReady,
  };
}

function assertVerifierProgramsReady(
  programs: { routerProgramReady: boolean; verifierProgramReady: boolean },
) {
  if (!programs.routerProgramReady) {
    throw new Error(
      `Verifier Router program ${ROUTER_PROGRAM_ID.toBase58()} is not deployed. ` +
        "Start localnet with: bash scripts/setup-verifier-localnet.sh --mode real",
    );
  }

  if (!programs.verifierProgramReady) {
    throw new Error(
      `Groth16 verifier program ${VERIFIER_PROGRAM_ID.toBase58()} is not deployed. ` +
        "Start localnet with: bash scripts/setup-verifier-localnet.sh --mode real",
    );
  }

}

async function assertRealVerifierState(
  routerAccounts: RouterAccounts,
  state: VerifierState,
) {
  if (!state.verifierProgramDataReady) {
    throw new Error(
      "Expected a real Groth16 verifier deployment with ProgramData upgrade authority " +
        `pinned to router PDA ${state.routerPda.toBase58()}, but that invariant is missing. ` +
        "This localnet looks like a mock verifier stack. Start it with: " +
        "bash scripts/setup-verifier-localnet.sh --mode real",
    );
  }

  if (state.routerPdaInfo) {
    try {
      await routerAccounts.verifierRouter.fetch(state.routerPda);
    } catch (error) {
      throw new Error(
        "Router PDA exists but does not decode as a real initialized verifier router. " +
          `Reset localnet and rerun setup in real mode. Underlying error: ${String(error)}`,
      );
    }
  }

  if (state.verifierEntryInfo && !state.verifierEntryReady) {
    throw new Error(
      "Verifier entry PDA exists but does not match the expected Groth16 verifier entry layout. " +
        "Reset localnet and rerun setup in real mode.",
    );
  }
}

function verifierBootstrapReady(state: VerifierState): boolean {
  return state.routerPdaReady && state.verifierEntryReady;
}

async function initializeRouter(
  provider: anchor.AnchorProvider,
  routerProgram: Program<Idl>,
  routerPda: PublicKey,
) {
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
      return;
    }
    throw e;
  }
}

async function addGroth16Verifier(
  provider: anchor.AnchorProvider,
  routerProgram: Program<Idl>,
  state: VerifierState,
) {
  console.log("\n--- Step 2: Add Groth16 Verifier ---");
  try {
    const tx = await routerProgram.methods
      .addVerifier(Array.from(GROTH16_SELECTOR))
      .accountsPartial({
        router: state.routerPda,
        verifierEntry: state.verifierEntryPda,
        verifierProgramData: state.verifierProgramData,
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
      return;
    }
    throw e;
  }
}

async function verifySetup(routerAccounts: RouterAccounts, state: VerifierState) {
  console.log("\n--- Verification ---");
  const verifiedRouterAccount = await routerAccounts.verifierRouter.fetch(state.routerPda);
  console.log(
    "Router owner:",
    (verifiedRouterAccount as { ownership: { owner: PublicKey } }).ownership.owner?.toBase58(),
  );

  const verifierEntry = await routerAccounts.verifierEntry.fetch(state.verifierEntryPda);
  const entry = verifierEntry as { selector: number[]; verifier: PublicKey; estopped: boolean };
  console.log("Verifier entry:", {
    selector: Buffer.from(entry.selector).toString("hex"),
    verifier: entry.verifier.toBase58(),
    estopped: entry.estopped,
  });

  console.log("\nVerifier localnet setup complete.");
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const { routerAccounts, routerProgram } = loadRouterProgram(provider);
  const addresses = deriveVerifierAddresses();
  logVerifierAddresses(addresses);

  const [programInfo, verifierState] = await Promise.all([
    Promise.all([
      provider.connection.getAccountInfo(ROUTER_PROGRAM_ID),
      provider.connection.getAccountInfo(VERIFIER_PROGRAM_ID),
    ]),
    fetchVerifierState(provider, addresses),
  ]);

  assertVerifierProgramsReady({
    routerProgramReady: Boolean(programInfo[0]?.executable),
    verifierProgramReady: Boolean(programInfo[1]?.executable),
  });
  await assertRealVerifierState(routerAccounts, verifierState);

  if (verifierBootstrapReady(verifierState)) {
    console.log("Verifier prerequisites already provisioned; skipping router bootstrap.");
    return;
  }

  await initializeRouter(provider, routerProgram, verifierState.routerPda);
  await addGroth16Verifier(provider, routerProgram, verifierState);
  await verifySetup(routerAccounts, verifierState);
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
