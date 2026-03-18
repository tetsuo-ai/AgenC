import test from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";

import {
  buildUserConfigContent,
  isUnsupportedRegistryProbe,
  withTemporaryUserConfig,
} from "./private-kernel-distribution.mjs";

test("buildUserConfigContent renders scope mapping and auth token", () => {
  const rendered = buildUserConfigContent(
    "http://127.0.0.1:4873",
    "@tetsuo-ai-private",
    "secret-token",
  );

  assert.match(rendered, /^registry=http:\/\/127\.0\.0\.1:4873/m);
  assert.match(rendered, /@tetsuo-ai-private:registry=http:\/\/127\.0\.0\.1:4873/);
  assert.match(rendered, /_authToken=secret-token/);
});

test("buildUserConfigContent scopes Cloudsmith auth to the exact host and path", () => {
  const rendered = buildUserConfigContent(
    "https://npm.cloudsmith.io/agenc/private-kernel/",
    "@tetsuo-ai-private",
    "secret-token",
  );

  assert.match(rendered, /^registry=https:\/\/npm\.cloudsmith\.io\/agenc\/private-kernel\/$/m);
  assert.match(
    rendered,
    /^@tetsuo-ai-private:registry=https:\/\/npm\.cloudsmith\.io\/agenc\/private-kernel\/$/m,
  );
  assert.match(
    rendered,
    /^\/\/npm\.cloudsmith\.io\/agenc\/private-kernel\/:_authToken=secret-token$/m,
  );
  assert.doesNotMatch(rendered, /registry\.npmjs\.org/);
});

test("withTemporaryUserConfig cleans up the generated userconfig", async () => {
  let observedPath = null;

  await withTemporaryUserConfig(
    {
      registryUrl: "http://127.0.0.1:4873",
      scope: "@tetsuo-ai-private",
      token: "secret-token",
    },
    async (userConfigPath) => {
      observedPath = userConfigPath;
      await access(userConfigPath);
    },
  );

  await assert.rejects(() => access(observedPath), /ENOENT/);
});

test("isUnsupportedRegistryProbe detects unsupported ping and whoami responses", () => {
  assert.equal(
    isUnsupportedRegistryProbe({
      stdout: "",
      stderr: "npm ERR! code E405\nnpm ERR! Method not allowed",
      error: null,
    }),
    true,
  );
  assert.equal(
    isUnsupportedRegistryProbe({
      stdout: "",
      stderr: "npm ERR! code E401\nnpm ERR! Unauthorized",
      error: null,
    }),
    false,
  );
});
