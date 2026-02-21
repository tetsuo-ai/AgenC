/**
 * Tests for AgentRuntimeConfig and isKeypair
 */

import { describe, it, expect } from "vitest";
import {
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import { isKeypair, AgentRuntimeConfig } from "./config.js";
import type { Wallet } from "./wallet.js";

describe("isKeypair", () => {
  it("returns true for Keypair instances", () => {
    const keypair = Keypair.generate();
    expect(isKeypair(keypair)).toBe(true);
  });

  it("returns false for Wallet interface objects", () => {
    const wallet: Wallet = {
      publicKey: Keypair.generate().publicKey,
      signTransaction: async <T extends Transaction | VersionedTransaction>(
        tx: T,
      ): Promise<T> => tx,
      signAllTransactions: async <T extends Transaction | VersionedTransaction>(
        txs: T[],
      ): Promise<T[]> => txs,
    };
    expect(isKeypair(wallet)).toBe(false);
  });

  it("returns true for objects with secretKey property", () => {
    // Edge case: object with secretKey that isn't a real Keypair
    const fakeKeypair = {
      publicKey: Keypair.generate().publicKey,
      secretKey: new Uint8Array(64),
    };
    // This should return true because it has secretKey
    expect(isKeypair(fakeKeypair as unknown as Keypair)).toBe(true);
  });
});

describe("AgentRuntimeConfig interface", () => {
  it("allows minimal valid config", () => {
    const keypair = Keypair.generate();
    const config: AgentRuntimeConfig = {
      connection: {} as import("@solana/web3.js").Connection,
      wallet: keypair,
    };
    expect(config.connection).toBeDefined();
    expect(config.wallet).toBeDefined();
  });

  it("allows all optional fields", () => {
    const keypair = Keypair.generate();
    const config: AgentRuntimeConfig = {
      connection: {} as import("@solana/web3.js").Connection,
      wallet: keypair,
      programId: Keypair.generate().publicKey,
      agentId: new Uint8Array(32),
      capabilities: 3n,
      endpoint: "https://example.com",
      metadataUri: "https://metadata.example.com",
      initialStake: 1_000_000_000n,
      logLevel: "info",
    };
    expect(config.programId).toBeInstanceOf(PublicKey);
    expect(config.agentId?.length).toBe(32);
    expect(config.capabilities).toBe(3n);
    expect(config.endpoint).toBe("https://example.com");
    expect(config.metadataUri).toBe("https://metadata.example.com");
    expect(config.initialStake).toBe(1_000_000_000n);
    expect(config.logLevel).toBe("info");
  });

  it("allows all log levels", () => {
    const keypair = Keypair.generate();
    const logLevels: Array<"debug" | "info" | "warn" | "error"> = [
      "debug",
      "info",
      "warn",
      "error",
    ];

    for (const level of logLevels) {
      const config: AgentRuntimeConfig = {
        connection: {} as import("@solana/web3.js").Connection,
        wallet: keypair,
        logLevel: level,
      };
      expect(config.logLevel).toBe(level);
    }
  });

  it("allows Wallet interface as wallet", () => {
    const wallet: Wallet = {
      publicKey: Keypair.generate().publicKey,
      signTransaction: async <T extends Transaction | VersionedTransaction>(
        tx: T,
      ): Promise<T> => tx,
      signAllTransactions: async <T extends Transaction | VersionedTransaction>(
        txs: T[],
      ): Promise<T[]> => txs,
    };

    const config: AgentRuntimeConfig = {
      connection: {} as import("@solana/web3.js").Connection,
      wallet,
    };
    expect(config.wallet).toBe(wallet);
    expect(isKeypair(config.wallet)).toBe(false);
  });
});
