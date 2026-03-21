import { beforeEach, describe, expect, it, vi } from "vitest";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  createTask,
  claimTask,
  expireClaim,
  completeTask,
  completeTaskPrivate,
  cancelTask,
  getTask,
  computeHashes,
  bigintToBytes32,
  buildJournalBytes,
  deriveTokenEscrowAddress,
  resolveDispute,
  expireDispute,
} from "../index.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { TaskState, PROGRAM_ID } from "../constants.js";
import { getAccount } from "../anchor-utils.js";

vi.mock("../anchor-utils.js", () => ({
  getAccount: vi.fn(),
}));

function makeKeypair(seed: number): Keypair {
  const bytes = new Uint8Array(32);
  bytes.fill(seed);
  return Keypair.fromSeed(bytes);
}

function makeProgram(methodNames: string[], rpcValue: string): unknown {
  const builder = {
    accountsPartial: vi.fn().mockReturnThis(),
    remainingAccounts: vi.fn().mockReturnThis(),
    preInstructions: vi.fn().mockReturnThis(),
    signers: vi.fn().mockReturnThis(),
    rpc: vi.fn().mockResolvedValue(rpcValue),
  };

  const methods: Record<string, (..._args: unknown[]) => unknown> = {};
  for (const methodName of methodNames) {
    methods[methodName] = vi.fn().mockReturnValue(builder);
  }

  return {
    methods,
    programId: PROGRAM_ID,
  };
}

function mockGetAccount(data: unknown): void {
  vi.mocked(getAccount).mockReturnValueOnce({
    fetch: vi.fn().mockResolvedValue(data),
  } as never);
}

const createPublicKeySeeded = (seed: number): PublicKey => {
  const bytes = new Uint8Array(32);
  bytes.fill(seed);
  return new PublicKey(bytes);
};

