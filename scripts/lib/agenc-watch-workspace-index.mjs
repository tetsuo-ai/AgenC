import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "logs",
  "target",
  ".tmp",
]);

function normalizePath(value) {
  return String(value ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
}

function basenameOf(value) {
  const normalized = normalizePath(value);
  const parts = normalized.split("/");
  return parts[parts.length - 1] ?? normalized;
}

function directoryOf(value) {
  const normalized = normalizePath(value);
  const parts = normalized.split("/");
  parts.pop();
  return parts.join("/");
}

function scoreFileMatch(record, query) {
  const normalizedQuery = String(query ?? "").trim().toLowerCase();
  if (!normalizedQuery) {
    return 1000 + record.path.length;
  }
  const pathValue = record.lowerPath;
  const basenameValue = record.lowerBasename;
  if (pathValue === normalizedQuery) {
    return 0;
  }
  if (basenameValue === normalizedQuery) {
    return 1;
  }
  if (pathValue.startsWith(normalizedQuery)) {
    return 2;
  }
  if (basenameValue.startsWith(normalizedQuery)) {
    return 3;
  }
  if (pathValue.includes(`/${normalizedQuery}`)) {
    return 4;
  }
  if (basenameValue.includes(normalizedQuery)) {
    return 5;
  }
  if (pathValue.includes(normalizedQuery)) {
    return 6;
  }
  return null;
}

function listFilesWithRipgrep(cwd, execFileSyncImpl) {
  const raw = execFileSyncImpl(
    "rg",
    [
      "--files",
      "--hidden",
      "-g",
      "!.git",
      "-g",
      "!node_modules",
      "-g",
      "!dist",
      "-g",
      "!build",
      "-g",
      "!coverage",
      "-g",
      "!logs",
      "-g",
      "!target",
      "-g",
      "!.tmp",
    ],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  return String(raw ?? "")
    .split(/\r?\n/)
    .map((line) => normalizePath(line))
    .filter(Boolean);
}

function walkFiles(rootDir, currentDir, results, fsImpl) {
  const entries = fsImpl.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (DEFAULT_IGNORED_DIRS.has(entry.name)) {
      continue;
    }
    const fullPath = path.join(currentDir, entry.name);
    const relativePath = normalizePath(path.relative(rootDir, fullPath));
    if (!relativePath) {
      continue;
    }
    if (entry.isDirectory()) {
      walkFiles(rootDir, fullPath, results, fsImpl);
      continue;
    }
    if (entry.isFile()) {
      results.push(relativePath);
    }
  }
}

export function createWorkspaceFileIndex(paths = [], { cwd = process.cwd() } = {}) {
  const unique = Array.from(
    new Set(
      (Array.isArray(paths) ? paths : [])
        .map((entry) => normalizePath(entry))
        .filter(Boolean),
    ),
  );
  const records = unique
    .map((relativePath) => ({
      path: relativePath,
      basename: basenameOf(relativePath),
      directory: directoryOf(relativePath),
      lowerPath: relativePath.toLowerCase(),
      lowerBasename: basenameOf(relativePath).toLowerCase(),
    }))
    .sort((left, right) =>
      left.path.length - right.path.length || left.path.localeCompare(right.path),
    );
  return {
    cwd,
    ready: true,
    error: null,
    files: records,
  };
}

export function loadWorkspaceFileIndex({
  cwd = process.cwd(),
  execFileSyncImpl = execFileSync,
  fsImpl = fs,
} = {}) {
  try {
    return createWorkspaceFileIndex(listFilesWithRipgrep(cwd, execFileSyncImpl), { cwd });
  } catch (ripgrepError) {
    try {
      const files = [];
      walkFiles(cwd, cwd, files, fsImpl);
      return {
        ...createWorkspaceFileIndex(files, { cwd }),
        error: null,
      };
    } catch (walkError) {
      const message =
        walkError instanceof Error
          ? walkError.message
          : ripgrepError instanceof Error
            ? ripgrepError.message
            : "workspace file index unavailable";
      return {
        cwd,
        ready: false,
        error: message,
        files: [],
      };
    }
  }
}

export function searchWorkspaceFileIndex(index, query, { limit = 8 } = {}) {
  const files = Array.isArray(index?.files) ? index.files : [];
  const ranked = [];
  for (const record of files) {
    const score = scoreFileMatch(record, query);
    if (score === null) {
      continue;
    }
    ranked.push({
      path: record.path,
      basename: record.basename,
      directory: record.directory,
      label: `@${record.path}`,
      score,
    });
  }
  return ranked
    .sort((left, right) =>
      left.score - right.score ||
      left.path.length - right.path.length ||
      left.path.localeCompare(right.path),
    )
    .slice(0, Math.max(1, Number(limit) || 8));
}
