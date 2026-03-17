#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PROFILE_DEFS = {
  roadmap: {
    description: "Legacy roadmap and issue-map path references.",
    targets: [
      { id: "docs-roadmap", type: "string", value: "docs/ROADMAP.md" },
      { id: "docs-issues-roadmap", type: "string", value: "docs/ISSUES_ROADMAP.md" },
      { id: "docs-issues-959-999", type: "string", value: "docs/ISSUES_959_999.md" },
      { id: "docs-issue-map", type: "string", value: "docs/architecture/issue-map.json" },
    ],
  },
  autonomy_stage2: {
    description: "autonomy_stage2 root fixture path or token references.",
    targets: [
      { id: "autonomy-stage2-path", type: "string", value: "autonomy_stage2.txt" },
      { id: "autonomy-stage2-token", type: "string", value: "AUTONOMY_STAGE2::FILE_OK" },
    ],
  },
  root_src: {
    description: "Legacy root src surface references.",
    targets: [
      { id: "root-src-grid-router", type: "string", value: "src/grid-router.ts" },
      { id: "root-src-grid-router-camel", type: "string", value: "src/gridRouter.ts" },
      { id: "root-src-legacy-surface", type: "string", value: "root `package.json` and `src/`" },
      { id: "root-src-legacy-name", type: "string", value: "grid-router-ts surface" },
      { id: "root-src-build-bearing", type: "string", value: "the root package and root `src/**` are build-bearing" },
      { id: "root-src-leftovers", type: "string", value: "treating the root package and root `src/**` as harmless leftovers" },
    ],
  },
  watch_paths: {
    description: "Watch test and fixture path references under scripts/.",
    targets: [
      { id: "watch-test-paths", type: "regex", value: "scripts/agenc-watch-[^\\s\"']+\\.test\\.mjs" },
      { id: "watch-fixture-paths", type: "regex", value: "scripts/fixtures/agenc-watch-[^\\s\"']+" },
    ],
  },
  eval_paths: {
    description: "Eval harness root path references.",
    targets: [
      { id: "eval-harness-root-cwd", type: "regex", value: "(?<!tools/eval)/agenc-eval-test\\.cjs" },
    ],
  },
};

const SCOPE_ENUM = new Set([
  "test_fixture",
  "historical_doc",
  "synthetic_reference",
  "migration_exception",
]);

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".mts",
  ".sh",
  ".test",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/check-cleanup-contracts.mjs --profile <name> [--allowlist <file>]",
      "",
      "Profiles:",
      ...Object.entries(PROFILE_DEFS).map(([key, value]) => `  - ${key}: ${value.description}`),
    ].join("\n"),
  );
}

function parseArgs(argv) {
  let profileName;
  let allowlistPath;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--profile" && i + 1 < argv.length) {
      profileName = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--allowlist" && i + 1 < argv.length) {
      allowlistPath = argv[i + 1];
      i += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  if (!profileName) {
    throw new Error("Missing required --profile");
  }
  return { profileName, allowlistPath };
}

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: process.cwd(),
    encoding: "utf8",
  }).trim();
}

function listRepoFiles(root) {
  const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  });
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((filePath) => fs.existsSync(path.join(root, filePath)))
    .filter((filePath) => isTextCandidate(filePath));
}

function isTextCandidate(filePath) {
  const base = path.basename(filePath);
  const ext = path.extname(filePath);
  if (TEXT_EXTENSIONS.has(ext)) return true;
  if (base === "Dockerfile") return true;
  if (base === "package.json" || base === "tsconfig.json" || base.startsWith("tsconfig.")) return true;
  if (base === "README" || base === "README.md") return true;
  return false;
}

