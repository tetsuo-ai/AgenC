import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRuntime,
  buildVolumeInitScript,
  deriveDefaultInstance,
  parseArgs,
  sanitizeSegment,
} from "./private-registry-service.mjs";

test("sanitizeSegment normalizes arbitrary instance names", () => {
  assert.equal(sanitizeSegment("Feature/Worktree Alpha"), "feature-worktree-alpha");
});

test("deriveDefaultInstance uses CI metadata when present", () => {
  const instance = deriveDefaultInstance(
    {
      GITHUB_RUN_ID: "12345",
      GITHUB_JOB: "private-kernel-registry-validation",
    },
    "/tmp/ignored",
  );

  assert.equal(instance, "12345-private-kernel-registry-validation");
});

test("buildRuntime namespaces container and volume names by instance", () => {
  const options = parseArgs(["start", "--instance", "demo", "--mode", "locked", "--port", "4988"]);
  const runtime = buildRuntime(options);

  assert.equal(runtime.containerName, "agenc-private-registry-demo");
  assert.equal(runtime.storageVolume, "agenc-private-registry-storage-demo");
  assert.equal(runtime.authVolume, "agenc-private-registry-auth-demo");
  assert.equal(runtime.registryUrl, "http://127.0.0.1:4988");
  assert.match(runtime.mountedConfigPath, /\.tmp\/private-registry\/demo\/locked-config\.yaml$/);
});

test("buildVolumeInitScript prepares Verdaccio-owned auth and storage mounts", () => {
  const script = buildVolumeInitScript();

  assert.match(script, /mkdir -p \/mnt\/auth \/mnt\/storage/);
  assert.match(script, /chown -R 10001:65533 \/mnt\/auth \/mnt\/storage/);
  assert.match(script, /chmod 0775 \/mnt\/auth \/mnt\/storage/);
});
