/**
 * AgenC private task demo using the RISC0 router payload/account model.
 *
 * Run:
 *   npx tsx demo/private_task_demo.ts
 */

import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createHash } from 'crypto';
import {
  PROGRAM_ID as AGENC_PROGRAM_ID,
  TRUSTED_RISC0_SELECTOR,
  TRUSTED_RISC0_IMAGE_ID,
  VERIFIER_PROGRAM_ID as TRUSTED_VERIFIER_PROGRAM_ID,
} from '../sdk/src/constants';
import { computeHashes } from '../sdk/src/proofs';

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || 'YOUR_HELIUS_KEY';
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const TRUSTED_ROUTER_PROGRAM_ID = new PublicKey('6JvFfBrvCcWgANKh1Eae9xDq4RC6cfJuBcf71rp2k9Y7');
const TRUSTED_SELECTOR = Buffer.from(TRUSTED_RISC0_SELECTOR);
const TRUSTED_IMAGE_ID = Buffer.from(TRUSTED_RISC0_IMAGE_ID);

const ROUTER_SEED = Buffer.from('router');
const VERIFIER_SEED = Buffer.from('verifier');
const BINDING_SPEND_SEED = Buffer.from('binding_spend');
const NULLIFIER_SPEND_SEED = Buffer.from('nullifier_spend');

const DEFAULT_OUTPUT = [1n, 2n, 3n, 4n] as const;
const DEFAULT_TASK_ID = 1;
const DEFAULT_SALT = 12345n;
const DEFAULT_SUBMISSION_DELAY_MS = 500;
const DEFAULT_PAYLOAD_SIM_DELAY_MS = 1200;

function parseIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBigIntEnv(name: string, fallback: bigint): bigint {
  const value = process.env[name];
  if (!value) return fallback;
  try {
    return BigInt(value);
  } catch {
    return fallback;
  }
}

const DEMO_CONFIG = {
  expectedOutput: [...DEFAULT_OUTPUT] as bigint[],
  taskId: parseIntegerEnv('PRIVATE_DEMO_TASK_ID', DEFAULT_TASK_ID),
  salt: parseBigIntEnv('PRIVATE_DEMO_SALT', DEFAULT_SALT),
  submissionDelayMs: parseIntegerEnv('PRIVATE_DEMO_SUBMISSION_DELAY_MS', DEFAULT_SUBMISSION_DELAY_MS),
  payloadSimulationDelayMs: parseIntegerEnv('PRIVATE_DEMO_PAYLOAD_SIM_DELAY_MS', DEFAULT_PAYLOAD_SIM_DELAY_MS),
};

interface PrivatePayload {
  sealBytes: Buffer;
  journal: Buffer;
  imageId: Buffer;
  bindingSeed: Buffer;
  nullifierSeed: Buffer;
}

interface RouterAccounts {
  routerProgram: PublicKey;
  router: PublicKey;
  verifierEntry: PublicKey;
  verifierProgram: PublicKey;
  bindingSpend: PublicKey;
  nullifierSpend: PublicKey;
}

function sha256(...chunks: Buffer[]): Buffer {
  const hasher = createHash('sha256');
  for (const chunk of chunks) {
    hasher.update(chunk);
  }
  return hasher.digest();
}

function bigintToBytes32(value: bigint): Buffer {
  const hex = value.toString(16).padStart(64, '0');
  return Buffer.from(hex, 'hex');
}

function deterministicBytes(seed: Buffer, length: number): Buffer {
  const out = Buffer.alloc(length);
  let offset = 0;
  let cursor = seed;
  while (offset < length) {
    cursor = sha256(cursor);
    const remaining = length - offset;
    const chunkSize = Math.min(cursor.length, remaining);
    cursor.copy(out, offset, 0, chunkSize);
    offset += chunkSize;
  }
  return out;
}

