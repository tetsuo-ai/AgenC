import { describe, it, expect } from "vitest";
import { PublicKey, Keypair } from "@solana/web3.js";
import { PrivacyClient } from "../client";

describe("PrivacyClient input validation (#963)", () => {
  it("rejects invalid RPC URL", () => {
    expect(() => new PrivacyClient({ rpcUrl: "not-a-url" })).toThrow(
      "Invalid RPC URL",
    );
  });

  it("rejects non-http RPC URL", () => {
    expect(() => new PrivacyClient({ rpcUrl: "ftp://example.com" })).toThrow(
      "http or https",
    );
  });

  it("accepts valid HTTP RPC URL", () => {
    expect(
      () => new PrivacyClient({ rpcUrl: "http://localhost:8899" }),
    ).not.toThrow();
  });

  it("accepts valid HTTPS RPC URL", () => {
    expect(
      () =>
        new PrivacyClient({ rpcUrl: "https://api.mainnet-beta.solana.com" }),
    ).not.toThrow();
  });

  it("accepts no RPC URL (defaults)", () => {
    expect(() => new PrivacyClient()).not.toThrow();
  });

  it("accepts proverConfig with remote backend", () => {
    expect(
      () =>
        new PrivacyClient({
          proverConfig: {
            kind: "remote",
            endpoint: "https://prover.example.com",
          },
        }),
    ).not.toThrow();
  });

  it("accepts proverConfig with local-binary backend", () => {
    expect(
      () =>
        new PrivacyClient({
          proverConfig: {
            kind: "local-binary",
            binaryPath: "/usr/bin/agenc-zkvm-host",
          },
        }),
    ).not.toThrow();
  });

  describe("completeTaskPrivate validation", () => {
    it("rejects when wallet not initialized", async () => {
      const client = new PrivacyClient({ rpcUrl: "http://localhost:8899" });
      await expect(
        client.completeTaskPrivate({
          taskPda: PublicKey.default,
          output: [1n, 2n, 3n, 4n],
        }),
      ).rejects.toThrow("not initialized");
    });

    it("rejects when program not initialized", async () => {
      const wallet = Keypair.generate();
      const client = new PrivacyClient({
        rpcUrl: "http://localhost:8899",
        wallet,
      });
      // init without IDL — program stays null
      await client.init(wallet);
      await expect(
        client.completeTaskPrivate({
          taskPda: PublicKey.default,
          output: [1n, 2n, 3n, 4n],
        }),
      ).rejects.toThrow("Program not initialized");
    });

    it("rejects when agentId not provided", async () => {
      const wallet = Keypair.generate();
      const client = new PrivacyClient({
        rpcUrl: "http://localhost:8899",
        wallet,
      });
      (client as any).program = {};
      await expect(
        client.completeTaskPrivate({
          taskPda: PublicKey.default,
          output: [1n, 2n, 3n, 4n],
        }),
      ).rejects.toThrow("Agent ID not provided");
    });

    it("rejects when proverConfig not provided", async () => {
      const wallet = Keypair.generate();
      const client = new PrivacyClient({
        rpcUrl: "http://localhost:8899",
        wallet,
        agentId: new Uint8Array(32).fill(1),
      });
      (client as any).program = {};
      await expect(
        client.completeTaskPrivate({
          taskPda: PublicKey.default,
          output: [1n, 2n, 3n, 4n],
        }),
      ).rejects.toThrow("requires proverConfig");
    });

    it("rejects invalid output array length", async () => {
      const wallet = Keypair.generate();
      const client = new PrivacyClient({
        rpcUrl: "http://localhost:8899",
        wallet,
        agentId: new Uint8Array(32).fill(1),
        proverConfig: { kind: "local-binary", binaryPath: "/test" },
      });
      (client as any).program = {};
      await expect(
        client.completeTaskPrivate({
          taskPda: PublicKey.default,
          output: [1n, 2n, 3n],
        }),
      ).rejects.toThrow("exactly 4");
    });

    it("rejects zero salt", async () => {
      const wallet = Keypair.generate();
      const client = new PrivacyClient({
        rpcUrl: "http://localhost:8899",
        wallet,
        agentId: new Uint8Array(32).fill(1),
        proverConfig: { kind: "local-binary", binaryPath: "/test" },
      });
      (client as any).program = {};
      await expect(
        client.completeTaskPrivate({
          taskPda: PublicKey.default,
          output: [1n, 2n, 3n, 4n],
          salt: 0n,
        }),
      ).rejects.toThrow("non-zero");
    });

    it("rejects negative bigint in output", async () => {
      const wallet = Keypair.generate();
      const client = new PrivacyClient({
        rpcUrl: "http://localhost:8899",
        wallet,
        agentId: new Uint8Array(32).fill(1),
        proverConfig: { kind: "local-binary", binaryPath: "/test" },
      });
      (client as any).program = {};
      await expect(
        client.completeTaskPrivate({
          taskPda: PublicKey.default,
          output: [1n, 2n, -1n, 4n],
        }),
      ).rejects.toThrow("output[2]");
    });
  });
});
