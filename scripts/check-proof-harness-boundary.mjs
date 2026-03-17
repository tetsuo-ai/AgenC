#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const workspaceRoot = path.join(repoRoot, "tools", "proof-harness");
const legacyWorkspaceRoot = path.join(repoRoot, "tools", "zk-admin");

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

if (!existsSync(workspaceRoot)) {
  failures.push("tools/proof-harness is missing");
}

if (existsSync(legacyWorkspaceRoot)) {
  failures.push("legacy tools/zk-admin workspace still exists");
}

const rootPkg = readJson("package.json");
if (rootPkg.scripts?.["zk:config"]) {
  failures.push("package.json still exposes zk:config from AgenC root");
}
if (rootPkg.scripts?.["zk:devnet:preflight"]) {
  failures.push("package.json still exposes zk:devnet:preflight from AgenC root");
}

const workspacePkg = readJson("tools/proof-harness/package.json");
if (workspacePkg.dependencies?.["@tetsuo-ai/runtime"]) {
  failures.push("tools/proof-harness/package.json still depends on @tetsuo-ai/runtime");
}
if (!workspacePkg.dependencies?.["@tetsuo-ai/protocol"]) {
  failures.push("tools/proof-harness/package.json is missing @tetsuo-ai/protocol");
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
  {
    pattern: /zk:config/u,
    reason: "still references private admin wrapper commands in package-local docs or help text",
  },
  {
    pattern: /zk:devnet:preflight/u,
    reason: "still references private admin wrapper commands in package-local docs or help text",
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

const repoWideChecks = [
  {
    relPath: "REFACTOR.MD",
    pattern: /tools\/zk-admin|@tetsuo-ai\/zk-admin-tools|npm run zk:config|npm run zk:devnet:preflight/u,
    reason: "still references the removed AgenC admin surface",
  },
  {
    relPath: "REFACTOR-MASTER-PROGRAM.md",
    pattern: /tools\/zk-admin|@tetsuo-ai\/zk-admin-tools|npm run zk:config|npm run zk:devnet:preflight/u,
    reason: "still references the removed AgenC admin surface",
  },
  {
    relPath: "docs/MAINNET_DEPLOYMENT.md",
    pattern: /npm run zk:config/u,
    reason: "still instructs operators to use the removed AgenC admin wrapper",
  },
  {
    relPath: "docs/devnet-program-data.md",
    pattern: /@tetsuo-ai\/zk-admin-tools|npm run zk:config/u,
    reason: "still points operators at the removed AgenC admin workspace",
  },
  {
    relPath: "docs/PRIVACY_README.md",
    pattern: /tools\/zk-admin/u,
    reason: "still points demo/verification readers at the removed AgenC admin path",
  },
];

for (const { relPath, pattern, reason } of repoWideChecks) {
  const contents = readFileSync(path.join(repoRoot, relPath), "utf8");
  if (pattern.test(contents)) {
    failures.push(`${relPath} ${reason}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `proof-harness boundary check failed:\n- ${failures.join("\n- ")}\n`,
  );
  process.exit(1);
}

process.stdout.write("proof-harness boundary check passed.\n");