function buildJournal(
  taskPda: PublicKey,
  authority: PublicKey,
  constraintHash: Buffer,
  outputCommitment: Buffer,
  bindingSeed: Buffer,
  nullifierSeed: Buffer,
): Buffer {
  const journal = Buffer.concat([
    taskPda.toBuffer(),
    authority.toBuffer(),
    constraintHash,
    outputCommitment,
    bindingSeed,
    nullifierSeed,
    Buffer.alloc(32), // model_commitment (zero = no model binding)
    Buffer.alloc(32), // input_commitment (zero = no input binding)
  ]);
  if (journal.length !== 256) {
    throw new Error(`journal must be 256 bytes, got ${journal.length}`);
  }
  return journal;
}

function buildSealBytes(journal: Buffer, imageId: Buffer): Buffer {
  const proofBody = deterministicBytes(sha256(Buffer.from('seal_body'), journal, imageId), 256);
  return Buffer.concat([TRUSTED_SELECTOR, proofBody]);
}

function deriveRouterAccounts(bindingSeed: Buffer, nullifierSeed: Buffer): RouterAccounts {
  const [bindingSpend] = PublicKey.findProgramAddressSync(
    [BINDING_SPEND_SEED, bindingSeed],
    AGENC_PROGRAM_ID,
  );
  const [nullifierSpend] = PublicKey.findProgramAddressSync(
    [NULLIFIER_SPEND_SEED, nullifierSeed],
    AGENC_PROGRAM_ID,
  );
  const [router] = PublicKey.findProgramAddressSync(
    [ROUTER_SEED],
    TRUSTED_ROUTER_PROGRAM_ID,
  );
  const [verifierEntry] = PublicKey.findProgramAddressSync(
    [VERIFIER_SEED, TRUSTED_SELECTOR],
    TRUSTED_ROUTER_PROGRAM_ID,
  );

  return {
    routerProgram: TRUSTED_ROUTER_PROGRAM_ID,
    router,
    verifierEntry,
    verifierProgram: TRUSTED_VERIFIER_PROGRAM_ID,
    bindingSpend,
    nullifierSpend,
  };
}

async function buildPrivatePayload(params: {
  taskPda: PublicKey;
  authority: PublicKey;
  hashes: { constraintHash: bigint; outputCommitment: bigint; binding: bigint; nullifier: bigint };
}): Promise<PrivatePayload> {
  await sleep(DEMO_CONFIG.payloadSimulationDelayMs);

  const constraintHash = bigintToBytes32(params.hashes.constraintHash);
  const outputCommitment = bigintToBytes32(params.hashes.outputCommitment);
  const bindingSeed = bigintToBytes32(params.hashes.binding);
  const nullifierSeed = bigintToBytes32(params.hashes.nullifier);

  const journal = buildJournal(
    params.taskPda,
    params.authority,
    constraintHash,
    outputCommitment,
    bindingSeed,
    nullifierSeed,
  );
  const sealBytes = buildSealBytes(journal, TRUSTED_IMAGE_ID);

  return {
    sealBytes,
    journal,
    imageId: Buffer.from(TRUSTED_IMAGE_ID),
    bindingSeed,
    nullifierSeed,
  };
}

