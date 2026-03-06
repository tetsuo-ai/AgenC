#!/usr/bin/env node

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const COLORS = {
  red: "\u001b[0;31m",
  green: "\u001b[0;32m",
  yellow: "\u001b[1;33m",
  reset: "\u001b[0m",
};

const PRIVATE_COMPLETION_FILE =
  "programs/agenc-coordination/src/instructions/complete_task_private.rs";
const POLICY_TRANSCRIPT_FILE =
  "artifacts/risc0/router-policy/transcript.json";

const SOURCE_SECTION_DEFINITIONS = [
  {
    title: "Router Verifier Policy",
    checks: [
      {
        okMessage: "Trusted selector pinning present",
        failMessage: "Missing trusted selector pinning",
        markers: ["TRUSTED_RISC0_SELECTOR"],
      },
      {
        okMessage: "Trusted image ID pinning present",
        failMessage: "Missing trusted image ID pinning",
        markers: ["TRUSTED_RISC0_IMAGE_ID"],
      },
      {
        okMessage: "Trusted router and verifier program pinning present",
        failMessage: "Missing trusted router/verifier program pinning",
        markers: [
          "TRUSTED_RISC0_ROUTER_PROGRAM_ID",
          "TRUSTED_RISC0_VERIFIER_PROGRAM_ID",
        ],
      },
      {
        okMessage: "Router verifier entry validation present",
        failMessage: "Missing verifier entry validation",
        markers: ["validate_verifier_entry", "validate_verifier_entry_data"],
      },
      {
        okMessage: "Router instruction validation present",
        failMessage: "Missing router instruction validation",
        markers: [
          "build_and_validate_router_verify_ix",
          "validate_router_verify_ix",
        ],
      },
    ],
  },
  {
    title: "Nullifier Protection",
    checks: [
      {
        okMessage: "Nullifier spend replay account wiring present",
        failMessage: "Missing nullifier spend replay account wiring",
        markers: [
          'seeds = [b"nullifier_spend"',
          "pub nullifier_spend: Box<Account<'info, NullifierSpend>>",
          "ctx.bumps.nullifier_spend",
        ],
      },
      {
        okMessage: "Binding spend replay account wiring present",
        failMessage: "Missing binding spend replay account wiring",
        markers: [
          'seeds = [b"binding_spend"',
          "pub binding_spend: Box<Account<'info, BindingSpend>>",
          "ctx.bumps.binding_spend",
        ],
      },
      {
        okMessage: "Nullifier validation present in private completion path",
        failMessage: "Missing nullifier validation in private completion path",
        markers: [
          "parse_and_validate_journal",
          "validate_parsed_journal",
          "CoordinationError::InvalidNullifier",
        ],
      },
    ],
  },
  {
    title: "Defense-in-Depth",
    checks: [
      {
        okMessage: "Journal binding validation present",
        failMessage: "Missing journal binding validation",
        markers: [
          "parse_and_validate_journal",
          "validate_parsed_journal",
          "CoordinationError::InvalidJournalBinding",
        ],
      },
      {
        okMessage: "Output commitment validation present",
        failMessage: "Missing output commitment validation",
        markers: [
          "parse_and_validate_journal",
          "CoordinationError::InvalidOutputCommitment",
        ],
      },
      {
        okMessage: "Constraint hash validation present",
        failMessage: "Missing constraint hash validation",
        markers: [
          "validate_parsed_journal",
          "CoordinationError::ConstraintHashMismatch",
        ],
      },
    ],
  },
];

function parseNetwork(argv) {
  let network = "devnet";

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--network") {
      network = argv[index + 1] ?? "devnet";
      index += 1;
      continue;
    }

    if (token === "mainnet" || token === "devnet" || token === "localnet") {
      network = token;
    }
  }

  return network;
}

function createSourceCheck(source, definition) {
  const missingMarkers = definition.markers.filter((marker) => !source.includes(marker));
  const ok = missingMarkers.length === 0;

  return {
    level: ok ? "pass" : "fail",
    message: ok ? definition.okMessage : definition.failMessage,
    details: ok ? [] : missingMarkers,
  };
}

export function evaluatePrivateCompletionSource(source) {
  return SOURCE_SECTION_DEFINITIONS.map((section) => ({
    title: section.title,
    checks: section.checks.map((check) => createSourceCheck(source, check)),
  }));
}

export function evaluateRateLimitingSource(source) {
  return {
    title: "Rate Limiting",
    checks: [
      source.includes("task_creation_cooldown")
        ? {
            level: "pass",
            message: "Task creation cooldown configured",
            details: [],
          }
        : {
            level: "warn",
            message: "No task creation cooldown found",
            details: [],
          },
    ],
  };
}

