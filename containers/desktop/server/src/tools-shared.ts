import { execFile } from "node:child_process";
import type { ToolResult } from "./types.js";

export const DISPLAY = process.env.DISPLAY ?? ":1";
export const EXEC_TIMEOUT_MS = 30_000;
export const MAX_OUTPUT_BYTES = 100 * 1024; // 100KB
export const MAX_EXEC_BUFFER_BYTES = 1024 * 1024; // 1MB capture headroom

export function exec(
  cmd: string,
  args: string[],
  timeoutMs = EXEC_TIMEOUT_MS,
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: MAX_EXEC_BUFFER_BYTES,
        env: { ...process.env, DISPLAY },
        ...(cwd ? { cwd } : {}),
      },
      (err, stdout, stderr) => {
        if (err) {
          const enriched = err as Error & {
            stdout?: string;
            stderr?: string;
            code?: number | string;
          };
          // Preserve callback streams for non-zero exits. Some Node runtimes
          // do not reliably populate err.stdout/err.stderr on execFile errors.
          if (typeof enriched.stdout !== "string") {
            enriched.stdout = stdout ?? "";
          }
          if (typeof enriched.stderr !== "string") {
            enriched.stderr = stderr ?? "";
          }
          reject(enriched);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

export function ok(content: unknown): ToolResult {
  return { content: JSON.stringify(content) };
}

export function fail(message: string): ToolResult {
  return { content: JSON.stringify({ error: message }), isError: true };
}

export function warnBestEffort(context: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[desktop-tools] ${context}: ${message}`);
}

export function truncateOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_BYTES) return text;
  return text.slice(0, MAX_OUTPUT_BYTES) + "\n... (truncated)";
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
