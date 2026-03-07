#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

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

function tokenizeAptBlock(aptBlock) {
  return aptBlock
    .replace(/\\\r?\n/g, " ")
    .replace(/#[^\r\n]*/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function aptBlockContainsPackage(aptBlock, packageName) {
  if (!/^[A-Za-z0-9.+-]+$/.test(packageName)) {
    throw new Error(`invalid package name guard: "${packageName}"`);
  }
  const aptTokens = new Set(tokenizeAptBlock(aptBlock));
  return aptTokens.has(packageName);
}

function assertDoesNotContainAptPackage(aptBlock, packageName) {
  if (aptBlockContainsPackage(aptBlock, packageName)) {
    fail(`apt install block contains forbidden package "${packageName}"`);
  }
}

function hasSecurePathLauncherInstaller(dockerfile) {
  return (
    /COPY install-secure-path-launchers\.sh \/tmp\/install-secure-path-launchers\.sh/.test(dockerfile) &&
    /COPY secure-path-launchers\.txt \/tmp\/secure-path-launchers\.txt/.test(dockerfile) &&
    /\/tmp\/install-secure-path-launchers\.sh \/tmp\/secure-path-launchers\.txt/.test(dockerfile)
  );
}

function hasAdHocGamesSymlink(dockerfile) {
  return /ln -sf \/usr\/games\//.test(dockerfile);
}

async function main() {
  const [dockerfile, guestCargoToml] = await Promise.all([
    fs.readFile(DOCKERFILE_PATH, "utf8"),
    fs.readFile(GUEST_CARGO_TOML_PATH, "utf8"),
  ]);

  if (!/^FROM ubuntu:24\.04$/m.test(dockerfile)) {
    fail('desktop image base must be "ubuntu:24.04"');
  }

  if (!/apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends/.test(dockerfile)) {
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

  if (!hasSecurePathLauncherInstaller(dockerfile)) {
    fail("missing secure-path launcher manifest installer wiring");
  }

  if (hasAdHocGamesSymlink(dockerfile)) {
    fail("ad hoc /usr/games symlinks are forbidden; use the secure-path launcher manifest");
  }

  if (/risc0-zkvm\s*=\s*\{[^}]*features\s*=\s*\[\s*"std"\s*\][^}]*\}/.test(guestCargoToml)) {
    fail('zkvm/methods/guest must not force `risc0-zkvm` "std" feature');
  }

  console.log("desktop hardening check passed.");
}

const isCliEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCliEntrypoint) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    fail(message);
  });
}

export {
  aptBlockContainsPackage,
  extractAptInstallBlock,
  hasAdHocGamesSymlink,
  hasSecurePathLauncherInstaller,
  tokenizeAptBlock,
};