function buildPattern(target) {
  if (target.type === "string") {
    return new RegExp(escapeRegExp(target.value), "g");
  }
  if (target.type === "regex") {
    return new RegExp(target.value, "g");
  }
  throw new Error(`Unsupported target type: ${target.type}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseAllowlist(filePath, root) {
  if (!filePath) return [];
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
  const raw = fs.readFileSync(absolutePath, "utf8");
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) {
    throw new Error("Allowlist must be a JSON array");
  }
  return data.map((entry, index) => validateAllowlistEntry(entry, index, absolutePath));
}

function validateAllowlistEntry(entry, index, sourcePath) {
  const requiredFields = ["path", "reason", "scope", "owner", "expires"];
  for (const field of requiredFields) {
    if (typeof entry?.[field] !== "string" || entry[field].trim() === "") {
      throw new Error(`Allowlist entry ${index} in ${sourcePath} missing valid ${field}`);
    }
  }
  if (!SCOPE_ENUM.has(entry.scope)) {
    throw new Error(
      `Allowlist entry ${index} in ${sourcePath} has invalid scope ${entry.scope}; expected one of ${Array.from(SCOPE_ENUM).join(", ")}`,
    );
  }
  const expires = `${entry.expires}T00:00:00Z`;
  const expiresDate = new Date(expires);
  if (Number.isNaN(expiresDate.getTime())) {
    throw new Error(`Allowlist entry ${index} in ${sourcePath} has invalid expires date ${entry.expires}`);
  }
  const today = new Date();
  const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  if (expiresDate < todayUtc) {
    throw new Error(`Allowlist entry ${index} in ${sourcePath} is expired (${entry.expires})`);
  }
  return {
    path: entry.path,
    pattern: typeof entry.pattern === "string" && entry.pattern.trim() !== "" ? entry.pattern : null,
    reason: entry.reason,
    scope: entry.scope,
    owner: entry.owner,
    expires: entry.expires,
  };
}

function computeLineIndex(content) {
  const offsets = [0];
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === "\n") offsets.push(i + 1);
  }
  return offsets;
}

function locate(offsets, position) {
  let low = 0;
  let high = offsets.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (offsets[mid] <= position) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  const lineIndex = Math.max(0, high);
  const lineStart = offsets[lineIndex];
  return {
    line: lineIndex + 1,
    column: position - lineStart + 1,
  };
}

function excerptForLine(content, line) {
  const lines = content.split(/\r?\n/);
  return String(lines[line - 1] ?? "");
}

function isAllowlisted(match, allowlist) {
  return allowlist.some((entry) => {
    if (entry.path !== match.path) return false;
    if (!entry.pattern) return true;
    return entry.pattern === match.targetValue || entry.pattern === match.targetId;
  });
}

function scanProfile({ root, files, profile, allowlist }) {
  const matches = [];
  for (const relativePath of files) {
    if (relativePath === "scripts/check-cleanup-contracts.mjs") {
      continue;
    }
    const absolutePath = path.join(root, relativePath);
    let content;
    try {
      content = fs.readFileSync(absolutePath, "utf8");
    } catch (error) {
      throw new Error(`Failed reading ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
    }

    const lineOffsets = computeLineIndex(content);
    for (const target of profile.targets) {
      const regex = buildPattern(target);
      for (const hit of content.matchAll(regex)) {
        const index = hit.index ?? 0;
        const location = locate(lineOffsets, index);
        const record = {
          targetId: target.id,
          targetType: target.type,
          targetValue: target.value,
          path: relativePath,
          line: location.line,
          column: location.column,
          excerpt: excerptForLine(content, location.line),
        };
        if (!isAllowlisted(record, allowlist)) {
          matches.push(record);
        }
      }
    }
  }
  return matches;
}

function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    usage();
    process.exit(1);
  }

  const profile = PROFILE_DEFS[parsed.profileName];
  if (!profile) {
    console.error(`Unknown profile: ${parsed.profileName}`);
    usage();
    process.exit(1);
  }

  try {
    const root = repoRoot();
    const files = listRepoFiles(root);
    const allowlist = parseAllowlist(parsed.allowlistPath, root);
    const matches = scanProfile({ root, files, profile, allowlist });

    const report = {
      schemaVersion: "1.0.0",
      phase: parsed.profileName,
      targets: profile.targets.map((target) => ({
        id: target.id,
        type: target.type,
        value: target.value,
      })),
      scannedFiles: files.length,
      allowlistEntries: allowlist.length,
      matches,
    };

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(matches.length === 0 ? 0 : 1);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(
      `${JSON.stringify(
        {
          schemaVersion: "1.0.0",
          phase: parsed.profileName,
          error: message,
          failedClosed: true,
        },
        null,
        2,
      )}\n`,
    );
    process.exit(1);
  }
}

main();
