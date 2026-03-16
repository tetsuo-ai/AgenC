/**
 * Bounded SPL Token compatibility layer for AgenC.
 *
 * Supported scope:
 * - Standard SPL Token program account and mint layouts
 * - Associated token account derivation
 * - Internal mint/create/mintTo helpers used by AgenC integration tests
 *
 * Explicitly out of scope:
 * - Token-2022 extensions and extension-bearing accounts
 * - Multisig account decoding
 * - The full @solana/spl-token surface area
 */

import {
  type AccountInfo,
  type Commitment,
  type ConfirmOptions,
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  type Signer,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type TransactionSignature,
} from "@solana/web3.js";

export const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);

export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

export const MINT_SIZE = 82;
export const ACCOUNT_SIZE = 165;

const TOKEN_INSTRUCTION_MINT_TO = 7;
const TOKEN_INSTRUCTION_INITIALIZE_MINT2 = 20;

export const AccountState = {
  Uninitialized: 0,
  Initialized: 1,
  Frozen: 2,
} as const;

export type AccountState = (typeof AccountState)[keyof typeof AccountState];

export interface TokenAccount {
  readonly address: PublicKey;
  readonly mint: PublicKey;
  readonly owner: PublicKey;
  readonly amount: bigint;
  readonly delegate: PublicKey | null;
  readonly delegatedAmount: bigint;
  readonly isInitialized: boolean;
  readonly isFrozen: boolean;
  readonly isNative: boolean;
  readonly rentExemptReserve: bigint | null;
  readonly closeAuthority: PublicKey | null;
  readonly tlvData: Buffer;
}

export interface TokenMint {
  readonly address: PublicKey;
  readonly mintAuthority: PublicKey | null;
  readonly supply: bigint;
  readonly decimals: number;
  readonly isInitialized: boolean;
  readonly freezeAuthority: PublicKey | null;
  readonly tlvData: Buffer;
}

export type Account = TokenAccount;
export type Mint = TokenMint;

export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenError";
  }
}

export class TokenAccountNotFoundError extends TokenError {
  constructor(message = "Token account not found") {
    super(message);
    this.name = "TokenAccountNotFoundError";
  }
}

export class TokenInvalidAccountOwnerError extends TokenError {
  constructor(message = "Token account has an unexpected owner") {
    super(message);
    this.name = "TokenInvalidAccountOwnerError";
  }
}

export class TokenInvalidAccountSizeError extends TokenError {
  constructor(message = "Token account has an unexpected size") {
    super(message);
    this.name = "TokenInvalidAccountSizeError";
  }
}

export class TokenInvalidMintError extends TokenError {
  constructor(message = "Mint account has invalid data") {
    super(message);
    this.name = "TokenInvalidMintError";
  }
}

export class TokenOwnerOffCurveError extends TokenError {
  constructor(message = "Token owner is off curve and allowOwnerOffCurve=false") {
    super(message);
    this.name = "TokenOwnerOffCurveError";
  }
}

function readPublicKey(data: Buffer, offset: number): PublicKey {
  return new PublicKey(data.subarray(offset, offset + 32));
}

function readU32(data: Buffer, offset: number): number {
  return data.readUInt32LE(offset);
}

function readU64(data: Buffer, offset: number): bigint {
  return data.readBigUInt64LE(offset);
}

function writeSignerKeys(
  keys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }>,
  authority: PublicKey | Signer,
  multiSigners: Signer[],
): Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> {
  if (multiSigners.length > 0) {
    keys.push({
      pubkey: authority instanceof PublicKey ? authority : authority.publicKey,
      isSigner: false,
      isWritable: false,
    });
    for (const signer of multiSigners) {
      keys.push({
        pubkey: signer.publicKey,
        isSigner: true,
        isWritable: false,
      });
    }
    return keys;
  }

  keys.push({
    pubkey: authority instanceof PublicKey ? authority : authority.publicKey,
    isSigner: true,
    isWritable: false,
  });
  return keys;
}

function resolveAuthoritySigners(
  authority: PublicKey | Signer,
  multiSigners: Signer[],
): Signer[] {
  if (multiSigners.length > 0) {
    return multiSigners;
  }
  return authority instanceof PublicKey ? [] : [authority];
}

function ensureOnCurveOwner(owner: PublicKey, allowOwnerOffCurve: boolean): void {
  if (!allowOwnerOffCurve && !PublicKey.isOnCurve(owner.toBuffer())) {
    throw new TokenOwnerOffCurveError();
  }
}

