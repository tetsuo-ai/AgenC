import { describe, it, expect, vi, beforeEach } from "vitest";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { X402Bridge } from "./x402.js";
import { BridgePaymentError } from "./errors.js";
import { ValidationError } from "../types/errors.js";

// Mock sendAndConfirmTransaction at module level
vi.mock("@solana/web3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solana/web3.js")>();
  return {
    ...actual,
    sendAndConfirmTransaction: vi.fn(),
  };
});

import { sendAndConfirmTransaction } from "@solana/web3.js";
const mockSendAndConfirm = vi.mocked(sendAndConfirmTransaction);

describe("X402Bridge", () => {
  let connection: Connection;
  let payer: Keypair;
  let recipient: string;

  beforeEach(() => {
    vi.clearAllMocks();
    connection = {
      getBalance: vi.fn(),
      getLatestBlockhash: vi.fn().mockResolvedValue({
        blockhash: "test-blockhash",
        lastValidBlockHeight: 1000,
      }),
      getRecentBlockhash: vi.fn().mockResolvedValue({
        blockhash: "test-blockhash",
        feeCalculator: { lamportsPerSignature: 5000 },
      }),
    } as unknown as Connection;
    payer = Keypair.generate();
    recipient = Keypair.generate().publicKey.toBase58();
  });

  // ---- Validation ----

  it("validates a correct payment request", () => {
    const bridge = new X402Bridge(connection, payer);
    expect(() => {
      bridge.validatePaymentRequest({
        recipient,
        amountLamports: 100_000n,
      });
    }).not.toThrow();
  });

  it("rejects invalid recipient address", () => {
    const bridge = new X402Bridge(connection, payer);
    expect(() => {
      bridge.validatePaymentRequest({
        recipient: "not-a-valid-address!!!",
        amountLamports: 100_000n,
      });
    }).toThrow(ValidationError);
  });

  it("rejects zero amount", () => {
    const bridge = new X402Bridge(connection, payer);
    expect(() => {
      bridge.validatePaymentRequest({
        recipient,
        amountLamports: 0n,
      });
    }).toThrow(ValidationError);
  });

  it("rejects negative amount", () => {
    const bridge = new X402Bridge(connection, payer);
    expect(() => {
      bridge.validatePaymentRequest({
        recipient,
        amountLamports: -1n,
      });
    }).toThrow(ValidationError);
  });

  it("rejects amount exceeding max cap", () => {
    const bridge = new X402Bridge(connection, payer, {
      maxPaymentLamports: 500_000n,
    });
    expect(() => {
      bridge.validatePaymentRequest({
        recipient,
        amountLamports: 500_001n,
      });
    }).toThrow(BridgePaymentError);
  });

  it("rejects memo exceeding max length", () => {
    const bridge = new X402Bridge(connection, payer);
    const longMemo = "x".repeat(257);
    expect(() => {
      bridge.validatePaymentRequest({
        recipient,
        amountLamports: 100n,
        memo: longMemo,
      });
    }).toThrow(ValidationError);
  });

  // ---- createPaymentRequest ----

  it("creates a validated payment request", () => {
    const bridge = new X402Bridge(connection, payer);
    const request = bridge.createPaymentRequest(
      recipient,
      50_000n,
      "test memo",
    );

    expect(request.recipient).toBe(recipient);
    expect(request.amountLamports).toBe(50_000n);
    expect(request.memo).toBe("test memo");
  });

  // ---- processPayment ----

  it("processes a valid payment", async () => {
    vi.mocked(connection.getBalance).mockResolvedValue(1_000_000_000);
    mockSendAndConfirm.mockResolvedValue("mock-sig-123");

    const bridge = new X402Bridge(connection, payer);
    const result = await bridge.processPayment({
      recipient,
      amountLamports: 100_000n,
    });

    expect(result.signature).toBe("mock-sig-123");
    expect(result.amountLamports).toBe(100_000n);
    expect(result.recipient).toBe(recipient);
  });

  it("throws BridgePaymentError on insufficient balance", async () => {
    vi.mocked(connection.getBalance).mockResolvedValue(50_000);

    const bridge = new X402Bridge(connection, payer);
    await expect(
      bridge.processPayment({
        recipient,
        amountLamports: 100_000n,
      }),
    ).rejects.toThrow(BridgePaymentError);
  });

  it("throws BridgePaymentError on transaction failure", async () => {
    vi.mocked(connection.getBalance).mockResolvedValue(1_000_000_000);
    mockSendAndConfirm.mockRejectedValue(new Error("Network error"));

    const bridge = new X402Bridge(connection, payer);
    await expect(
      bridge.processPayment({
        recipient,
        amountLamports: 100_000n,
      }),
    ).rejects.toThrow(BridgePaymentError);
  });
});
