import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  readWatchDaemonLogTail,
  resolveWatchDaemonLogPath,
} from "./lib/agenc-watch-log-tail.mjs";

test("resolveWatchDaemonLogPath prefers explicit env override", () => {
  assert.equal(
    resolveWatchDaemonLogPath({ AGENC_DAEMON_LOG_PATH: "/tmp/custom-daemon.log" }),
    "/tmp/custom-daemon.log",
  );
});

test("readWatchDaemonLogTail returns the latest non-empty lines from the daemon log", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agenc-watch-log-tail-"));
  const logPath = path.join(workspace, "daemon.log");
  fs.writeFileSync(
    logPath,
    [
      "line 1",
      "",
      "line 2",
      "line 3",
      "line 4",
      "line 5",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = readWatchDaemonLogTail({
    lines: 3,
    env: { AGENC_DAEMON_LOG_PATH: logPath },
  });

  assert.deepEqual(result, {
    path: "daemon.log",
    fullPath: logPath,
    lines: ["line 3", "line 4", "line 5"],
  });

  fs.rmSync(workspace, { recursive: true, force: true });
});
