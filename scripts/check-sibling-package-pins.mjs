#!/usr/bin/env node
// Warn when sibling package.json files pin stale @tetsuo-ai/* package versions.
// Vendored into the umbrella repo 2026-07-02 from agenc-core@6baf0baec
// (scripts/check-sibling-package-pins.mjs, deleted upstream in 7274fd9ed —
// the umbrella owns its own validation now; --root . walks every sibling).

import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies"];
const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "coverage",
  "node_modules",
]);
const NPM_VIEW_TIMEOUT_MS = 15_000;

export function isExactVersion(spec) {
  if (typeof spec !== "string") return false;
  try {
    parseVersion(spec);
    return true;
  } catch {
    return false;
  }
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] < b.core[i]) return -1;
    if (a.core[i] > b.core[i]) return 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

export function findPackageJsonFiles(root) {
  const out = [];
  walk(root, out);
  return out.sort((a, b) => relativePath(root, a).localeCompare(relativePath(root, b)));
}

export function collectPinnedTetsuoDependencies(root) {
  const packages = [];
  for (const packageJsonPath of findPackageJsonFiles(root)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    } catch (error) {
      throw new Error(`could not parse ${relativePath(root, packageJsonPath)}: ${error.message}`);
    }
    for (const field of DEPENDENCY_FIELDS) {
      const deps = parsed[field];
      if (!deps || typeof deps !== "object") continue;
      for (const [name, spec] of Object.entries(deps)) {
        if (!name.startsWith("@tetsuo-ai/")) continue;
        if (!isExactVersion(spec)) continue;
        packages.push({
          packageJsonPath,
          packageDir: path.dirname(packageJsonPath),
          field,
          name,
          spec,
        });
      }
    }
  }
  return packages;
}

export function buildPinStalenessReport(options = {}) {
  const root = path.resolve(options.root ?? resolveUmbrellaRoot(process.cwd()));
  const seededLatestVersions = options.latestVersions ?? new Map();
  const latestVersions =
    seededLatestVersions instanceof Map
      ? new Map(seededLatestVersions)
      : new Map(Object.entries(seededLatestVersions));
  const lookupLatest = options.lookupLatest ?? getLatestPublishedVersion;
  const pins = collectPinnedTetsuoDependencies(root);
  const stalePins = [];
  // Packages that never resolve on the registry (unpublished/private workspace
  // internals, e.g. the kit's @tetsuo-ai/marketplace-policy) are skipped with a
  // note instead of failing the whole sweep — this umbrella mixes public and
  // private repos.
  const unresolvedPackages = new Map();

  for (const pin of pins) {
    if (unresolvedPackages.has(pin.name)) continue;
    let latest = latestVersions.get(pin.name);
    if (!latest) {
      try {
        latest = lookupLatest(pin.name);
      } catch (error) {
        unresolvedPackages.set(pin.name, error.message);
        continue;
      }
      latestVersions.set(pin.name, latest);
    }
    if (compareVersions(pin.spec, latest) < 0) {
      stalePins.push({
        ...pin,
        latest,
        packageJson: relativePath(root, pin.packageJsonPath),
        packageDirRelative: relativePath(root, pin.packageDir),
        fixCommand: fixCommandForPin(root, pin, latest),
      });
    }
  }

  return {
    root,
    checkedPins: pins.length,
    stalePins,
    unresolvedPackages: Object.fromEntries(unresolvedPackages),
  };
}

function parseVersion(version) {
  const match =
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version,
    );
  if (!match) throw new Error(`not a semver version: ${version}`);
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;

  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i += 1) {
    const a = left[i];
    const b = right[i];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;

    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      const aNumber = Number(a);
      const bNumber = Number(b);
      if (aNumber < bNumber) return -1;
      if (aNumber > bNumber) return 1;
      continue;
    }
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    return a < b ? -1 : 1;
  }

  return 0;
}

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "package.json") {
      const file = path.join(dir, entry.name);
      if (statSync(file).isFile()) out.push(file);
      continue;
    }
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith(".") && entry.name !== ".agenc") continue;
    walk(path.join(dir, entry.name), out);
  }
}

