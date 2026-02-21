import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  Keypair,
  Transaction,
  VersionedTransaction,
  SystemProgram,
  TransactionMessage,
} from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  keypairToWallet,
  loadKeypairFromFile,
  loadKeypairFromFileSync,
  getDefaultKeypairPath,
  loadDefaultKeypair,
  KeypairFileError,
  Wallet,
} from "./wallet";

describe("keypairToWallet", () => {
  it("returns wallet with correct publicKey", () => {
    const keypair = Keypair.generate();
    const wallet = keypairToWallet(keypair);

    expect(wallet.publicKey.equals(keypair.publicKey)).toBe(true);
  });

  it("signTransaction signs legacy Transaction", async () => {
    const keypair = Keypair.generate();
    const wallet = keypairToWallet(keypair);

    const tx = new Transaction();
    tx.recentBlockhash = "GfVcyD4kkTrj4bKc7WA9sZCin9JDbdT4Zkd3EittNR1W";
    tx.feePayer = keypair.publicKey;
    tx.add(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1000,
      }),
    );

    const signedTx = await wallet.signTransaction(tx);

    expect(signedTx).toBe(tx);
    expect(tx.signatures.length).toBeGreaterThan(0);
    expect(tx.signatures[0].signature).not.toBeNull();
  });

  it("signTransaction signs VersionedTransaction", async () => {
    const keypair = Keypair.generate();
    const wallet = keypairToWallet(keypair);

    const recentBlockhash = "GfVcyD4kkTrj4bKc7WA9sZCin9JDbdT4Zkd3EittNR1W";
    const message = new TransactionMessage({
      payerKey: keypair.publicKey,
      recentBlockhash,
      instructions: [
        SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: 1000,
        }),
      ],
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);

    const signedTx = await wallet.signTransaction(tx);

    expect(signedTx).toBe(tx);
    expect(tx.signatures.length).toBe(1);
    expect(tx.signatures[0]).not.toEqual(new Uint8Array(64));
  });

  it("signAllTransactions signs multiple transactions", async () => {
    const keypair = Keypair.generate();
    const wallet = keypairToWallet(keypair);

    const recentBlockhash = "GfVcyD4kkTrj4bKc7WA9sZCin9JDbdT4Zkd3EittNR1W";

    const tx1 = new Transaction();
    tx1.recentBlockhash = recentBlockhash;
    tx1.feePayer = keypair.publicKey;
    tx1.add(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1000,
      }),
    );

    const tx2 = new Transaction();
    tx2.recentBlockhash = recentBlockhash;
    tx2.feePayer = keypair.publicKey;
    tx2.add(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 2000,
      }),
    );

    const signedTxs = await wallet.signAllTransactions([tx1, tx2]);

    expect(signedTxs).toHaveLength(2);
    expect(signedTxs[0]).toBe(tx1);
    expect(signedTxs[1]).toBe(tx2);
    expect(tx1.signatures[0].signature).not.toBeNull();
    expect(tx2.signatures[0].signature).not.toBeNull();
  });

  it("implements Wallet interface", () => {
    const keypair = Keypair.generate();
    const wallet = keypairToWallet(keypair);

    // Type assertion - this should compile without errors
    const _walletInterface: Wallet = wallet;
    expect(_walletInterface).toBeDefined();
  });
});

