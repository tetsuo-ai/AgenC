#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

function snakeToCamelCase(value) {
  return value.replace(/_([a-z])/g, (_match, char) => char.toUpperCase());
}

function readFileText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function resolveInsideRoot(rootPath, relativePath) {
  // nosemgrep
  // Path resolution is followed by strict root-boundary checks below.
  const resolvedRoot = path.resolve(rootPath); // nosemgrep
  const resolvedPath = path.resolve(resolvedRoot, relativePath); // nosemgrep
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative.includes(`..${path.sep}`)
  ) {
    throw new Error(`Path escapes repository root: ${relativePath}`);
  }
  return resolvedPath;
}

function loadInstructionNames(repoRoot) {
  const libPath = resolveInsideRoot(repoRoot, path.join(
    "programs",
    "agenc-coordination",
    "src",
    "lib.rs",
  ));
  const libText = readFileText(libPath);
  const fnRegex = /pub fn\s+([a-zA-Z0-9_]+)\s*\(/g;
  const ignore = new Set(["initialize", "id"]);
  const instructionNames = [];

  let match = fnRegex.exec(libText);
  while (match !== null) {
    const name = match[1];
    if (!ignore.has(name)) {
      instructionNames.push(name);
    }
    match = fnRegex.exec(libText);
  }

  return instructionNames;
}

function loadTestFilePaths(repoRoot) {
  const output = childProcess
    .execSync("rg --files tests -g '*.ts'", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    .trim();

  if (!output) {
    return [];
  }

  return output.split("\n").map((relativePath) => resolveInsideRoot(repoRoot, relativePath));
}

function loadInvokedMethodNames(testFiles) {
  // Match first method call in chains like:
  // program.methods\n  .createTask(...)
  const callRegex = /\.methods[\s\S]{0,500}?\.(\w+)\(/g;
  const invoked = new Set();

  for (const filePath of testFiles) {
    const text = readFileText(filePath);
    let match = callRegex.exec(text);
    while (match !== null) {
      invoked.add(match[1]);
      match = callRegex.exec(text);
    }
  }

  return invoked;
}

function main() {
  const repoRoot = process.cwd();
  const instructions = loadInstructionNames(repoRoot);
  const testFiles = loadTestFilePaths(repoRoot);
  const invokedMethods = loadInvokedMethodNames(testFiles);

  const missing = [];
  for (const instruction of instructions) {
    const camel = snakeToCamelCase(instruction);
    if (!invokedMethods.has(camel) && !invokedMethods.has(instruction)) {
      missing.push({ instruction, expectedMethod: camel });
    }
  }

  const covered = instructions.length - missing.length;
  console.log(
    `[onchain-coverage] instructions referenced in tests: ${covered}/${instructions.length}`,
  );

  if (missing.length > 0) {
    console.error("[onchain-coverage] missing instruction coverage:");
    for (const item of missing) {
      console.error(
        `  - ${item.instruction} (expected test invocation: program.methods.${item.expectedMethod}(...))`,
      );
    }
    process.exit(1);
  }

  console.log("[onchain-coverage] all on-chain instructions are covered.");
}

main();