export function unpackAccount(
  address: PublicKey,
  info: AccountInfo<Buffer> | null,
  programId: PublicKey = TOKEN_PROGRAM_ID,
): TokenAccount {
  if (!info) {
    throw new TokenAccountNotFoundError();
  }
  if (!info.owner.equals(programId)) {
    throw new TokenInvalidAccountOwnerError(
      `Expected owner ${programId.toBase58()}, received ${info.owner.toBase58()}`,
    );
  }
  if (info.data.length !== ACCOUNT_SIZE) {
    throw new TokenInvalidAccountSizeError(
      `Expected standard SPL token account size ${ACCOUNT_SIZE}, received ${info.data.length}`,
    );
  }

  const data = Buffer.isBuffer(info.data) ? info.data : Buffer.from(info.data);
  const delegateOption = readU32(data, 72);
  const isNativeOption = readU32(data, 109);
  const closeAuthorityOption = readU32(data, 129);
  const state = data.readUInt8(108);

  return {
    address,
    mint: readPublicKey(data, 0),
    owner: readPublicKey(data, 32),
    amount: readU64(data, 64),
    delegate: delegateOption !== 0 ? readPublicKey(data, 76) : null,
    delegatedAmount: readU64(data, 121),
    isInitialized: state !== AccountState.Uninitialized,
    isFrozen: state === AccountState.Frozen,
    isNative: isNativeOption !== 0,
    rentExemptReserve: isNativeOption !== 0 ? readU64(data, 113) : null,
    closeAuthority:
      closeAuthorityOption !== 0 ? readPublicKey(data, 133) : null,
    tlvData: Buffer.alloc(0),
  };
}

export function unpackMint(
  address: PublicKey,
  info: AccountInfo<Buffer> | null,
  programId: PublicKey = TOKEN_PROGRAM_ID,
): TokenMint {
  if (!info) {
    throw new TokenAccountNotFoundError("Mint account not found");
  }
  if (!info.owner.equals(programId)) {
    throw new TokenInvalidAccountOwnerError(
      `Expected mint owner ${programId.toBase58()}, received ${info.owner.toBase58()}`,
    );
  }
  if (info.data.length !== MINT_SIZE) {
    throw new TokenInvalidAccountSizeError(
      `Expected standard SPL mint size ${MINT_SIZE}, received ${info.data.length}`,
    );
  }

  const data = Buffer.isBuffer(info.data) ? info.data : Buffer.from(info.data);
  const mintAuthorityOption = readU32(data, 0);
  const freezeAuthorityOption = readU32(data, 46);

  return {
    address,
    mintAuthority:
      mintAuthorityOption !== 0 ? readPublicKey(data, 4) : null,
    supply: readU64(data, 36),
    decimals: data.readUInt8(44),
    isInitialized: data.readUInt8(45) !== 0,
    freezeAuthority:
      freezeAuthorityOption !== 0 ? readPublicKey(data, 50) : null,
    tlvData: Buffer.alloc(0),
  };
}

export async function getAccount(
  connection: Connection,
  address: PublicKey,
  commitment?: Commitment,
  programId: PublicKey = TOKEN_PROGRAM_ID,
): Promise<TokenAccount> {
  const info = await connection.getAccountInfo(address, commitment);
  return unpackAccount(address, info, programId);
}

export async function getMint(
  connection: Connection,
  address: PublicKey,
  commitment?: Commitment,
  programId: PublicKey = TOKEN_PROGRAM_ID,
): Promise<TokenMint> {
  const info = await connection.getAccountInfo(address, commitment);
  return unpackMint(address, info, programId);
}

export async function getAssociatedTokenAddress(
  mint: PublicKey,
  owner: PublicKey,
  allowOwnerOffCurve = false,
  programId: PublicKey = TOKEN_PROGRAM_ID,
  associatedTokenProgramId: PublicKey = ASSOCIATED_TOKEN_PROGRAM_ID,
): Promise<PublicKey> {
  ensureOnCurveOwner(owner, allowOwnerOffCurve);
  const [address] = await PublicKey.findProgramAddress(
    [owner.toBuffer(), programId.toBuffer(), mint.toBuffer()],
    associatedTokenProgramId,
  );
  return address;
}

export function getAssociatedTokenAddressSync(
  mint: PublicKey,
  owner: PublicKey,
  allowOwnerOffCurve = false,
  programId: PublicKey = TOKEN_PROGRAM_ID,
  associatedTokenProgramId: PublicKey = ASSOCIATED_TOKEN_PROGRAM_ID,
): PublicKey {
  ensureOnCurveOwner(owner, allowOwnerOffCurve);
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), programId.toBuffer(), mint.toBuffer()],
    associatedTokenProgramId,
  );
  return address;
}

