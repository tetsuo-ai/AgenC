import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  evaluatePrivateCompletionSource,
  runReadinessCheck,
} from "./check-deployment-readiness.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const privateCompletionPath = resolve(
  repoRoot,
  "programs/agenc-coordination/src/instructions/complete_task_private.rs",
);
const privateCompletionSource = readFileSync(privateCompletionPath, "utf8");

function getCheck(sections, title, message) {
  const section = sections.find((candidate) => candidate.title === title);
  assert.ok(section, `missing section: ${title}`);

  const check = section.checks.find((candidate) => candidate.message === message);
  assert.ok(check, `missing check: ${message}`);
  return check;
}

test("current private completion source satisfies semantic readiness invariants", () => {
  const sections = evaluatePrivateCompletionSource(privateCompletionSource);

  for (const section of sections) {
    for (const check of section.checks) {
      assert.notEqual(
        check.level,
        "fail",
        `unexpected failing check: ${section.title} -> ${check.message}`,
      );
    }
  }
});

test("nullifier spend regressions are detected", () => {
  const mutatedSource = privateCompletionSource
    .replace('seeds = [b"nullifier_spend"', 'seeds = [b"nullifier_account"')
    .replace("pub nullifier_spend: Box<Account<'info, NullifierSpend>>", "");

  const sections = evaluatePrivateCompletionSource(mutatedSource);
  const check = getCheck(
    sections,
    "Nullifier Protection",
    "Missing nullifier spend replay account wiring",
  );

  assert.equal(check.level, "fail");
  assert.ok(check.details.some((detail) => detail.includes('seeds = [b"nullifier_spend"')));
});

test("journal binding regressions are detected", () => {
  const mutatedSource = privateCompletionSource.replaceAll(
    "CoordinationError::InvalidJournalBinding",
    "CoordinationError::InvalidProofBinding",
  );

  const sections = evaluatePrivateCompletionSource(mutatedSource);
  const check = getCheck(
    sections,
    "Defense-in-Depth",
    "Missing journal binding validation",
  );

  assert.equal(check.level, "fail");
  assert.ok(
    check.details.includes("CoordinationError::InvalidJournalBinding"),
    "expected missing InvalidJournalBinding marker",
  );
});

test("cli succeeds against the current checkout for localnet", () => {
  const result = runReadinessCheck({ cwd: repoRoot, network: "localnet" });
  assert.equal(result.exitCode, 0);

  const stdout = execFileSync(
    "node",
    [resolve(scriptDir, "check-deployment-readiness.mjs"), "localnet"],
    { cwd: repoRoot, encoding: "utf8" },
  );

  assert.match(stdout, /All checks passed for localnet deployment\./);
});