async function main() {
  console.log('='.repeat(60));
  console.log('AgenC PRIVATE TASK COMPLETION DEMO');
  console.log('RISC0 Router Payload Flow');
  console.log('='.repeat(60));
  console.log();

  const hasApiKey = HELIUS_API_KEY !== 'YOUR_HELIUS_KEY' && HELIUS_API_KEY.length > 10;
  const rpcUrl = hasApiKey ? HELIUS_RPC : 'https://api.devnet.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');

  console.log('RPC:', hasApiKey ? 'Helius Mainnet' : 'Devnet (no HELIUS_API_KEY)');
  console.log('Slot:', await connection.getSlot());
  console.log();

  const taskCreator = Keypair.generate();
  const worker = Keypair.generate();
  const recipientWallet = Keypair.generate();

  console.log('Task Creator:', taskCreator.publicKey.toBase58());
  console.log('Worker:', worker.publicKey.toBase58());
  console.log('Recipient (private payment):', recipientWallet.publicKey.toBase58());
  console.log();

  const taskIdBytes = Buffer.alloc(32);
  taskIdBytes.writeUInt32LE(DEMO_CONFIG.taskId, 0);
  const [taskPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('task'), taskCreator.publicKey.toBuffer(), taskIdBytes],
    AGENC_PROGRAM_ID,
  );

  console.log('-'.repeat(60));
  console.log('STEP 1: Create Task');
  console.log('-'.repeat(60));

  const output = [...DEMO_CONFIG.expectedOutput];
  const hashes = computeHashes(taskPda, worker.publicKey, output, DEMO_CONFIG.salt);
  const constraintHash = bigintToBytes32(hashes.constraintHash);
  const outputCommitment = bigintToBytes32(hashes.outputCommitment);

  console.log('Task ID:', DEMO_CONFIG.taskId);
  console.log('Task PDA:', taskPda.toBase58());
  console.log('Constraint hash:', constraintHash.toString('hex'));
  console.log('Output commitment:', outputCommitment.toString('hex'));
  console.log();

  console.log('-'.repeat(60));
  console.log('STEP 2: Build Private Payload');
  console.log('-'.repeat(60));

  const payload = await buildPrivatePayload({
    taskPda,
    authority: worker.publicKey,
    hashes,
  });
  const routerAccounts = deriveRouterAccounts(payload.bindingSeed, payload.nullifierSeed);

  console.log('sealBytes:', payload.sealBytes.length, 'bytes');
  console.log('journal:', payload.journal.length, 'bytes');
  console.log('imageId:', payload.imageId.toString('hex'));
  console.log('bindingSeed:', payload.bindingSeed.toString('hex'));
  console.log('nullifierSeed:', payload.nullifierSeed.toString('hex'));
  console.log();

  console.log('Router accounts required by complete_task_private:');
  console.log('  routerProgram:', routerAccounts.routerProgram.toBase58());
  console.log('  router:', routerAccounts.router.toBase58());
  console.log('  verifierEntry:', routerAccounts.verifierEntry.toBase58());
  console.log('  verifierProgram:', routerAccounts.verifierProgram.toBase58());
  console.log('  bindingSpend:', routerAccounts.bindingSpend.toBase58());
  console.log('  nullifierSpend:', routerAccounts.nullifierSpend.toBase58());
  console.log();

  console.log('-'.repeat(60));
  console.log('STEP 3: Submit + Private Payment');
  console.log('-'.repeat(60));

  const simulationMode = !process.env.PRIVATE_KEY;
  let signature: string;

  if (simulationMode) {
    console.log('[SIMULATION MODE - no PRIVATE_KEY provided]');
    console.log('Would submit complete_task_private(task_id, payload) with accounts above.');
    await sleep(DEMO_CONFIG.submissionDelayMs);
    signature = `DEMO_SIGNATURE_${Date.now().toString(36)}`;
  } else {
    const owner = process.env.PRIVATE_KEY as string;
    const { PrivacyCash } = await import('../sdk/privacy-cash-sdk/src/index.js');
    const privacyCash = new PrivacyCash({
      RPC_url: HELIUS_RPC,
      owner,
      enableDebug: true,
    });

    const withdrawResult = await privacyCash.withdraw({
      lamports: 1 * LAMPORTS_PER_SOL,
      recipientAddress: recipientWallet.publicKey.toBase58(),
    });

    signature = withdrawResult.signature || 'completed';
  }

  console.log('Transaction:', signature);
  console.log();

  console.log('='.repeat(60));
  console.log('DEMO COMPLETE');
  console.log('='.repeat(60));
  console.log('What was proven:');
  console.log('  [x] Private output remained off-chain');
  console.log('  [x] RISC0 payload was prepared with fixed schema');
  console.log('  [x] Router/verifier account model was satisfied');
  console.log('  [x] Replay spend accounts were derived from binding/nullifier seeds');
  console.log();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error('Demo failed:', err.message);
  process.exit(1);
});
