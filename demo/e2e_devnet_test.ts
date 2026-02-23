/**
 * AgenC Private Task Completion - Devnet preflight checks
 *
 * Validates router-based private submission surfaces:
 * - RISC0 payload shape
 * - router/verifier account model
 * - binding/nullifier spend PDA derivation
 */

import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createHash } from 'crypto';

const RPC_URL = process.env.HELIUS_RPC || 'https://api.devnet.solana.com';
const AGENC_PROGRAM_ID = new PublicKey('5j9ZbT3mnPX5QjWVMrDaWFuaGf8ddji6LW1HVJw6kUE7');
const ROUTER_PROGRAM_ID = new PublicKey('6JvFfBrvCcWgANKh1Eae9xDq4RC6cfJuBcf71rp2k9Y7');
const VERIFIER_PROGRAM_ID = new PublicKey('THq1qFYQoh7zgcjXoMXduDBqiZRCPeg3PvvMbrVQUge');
const TRUSTED_SELECTOR = Buffer.from('525a5631', 'hex');
const TRUSTED_IMAGE_ID = Buffer.from('11'.repeat(32), 'hex');

const ROUTER_SEED = Buffer.from('router');
const VERIFIER_SEED = Buffer.from('verifier');
const BINDING_SPEND_SEED = Buffer.from('binding_spend');
const NULLIFIER_SPEND_SEED = Buffer.from('nullifier_spend');

interface TestResult {
  step: string;
  success: boolean;
  details?: string;
  error?: string;
}

interface PrivatePayload {
  sealBytes: Buffer;
  journal: Buffer;
  imageId: Buffer;
  bindingSeed: Buffer;
  nullifierSeed: Buffer;
}

function sha256(...chunks: Buffer[]): Buffer {
  const hasher = createHash('sha256');
  for (const chunk of chunks) {
    hasher.update(chunk);
  }
  return hasher.digest();
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

function makePayload(taskPda: PublicKey, authority: PublicKey): PrivatePayload {
  const constraintHash = sha256(Buffer.from('constraint'), taskPda.toBuffer());
  const outputCommitment = sha256(Buffer.from('output_commitment'), authority.toBuffer());
  const bindingSeed = sha256(Buffer.from('AGENC_V2_BINDING'), taskPda.toBuffer(), authority.toBuffer(), outputCommitment);
  const nullifierSeed = sha256(Buffer.from('AGENC_V2_NULLIFIER'), constraintHash, outputCommitment, authority.toBuffer());
  const journal = Buffer.concat([
    taskPda.toBuffer(),
    authority.toBuffer(),
    constraintHash,
    outputCommitment,
    bindingSeed,
    nullifierSeed,
  ]);
  const sealProof = deterministicBytes(sha256(Buffer.from('seal'), journal, TRUSTED_IMAGE_ID), 256);
  const sealBytes = Buffer.concat([TRUSTED_SELECTOR, sealProof]);

  return {
    sealBytes,
    journal,
    imageId: Buffer.from(TRUSTED_IMAGE_ID),
    bindingSeed,
    nullifierSeed,
  };
}

class E2ERouterPreflight {
  connection: Connection;
  creator: Keypair;
  worker: Keypair;
  results: TestResult[] = [];

  constructor() {
    this.connection = new Connection(RPC_URL, 'confirmed');
    this.creator = Keypair.generate();
    this.worker = Keypair.generate();
  }

  log(message: string) {
    console.log(`[E2E] ${message}`);
  }

  async getBalance(pubkey: PublicKey): Promise<number> {
    const balance = await this.connection.getBalance(pubkey);
    return balance / LAMPORTS_PER_SOL;
  }

  async testProgramExecutable(label: string, programId: PublicKey): Promise<TestResult> {
    try {
      const info = await this.connection.getAccountInfo(programId);
      if (!info?.executable) {
        return {
          step: `${label} program`,
          success: false,
          error: 'Program missing or not executable',
        };
      }
      return {
        step: `${label} program`,
        success: true,
        details: programId.toBase58(),
      };
    } catch (err: unknown) {
      return {
        step: `${label} program`,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async testPayloadAndAccounts(): Promise<TestResult> {
    try {
      const taskId = Buffer.alloc(32);
      taskId.writeUInt32LE(1, 0);
      const [taskPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('task'), this.creator.publicKey.toBuffer(), taskId],
        AGENC_PROGRAM_ID,
      );

      const payload = makePayload(taskPda, this.worker.publicKey);
      const [bindingSpend] = PublicKey.findProgramAddressSync(
        [BINDING_SPEND_SEED, payload.bindingSeed],
        AGENC_PROGRAM_ID,
      );
      const [nullifierSpend] = PublicKey.findProgramAddressSync(
        [NULLIFIER_SPEND_SEED, payload.nullifierSeed],
        AGENC_PROGRAM_ID,
      );
      const [router] = PublicKey.findProgramAddressSync(
        [ROUTER_SEED],
        ROUTER_PROGRAM_ID,
      );
      const [verifierEntry] = PublicKey.findProgramAddressSync(
        [VERIFIER_SEED, TRUSTED_SELECTOR],
        ROUTER_PROGRAM_ID,
      );

      const lengthsOk = payload.sealBytes.length === 260
        && payload.journal.length === 192
        && payload.imageId.length === 32
        && payload.bindingSeed.length === 32
        && payload.nullifierSeed.length === 32;
      if (!lengthsOk) {
        return {
          step: 'Payload shape',
          success: false,
          error: `Invalid lengths: seal=${payload.sealBytes.length}, journal=${payload.journal.length}`,
        };
      }

      return {
        step: 'Payload + account derivation',
        success: true,
        details: [
          `router=${router.toBase58()}`,
          `verifierEntry=${verifierEntry.toBase58()}`,
          `bindingSpend=${bindingSpend.toBase58()}`,
          `nullifierSpend=${nullifierSpend.toBase58()}`,
        ].join(' | '),
      };
    } catch (err: unknown) {
      return {
        step: 'Payload + account derivation',
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async run(): Promise<void> {
    console.log('\n========================================');
    console.log('AgenC E2E Devnet Router Preflight');
    console.log('========================================\n');

    this.log(`RPC: ${RPC_URL}`);
    this.log(`Creator wallet: ${this.creator.publicKey.toBase58()}`);
    this.log(`Worker wallet: ${this.worker.publicKey.toBase58()}`);

    const creatorBalance = await this.getBalance(this.creator.publicKey);
    const workerBalance = await this.getBalance(this.worker.publicKey);
    this.log(`Creator balance: ${creatorBalance} SOL`);
    this.log(`Worker balance: ${workerBalance} SOL`);

    this.results.push(await this.testProgramExecutable('AgenC', AGENC_PROGRAM_ID));
    this.results.push(await this.testProgramExecutable('Router', ROUTER_PROGRAM_ID));
    this.results.push(await this.testProgramExecutable('Verifier', VERIFIER_PROGRAM_ID));
    this.results.push(await this.testPayloadAndAccounts());

    console.log('\n--- Results ---\n');
    for (const result of this.results) {
      const status = result.success ? '[PASS]' : '[FAIL]';
      console.log(`${status} ${result.step}`);
      if (result.details) {
        console.log(`  ${result.details}`);
      }
      if (result.error) {
        console.log(`  Error: ${result.error}`);
      }
    }

    const passed = this.results.filter(r => r.success).length;
    const total = this.results.length;
    console.log(`\n${passed}/${total} checks passed\n`);
  }
}

async function main() {
  const test = new E2ERouterPreflight();
  await test.run();
}

main().catch(console.error);
