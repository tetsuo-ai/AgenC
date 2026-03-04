#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const TARGET_DIRS = [
  "programs/agenc-coordination/src",
  "zkvm/host/src",
  "zkvm/methods",
];
const EXCLUDED_FILES = new Set([
  "programs/agenc-coordination/src/utils/borsh.rs",
]);
const BANNED_PATTERN = /\b[A-Za-z_][A-Za-z0-9_:<>]*::try_from_slice\s*\(/;

function fail(message) {
  console.error(`borsh zst guard failed: ${message}`);
  process.exit(1);
}

async function walkRustFiles(dirPath, out) {
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const absPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await walkRustFiles(absPath, out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".rs")) {
      out.push(absPath);
    }
  }
}

async function main() {
  const rustFiles = [];
  for (const relDir of TARGET_DIRS) {
    await walkRustFiles(path.join(ROOT, relDir), rustFiles);
  }

  const violations = [];
  for (const absFile of rustFiles) {
    const relFile = path.relative(ROOT, absFile);
    if (EXCLUDED_FILES.has(relFile)) continue;

    const source = await fs.readFile(absFile, "utf8");
    const lines = source.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const trimmed = line.trim();
      if (trimmed.startsWith("//")) continue;
      if (BANNED_PATTERN.test(line)) {
        violations.push({
          file: relFile,
          line: index + 1,
          snippet: trimmed,
        });
      }
    }
  }

  if (violations.length > 0) {
    console.error("Direct `::try_from_slice(...)` usage is disallowed in guarded paths.");
    console.error(
      "Use `crate::utils::borsh::try_from_slice_non_zst::<Type>(...)` instead.",
    );
    for (const violation of violations) {
      console.error(`- ${violation.file}:${violation.line}: ${violation.snippet}`);
    }
    process.exit(1);
  }

  console.log("borsh zst guard passed.");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  fail(message);
});