describe("loadKeypairFromFile", () => {
  const tmpDir = os.tmpdir();
  const validKeypairPath = path.join(tmpDir, "test-keypair-valid.json");
  const invalidJsonPath = path.join(tmpDir, "test-keypair-invalid.json");
  const wrongSizePath = path.join(tmpDir, "test-keypair-wrongsize.json");
  const invalidBytePath = path.join(tmpDir, "test-keypair-invalidbyte.json");
  const nonArrayPath = path.join(tmpDir, "test-keypair-nonarray.json");
  const negativeBytePath = path.join(tmpDir, "test-keypair-negative.json");
  const floatBytePath = path.join(tmpDir, "test-keypair-float.json");

  let testKeypair: Keypair;

  beforeAll(() => {
    testKeypair = Keypair.generate();

    // Write valid keypair file
    fs.writeFileSync(
      validKeypairPath,
      JSON.stringify(Array.from(testKeypair.secretKey)),
    );

    // Write invalid JSON file
    fs.writeFileSync(invalidJsonPath, "not valid json{");

    // Write wrong size array
    fs.writeFileSync(wrongSizePath, JSON.stringify([1, 2, 3, 4, 5]));

    // Write array with invalid byte value (> 255)
    const invalidBytes = Array(64).fill(0);
    invalidBytes[10] = 256;
    fs.writeFileSync(invalidBytePath, JSON.stringify(invalidBytes));

    // Write non-array JSON (object instead of array)
    fs.writeFileSync(nonArrayPath, JSON.stringify({ foo: "bar" }));

    // Write array with negative byte value
    const negativeBytes = Array(64).fill(0);
    negativeBytes[5] = -1;
    fs.writeFileSync(negativeBytePath, JSON.stringify(negativeBytes));

    // Write array with float byte value
    const floatBytes = Array(64).fill(0);
    floatBytes[3] = 1.5;
    fs.writeFileSync(floatBytePath, JSON.stringify(floatBytes));
  });

  afterAll(() => {
    // Cleanup test files
    const filesToClean = [
      validKeypairPath,
      invalidJsonPath,
      wrongSizePath,
      invalidBytePath,
      nonArrayPath,
      negativeBytePath,
      floatBytePath,
    ];
    for (const f of filesToClean) {
      try {
        fs.unlinkSync(f);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  it("loads valid keypair file", async () => {
    const loaded = await loadKeypairFromFile(validKeypairPath);

    expect(loaded.publicKey.equals(testKeypair.publicKey)).toBe(true);
    expect(loaded.secretKey).toEqual(testKeypair.secretKey);
  });

  it("throws KeypairFileError for missing file", async () => {
    const nonExistentPath = path.join(tmpDir, "does-not-exist.json");

    await expect(loadKeypairFromFile(nonExistentPath)).rejects.toThrow(
      KeypairFileError,
    );
    await expect(loadKeypairFromFile(nonExistentPath)).rejects.toThrow(
      `Keypair file not found: ${nonExistentPath}`,
    );
  });

  it("throws KeypairFileError for invalid JSON", async () => {
    await expect(loadKeypairFromFile(invalidJsonPath)).rejects.toThrow(
      KeypairFileError,
    );
    await expect(loadKeypairFromFile(invalidJsonPath)).rejects.toThrow(
      `Invalid JSON in keypair file: ${invalidJsonPath}`,
    );
  });

  it("throws KeypairFileError for wrong array size", async () => {
    await expect(loadKeypairFromFile(wrongSizePath)).rejects.toThrow(
      KeypairFileError,
    );
    await expect(loadKeypairFromFile(wrongSizePath)).rejects.toThrow(
      "must contain 64 bytes, got 5",
    );
  });

  it("throws KeypairFileError for invalid byte value", async () => {
    await expect(loadKeypairFromFile(invalidBytePath)).rejects.toThrow(
      KeypairFileError,
    );
    await expect(loadKeypairFromFile(invalidBytePath)).rejects.toThrow(
      "Invalid byte value at index 10: 256",
    );
  });

  it("throws KeypairFileError for non-array JSON", async () => {
    await expect(loadKeypairFromFile(nonArrayPath)).rejects.toThrow(
      KeypairFileError,
    );
    await expect(loadKeypairFromFile(nonArrayPath)).rejects.toThrow(
      "must contain a JSON array, got object",
    );
  });

  it("throws KeypairFileError for negative byte value", async () => {
    await expect(loadKeypairFromFile(negativeBytePath)).rejects.toThrow(
      KeypairFileError,
    );
    await expect(loadKeypairFromFile(negativeBytePath)).rejects.toThrow(
      "Invalid byte value at index 5: -1",
    );
  });

  it("throws KeypairFileError for float byte value", async () => {
    await expect(loadKeypairFromFile(floatBytePath)).rejects.toThrow(
      KeypairFileError,
    );
    await expect(loadKeypairFromFile(floatBytePath)).rejects.toThrow(
      "Invalid byte value at index 3: 1.5",
    );
  });
});

describe("loadKeypairFromFileSync", () => {
  const tmpDir = os.tmpdir();
  const validKeypairPath = path.join(tmpDir, "test-keypair-sync-valid.json");
  const invalidJsonPath = path.join(tmpDir, "test-keypair-sync-invalid.json");

  let testKeypair: Keypair;

  beforeAll(() => {
    testKeypair = Keypair.generate();

    fs.writeFileSync(
      validKeypairPath,
      JSON.stringify(Array.from(testKeypair.secretKey)),
    );

    fs.writeFileSync(invalidJsonPath, "not valid json{");
  });

  afterAll(() => {
    try {
      fs.unlinkSync(validKeypairPath);
    } catch {
      // Ignore
    }
    try {
      fs.unlinkSync(invalidJsonPath);
    } catch {
      // Ignore
    }
  });

  it("loads valid keypair file synchronously", () => {
    const loaded = loadKeypairFromFileSync(validKeypairPath);

    expect(loaded.publicKey.equals(testKeypair.publicKey)).toBe(true);
    expect(loaded.secretKey).toEqual(testKeypair.secretKey);
  });

  it("throws KeypairFileError for missing file", () => {
    const nonExistentPath = path.join(tmpDir, "sync-does-not-exist.json");

    expect(() => loadKeypairFromFileSync(nonExistentPath)).toThrow(
      KeypairFileError,
    );
    expect(() => loadKeypairFromFileSync(nonExistentPath)).toThrow(
      `Keypair file not found: ${nonExistentPath}`,
    );
  });

  it("throws KeypairFileError for invalid JSON", () => {
    expect(() => loadKeypairFromFileSync(invalidJsonPath)).toThrow(
      KeypairFileError,
    );
  });

  it("behaves identically to async version", async () => {
    const asyncResult = await loadKeypairFromFile(validKeypairPath);
    const syncResult = loadKeypairFromFileSync(validKeypairPath);

    expect(syncResult.publicKey.equals(asyncResult.publicKey)).toBe(true);
    expect(syncResult.secretKey).toEqual(asyncResult.secretKey);
  });
});

describe("getDefaultKeypairPath", () => {
  it("returns correct format", () => {
    const defaultPath = getDefaultKeypairPath();

    expect(defaultPath).toContain(".config");
    expect(defaultPath).toContain("solana");
    expect(defaultPath).toContain("id.json");
    expect(defaultPath.startsWith(os.homedir())).toBe(true);
  });

  it("returns path under home directory", () => {
    const defaultPath = getDefaultKeypairPath();
    const expectedPath = path.join(
      os.homedir(),
      ".config",
      "solana",
      "id.json",
    );

    expect(defaultPath).toBe(expectedPath);
  });
});

describe("loadDefaultKeypair", () => {
  it("attempts to load from default path", async () => {
    const defaultPath = getDefaultKeypairPath();

    // loadDefaultKeypair should either succeed (if default keypair exists)
    // or fail with an error referencing the default path
    try {
      const keypair = await loadDefaultKeypair();
      // If it succeeds, verify it returned a valid keypair
      expect(keypair.publicKey).toBeDefined();
      expect(keypair.secretKey).toHaveLength(64);
    } catch (err) {
      // If it fails, verify the error references the default path
      expect(err).toBeInstanceOf(KeypairFileError);
      expect((err as KeypairFileError).filePath).toBe(defaultPath);
    }
  });

  it("uses the same path as getDefaultKeypairPath", async () => {
    const defaultPath = getDefaultKeypairPath();

    // Both functions should reference the same path
    const loadDefaultResult = loadDefaultKeypair();
    const loadFromPathResult = loadKeypairFromFile(defaultPath);

    // Both should resolve/reject consistently
    const [defaultOutcome, pathOutcome] = await Promise.allSettled([
      loadDefaultResult,
      loadFromPathResult,
    ]);

    expect(defaultOutcome.status).toBe(pathOutcome.status);

    if (
      defaultOutcome.status === "fulfilled" &&
      pathOutcome.status === "fulfilled"
    ) {
      expect(
        defaultOutcome.value.publicKey.equals(pathOutcome.value.publicKey),
      ).toBe(true);
    }
  });
});

describe("KeypairFileError", () => {
  it("has correct name and message", () => {
    const error = new KeypairFileError("Test message", "/path/to/file.json");

    expect(error.name).toBe("KeypairFileError");
    expect(error.message).toBe("Test message");
    expect(error.filePath).toBe("/path/to/file.json");
    expect(error.cause).toBeUndefined();
  });

  it("preserves cause error", () => {
    const cause = new Error("Original error");
    const error = new KeypairFileError(
      "Wrapped message",
      "/path/to/file.json",
      cause,
    );

    expect(error.cause).toBe(cause);
  });

  it("is instanceof Error", () => {
    const error = new KeypairFileError("Test", "/path");

    expect(error instanceof Error).toBe(true);
    expect(error instanceof KeypairFileError).toBe(true);
  });
});
