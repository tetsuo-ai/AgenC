#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
const packageDir = path.dirname(packageJsonPath);

function collectPackageEntryPaths(packageManifest) {
  const paths = new Set();

  const maybeAdd = (value) => {
    if (typeof value !== "string") {
      return;
    }
    if (value.startsWith("./")) {
      paths.add(value.slice(2));
      return;
    }
    if (!value.startsWith("/")) {
      paths.add(value);
    }
  };

  maybeAdd(packageManifest.main);
  maybeAdd(packageManifest.module);
  maybeAdd(packageManifest.types);

  if (packageManifest.bin && typeof packageManifest.bin === "object") {
    for (const binTarget of Object.values(packageManifest.bin)) {
      maybeAdd(binTarget);
    }
  } else {
    maybeAdd(packageManifest.bin);
  }

  const walkExports = (value) => {
    if (typeof value === "string") {
      maybeAdd(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        walkExports(entry);
      }
      return;
    }
    if (value && typeof value === "object") {
      for (const entry of Object.values(value)) {
        walkExports(entry);
      }
    }
  };

  walkExports(packageManifest.exports);
  return [...paths];
}

async function main() {
  const packageManifest = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const missingPaths = [];

  for (const relPath of collectPackageEntryPaths(packageManifest)) {
    if (relPath.startsWith("node:") || relPath.startsWith("#")) {
      continue;
    }

    const fullPath = path.join(packageDir, relPath);
    try {
      await access(fullPath);
    } catch {
      missingPaths.push(relPath);
    }
  }

  if (missingPaths.length > 0) {
    throw new Error(
      `runtime package metadata references missing built entries:\n- ${missingPaths.join("\n- ")}`,
    );
  }

  process.stdout.write(
    `[runtime build contract] verified ${packageManifest.name} entrypoints (${collectPackageEntryPaths(packageManifest).length})\n`,
  );
}

await main();
