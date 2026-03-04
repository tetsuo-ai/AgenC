#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const DEFAULT_BASELINE = "docs/security/fender-medium-baseline.json";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--scan") {
      args.scan = argv[i + 1];
      i += 1;
    } else if (token === "--baseline") {
      args.baseline = argv[i + 1];
      i += 1;
    } else if (token === "--help" || token === "-h") {
      args.help = true;
    }
  }
  return args;
}

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/check-fender-baseline.mjs --scan <scan-output-file> [--baseline <baseline-json>]",
      "",
      "Example:",
      "  node scripts/check-fender-baseline.mjs \\",
      "    --scan .tmp/fender-program-scan-final.txt \\",
      "    --baseline docs/security/fender-medium-baseline.json",
    ].join("\n"),
  );
}

function parseFindings(markdown) {
  const lines = markdown.split(/\r?\n/);
  const findings = [];

  let file = null;
  let severity = null;
  let location = null;

  for (const line of lines) {
    if (line.startsWith("### File: ")) {
      file = line.slice("### File: ".length).trim();
      severity = null;
      location = null;
      continue;
    }

    if (line.startsWith("**Severity**: ")) {
      severity = line.slice("**Severity**: ".length).trim();
      continue;
    }

    if (line.startsWith("**Location**: ")) {
      location = line.slice("**Location**: ".length).trim();
      continue;
    }

    if (line.startsWith("**Description**: ")) {
      const description = line.slice("**Description**: ".length).trim();
      if (file && severity) {
        findings.push({
          file,
          severity,
          location: location ?? "",
          description,
        });
      }
      severity = null;
      location = null;
    }
  }

  return findings;
}

function matchesEntry(finding, entry) {
  if (finding.severity !== entry.severity) return false;
  if (finding.file !== entry.file) return false;

  if (entry.locationRegex) {
    const regex = new RegExp(entry.locationRegex);
    if (!regex.test(finding.location)) return false;
  }

  if (entry.descriptionRegex) {
    const regex = new RegExp(entry.descriptionRegex);
    if (!regex.test(finding.description)) return false;
  }

  return true;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.scan) {
    usage();
    process.exit(args.help ? 0 : 2);
  }

  const scanPath = path.resolve(process.cwd(), args.scan);
  const baselinePath = path.resolve(process.cwd(), args.baseline ?? DEFAULT_BASELINE);

  const scanRaw = fs.readFileSync(scanPath, "utf8");
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const allowlist = Array.isArray(baseline.allowlist) ? baseline.allowlist : [];

  const findings = parseFindings(scanRaw);
  const gated = findings.filter((f) =>
    f.severity === "Medium" || f.severity === "High" || f.severity === "Critical",
  );

  const unexpected = [];
  for (const finding of gated) {
    const matched = allowlist.some((entry) => matchesEntry(finding, entry));
    if (!matched) unexpected.push(finding);
  }

  const staleEntries = [];
  for (const entry of allowlist) {
    const matched = gated.some((finding) => matchesEntry(finding, entry));
    if (!matched) staleEntries.push(entry);
  }

  console.log(
    `Fender gate: scanned ${gated.length} medium+ findings, baseline entries ${allowlist.length}.`,
  );

  if (unexpected.length > 0) {
    console.error("\nUnexpected medium+ findings:");
    for (const finding of unexpected) {
      console.error(
        `- ${finding.severity} ${finding.file} ${finding.location}: ${finding.description}`,
      );
    }
  }

  if (staleEntries.length > 0) {
    console.error("\nStale baseline entries (no longer present in current scan):");
    for (const entry of staleEntries) {
      console.error(`- ${entry.id}: ${entry.file} ${entry.locationRegex}`);
    }
  }

  if (unexpected.length > 0 || staleEntries.length > 0) {
    process.exit(1);
  }

  console.log("Fender baseline gate passed.");
}

main();