export function evaluateProofPolicyTranscript(rawTranscript) {
  const transcript = JSON.parse(rawTranscript);
  const contributionCount = Array.isArray(transcript.contributions)
    ? transcript.contributions.length
    : 0;

  return [
    contributionCount >= 3
      ? {
          level: "pass",
          message: `${contributionCount} contributions (>= 3 required)`,
          details: [],
        }
      : {
          level: "fail",
          message: `Only ${contributionCount} contributions (>= 3 required)`,
          details: [],
        },
    transcript.beaconApplied
      ? {
          level: "pass",
          message: "Random beacon applied",
          details: [],
        }
      : {
          level: "fail",
          message: "Random beacon not applied",
          details: [],
        },
  ];
}

export function evaluateProofPolicySection({ network, cwd }) {
  const transcriptPath = resolve(cwd, POLICY_TRANSCRIPT_FILE);

  if (network !== "mainnet") {
    return {
      title: "Proof Policy Evidence (mainnet requirement)",
      checks: [
        {
          level: "warn",
          message: `Proof policy transcript check skipped for ${network}`,
          details: [],
        },
      ],
    };
  }

  if (!existsSync(transcriptPath)) {
    return {
      title: "Proof Policy Evidence (mainnet requirement)",
      checks: [
        {
          level: "fail",
          message: "No proof policy transcript found (required for mainnet)",
          details: [],
        },
      ],
    };
  }

  let transcriptChecks;

  try {
    transcriptChecks = evaluateProofPolicyTranscript(
      readFileSync(transcriptPath, "utf8"),
    );
  } catch (error) {
    return {
      title: "Proof Policy Evidence (mainnet requirement)",
      checks: [
        {
          level: "fail",
          message: "Proof policy transcript validation failed",
          details: [error instanceof Error ? error.message : String(error)],
        },
      ],
    };
  }

  return {
    title: "Proof Policy Evidence (mainnet requirement)",
    checks: [
      {
        level: "pass",
        message: "Proof policy transcript found",
        details: [],
      },
      ...transcriptChecks,
    ],
  };
}

function formatCheck(check) {
  if (check.level === "pass") {
    return `  ${COLORS.green}PASS${COLORS.reset}: ${check.message}`;
  }

  if (check.level === "warn") {
    return `  ${COLORS.yellow}WARN${COLORS.reset}: ${check.message}`;
  }

  return `  ${COLORS.red}FAIL${COLORS.reset}: ${check.message}`;
}

export function renderSections(sections) {
  const lines = [];

  for (const section of sections) {
    lines.push(`--- ${section.title} ---`);
    for (const check of section.checks) {
      lines.push(formatCheck(check));
      for (const detail of check.details) {
        lines.push(`    - ${detail}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function getExitCode(sections) {
  return sections.some((section) =>
    section.checks.some((check) => check.level === "fail"),
  )
    ? 1
    : 0;
}

export function runReadinessCheck({ cwd = process.cwd(), network = "devnet" } = {}) {
  const privateCompletionPath = resolve(cwd, PRIVATE_COMPLETION_FILE);
  const sections = [];

  if (!existsSync(privateCompletionPath)) {
    sections.push({
      title: "Router Verifier Policy",
      checks: [
        {
          level: "fail",
          message: "Private completion handler not found",
          details: [privateCompletionPath],
        },
      ],
    });
  } else {
    const privateCompletionSource = readFileSync(privateCompletionPath, "utf8");
    sections.push(...evaluatePrivateCompletionSource(privateCompletionSource));
    sections.push(evaluateRateLimitingSource(privateCompletionSource));
  }

  sections.push(evaluateProofPolicySection({ cwd, network }));

  return {
    network,
    sections,
    exitCode: getExitCode(sections),
  };
}

function main() {
  const network = parseNetwork(process.argv.slice(2));
  const result = runReadinessCheck({ cwd: process.cwd(), network });

  const header = [
    "=== AgenC Deployment Readiness Check ===",
    `Network: ${result.network}`,
    "",
  ].join("\n");

  const summary =
    result.exitCode === 0
      ? `${COLORS.green}All checks passed for ${result.network} deployment.${COLORS.reset}`
      : `${COLORS.red}Some checks failed. Fix issues before ${result.network} deployment.${COLORS.reset}`;

  process.stdout.write(
    `${header}${renderSections(result.sections)}=== Summary ===\n${summary}\n`,
  );
  process.exit(result.exitCode);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
