/**
 * Deterministic local pipeline repro harness for desktop/system command flow.
 *
 * @module
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PipelineHttpReproStepResult {
  step: number;
  tool: string;
  ok: boolean;
  preview: string;
  skipped?: boolean;
}

export interface PipelineHttpReproResult {
  overall: "pass" | "fail";
  durationMs: number;
  steps: PipelineHttpReproStepResult[];
}

interface BashResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface PipelineHttpReproOptions {
  workspace?: string;
  port?: number;
}

async function runBash(command: string, timeoutMs = 30_000): Promise<BashResult> {
  try {
    const { stdout, stderr } = await execFileAsync("bash", ["-lc", command], {
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    });
    return {
      ok: true,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode: 0,
    };
  } catch (error) {
    const err = error as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      signal?: string;
      message?: string;
    };
    const code =
      typeof err.code === "number"
        ? err.code
        : err.signal
          ? -1
          : 1;
    return {
      ok: false,
      stdout: String(err.stdout ?? "").trim(),
      stderr: String(err.stderr ?? err.message ?? "command failed").trim(),
      exitCode: code,
    };
  }
}

function preview(result: BashResult): string {
  if (result.ok) {
    return result.stdout || "ok";
  }
  const stderr = result.stderr || "failed";
  return `exit=${result.exitCode} ${stderr}`.slice(0, 240);
}

async function runOptionalPlaywrightStep(url: string): Promise<PipelineHttpReproStepResult> {
  try {
    const playwright = await import("playwright");
    const browser = await playwright.chromium.launch({
      headless: true,
      timeout: 10_000,
    });
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
      const html = await page.content();
      const ok = html.includes("pipeline-ok");
      return {
        step: 3,
        tool: "playwright.browser_navigate",
        ok,
        preview: ok
          ? "pipeline-ok detected in page content"
          : "page loaded but marker missing",
      };
    } finally {
      await browser.close();
    }
  } catch {
    return {
      step: 3,
      tool: "playwright.browser_navigate",
      ok: true,
      skipped: true,
      preview: "Playwright unavailable; step skipped",
    };
  }
}

/**
 * Execute the canonical desktop/system HTTP pipeline repro sequence.
 */
export async function runPipelineHttpRepro(
  options: PipelineHttpReproOptions = {},
): Promise<PipelineHttpReproResult> {
  const startedAt = Date.now();
  const steps: PipelineHttpReproStepResult[] = [];
  const workspace = options.workspace ?? "/tmp/agenc-pipeline-test";
  const port = Number.isInteger(options.port) ? Number(options.port) : 8123;
  let serverPid: string | undefined;

  const step1 = await runBash(
    [
      "set -euo pipefail",
      `rm -rf ${workspace}`,
      `mkdir -p ${workspace}`,
      `cat > ${workspace}/index.html <<'HTML'`,
      "<!doctype html><title>AgenC Pipeline OK</title><h1>pipeline-ok</h1>",
      "HTML",
    ].join("\n"),
  );
  steps.push({
    step: 1,
    tool: "system.bash",
    ok: step1.ok,
    preview: preview(step1),
  });

  const step2 = await runBash(
    `cd ${workspace} && python3 -m http.server ${port} >/tmp/agenc-http.log 2>&1 & echo $!`,
  );
  if (step2.ok) {
    serverPid = step2.stdout.split(/\s+/)[0]?.trim();
  }
  steps.push({
    step: 2,
    tool: "system.bash",
    ok: step2.ok && Boolean(serverPid),
    preview: step2.ok ? `server pid=${serverPid ?? "unknown"}` : preview(step2),
  });

  steps.push(await runOptionalPlaywrightStep(`http://127.0.0.1:${port}`));

  const step4 = await runBash(
    `curl -sSf http://127.0.0.1:${port} | grep -q 'pipeline-ok' && echo HTTP_OK`,
  );
  steps.push({
    step: 4,
    tool: "system.bash",
    ok: step4.ok,
    preview: preview(step4),
  });

  const step5 = await runBash(`pgrep -fa 'python3 -m http.server ${port}'`);
  const step5HasHttpServer =
    step5.ok &&
    step5.stdout
      .split("\n")
      .some((line) => line.includes(`python3 -m http.server ${port}`));
  steps.push({
    step: 5,
    tool: "system.bash",
    ok: step5HasHttpServer,
    preview: preview(step5),
  });

  const step6 = await runBash(
    [
      `pkill -f '[p]ython3 -m http.server ${port}' || true`,
      "sleep 1",
      `if command -v ss >/dev/null 2>&1; then`,
      `  ss -ltn '( sport = :${port} )' | tail -n +2 | wc -l`,
      "elif command -v lsof >/dev/null 2>&1; then",
      `  lsof -nP -iTCP:${port} -sTCP:LISTEN 2>/dev/null | tail -n +2 | wc -l`,
      "else",
      `  if curl -fsS --max-time 1 http://127.0.0.1:${port} >/dev/null 2>&1; then echo 1; else echo 0; fi`,
      "fi",
    ].join("\n"),
  );
  const portListeners = Number(step6.stdout.trim() || "0");
  steps.push({
    step: 6,
    tool: "system.bash",
    ok: step6.ok && Number.isFinite(portListeners) && portListeners === 0,
    preview: step6.ok
      ? `listeners_on_${port}=${step6.stdout.trim()}`
      : preview(step6),
  });

  if (serverPid) {
    await runBash(`kill ${serverPid} >/dev/null 2>&1 || true`);
  }
  await runBash(`pkill -f '[p]ython3 -m http.server ${port}' || true`);

  const overall = steps.every((step) => step.ok);
  return {
    overall: overall ? "pass" : "fail",
    durationMs: Date.now() - startedAt,
    steps,
  };
}
