import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";

const workspaceDir = path.dirname(fileURLToPath(import.meta.url));
const benchmarkScriptPath = path.join(workspaceDir, "benchmark-private-e2e.mts");

test("benchmark-private-e2e reaches the verifier-stack check path", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "agenc-private-bench-"));
  const authorityKeypairPath = path.join(tempDir, "authority.json");
  writeFileSync(
    authorityKeypairPath,
    JSON.stringify(Array.from(Keypair.generate().secretKey)),
  );

  try {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        benchmarkScriptPath,
        "--prover-endpoint",
        "http://127.0.0.1:65535",
      ],
      {
        cwd: workspaceDir,
        encoding: "utf8",
        env: {
          ...process.env,
          ANCHOR_PROVIDER_URL: "http://127.0.0.1:65535",
          ANCHOR_WALLET: authorityKeypairPath,
        },
      },
    );

    assert.notEqual(result.status, 0);
    assert.doesNotMatch(
      result.stderr,
      /(@tetsuo-ai\/runtime|ProofEngine|TaskOperations|taskStatusToString)/u,
    );
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /(fetch failed|ECONNREFUSED|connect|error sending request)/iu,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
