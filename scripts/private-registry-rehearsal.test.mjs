import assert from "node:assert/strict";
import test from "node:test";

import { isRetryableFreshPublishRead, parseArgs } from "./private-registry-rehearsal.mjs";

test("parseArgs defaults to the private scope and disables public-scope denial by default", () => {
  const options = parseArgs([], {
    PRIVATE_KERNEL_REGISTRY_TOKEN: "token",
  });

  assert.equal(options.registryUrl, "http://127.0.0.1:4873");
  assert.equal(options.scope, "@tetsuo-ai-private");
  assert.equal(options.fixtureOnly, false);
  assert.equal(options.expectPublicScopePublishDenied, false);
});

test("parseArgs enables public-scope denial when explicitly requested", () => {
  const options = parseArgs(["--expect-public-scope-publish-denied"], {
    PRIVATE_KERNEL_REGISTRY_TOKEN: "token",
  });

  assert.equal(options.expectPublicScopePublishDenied, true);
});

test("parseArgs accepts explicit fresh publish retry controls", () => {
  const options = parseArgs([
    "--fresh-publish-read-retries",
    "12",
    "--fresh-publish-read-delay-ms",
    "4500",
  ], {
    PRIVATE_KERNEL_REGISTRY_TOKEN: "token",
  });

  assert.equal(options.freshPublishReadRetries, 12);
  assert.equal(options.freshPublishReadDelayMs, 4500);
});

test("parseArgs still requires a token", () => {
  assert.throws(
    () => parseArgs([], {}),
    /PRIVATE_KERNEL_REGISTRY_TOKEN or --token is required/,
  );
});

test("parseArgs rejects invalid fresh publish retry controls", () => {
  assert.throws(
    () => parseArgs(["--fresh-publish-read-retries", "-1"], {
      PRIVATE_KERNEL_REGISTRY_TOKEN: "token",
    }),
    /--fresh-publish-read-retries must be a non-negative integer/,
  );

  assert.throws(
    () => parseArgs(["--fresh-publish-read-delay-ms", "not-a-number"], {
      PRIVATE_KERNEL_REGISTRY_TOKEN: "token",
    }),
    /--fresh-publish-read-delay-ms must be a non-negative integer/,
  );
});

test("isRetryableFreshPublishRead only retries fresh publish 404s", () => {
  assert.equal(
    isRetryableFreshPublishRead({
      status: 1,
      stdout: "",
      stderr: "npm error code E404\nThe requested resource could not be found",
    }),
    true,
  );

  assert.equal(
    isRetryableFreshPublishRead({
      status: 1,
      stdout: "",
      stderr: "npm error code E403\nforbidden",
    }),
    false,
  );

  assert.equal(
    isRetryableFreshPublishRead({
      status: 0,
      stdout: "",
      stderr: "",
    }),
    false,
  );
});
