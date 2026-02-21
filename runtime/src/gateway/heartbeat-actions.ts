/**
 * Built-in heartbeat actions for @agenc/runtime.
 *
 * Each factory creates a {@link HeartbeatAction} that follows the "quiet
 * heartbeat" contract — nothing is reported unless something noteworthy
 * happens.
 *
 * Actions:
 * - **task-scan** — scans for claimable on-chain tasks
 * - **summary** — generates a conversation summary via LLM
 * - **portfolio** — monitors SOL balance changes
 * - **polling** — generic external endpoint polling
 *
 * @module
 */

import type { Connection, PublicKey } from "@solana/web3.js";
import type {
  HeartbeatAction,
  HeartbeatContext,
  HeartbeatResult,
} from "./heartbeat.js";
import type { TaskScanner } from "../autonomous/scanner.js";
import type { MemoryBackend } from "../memory/types.js";
import { entryToMessage } from "../memory/types.js";
import type { LLMProvider } from "../llm/types.js";

// ============================================================================
// Quiet result helpers
// ============================================================================

const QUIET: HeartbeatResult = Object.freeze({ hasOutput: false, quiet: true });

function output(text: string): HeartbeatResult {
  return { hasOutput: true, output: text, quiet: false };
}

// ============================================================================
// Task scan action
// ============================================================================

export interface TaskScanActionConfig {
  scanner: TaskScanner;
}

export function createTaskScanAction(
  config: TaskScanActionConfig,
): HeartbeatAction {
  const { scanner } = config;

  return {
    name: "task-scan",
    enabled: true,
    async execute(context: HeartbeatContext): Promise<HeartbeatResult> {
      try {
        const tasks = await scanner.scan();
        if (tasks.length === 0) return QUIET;

        const lines = tasks.map((t) => {
          const pda = t.pda.toBase58().slice(0, 8);
          const reward =
            t.rewardMint === null
              ? `${(Number(t.reward) / 1e9).toFixed(4)} SOL`
              : `${t.reward.toString()} lamports (mint: ${t.rewardMint.toBase58()})`;
          return `- Task ${pda}: ${reward}`;
        });

        return output(
          `Found ${tasks.length} claimable task(s):\n${lines.join("\n")}`,
        );
      } catch (err) {
        context.logger.error("task-scan heartbeat failed:", err);
        return QUIET;
      }
    },
  };
}

// ============================================================================
// Summary action
// ============================================================================

export interface SummaryActionConfig {
  memory: MemoryBackend;
  llm: LLMProvider;
  sessionId: string;
  /** Lookback window in ms (default: 86_400_000 = 24 h). */
  lookbackMs?: number;
  /** Max entries to feed the summarizer (default: 50). */
  maxEntries?: number;
}

const DEFAULT_LOOKBACK_MS = 86_400_000;
const DEFAULT_MAX_ENTRIES = 50;

const SUMMARY_SYSTEM_PROMPT =
  "You are a concise summarizer. Summarize the following conversation in 2-3 sentences, highlighting key decisions, completed actions, and outstanding items.";

export function createSummaryAction(
  config: SummaryActionConfig,
): HeartbeatAction {
  const { memory, llm, sessionId } = config;
  const lookbackMs = config.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES;

  return {
    name: "summary",
    enabled: true,
    async execute(context: HeartbeatContext): Promise<HeartbeatResult> {
      try {
        const entries = await memory.query({
          sessionId,
          after: Date.now() - lookbackMs,
          limit: maxEntries,
          order: "asc",
        });

        if (entries.length === 0) return QUIET;

        const messages = entries.map(entryToMessage);
        const formatted = messages
          .map((m) => `[${m.role}]: ${m.content}`)
          .join("\n");

        const response = await llm.chat([
          { role: "system", content: SUMMARY_SYSTEM_PROMPT },
          {
            role: "user",
            content: `Summarize this conversation:\n\n${formatted}`,
          },
        ]);

        if (!response.content) return QUIET;

        return output(response.content);
      } catch (err) {
        context.logger.error("summary heartbeat failed:", err);
        return QUIET;
      }
    },
  };
}

// ============================================================================
// Portfolio action
// ============================================================================

export interface PortfolioActionConfig {
  connection: Connection;
  wallet: PublicKey;
  memory: MemoryBackend;
  /** Minimum lamport delta to trigger an alert (default: 1_000_000_000 = 1 SOL). */
  alertThresholdLamports?: number;
}

const DEFAULT_ALERT_THRESHOLD = 1_000_000_000; // 1 SOL

export function createPortfolioAction(
  config: PortfolioActionConfig,
): HeartbeatAction {
  const { connection, wallet, memory } = config;
  const threshold = config.alertThresholdLamports ?? DEFAULT_ALERT_THRESHOLD;
  const storageKey = `heartbeat:portfolio:${wallet.toBase58()}`;

  return {
    name: "portfolio",
    enabled: true,
    async execute(context: HeartbeatContext): Promise<HeartbeatResult> {
      try {
        const balance = await connection.getBalance(wallet);
        const prev = await memory.get<number>(storageKey);

        await memory.set(storageKey, balance);

        if (prev === undefined) return QUIET;

        const delta = balance - prev;
        if (Math.abs(delta) < threshold) return QUIET;

        const sign = delta >= 0 ? "+" : "";
        const deltaSOL = (delta / 1e9).toFixed(4);
        const currentSOL = (balance / 1e9).toFixed(4);

        return output(
          `Portfolio alert: balance changed by ${sign}${deltaSOL} SOL (now ${currentSOL} SOL)`,
        );
      } catch (err) {
        context.logger.error("portfolio heartbeat failed:", err);
        return QUIET;
      }
    },
  };
}

// ============================================================================
// Polling action
// ============================================================================

export interface PollingActionConfig {
  name: string;
  url: string;
  checkFn: (response: unknown) => HeartbeatResult;
  headers?: Record<string, string>;
}

export function createPollingAction(
  config: PollingActionConfig,
): HeartbeatAction {
  const { name, url, checkFn, headers } = config;

  return {
    name,
    enabled: true,
    async execute(context: HeartbeatContext): Promise<HeartbeatResult> {
      try {
        const res = await fetch(url, { headers });
        if (!res.ok) {
          context.logger.error(`polling action "${name}" HTTP ${res.status}`);
          return QUIET;
        }
        const data: unknown = await res.json();
        return checkFn(data);
      } catch (err) {
        context.logger.error(`polling action "${name}" failed:`, err);
        return QUIET;
      }
    },
  };
}

// ============================================================================
// Default actions factory
// ============================================================================

export interface DefaultHeartbeatActionsConfig {
  scanner: TaskScanner;
  memory: MemoryBackend;
  llm: LLMProvider;
  connection: Connection;
  wallet: PublicKey;
  sessionId: string;
}

export function createDefaultHeartbeatActions(
  config: DefaultHeartbeatActionsConfig,
): HeartbeatAction[] {
  return [
    createTaskScanAction({ scanner: config.scanner }),
    createSummaryAction({
      memory: config.memory,
      llm: config.llm,
      sessionId: config.sessionId,
    }),
    createPortfolioAction({
      connection: config.connection,
      wallet: config.wallet,
      memory: config.memory,
    }),
  ];
}