export function getLatestPublishedVersion(packageName, options = {}) {
  const timeoutMs = options.timeoutMs ?? NPM_VIEW_TIMEOUT_MS;
  const spawn = options.spawnSyncFn ?? spawnSync;
  const result = spawn("npm", ["view", packageName, "version", "--silent"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
  });
  if (result.error) {
    if (result.error.code === "ETIMEDOUT" || result.signal === "SIGTERM") {
      throw new Error(`npm view ${packageName} version timed out after ${timeoutMs}ms`);
    }
    throw new Error(`npm view ${packageName} version failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `npm view ${packageName} version failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  const version = result.stdout.trim();
  if (!isExactVersion(version)) {
    throw new Error(`npm view ${packageName} returned invalid version: ${version}`);
  }
  return version;
}

function fixCommandForPin(root, pin, latest) {
  const saveFlag = pin.field === "devDependencies" ? "--save-dev" : "--save-prod";
  return [
    "npm",
    "install",
    `${pin.name}@${latest}`,
    "--save-exact",
    saveFlag,
    "--prefix",
    shellQuote(relativePath(root, pin.packageDir)),
  ].join(" ");
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function relativePath(root, file) {
  return path.relative(root, file).split(path.sep).join("/") || ".";
}

function resolveUmbrellaRoot(cwd) {
  const explicit = process.env.AGENC_UMBRELLA_ROOT;
  if (explicit) return explicit;

  const commonDir = gitCommonDir(cwd);
  if (commonDir && path.basename(commonDir) === ".git") {
    const mainCheckout = path.dirname(commonDir);
    const parent = path.dirname(mainCheckout);
    if (existsSync(path.join(parent, "package.json"))) return parent;
  }

  for (const candidate of [cwd, path.resolve(cwd, ".."), path.resolve(cwd, "..", "..")]) {
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
  }
  throw new Error("could not locate AgenC umbrella root; pass --root <path>");
}

function gitCommonDir(cwd) {
  const result = spawnSync("git", ["rev-parse", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return null;
  return path.resolve(cwd, result.stdout.trim());
}

function loadLatestVersions(filePath) {
  const parsed = JSON.parse(readFileSync(filePath, "utf8"));
  return new Map(Object.entries(parsed));
}

function parseArgs(argv) {
  const parsed = {
    root: undefined,
    latestVersions: undefined,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      const value = argv[i + 1];
      if (!value) throw new Error("--root requires a value");
      parsed.root = value;
      i += 1;
    } else if (arg === "--latest-json") {
      const value = argv[i + 1];
      if (!value) throw new Error("--latest-json requires a value");
      parsed.latestVersions = loadLatestVersions(value);
      i += 1;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function usage() {
  process.stderr.write(
    [
      "Usage: node scripts/check-sibling-package-pins.mjs [--root <umbrella-root>] [--latest-json <file>] [--json]",
      "",
      "Warns when package.json dependencies/devDependencies pin stale @tetsuo-ai/* versions.",
    ].join("\n") + "\n",
  );
}

function printReport(report) {
  const unresolved = Object.entries(report.unresolvedPackages ?? {});
  for (const [name, reason] of unresolved) {
    process.stdout.write(
      `note: ${name} not resolvable on the registry (unpublished/private?) — pins skipped. (${reason.split("\n")[0]})\n`,
    );
  }
  if (report.stalePins.length === 0) {
    process.stdout.write(
      `checked ${report.checkedPins} pinned @tetsuo-ai package(s); no stale pins found\n`,
    );
    return;
  }
  for (const pin of report.stalePins) {
    process.stdout.write(
      [
        `warning: ${pin.packageJson} ${pin.field}.${pin.name} pins ${pin.spec}; latest published is ${pin.latest}.`,
        `fix: ${pin.fixCommand}`,
      ].join("\n") + "\n",
    );
  }
  process.stdout.write(
    `checked ${report.checkedPins} pinned @tetsuo-ai package(s); ${report.stalePins.length} stale pin(s) warned\n`,
  );
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = buildPinStalenessReport(args);
    if (args.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      printReport(report);
    }
    process.exit(0);
  } catch (error) {
    process.stderr.write(`sibling package pin check failed: ${error.message}\n`);
    process.exit(2);
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(fileURLToPath(import.meta.url)) ===
      realpathSync(path.resolve(process.argv[1]))
    );
  } catch {
    return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  }
}

if (isMainModule()) {
  await main();
}
