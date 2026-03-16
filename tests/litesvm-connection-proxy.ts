import { FailedTransactionMetadata, LiteSVM } from "litesvm";
import {
  PublicKey,
  SendTransactionError,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import type { Bs58Codec } from "./litesvm-shared.ts";

export interface LiteSVMConnectionProxyOptions {
  allowConstructorNameFallback?: boolean;
}

function isFailedTransactionMetadata(
  value: unknown,
  options: LiteSVMConnectionProxyOptions,
): value is FailedTransactionMetadata {
  if (value instanceof FailedTransactionMetadata) {
    return true;
  }
  return options.allowConstructorNameFallback === true
    && (value as { constructor?: { name?: string } } | null)?.constructor?.name
      === "FailedTransactionMetadata";
}

export function extendLiteSVMConnectionProxy(
  svm: LiteSVM,
  connection: any,
  walletRef: { publicKey: PublicKey },
  bs58: Bs58Codec,
  options: LiteSVMConnectionProxyOptions = {},
): void {
  connection.getAccountInfo = async (
    publicKey: PublicKey,
    _commitmentOrConfig?: any,
  ) => {
    const account = svm.getAccount(publicKey);
    if (!account) return null;
    return {
      ...account,
      data: Buffer.from(account.data),
    };
  };

  connection.getAccountInfoAndContext = async (
    publicKey: PublicKey,
    _commitmentOrConfig?: any,
  ) => {
    const account = svm.getAccount(publicKey);
    if (!account) {
      return {
        context: { slot: Number(svm.getClock().slot) },
        value: null,
      };
    }
    return {
      context: { slot: Number(svm.getClock().slot) },
      value: {
        ...account,
        data: Buffer.from(account.data),
      },
    };
  };

  connection.getBalance = async (
    address: PublicKey,
    _commitment?: any,
  ): Promise<number> => {
    const balance = svm.getBalance(address);
    return balance !== null ? Number(balance) : 0;
  };

  connection.getLatestBlockhash = async (_commitment?: any) => ({
    blockhash: svm.latestBlockhash(),
    lastValidBlockHeight: 0,
  });

  connection.sendTransaction = async (
    transaction: Transaction | VersionedTransaction,
    signersOrOptions?: any,
    _options?: any,
  ): Promise<string> => {
    if ("version" in transaction) {
      const signers = Array.isArray(signersOrOptions) ? signersOrOptions : [];
      signers.forEach((signer: any) => transaction.sign([signer]));
      const result = svm.sendTransaction(transaction);
      if (isFailedTransactionMetadata(result, options)) {
        throw new SendTransactionError({
          action: "send",
          signature: "unknown",
          transactionMessage: result.err().toString(),
          logs: result.meta().logs(),
        });
      }
      return bs58.encode(transaction.signatures[0]);
    }

    const signers = Array.isArray(signersOrOptions) ? signersOrOptions : [];
    transaction.feePayer = transaction.feePayer || walletRef.publicKey;
    transaction.recentBlockhash = svm.latestBlockhash();
    if (signers.length > 0) {
      transaction.sign(...signers);
    }

    const result = svm.sendTransaction(transaction);
    if (isFailedTransactionMetadata(result, options)) {
      const signatureBytes = transaction.signature;
      throw new SendTransactionError({
        action: "send",
        signature: signatureBytes ? bs58.encode(signatureBytes) : "unknown",
        transactionMessage: result.err().toString(),
        logs: result.meta().logs(),
      });
    }

    return bs58.encode(transaction.signature!);
  };

  connection.confirmTransaction = async (
    _strategyOrSignature?: any,
    _commitment?: any,
  ): Promise<any> => ({
    context: { slot: Number(svm.getClock().slot) },
    value: { err: null },
  });

  connection.requestAirdrop = async (
    address: PublicKey,
    lamports: number,
  ): Promise<string> => {
    svm.airdrop(address, BigInt(lamports));
    return "litesvm-airdrop-" + address.toBase58().slice(0, 8);
  };

  connection.getSlot = async (_commitment?: any): Promise<number> => {
    return Number(svm.getClock().slot);
  };

  connection.getBlockTime = async (_slot?: number): Promise<number | null> => {
    return Number(svm.getClock().unixTimestamp);
  };

  connection.getTransaction = async (
    signature: string,
    _opts?: any,
  ): Promise<any> => {
    let signatureBytes: Uint8Array;
    try {
      signatureBytes = bs58.decode(signature);
    } catch {
      return null;
    }

    const transactionMeta = svm.getTransaction(signatureBytes);
    if (!transactionMeta) return null;

    const BASE_FEE_LAMPORTS = 5000;
    if (isFailedTransactionMetadata(transactionMeta, options)) {
      return {
        meta: {
          fee: BASE_FEE_LAMPORTS,
          err: transactionMeta.err().toString(),
        },
      };
    }

    return {
      meta: {
        fee: BASE_FEE_LAMPORTS,
        err: null,
      },
    };
  };

  connection.getParsedTransaction = connection.getTransaction;

  connection.getSignatureStatuses = async (
    signatures: string[],
    _config?: any,
  ) => ({
    context: { slot: Number(svm.getClock().slot) },
    value: signatures.map(() => ({
      slot: Number(svm.getClock().slot),
      confirmations: 1,
      err: null,
      confirmationStatus: "confirmed" as const,
    })),
  });
}
