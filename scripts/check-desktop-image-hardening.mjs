#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const DOCKERFILE_PATH = path.join(ROOT, "containers/desktop/Dockerfile");
const GUEST_CARGO_TOML_PATH = path.join(ROOT, "zkvm/methods/guest/Cargo.toml");

function fail(message) {
  console.error(`desktop hardening check failed: ${message}`);
  process.exit(1);
}

function extractAptInstallBlock(dockerfile) {
  const match = dockerfile.match(
    /RUN apt-get update[\s\S]*?apt-get install -y --no-install-recommends[\s\S]*?&& locale-gen en_US\.UTF-8/,
  );
  return match?.[0] ?? "";
}

function assertDoesNotContainAptPackage(aptBlock, packageName) {
  const pattern = new RegExp(`\\b${packageName}\\b`);
  if (pattern.test(aptBlock)) {
    fail(`apt install block contains forbidden package "${packageName}"`);
  }
}

async function main() {
  const [dockerfile, guestCargoToml] = await Promise.all([
    fs.readFile(DOCKERFILE_PATH, "utf8"),
    fs.readFile(GUEST_CARGO_TOML_PATH, "utf8"),
  ]);

  if (!/^FROM ubuntu:24\.04$/m.test(dockerfile)) {
    fail('desktop image base must be "ubuntu:24.04"');
  }

  if (!/RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends/.test(dockerfile)) {
    fail("missing apt upgrade stage before install");
  }

  const aptBlock = extractAptInstallBlock(dockerfile);
  if (!aptBlock) {
    fail("could not locate apt install block");
  }

  assertDoesNotContainAptPackage(aptBlock, "imagemagick");
  assertDoesNotContainAptPackage(aptBlock, "epiphany-browser");
  assertDoesNotContainAptPackage(aptBlock, "ffmpeg");

  if (!/FFMPEG_BIN="\$\(find \$\{PLAYWRIGHT_BROWSERS_PATH\} -path '\*\/ffmpeg-linux' \| head -n1\)"/.test(dockerfile)) {
    fail("missing playwright ffmpeg discovery");
  }

  if (!/ln -sf "\$FFMPEG_BIN" \/usr\/bin\/ffmpeg/.test(dockerfile)) {
    fail("missing ffmpeg symlink to playwright binary");
  }

  if (/risc0-zkvm\s*=\s*\{[^}]*features\s*=\s*\[\s*"std"\s*\][^}]*\}/.test(guestCargoToml)) {
    fail('zkvm/methods/guest must not force `risc0-zkvm` "std" feature');
  }

  console.log("desktop hardening check passed.");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  fail(message);
});
