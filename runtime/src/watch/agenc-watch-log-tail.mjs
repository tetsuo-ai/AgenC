import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_LOG_LINES = 80;
const DEFAULT_LOG_FILE = "daemon.log";
const DEFAULT_LOG_TAIL_BYTES = 128_000;

export function resolveWatchDaemonLogPath(env = process.env) {
  if (typeof env?.AGENC_DAEMON_LOG_PATH === "string" && env.AGENC_DAEMON_LOG_PATH.trim()) {
    return env.AGENC_DAEMON_LOG_PATH.trim();
  }
  return path.join(os.homedir(), ".agenc", DEFAULT_LOG_FILE);
}

export function readWatchDaemonLogTail(
  { lines = DEFAULT_LOG_LINES, env = process.env } = {},
) {
  const lineLimit = Math.max(1, Math.min(1000, Number(lines) || DEFAULT_LOG_LINES));
  const logPath = resolveWatchDaemonLogPath(env);
  const stats = fs.statSync(logPath);
  const bytesToRead = Math.min(DEFAULT_LOG_TAIL_BYTES, stats.size);
  const content = fs.readFileSync(logPath, "utf8");
  const sliced = content.slice(Math.max(0, content.length - bytesToRead));
  const filtered = sliced
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  return {
    path: path.basename(logPath),
    fullPath: logPath,
    lines: filtered.slice(-lineLimit),
  };
}
