import { describe, expect, it, vi } from "vitest";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ACCOUNT_SIZE,
  AccountState,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  TokenAccountNotFoundError,
  TokenInvalidAccountOwnerError,
  TokenInvalidAccountSizeError,
  unpackAccount,
  unpackMint,
} from "../spl-token";

function makePubkey(seed: number): PublicKey {
  const bytes = new Uint8Array(32);
  bytes.fill(seed);
  return Keypair.fromSeed(bytes).publicKey;
}

function buildMintInfo(data: Buffer, owner: PublicKey = TOKEN_PROGRAM_ID) {
  return {
    executable: false,
    owner,
    lamports: 0,
    data,
    rentEpoch: 0,
  };
}

describe("sdk spl-token subset", () => {
  it("derives the associated token address using the canonical seeds", () => {
    const mint = makePubkey(1);
    const owner = makePubkey(2);
    const [expected] = PublicKey.findProgramAddressSync(
      [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    expect(getAssociatedTokenAddressSync(mint, owner)).toEqual(expected);
  });

  it("rejects off-curve owners unless explicitly allowed", () => {
    const mint = makePubkey(3);
    const offCurveOwner = PublicKey.unique();

    expect(() => getAssociatedTokenAddressSync(mint, offCurveOwner)).toThrow(
      /allowOwnerOffCurve=false/,
    );
    expect(
      getAssociatedTokenAddressSync(mint, offCurveOwner, true),
    ).toBeInstanceOf(PublicKey);
  });

  it("unpacks a classic mint account", () => {
    const mintAuthority = makePubkey(4);
    const freezeAuthority = makePubkey(5);
    const address = makePubkey(6);
    const data = Buffer.alloc(MINT_SIZE);

    data.writeUInt32LE(1, 0);
    mintAuthority.toBuffer().copy(data, 4);
    data.writeBigUInt64LE(123456789n, 36);
    data.writeUInt8(9, 44);
    data.writeUInt8(1, 45);
    data.writeUInt32LE(1, 46);
    freezeAuthority.toBuffer().copy(data, 50);

    const mint = unpackMint(address, buildMintInfo(data));

    expect(mint.address).toEqual(address);
    expect(mint.mintAuthority).toEqual(mintAuthority);
    expect(mint.supply).toBe(123456789n);
    expect(mint.decimals).toBe(9);
    expect(mint.isInitialized).toBe(true);
    expect(mint.freezeAuthority).toEqual(freezeAuthority);
  });

  it("unpacks a classic token account", () => {
    const address = makePubkey(7);
    const mint = makePubkey(8);
    const owner = makePubkey(9);
    const delegate = makePubkey(10);
    const closeAuthority = makePubkey(11);
    const data = Buffer.alloc(ACCOUNT_SIZE);

    mint.toBuffer().copy(data, 0);
    owner.toBuffer().copy(data, 32);
    data.writeBigUInt64LE(99n, 64);
    data.writeUInt32LE(1, 72);
    delegate.toBuffer().copy(data, 76);
    data.writeUInt8(AccountState.Frozen, 108);
    data.writeUInt32LE(1, 109);
    data.writeBigUInt64LE(5000n, 113);
    data.writeBigUInt64LE(12n, 121);
    data.writeUInt32LE(1, 129);
    closeAuthority.toBuffer().copy(data, 133);

    const account = unpackAccount(address, buildMintInfo(data));

    expect(account.address).toEqual(address);
    expect(account.mint).toEqual(mint);
    expect(account.owner).toEqual(owner);
    expect(account.amount).toBe(99n);
    expect(account.delegate).toEqual(delegate);
    expect(account.delegatedAmount).toBe(12n);
    expect(account.isInitialized).toBe(true);
    expect(account.isFrozen).toBe(true);
    expect(account.isNative).toBe(true);
    expect(account.rentExemptReserve).toBe(5000n);
    expect(account.closeAuthority).toEqual(closeAuthority);
  });

  it("rejects missing token accounts", () => {
    expect(() => unpackAccount(makePubkey(22), null)).toThrowError(
      TokenAccountNotFoundError,
    );
  });

  it("rejects token accounts owned by another program", () => {
    const data = Buffer.alloc(ACCOUNT_SIZE);

    expect(() =>
      unpackAccount(makePubkey(23), buildMintInfo(data, SystemProgram.programId)),
    ).toThrowError(TokenInvalidAccountOwnerError);
  });

  it("rejects extension-bearing token account layouts outside the classic boundary", () => {
    const extendedData = Buffer.alloc(ACCOUNT_SIZE + 8);

    expect(() => unpackAccount(makePubkey(24), buildMintInfo(extendedData))).toThrowError(
      TokenInvalidAccountSizeError,
    );
  });

  it("rejects missing mint accounts", () => {
    expect(() => unpackMint(makePubkey(25), null)).toThrowError(
      TokenAccountNotFoundError,
    );
  });

  it("rejects mints owned by another program", () => {
    const data = Buffer.alloc(MINT_SIZE);

    expect(() =>
      unpackMint(makePubkey(26), buildMintInfo(data, SystemProgram.programId)),
    ).toThrowError(TokenInvalidAccountOwnerError);
  });

  it("rejects extension-bearing mint layouts outside the classic boundary", () => {
    const extendedData = Buffer.alloc(MINT_SIZE + 16);

    expect(() => unpackMint(makePubkey(27), buildMintInfo(extendedData))).toThrowError(
      TokenInvalidAccountSizeError,
    );
  });

  it("encodes InitializeMint2 with and without a freeze authority", () => {
    const mint = makePubkey(12);
    const mintAuthority = makePubkey(13);
    const freezeAuthority = makePubkey(14);

    const withFreeze = createInitializeMint2Instruction(
      mint,
      6,
      mintAuthority,
      freezeAuthority,
    );
    const withoutFreeze = createInitializeMint2Instruction(
      mint,
      6,
      mintAuthority,
      null,
    );

    expect(withFreeze.programId).toEqual(TOKEN_PROGRAM_ID);
    expect(withFreeze.data.length).toBe(67);
    expect(withFreeze.data.readUInt8(0)).toBe(20);
    expect(withFreeze.data.readUInt8(1)).toBe(6);
    expect(withFreeze.data.readUInt8(34)).toBe(1);
    expect(withFreeze.keys[0]?.pubkey).toEqual(mint);

    expect(withoutFreeze.data.length).toBe(35);
    expect(withoutFreeze.data.readUInt8(34)).toBe(0);
  });

  it("encodes MintTo for a single signer authority", () => {
    const mint = makePubkey(15);
    const destination = makePubkey(16);
    const authority = makePubkey(17);
    const instruction = createMintToInstruction(
      mint,
      destination,
      authority,
      42n,
    );

    expect(instruction.programId).toEqual(TOKEN_PROGRAM_ID);
    expect(instruction.keys).toHaveLength(3);
    expect(instruction.keys[2]?.pubkey).toEqual(authority);
    expect(instruction.keys[2]?.isSigner).toBe(true);
    expect(instruction.data.readUInt8(0)).toBe(7);
    expect(instruction.data.readBigUInt64LE(1)).toBe(42n);
  });

  it("builds the associated token account instruction keys explicitly", () => {
    const payer = makePubkey(18);
    const ata = makePubkey(19);
    const owner = makePubkey(20);
    const mint = makePubkey(21);

    const instruction = createAssociatedTokenAccountInstruction(
      payer,
      ata,
      owner,
      mint,
    );

    expect(instruction.programId).toEqual(ASSOCIATED_TOKEN_PROGRAM_ID);
    expect(instruction.data).toHaveLength(0);
    expect(instruction.keys.map((key) => key.pubkey)).toEqual([
      payer,
      ata,
      owner,
      mint,
      SystemProgram.programId,
      TOKEN_PROGRAM_ID,
    ]);
    expect(instruction.keys[0]?.isSigner).toBe(true);
  });

  it("fetch helpers decode classic layouts through the connection boundary", async () => {
    const mintAddress = makePubkey(28);
    const accountAddress = makePubkey(29);
    const mintAuthority = makePubkey(30);
    const owner = makePubkey(31);
    const mintData = Buffer.alloc(MINT_SIZE);
    const accountData = Buffer.alloc(ACCOUNT_SIZE);
    mintAddress.toBuffer().copy(accountData, 0);
    owner.toBuffer().copy(accountData, 32);
    accountData.writeBigUInt64LE(7n, 64);
    accountData.writeUInt8(AccountState.Initialized, 108);
    mintData.writeUInt32LE(1, 0);
    mintAuthority.toBuffer().copy(mintData, 4);
    mintData.writeUInt8(1, 45);

    const getAccountInfo = vi
      .fn()
      .mockResolvedValueOnce(buildMintInfo(accountData))
      .mockResolvedValueOnce(buildMintInfo(mintData));
    const connection = { getAccountInfo } as unknown as Connection;

    const account = await getAccount(connection, accountAddress);
    const mint = await getMint(connection, mintAddress);

    expect(getAccountInfo).toHaveBeenCalledTimes(2);
    expect(account.address).toEqual(accountAddress);
    expect(account.owner).toEqual(owner);
    expect(account.amount).toBe(7n);
    expect(mint.address).toEqual(mintAddress);
    expect(mint.mintAuthority).toEqual(mintAuthority);
    expect(mint.isInitialized).toBe(true);
  });
});
