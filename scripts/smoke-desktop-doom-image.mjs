#!/usr/bin/env node

import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_IMAGE = "agenc/desktop:latest";

function fail(message, details = "") {
  if (details.trim().length > 0) {
    console.error(details);
  }
  console.error(`desktop doom smoke failed: ${message}`);
  process.exit(1);
}

async function runDocker(image, script) {
  return execFileAsync(
    "docker",
    ["run", "--rm", image, "sh", "-lc", script],
    {
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}

async function main() {
  const image = process.argv[2] || DEFAULT_IMAGE;

  const pathProbe = [
    'printf "doom-mcp-server=%s\\n" "$(command -v doom-mcp-server)"',
    'printf "chocolate-doom=%s\\n" "$(command -v chocolate-doom)"',
    'printf "doom=%s\\n" "$(command -v doom)"',
    "test -f /usr/share/games/doom/freedoom1.wad",
    "test -f /usr/share/games/doom/freedoom2.wad",
  ].join(" && ");

  const patchProbe = [
    "/opt/doom-mcp/.venv/bin/python - <<'PY'",
    "import inspect",
    "from doom_mcp.server import set_god_mode, start_game",
    "assert callable(set_god_mode)",
    "assert 'god_mode' in inspect.signature(start_game).parameters",
    "print('doom_patch_contract=ok')",
    "PY",
  ].join("\n");

  const startupProbe = [
    "rm -f /tmp/doom-stdio.log",
    "timeout 5s doom-mcp-server </dev/null >/tmp/doom-stdio.log 2>&1 || true",
    "grep -q \"Starting MCP server 'doom'\" /tmp/doom-stdio.log",
    "sed -n '1,40p' /tmp/doom-stdio.log",
  ].join(" && ");

  try {
    const [pathResult, patchResult, startupResult] = await Promise.all([
      runDocker(image, pathProbe),
      runDocker(image, patchProbe),
      runDocker(image, startupProbe),
    ]);

    process.stdout.write(pathResult.stdout);
    process.stdout.write(patchResult.stdout);
    process.stdout.write(startupResult.stdout);
    process.stdout.write(`desktop doom smoke passed for ${image}\n`);
  } catch (error) {
    const stdout =
      error && typeof error === "object" && "stdout" in error
        ? String(error.stdout ?? "")
        : "";
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String(error.stderr ?? "")
        : "";
    const details = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
    fail(error instanceof Error ? error.message : String(error), details);
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
