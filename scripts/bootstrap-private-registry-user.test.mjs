import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildRegistryUserEndpoint,
  buildRegistryUserPayload,
  readResponseMessage,
  readTokenFileIfExists,
} from "./bootstrap-private-registry-user.mjs";

test("buildRegistryUserPayload emits Verdaccio-compatible service account fields", () => {
  const payload = buildRegistryUserPayload({
    username: "alice",
    password: "hunter2",
    email: "alice@example.com",
  });

  assert.equal(payload.name, "alice");
  assert.equal(payload.password, "hunter2");
  assert.equal(payload.email, "alice@example.com");
  assert.equal(payload.type, "user");
  assert.deepEqual(payload.roles, []);
  assert.equal(typeof payload.date, "string");
});

test("buildRegistryUserEndpoint targets the Verdaccio couchdb user route", () => {
  assert.equal(
    buildRegistryUserEndpoint("http://127.0.0.1:4873", "agenc-ci"),
    "http://127.0.0.1:4873/-/user/org.couchdb.user:agenc-ci",
  );
});

test("readResponseMessage prefers structured registry messages", () => {
  assert.equal(readResponseMessage({ error: "username is already registered" }, ""), "username is already registered");
  assert.equal(readResponseMessage({ ok: "user created" }, ""), "user created");
  assert.equal(readResponseMessage({}, "fallback text"), "fallback text");
});

test("readTokenFileIfExists returns null for missing files and trims existing tokens", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agenc-bootstrap-token-test-"));
  const tokenPath = path.join(tempDir, "token.txt");

  try {
    assert.equal(await readTokenFileIfExists(tokenPath), null);

    await writeFile(tokenPath, "secret-token\n", "utf8");
    assert.equal(await readTokenFileIfExists(tokenPath), "secret-token");
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});
