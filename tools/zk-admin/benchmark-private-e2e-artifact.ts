import * as anchor from "@coral-xyz/anchor";
import {
  ROUTER_PROGRAM_ID,
  VERIFIER_PROGRAM_ID,
  deriveRouterPda,
  deriveVerifierEntryPda,
  deriveVerifierProgramDataPda,
} from "./verifier-localnet.js";
import type { CliOptions } from "./benchmark-private-e2e-cli.js";

export interface FundingResult {
  strategy: "airdrop" | "payer-transfer" | "preloaded";
  signature: string;
}

export interface ProtocolBootstrapResult {
  protocolPda: string;
  treasury: string;
  initializedThisRun: boolean;
  durationMs: number;
}

export interface BenchmarkRoundArtifact {
  round: number;
  creator: string;
  worker: string;
  creatorAgent: string;
  workerAgent: string;
  taskPda: string;
  claimPda: string;
  finalTaskStatus: string;
  funding: {
    creator: FundingResult;
    worker: FundingResult;
  };
  signatures: {
    registerCreator: string;
    registerWorker: string;
    createTask: string;
    claimTask: string;
    completeTaskPrivate: string;
  };
  proof: {
    proofSizeBytes: number;
    journalBytes: number;
    imageIdHex: string;
    bindingSeedHex: string;
    nullifierSeedHex: string;
    selectorHex: string;
  };
  timingsMs: {
    fundCreator: number;
    fundWorker: number;
    registerCreator: number;
    registerWorker: number;
    createTask: number;
    claimTask: number;
    proofGeneration: number;
    proofGenerationReported: number;
    submitCompletion: number;
    total: number;
  };
}

export interface BenchmarkArtifact {
  schemaVersion: 1;
  benchmark: "private-task-e2e";
  generatedAt: string;
  gitCommit: string | null;
  network: {
    rpcUrl: string;
    slot: number;
    routerProgramId: string;
    verifierProgramId: string;
    routerPda: string;
    verifierEntryPda: string;
    verifierProgramDataPda: string;
  };
  prover: {
    kind: "remote";
    endpoint: string;
    timeoutMs: number | null;
    configuredHeaders: string[];
    methodIdHex: string;
  };
  config: {
    rounds: number;
    stakeLamports: number;
    rewardLamports: number;
    fundingLamports: number;
    output: string[];
  };
  bootstrap: ProtocolBootstrapResult;
  aggregate: {
    rounds: number;
    meanProofGenerationMs: number;
    medianProofGenerationMs: number;
    meanSubmitCompletionMs: number;
    medianSubmitCompletionMs: number;
    meanTotalMs: number;
    medianTotalMs: number;
    minTotalMs: number;
    maxTotalMs: number;
  };
  rounds: BenchmarkRoundArtifact[];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[midpoint - 1] + sorted[midpoint]) / 2
    : sorted[midpoint]!;
}

function sanitizeEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return `${url.origin}${url.pathname}`;
  } catch {
    return endpoint;
  }
}

