#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const LOCKFILES = [
  path.join(ROOT, "programs/agenc-coordination/Cargo.lock"),
  path.join(ROOT, "zkvm/Cargo.lock"),
];

const MIN_BORSH_VERSION = "0.10.4";
const MIN_ZKVM_TRACING_SUBSCRIBER_VERSION = "0.3.20";

function fail(message) {
  console.error(`cargo lock security check failed: ${message}`);
  process.exit(1);
}

function parseVersion(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
  if (!match) {
    throw new Error(`Unsupported version format: ${version}`);
  }

  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    prerelease: match[4] ?? null,
  };
}

function comparePrerelease(a, b) {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;

  const aParts = a.split(".");
  const bParts = b.split(".");
  const maxLength = Math.max(aParts.length, bParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const aPart = aParts[index];
    const bPart = bParts[index];

    if (aPart === undefined) return -1;
    if (bPart === undefined) return 1;
    if (aPart === bPart) continue;

    const aNumber = /^\d+$/.test(aPart) ? Number.parseInt(aPart, 10) : null;
    const bNumber = /^\d+$/.test(bPart) ? Number.parseInt(bPart, 10) : null;

    if (aNumber !== null && bNumber !== null) {
      return aNumber === bNumber ? 0 : aNumber < bNumber ? -1 : 1;
    }
    if (aNumber !== null && bNumber === null) return -1;
    if (aNumber === null && bNumber !== null) return 1;
    return aPart < bPart ? -1 : 1;
  }

  return 0;
}

function compareVersions(left, right) {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);

  if (leftVersion.major !== rightVersion.major) {
    return leftVersion.major < rightVersion.major ? -1 : 1;
  }
  if (leftVersion.minor !== rightVersion.minor) {
    return leftVersion.minor < rightVersion.minor ? -1 : 1;
  }
  if (leftVersion.patch !== rightVersion.patch) {
    return leftVersion.patch < rightVersion.patch ? -1 : 1;
  }
  return comparePrerelease(leftVersion.prerelease, rightVersion.prerelease);
}

function parsePackages(lockContents) {
  return lockContents
    .split("[[package]]")
    .slice(1)
    .map((entry) => {
      const nameMatch = entry.match(/^\s*name = "([^"]+)"/m);
      const versionMatch = entry.match(/^\s*version = "([^"]+)"/m);
      if (!nameMatch || !versionMatch) return null;
      return { name: nameMatch[1], version: versionMatch[1] };
    })
    .filter(Boolean);
}

function collectVersions(packages, packageName) {
  return [...new Set(packages.filter((pkg) => pkg.name === packageName).map((pkg) => pkg.version))].sort(compareVersions);
}

async function readLockfiles() {
  const entries = await Promise.all(
    LOCKFILES.map(async (lockPath) => {
      const contents = await fs.readFile(lockPath, "utf8");
      return { lockPath, packages: parsePackages(contents) };
    }),
  );
  return entries;
}

async function main() {
  const lockfiles = await readLockfiles();

  for (const { lockPath, packages } of lockfiles) {
    const borshVersions = collectVersions(packages, "borsh");
    for (const version of borshVersions) {
      if (compareVersions(version, MIN_BORSH_VERSION) < 0) {
        fail(
          `${path.relative(ROOT, lockPath)} contains borsh ${version} < ${MIN_BORSH_VERSION}; this reintroduces GHSA-fjx5-qpf4-xjf2 risk`,
        );
      }
    }
  }

  const zkvmLock = lockfiles.find(({ lockPath }) => lockPath.endsWith(path.normalize("zkvm/Cargo.lock")));
  if (!zkvmLock) {
    fail("missing zkvm/Cargo.lock from lockfile set");
  }

  const tracingSubscriberVersions = collectVersions(zkvmLock.packages, "tracing-subscriber");
  for (const version of tracingSubscriberVersions) {
    if (compareVersions(version, MIN_ZKVM_TRACING_SUBSCRIBER_VERSION) < 0) {
      fail(
        `zkvm/Cargo.lock contains tracing-subscriber ${version} < ${MIN_ZKVM_TRACING_SUBSCRIBER_VERSION}; this reintroduces CVE-2025-58160 risk`,
      );
    }
  }

  console.log("cargo lock security check passed.");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  fail(message);
});
