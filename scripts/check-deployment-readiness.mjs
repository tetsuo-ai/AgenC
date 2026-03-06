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

function createDefinitionSection(title, checks) {
  return { title, checks };
}

function createSourceDefinition(okMessage, failMessage, ...markers) {
  return { okMessage, failMessage, markers };
}

function createResultCheck(level, message, details = []) {
  return { level, message, details };
}

const SOURCE_SECTION_DEFINITIONS = [
  createDefinitionSection("Router Verifier Policy", [
    createSourceDefinition(
      "Trusted selector pinning present",
      "Missing trusted selector pinning",
      "TRUSTED_RISC0_SELECTOR",
    ),
    createSourceDefinition(
      "Trusted image ID pinning present",
      "Missing trusted image ID pinning",
      "TRUSTED_RISC0_IMAGE_ID",
    ),
    createSourceDefinition(
      "Trusted router and verifier program pinning present",
      "Missing trusted router/verifier program pinning",
      "TRUSTED_RISC0_ROUTER_PROGRAM_ID",
      "TRUSTED_RISC0_VERIFIER_PROGRAM_ID",
    ),
    createSourceDefinition(
      "Router verifier entry validation present",
      "Missing verifier entry validation",
      "validate_verifier_entry",
      "validate_verifier_entry_data",
    ),
    createSourceDefinition(
      "Router instruction validation present",
      "Missing router instruction validation",
      "build_and_validate_router_verify_ix",
      "validate_router_verify_ix",
    ),
  ]),
  createDefinitionSection("Nullifier Protection", [
    createSourceDefinition(
      "Nullifier spend replay account wiring present",
      "Missing nullifier spend replay account wiring",
      'seeds = [b"nullifier_spend"',
      "pub nullifier_spend: Box<Account<'info, NullifierSpend>>",
      "ctx.bumps.nullifier_spend",
    ),
    createSourceDefinition(
      "Binding spend replay account wiring present",
      "Missing binding spend replay account wiring",
      'seeds = [b"binding_spend"',
      "pub binding_spend: Box<Account<'info, BindingSpend>>",
      "ctx.bumps.binding_spend",
    ),
    createSourceDefinition(
      "Nullifier validation present in private completion path",
      "Missing nullifier validation in private completion path",
      "parse_and_validate_journal",
      "validate_parsed_journal",
      "CoordinationError::InvalidNullifier",
    ),
  ]),
  createDefinitionSection("Defense-in-Depth", [
    createSourceDefinition(
      "Journal binding validation present",
      "Missing journal binding validation",
      "parse_and_validate_journal",
      "validate_parsed_journal",
      "CoordinationError::InvalidJournalBinding",
    ),
    createSourceDefinition(
      "Output commitment validation present",
      "Missing output commitment validation",
      "parse_and_validate_journal",
      "CoordinationError::InvalidOutputCommitment",
    ),
    createSourceDefinition(
      "Constraint hash validation present",
      "Missing constraint hash validation",
      "validate_parsed_journal",
      "CoordinationError::ConstraintHashMismatch",
    ),
  ]),
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

  return createResultCheck(
    ok ? "pass" : "fail",
    ok ? definition.okMessage : definition.failMessage,
    ok ? [] : missingMarkers,
  );
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
        ? createResultCheck("pass", "Task creation cooldown configured")
        : createResultCheck("warn", "No task creation cooldown found"),
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
      ? createResultCheck(
          "pass",
          `${contributionCount} contributions (>= 3 required)`,
        )
      : createResultCheck(
          "fail",
          `Only ${contributionCount} contributions (>= 3 required)`,
        ),
    transcript.beaconApplied
      ? createResultCheck("pass", "Random beacon applied")
      : createResultCheck("fail", "Random beacon not applied"),
  ];
}

export function evaluateProofPolicySection({ network, cwd }) {
  const transcriptPath = resolve(cwd, POLICY_TRANSCRIPT_FILE);

  if (network !== "mainnet") {
    return {
      title: "Proof Policy Evidence (mainnet requirement)",
      checks: [
        createResultCheck(
          "warn",
          `Proof policy transcript check skipped for ${network}`,
        ),
      ],
    };
  }

  if (!existsSync(transcriptPath)) {
    return {
      title: "Proof Policy Evidence (mainnet requirement)",
      checks: [
        createResultCheck(
          "fail",
          "No proof policy transcript found (required for mainnet)",
        ),
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
        createResultCheck("fail", "Proof policy transcript validation failed", [
          error instanceof Error ? error.message : String(error),
        ]),
      ],
    };
  }

  return {
      title: "Proof Policy Evidence (mainnet requirement)",
      checks: [
        createResultCheck("pass", "Proof policy transcript found"),
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
  const proofPolicySection = evaluateProofPolicySection({ cwd, network });

  if (existsSync(privateCompletionPath)) {
    const privateCompletionSource = readFileSync(privateCompletionPath, "utf8");
    const sections = [
      ...evaluatePrivateCompletionSource(privateCompletionSource),
      evaluateRateLimitingSource(privateCompletionSource),
      proofPolicySection,
    ];

    return {
      network,
      sections,
      exitCode: getExitCode(sections),
    };
  }

  const sections = [
    {
      title: "Router Verifier Policy",
      checks: [
        createResultCheck("fail", "Private completion handler not found", [
          privateCompletionPath,
        ]),
      ],
    },
    proofPolicySection,
  ];

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
