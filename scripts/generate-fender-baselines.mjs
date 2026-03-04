#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { sharedBaseline } from "./fender-baseline-shared.mjs";

const MEDIUM_PATH = "docs/security/fender-medium-baseline.json";
const FULL_PATH = "docs/security/fender-full-baseline.json";

function toAbs(relPath) {
  return path.resolve(process.cwd(), relPath);
}

function withPrefix(entry, prefix) {
  return {
    ...entry,
    file: `${prefix}${entry.file}`,
  };
}

function writeJson(relPath, data) {
  fs.writeFileSync(toAbs(relPath), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function main() {
  const {
    tool,
    version,
    programScope,
    fullScope,
    programPathPrefix,
    programAllowlist,
    fullExtraAllowlist,
  } = sharedBaseline;

  if (!Array.isArray(programAllowlist) || !Array.isArray(fullExtraAllowlist)) {
    throw new Error("Shared baseline config must include array fields: programAllowlist and fullExtraAllowlist");
  }

  const mediumBaseline = {
    tool,
    scope: programScope,
    version,
    allowlist: programAllowlist,
  };

  const fullBaseline = {
    tool,
    scope: fullScope,
    version,
    allowlist: [
      ...fullExtraAllowlist,
      ...programAllowlist.map((entry) => withPrefix(entry, programPathPrefix)),
    ],
  };

  writeJson(MEDIUM_PATH, mediumBaseline);
  writeJson(FULL_PATH, fullBaseline);

  console.log(`Wrote ${MEDIUM_PATH}`);
  console.log(`Wrote ${FULL_PATH}`);
}

main();