export function createAssociatedTokenAccountInstruction(
  payer: PublicKey,
  associatedToken: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  programId: PublicKey = TOKEN_PROGRAM_ID,
  associatedTokenProgramId: PublicKey = ASSOCIATED_TOKEN_PROGRAM_ID,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: associatedTokenProgramId,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedToken, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      {
        pubkey: SystemProgram.programId,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.alloc(0),
  });
}

export async function createAssociatedTokenAccount(
  connection: Connection,
  payer: Signer,
  mint: PublicKey,
  owner: PublicKey,
  confirmOptions?: ConfirmOptions,
  programId: PublicKey = TOKEN_PROGRAM_ID,
  associatedTokenProgramId: PublicKey = ASSOCIATED_TOKEN_PROGRAM_ID,
  allowOwnerOffCurve = false,
): Promise<PublicKey> {
  const associatedToken = getAssociatedTokenAddressSync(
    mint,
    owner,
    allowOwnerOffCurve,
    programId,
    associatedTokenProgramId,
  );

  const transaction = new Transaction().add(
    createAssociatedTokenAccountInstruction(
      payer.publicKey,
      associatedToken,
      owner,
      mint,
      programId,
      associatedTokenProgramId,
    ),
  );

  await sendAndConfirmTransaction(connection, transaction, [payer], confirmOptions);
  return associatedToken;
}

export function createInitializeMint2Instruction(
  mint: PublicKey,
  decimals: number,
  mintAuthority: PublicKey,
  freezeAuthority: PublicKey | null,
  programId: PublicKey = TOKEN_PROGRAM_ID,
): TransactionInstruction {
  const data = Buffer.alloc(freezeAuthority ? 67 : 35);
  data.writeUInt8(TOKEN_INSTRUCTION_INITIALIZE_MINT2, 0);
  data.writeUInt8(decimals, 1);
  mintAuthority.toBuffer().copy(data, 2);

  if (freezeAuthority) {
    data.writeUInt8(1, 34);
    freezeAuthority.toBuffer().copy(data, 35);
  } else {
    data.writeUInt8(0, 34);
  }

  return new TransactionInstruction({
    programId,
    keys: [{ pubkey: mint, isSigner: false, isWritable: true }],
    data,
  });
}

export async function getMinimumBalanceForRentExemptMint(
  connection: Connection,
  commitment?: Commitment,
): Promise<number> {
  return connection.getMinimumBalanceForRentExemption(MINT_SIZE, commitment);
}

export function createMintToInstruction(
  mint: PublicKey,
  destination: PublicKey,
  authority: PublicKey | Signer,
  amount: number | bigint,
  multiSigners: Signer[] = [],
  programId: PublicKey = TOKEN_PROGRAM_ID,
): TransactionInstruction {
  const data = Buffer.alloc(9);
  data.writeUInt8(TOKEN_INSTRUCTION_MINT_TO, 0);
  data.writeBigUInt64LE(BigInt(amount), 1);

  return new TransactionInstruction({
    programId,
    keys: writeSignerKeys(
      [
        { pubkey: mint, isSigner: false, isWritable: true },
        { pubkey: destination, isSigner: false, isWritable: true },
      ],
      authority,
      multiSigners,
    ),
    data,
  });
}

export async function createMint(
  connection: Connection,
  payer: Signer,
  mintAuthority: PublicKey,
  freezeAuthority: PublicKey | null,
  decimals: number,
  keypair: Keypair = Keypair.generate(),
  confirmOptions?: ConfirmOptions,
  programId: PublicKey = TOKEN_PROGRAM_ID,
): Promise<PublicKey> {
  const lamports = await getMinimumBalanceForRentExemptMint(
    connection,
    confirmOptions?.commitment,
  );

  const transaction = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: keypair.publicKey,
      space: MINT_SIZE,
      lamports,
      programId,
    }),
    createInitializeMint2Instruction(
      keypair.publicKey,
      decimals,
      mintAuthority,
      freezeAuthority,
      programId,
    ),
  );

  await sendAndConfirmTransaction(connection, transaction, [payer, keypair], confirmOptions);
  return keypair.publicKey;
}

export async function mintTo(
  connection: Connection,
  payer: Signer,
  mint: PublicKey,
  destination: PublicKey,
  authority: PublicKey | Signer,
  amount: number | bigint,
  multiSigners: Signer[] = [],
  confirmOptions?: ConfirmOptions,
  programId: PublicKey = TOKEN_PROGRAM_ID,
): Promise<TransactionSignature> {
  const signers = resolveAuthoritySigners(authority, multiSigners);
  const transaction = new Transaction().add(
    createMintToInstruction(
      mint,
      destination,
      authority,
      amount,
      multiSigners,
      programId,
    ),
  );

  return sendAndConfirmTransaction(
    connection,
    transaction,
    [payer, ...signers],
    confirmOptions,
  );
}