export function buildBenchmarkArtifact(params: {
  options: CliOptions;
  rounds: BenchmarkRoundArtifact[];
  provider: anchor.AnchorProvider;
  bootstrap: ProtocolBootstrapResult;
  activeImageId: Uint8Array;
  stakeLamports: number;
  generatedAt: string;
  gitCommit: string | null;
}): BenchmarkArtifact {
  const proofDurations = params.rounds.map((round) => round.timingsMs.proofGeneration);
  const submitDurations = params.rounds.map((round) => round.timingsMs.submitCompletion);
  const totalDurations = params.rounds.map((round) => round.timingsMs.total);

  return {
    schemaVersion: 1,
    benchmark: "private-task-e2e",
    generatedAt: params.generatedAt,
    gitCommit: params.gitCommit,
    network: {
      rpcUrl: params.provider.connection.rpcEndpoint,
      slot: 0,
      routerProgramId: ROUTER_PROGRAM_ID.toBase58(),
      verifierProgramId: VERIFIER_PROGRAM_ID.toBase58(),
      routerPda: deriveRouterPda().toBase58(),
      verifierEntryPda: deriveVerifierEntryPda().toBase58(),
      verifierProgramDataPda: deriveVerifierProgramDataPda().toBase58(),
    },
    prover: {
      kind: "remote",
      endpoint: sanitizeEndpoint(params.options.proverEndpoint),
      timeoutMs: params.options.proverTimeoutMs ?? null,
      configuredHeaders: Object.keys(params.options.proverHeaders),
      methodIdHex: Buffer.from(params.activeImageId).toString("hex"),
    },
    config: {
      rounds: params.options.rounds,
      stakeLamports: params.stakeLamports,
      rewardLamports: params.options.rewardLamports,
      fundingLamports: params.options.fundingLamports,
      output: params.options.output.map((value) => value.toString()),
    },
    bootstrap: params.bootstrap,
    aggregate: {
      rounds: params.rounds.length,
      meanProofGenerationMs: mean(proofDurations),
      medianProofGenerationMs: median(proofDurations),
      meanSubmitCompletionMs: mean(submitDurations),
      medianSubmitCompletionMs: median(submitDurations),
      meanTotalMs: mean(totalDurations),
      medianTotalMs: median(totalDurations),
      minTotalMs: totalDurations.length > 0 ? Math.min(...totalDurations) : 0,
      maxTotalMs: totalDurations.length > 0 ? Math.max(...totalDurations) : 0,
    },
    rounds: params.rounds,
  };
}

export function renderBenchmarkMarkdown(artifact: BenchmarkArtifact): string {
  const lines = [
    "# Private Task E2E Benchmark",
    "",
    `Generated: ${artifact.generatedAt}`,
    artifact.gitCommit ? `Git commit: \`${artifact.gitCommit}\`` : "Git commit: unavailable",
    `RPC: \`${artifact.network.rpcUrl}\``,
    `Prover endpoint: \`${artifact.prover.endpoint}\``,
    `Rounds: ${artifact.aggregate.rounds}`,
    `Stake lamports: ${artifact.config.stakeLamports}`,
    `Reward lamports: ${artifact.config.rewardLamports}`,
    `Funding lamports: ${artifact.config.fundingLamports}`,
    "",
    "## Aggregate",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Mean proof generation (ms) | ${artifact.aggregate.meanProofGenerationMs.toFixed(2)} |`,
    `| Median proof generation (ms) | ${artifact.aggregate.medianProofGenerationMs.toFixed(2)} |`,
    `| Mean completeTaskPrivate submit (ms) | ${artifact.aggregate.meanSubmitCompletionMs.toFixed(2)} |`,
    `| Median completeTaskPrivate submit (ms) | ${artifact.aggregate.medianSubmitCompletionMs.toFixed(2)} |`,
    `| Mean round total (ms) | ${artifact.aggregate.meanTotalMs.toFixed(2)} |`,
    `| Median round total (ms) | ${artifact.aggregate.medianTotalMs.toFixed(2)} |`,
    `| Min round total (ms) | ${artifact.aggregate.minTotalMs.toFixed(2)} |`,
    `| Max round total (ms) | ${artifact.aggregate.maxTotalMs.toFixed(2)} |`,
    "",
    "## Rounds",
    "",
    "| Round | Proof ms | Submit ms | Total ms | Task | Tx |",
    "| --- | ---: | ---: | ---: | --- | --- |",
  ];

  for (const round of artifact.rounds) {
    lines.push(
      `| ${round.round} | ${round.timingsMs.proofGeneration.toFixed(2)} | ${round.timingsMs.submitCompletion.toFixed(2)} | ${round.timingsMs.total.toFixed(2)} | \`${round.taskPda}\` | \`${round.signatures.completeTaskPrivate}\` |`,
    );
  }

  lines.push(
    "",
    "## Notes",
    "",
    "- This benchmark creates a real private task, claims it, generates a proof through the configured remote prover, and submits `completeTaskPrivate` against the verifier-enabled chain.",
    "- The prover header values are intentionally omitted from this report; only header names are recorded in the JSON artifact.",
  );

  return `${lines.join("\n")}\n`;
}
