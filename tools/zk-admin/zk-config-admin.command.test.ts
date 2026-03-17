import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";

const workspaceDir = path.dirname(fileURLToPath(import.meta.url));
const zkConfigScriptPath = path.join(workspaceDir, "zk-config-admin.ts");

test("zk-config show reaches the execution path beyond local helper wiring", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "agenc-zk-config-"));
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
        zkConfigScriptPath,
        "show",
        "--rpc-url",
        "http://127.0.0.1:65535",
        "--authority-keypair",
        authorityKeypairPath,
      ],
      {
        cwd: workspaceDir,
        encoding: "utf8",
      },
    );

    assert.notEqual(result.status, 0);
    assert.doesNotMatch(
      result.stderr,
      /(idlJson is not defined|AgencCoordination is not defined|createProgram)/u,
    );
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /(fetch failed|ECONNREFUSED|connect|failed to get info|error sending request)/iu,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