describe("SDK contract tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns stable contract for createTask", async () => {
    const connection = { confirmTransaction: vi.fn() } as unknown as Connection;
    const program = makeProgram(["createTask"], "tx-create-task") as never;
    const creator = makeKeypair(1);
    const creatorId = new Uint8Array(32);
    creatorId.fill(1);

    const result = await createTask(
      connection,
      program as never,
      creator,
      creatorId,
      {
        taskId: new Uint8Array(32),
        requiredCapabilities: 1,
        description: new Uint8Array(64),
        rewardAmount: 1,
        maxWorkers: 1,
        deadline: 1,
        taskType: 0,
        constraintHash: undefined,
        minReputation: 0,
      },
    );

    expect(result).toHaveProperty("taskPda");
    expect(result.taskPda).toBeInstanceOf(PublicKey);
    expect(result).toHaveProperty("txSignature", "tx-create-task");
    expect(typeof result.txSignature).toBe("string");
    expect(result.txSignature).toBe("tx-create-task");
  });

  it("returns stable contract for claimTask", async () => {
    const connection = { confirmTransaction: vi.fn() } as unknown as Connection;
    const program = makeProgram(["claimTask"], "tx-claim-task") as never;
    const worker = makeKeypair(2);
    const taskPda = createPublicKeySeeded(3);
    const workerId = new Uint8Array(32);
    workerId.fill(2);

    const result = await claimTask(
      connection,
      program as never,
      worker,
      workerId,
      taskPda,
    );

    expect(result).toEqual({ txSignature: "tx-claim-task" });
    expect(result.txSignature).toMatch(/\S+/);
  });

  it("appends Marketplace V2 remaining accounts for expireClaim", async () => {
    const connection = { confirmTransaction: vi.fn() } as unknown as Connection;
    const program = makeProgram(["expireClaim"], "tx-expire-claim") as never;
    const caller = makeKeypair(21);
    const taskPda = createPublicKeySeeded(22);
    const workerId = new Uint8Array(32);
    workerId.fill(21);
    const rentRecipient = createPublicKeySeeded(23);
    const bidMarketplace = createPublicKeySeeded(24);
    const bidBook = createPublicKeySeeded(25);
    const acceptedBid = createPublicKeySeeded(26);
    const bidderMarketState = createPublicKeySeeded(27);
    const creator = createPublicKeySeeded(28);

    const result = await expireClaim(
      connection,
      program as never,
      caller,
      taskPda,
      workerId,
      rentRecipient,
      {
        bidMarketplaceSettlement: {
          bidMarketplace,
          bidBook,
          acceptedBid,
          bidderMarketState,
          creator,
        },
      },
    );

    expect(result).toEqual({ txSignature: "tx-expire-claim" });

    const builder = (program as any).methods.expireClaim.mock.results[0].value;
    expect(builder.remainingAccounts).toHaveBeenCalledWith([
      { pubkey: bidMarketplace, isSigner: false, isWritable: false },
      { pubkey: bidBook, isSigner: false, isWritable: true },
      { pubkey: acceptedBid, isSigner: false, isWritable: true },
      { pubkey: bidderMarketState, isSigner: false, isWritable: true },
      { pubkey: creator, isSigner: false, isWritable: true },
    ]);
  });

  it("returns stable contract for completeTask", async () => {
    const connection = { confirmTransaction: vi.fn() } as unknown as Connection;
    const program = makeProgram(["completeTask"], "tx-complete-task") as never;
    const worker = makeKeypair(3);
    const taskPda = createPublicKeySeeded(4);
    const workerId = new Uint8Array(32);
    workerId.fill(3);

    mockGetAccount({
      creator: createPublicKeySeeded(5),
      rewardMint: null,
    } as never);
    mockGetAccount({
      treasury: createPublicKeySeeded(6),
    } as never);

    const result = await completeTask(
      connection,
      program as never,
      worker,
      workerId,
      taskPda,
      new Uint8Array(32),
    );

    expect(result).toEqual({ txSignature: "tx-complete-task" });
    expect(result.txSignature).toMatch(/\S+/);
  });

  it("appends proof dependency and accepted bid settlement for completeTask", async () => {
    const connection = { confirmTransaction: vi.fn() } as unknown as Connection;
    const program = makeProgram(["completeTask"], "tx-complete-task-v2") as never;
    const worker = makeKeypair(31);
    const taskPda = createPublicKeySeeded(32);
    const workerId = new Uint8Array(32);
    workerId.fill(31);
    const parentTaskPda = createPublicKeySeeded(33);
    const bidBook = createPublicKeySeeded(34);
    const acceptedBid = createPublicKeySeeded(35);
    const bidderMarketState = createPublicKeySeeded(36);
    const bidderAuthority = createPublicKeySeeded(37);

    mockGetAccount({
      creator: createPublicKeySeeded(38),
      rewardMint: null,
    } as never);
    mockGetAccount({
      treasury: createPublicKeySeeded(39),
    } as never);

    await completeTask(
      connection,
      program as never,
      worker,
      workerId,
      taskPda,
      new Uint8Array(32),
      undefined,
      {
        parentTaskPda,
        acceptedBidSettlement: {
          bidBook,
          acceptedBid,
          bidderMarketState,
        },
        bidderAuthority,
      },
    );

    const builder = (program as any).methods.completeTask.mock.results[0].value;
    expect(builder.remainingAccounts).toHaveBeenCalledWith([
      { pubkey: parentTaskPda, isSigner: false, isWritable: false },
      { pubkey: bidBook, isSigner: false, isWritable: true },
      { pubkey: acceptedBid, isSigner: false, isWritable: true },
      { pubkey: bidderMarketState, isSigner: false, isWritable: true },
      { pubkey: bidderAuthority, isSigner: false, isWritable: true },
    ]);
  });

  it("returns stable contract for completeTaskPrivate with router accounts", async () => {
    const connection = { confirmTransaction: vi.fn() } as unknown as Connection;
    const program = makeProgram(
      ["completeTaskPrivate"],
      "tx-complete-task-private",
    ) as never;
    const worker = makeKeypair(13);
    const taskPda = createPublicKeySeeded(14);
    const workerId = new Uint8Array(32);
    workerId.fill(13);

    const taskId = new Uint8Array(32);
    taskId.fill(42);
    mockGetAccount({
      creator: createPublicKeySeeded(15),
      taskId,
      rewardMint: null,
    } as never);
    mockGetAccount({
      treasury: createPublicKeySeeded(16),
    } as never);

    const hashes = computeHashes(
      taskPda,
      worker.publicKey,
      [1n, 2n, 3n, 4n],
      17n,
      99999n, // agentSecret
    );

    const constraintHashBuf = bigintToBytes32(hashes.constraintHash);
    const outputCommitmentBuf = bigintToBytes32(hashes.outputCommitment);
    const bindingSeedBuf = bigintToBytes32(hashes.binding);
    const nullifierSeedBuf = bigintToBytes32(hashes.nullifier);

    const sealBytes = Buffer.alloc(260, 0xab);
    sealBytes[0] = 0x52;
    sealBytes[1] = 0x5a;
    sealBytes[2] = 0x56;
    sealBytes[3] = 0x4d;

    const journal = buildJournalBytes({
      taskPda: taskPda.toBytes(),
      agentAuthority: worker.publicKey.toBytes(),
      constraintHash: constraintHashBuf,
      outputCommitment: outputCommitmentBuf,
      bindingSeed: bindingSeedBuf,
      nullifierSeed: nullifierSeedBuf,
    });

    const imageId = Buffer.alloc(32, 0xef);

    const parentTaskPda = createPublicKeySeeded(17);
    const bidBook = createPublicKeySeeded(18);
    const acceptedBid = createPublicKeySeeded(19);
    const bidderMarketState = createPublicKeySeeded(20);
    const bidderAuthority = createPublicKeySeeded(21);

    const result = await completeTaskPrivate(
      connection,
      program as never,
      worker,
      workerId,
      taskPda,
      {
        sealBytes,
        journal,
        imageId,
        bindingSeed: bindingSeedBuf,
        nullifierSeed: nullifierSeedBuf,
      },
      {
        parentTaskPda,
        acceptedBidSettlement: {
          bidBook,
          acceptedBid,
          bidderMarketState,
        },
        bidderAuthority,
      },
    );

    expect(result).toEqual({ txSignature: "tx-complete-task-private" });

    const completeTaskPrivateMock = (program as any).methods
      .completeTaskPrivate as ReturnType<typeof vi.fn>;
    expect(completeTaskPrivateMock).toHaveBeenCalledTimes(1);
    const proofArg = completeTaskPrivateMock.mock.calls[0][1];
    expect(proofArg).toMatchObject({
      sealBytes: expect.any(Array),
      journal: expect.any(Array),
      imageId: expect.any(Array),
      bindingSeed: expect.any(Array),
      nullifierSeed: expect.any(Array),
    });
    expect(proofArg.sealBytes).toHaveLength(260);
    expect(proofArg.journal).toHaveLength(192);
    expect(proofArg.imageId).toHaveLength(32);
    expect(proofArg.bindingSeed).toHaveLength(32);
    expect(proofArg.nullifierSeed).toHaveLength(32);

    const builder = completeTaskPrivateMock.mock.results[0].value;
    expect(builder.accountsPartial).toHaveBeenCalledWith(
      expect.objectContaining({
        bindingSpend: expect.any(PublicKey),
        nullifierSpend: expect.any(PublicKey),
        routerProgram: expect.any(PublicKey),
        router: expect.any(PublicKey),
        verifierEntry: expect.any(PublicKey),
        verifierProgram: expect.any(PublicKey),
      }),
    );
    expect(builder.remainingAccounts).toHaveBeenCalledWith([
      { pubkey: parentTaskPda, isSigner: false, isWritable: false },
      { pubkey: bidBook, isSigner: false, isWritable: true },
      { pubkey: acceptedBid, isSigner: false, isWritable: true },
      { pubkey: bidderMarketState, isSigner: false, isWritable: true },
      { pubkey: bidderAuthority, isSigner: false, isWritable: true },
    ]);
  });

  it("encodes bid-marketplace cancellation cleanup triples", async () => {
    const connection = { confirmTransaction: vi.fn() } as unknown as Connection;
    const program = makeProgram(["cancelTask"], "tx-cancel-task-v2") as never;
    const creator = makeKeypair(41);
    const taskPda = createPublicKeySeeded(42);

    mockGetAccount({
      rewardMint: null,
    } as never);

    const workerCleanupTriples = [
      {
        claimPda: createPublicKeySeeded(43),
        workerAgentPda: createPublicKeySeeded(44),
        rentRecipient: createPublicKeySeeded(45),
      },
    ];
    const bidBook = createPublicKeySeeded(46);
    const acceptedBid = createPublicKeySeeded(47);
    const bidderMarketState = createPublicKeySeeded(48);

    const result = await cancelTask(
      connection,
      program as never,
      creator,
      taskPda,
      undefined,
      {
        workerCleanupTriples,
        bidMarketplaceSettlement: {
          bidBook,
          acceptedBid,
          bidderMarketState,
        },
      },
    );

    expect(result).toEqual({ txSignature: "tx-cancel-task-v2" });

    const builder = (program as any).methods.cancelTask.mock.results[0].value;
    expect(builder.remainingAccounts).toHaveBeenCalledWith([
      {
        pubkey: workerCleanupTriples[0].claimPda,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: workerCleanupTriples[0].workerAgentPda,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: workerCleanupTriples[0].rentRecipient,
        isSigner: false,
        isWritable: true,
      },
      { pubkey: bidBook, isSigner: false, isWritable: true },
      { pubkey: acceptedBid, isSigner: false, isWritable: true },
      { pubkey: bidderMarketState, isSigner: false, isWritable: true },
    ]);
  });

  it("appends accepted bid settlement suffix for resolveDispute", async () => {
    const connection = { confirmTransaction: vi.fn() } as unknown as Connection;
    const program = makeProgram(["resolveDispute"], "tx-resolve-dispute") as never;
    const resolver = makeKeypair(51);
    const disputePda = createPublicKeySeeded(52);
    const taskPda = createPublicKeySeeded(53);
    const creatorPubkey = createPublicKeySeeded(54);
    const workerAuthority = createPublicKeySeeded(55);
    const votePda = createPublicKeySeeded(56);
    const arbiterPda = createPublicKeySeeded(57);
    const claimPda = createPublicKeySeeded(58);
    const workerPda = createPublicKeySeeded(59);
    const bidBook = createPublicKeySeeded(60);
    const acceptedBid = createPublicKeySeeded(61);
    const bidderMarketState = createPublicKeySeeded(62);

    mockGetAccount({
      rewardMint: null,
    } as never);
    mockGetAccount({
      treasury: createPublicKeySeeded(63),
    } as never);

    const result = await resolveDispute(
      connection,
      program as never,
      resolver,
      {
        disputePda,
        taskPda,
        creatorPubkey,
        workerAuthority,
        arbiterPairs: [{ votePda, agentPda: arbiterPda }],
        workerPairs: [{ claimPda, agentPda: workerPda }],
        acceptedBidSettlement: {
          bidBook,
          acceptedBid,
          bidderMarketState,
        },
      },
    );

    expect(result).toEqual({ txSignature: "tx-resolve-dispute" });

    const builder = (program as any).methods.resolveDispute.mock.results[0].value;
    expect(builder.remainingAccounts).toHaveBeenCalledWith([
      { pubkey: votePda, isSigner: false, isWritable: true },
      { pubkey: arbiterPda, isSigner: false, isWritable: true },
      { pubkey: claimPda, isSigner: false, isWritable: true },
      { pubkey: workerPda, isSigner: false, isWritable: true },
      { pubkey: bidBook, isSigner: false, isWritable: true },
      { pubkey: acceptedBid, isSigner: false, isWritable: true },
      { pubkey: bidderMarketState, isSigner: false, isWritable: true },
    ]);
  });

  it("appends accepted bid settlement suffix for expireDispute", async () => {
    const connection = { confirmTransaction: vi.fn() } as unknown as Connection;
    const program = makeProgram(["expireDispute"], "tx-expire-dispute") as never;
    const caller = makeKeypair(71);
    const disputePda = createPublicKeySeeded(72);
    const taskPda = createPublicKeySeeded(73);
    const creatorPubkey = createPublicKeySeeded(74);
    const workerAuthority = createPublicKeySeeded(75);
    const votePda = createPublicKeySeeded(76);
    const arbiterPda = createPublicKeySeeded(77);
    const claimPda = createPublicKeySeeded(78);
    const workerPda = createPublicKeySeeded(79);
    const bidBook = createPublicKeySeeded(80);
    const acceptedBid = createPublicKeySeeded(81);
    const bidderMarketState = createPublicKeySeeded(82);

    mockGetAccount({
      rewardMint: null,
    } as never);

    const result = await expireDispute(
      connection,
      program as never,
      caller,
      {
        disputePda,
        taskPda,
        creatorPubkey,
        workerAuthority,
        arbiterPairs: [{ votePda, agentPda: arbiterPda }],
        workerPairs: [{ claimPda, agentPda: workerPda }],
        acceptedBidSettlement: {
          bidBook,
          acceptedBid,
          bidderMarketState,
        },
      },
    );

    expect(result).toEqual({ txSignature: "tx-expire-dispute" });

    const builder = (program as any).methods.expireDispute.mock.results[0].value;
    expect(builder.remainingAccounts).toHaveBeenCalledWith([
      { pubkey: votePda, isSigner: false, isWritable: true },
      { pubkey: arbiterPda, isSigner: false, isWritable: true },
      { pubkey: claimPda, isSigner: false, isWritable: true },
      { pubkey: workerPda, isSigner: false, isWritable: true },
      { pubkey: bidBook, isSigner: false, isWritable: true },
      { pubkey: acceptedBid, isSigner: false, isWritable: true },
      { pubkey: bidderMarketState, isSigner: false, isWritable: true },
    ]);
  });

  it("returns stable TaskStatus contract for getTask", async () => {
    const taskPda = createPublicKeySeeded(7);
    const creator = createPublicKeySeeded(8);
    const constraintHash = new Uint8Array([9, 8, 7, 6]);

    mockGetAccount({
      taskId: new Uint8Array(32),
      status: { open: {} },
      creator,
      rewardAmount: { toString: () => "42" },
      deadline: { toNumber: () => 1_234_567 },
      constraintHash,
      currentWorkers: 1,
      maxWorkers: 2,
      completedAt: null,
      rewardMint: null,
    } as never);

    const status = await getTask(
      { rpc: () => Promise.resolve("ok") } as never,
      taskPda,
    );

    expect(status).not.toBeNull();
    expect(status).toMatchObject({
      taskId: new Uint8Array(32),
      state: TaskState.Open,
      creator,
      rewardAmount: 42n,
      deadline: 1_234_567,
      currentWorkers: 1,
      maxWorkers: 2,
      completedAt: null,
      rewardMint: null,
      constraintHash,
    });
  });

  it("returns stable contract for deriveTokenEscrowAddress", () => {
    const mint = createPublicKeySeeded(11);
    const escrow = createPublicKeySeeded(12);
    const expected = getAssociatedTokenAddressSync(mint, escrow, true);

    const result = deriveTokenEscrowAddress(mint, escrow);

    expect(result).toBeInstanceOf(PublicKey);
    expect(result.toBase58()).toBe(expected.toBase58());
  });
});
