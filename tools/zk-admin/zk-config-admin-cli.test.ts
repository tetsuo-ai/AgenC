import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PROGRAM_ID } from "@tetsuo-ai/sdk";
import {
  DEFAULT_AUTHORITY_KEYPAIR,
  DEFAULT_RPC_URL,
  parseImageId,
  parseZkConfigArgs,
} from "./zk-config-admin-cli.js";

test("parseImageId accepts hex input", () => {
  const parsed = parseImageId(`0x${"11".repeat(32)}`);
  assert.equal(parsed.length, 32);
  assert.equal(parsed[0], 0x11);
  assert.equal(parsed[31], 0x11);
});

test("parseZkConfigArgs applies defaults for show", () => {
  const options = parseZkConfigArgs(["show"]);
  assert.equal(options.command, "show");
  assert.equal(options.rpcUrl, DEFAULT_RPC_URL);
  assert.equal(options.programId, PROGRAM_ID.toBase58());
  assert.equal(
    options.authorityKeypairPath,
    path.resolve(
      DEFAULT_AUTHORITY_KEYPAIR.startsWith("~/")
        ? path.join(os.homedir(), DEFAULT_AUTHORITY_KEYPAIR.slice(2))
        : DEFAULT_AUTHORITY_KEYPAIR,
    ),
  );
});

test("parseZkConfigArgs requires --image-id for rotate", () => {
  assert.throws(
    () => parseZkConfigArgs(["rotate"]),
    /rotate requires --image-id/u,
  );
});
