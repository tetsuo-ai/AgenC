#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const workspaceRoot = path.join(repoRoot, "tools", "zk-admin");

const failures = [];

function readJson(relPath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relPath), "utf8"));
}

function readWorkspaceFiles(rootDir) {
  const files = [];
  for (const entry of readdirSync(rootDir)) {
    const absPath = path.join(rootDir, entry);
    const stat = statSync(absPath);
    if (stat.isDirectory()) {
      continue;
    }
    if (
      entry.endsWith(".ts")
      || entry.endsWith(".mts")
      || entry.endsWith(".md")
      || entry === "package.json"
    ) {
      files.push(absPath);
    }
  }
  return files;
}

function relativeWorkspacePath(absPath) {
  return path.relative(repoRoot, absPath);
}

const workspacePkg = readJson("tools/zk-admin/package.json");
if (workspacePkg.dependencies?.["@tetsuo-ai/runtime"]) {
  failures.push("tools/zk-admin/package.json still depends on @tetsuo-ai/runtime");
}
if (!workspacePkg.dependencies?.["@tetsuo-ai/protocol"]) {
  failures.push("tools/zk-admin/package.json is missing @tetsuo-ai/protocol");
}

const forbiddenPatterns = [
  {
    pattern: /@tetsuo-ai\/runtime/u,
    reason: "imports or references @tetsuo-ai/runtime",
  },
  {
    pattern: /(?:\.\.\/)+runtime\//u,
    reason: "reaches into runtime source by relative path",
  },
  {
    pattern: /scripts\/setup-verifier-localnet/u,
    reason: "assumes AgenC-root verifier bootstrap scripts in package-local docs or help text",
  },
  {
    pattern: /scripts\/run-e2e-zk-local/u,
    reason: "assumes AgenC-root e2e wrapper scripts in package-local docs or help text",
  },
  {
    pattern: /scripts\/agenc-localnet-soak-launch/u,
    reason: "assumes AgenC-root soak wrappers in package-local docs or help text",
  },
];

for (const absPath of readWorkspaceFiles(workspaceRoot)) {
  const relPath = relativeWorkspacePath(absPath);
  const contents = readFileSync(absPath, "utf8");
  for (const { pattern, reason } of forbiddenPatterns) {
    if (pattern.test(contents)) {
      failures.push(`${relPath} ${reason}`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `prover extraction boundary check failed:\n- ${failures.join("\n- ")}\n`,
  );
  process.exit(1);
}

process.stdout.write("prover extraction boundary check passed.\n");
