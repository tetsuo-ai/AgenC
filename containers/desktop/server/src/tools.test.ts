import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  __managedProcessTestHooks,
  executeTool,
  validateDesktopToolHandlers,
} from "./tools.js";

test("desktop tool contract stays aligned with executable handlers", () => {
  assert.doesNotThrow(() => validateDesktopToolHandlers());
});

async function waitForFile(path: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path, fsConstants.F_OK);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Timed out waiting for file: ${path}`);
}

test("bash detaches explicit background commands that also write a PID file", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "agenc-desktop-bash-"));
  const donePath = join(workspace, "done.txt");
  const pidPath = join(workspace, "job.pid");

  try {
    const start = Date.now();
    const result = await executeTool("bash", {
      command: `(sleep 1 && touch '${donePath}') & echo $! > '${pidPath}'`,
    });
    const elapsedMs = Date.now() - start;

    assert.notEqual(result.isError, true);
    const payload = JSON.parse(result.content) as Record<string, unknown>;
    assert.equal(payload.backgrounded, true);
    assert.equal(payload.exitCode, 0);
    assert.equal(payload.pidSemantics, "background_process");
    assert.equal(payload.pid, payload.backgroundPid);
    assert.match(String(payload.launcherPid ?? ""), /^\d+$/);
    assert.notEqual(payload.launcherPid, payload.backgroundPid);
    assert.ok(elapsedMs < 1_000, `expected detached background launch, got ${elapsedMs}ms`);

    await waitForFile(pidPath, 1_000);
    const pidText = (await readFile(pidPath, "utf8")).trim();
    assert.match(pidText, /^\d+$/);
    assert.equal(pidText, String(payload.backgroundPid));

    await waitForFile(donePath, 2_500);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("process_start/process_status/process_stop manage a long-running process", async () => {
  const label = `sleep-${Date.now().toString(36)}`;
  const idempotencyKey = `${label}-request`;
  const nodeExec = process.execPath;

  const started = await executeTool("process_start", {
    command: nodeExec,
    args: ["-e", "console.log('ready'); setInterval(() => {}, 1000);"],
    label,
    idempotencyKey,
  });
  assert.notEqual(started.isError, true);
  const startPayload = JSON.parse(started.content) as Record<string, unknown>;
  assert.equal(startPayload.started, true);
  assert.equal(startPayload.state, "running");
  assert.equal(startPayload.label, label);
  assert.equal(startPayload.idempotencyKey, idempotencyKey);
  assert.match(String(startPayload.processId ?? ""), /^proc_/);
  assert.match(String(startPayload.pid ?? ""), /^\d+$/);
  assert.match(String(startPayload.pgid ?? ""), /^\d+$/);
  assert.equal(startPayload.pid, startPayload.pgid);

  const reused = await executeTool("process_start", {
    command: nodeExec,
    args: ["-e", "console.log('ready'); setInterval(() => {}, 1000);"],
    label,
    idempotencyKey,
  });
  assert.notEqual(reused.isError, true);
  const reusedPayload = JSON.parse(reused.content) as Record<string, unknown>;
  assert.equal(reusedPayload.reused, true);
  assert.equal(reusedPayload.processId, startPayload.processId);

  const status = await executeTool("process_status", {
    idempotencyKey,
  });
  assert.notEqual(status.isError, true);
  const statusPayload = JSON.parse(status.content) as Record<string, unknown>;
  assert.equal(statusPayload.processId, startPayload.processId);
  assert.equal(statusPayload.state, "running");
  assert.equal(statusPayload.running, true);
  assert.match(String(statusPayload.recentOutput ?? ""), /ready/);

  const stopped = await executeTool("process_stop", {
    idempotencyKey,
    gracePeriodMs: 500,
  });
  assert.notEqual(stopped.isError, true);
  const stopPayload = JSON.parse(stopped.content) as Record<string, unknown>;
  assert.equal(stopPayload.stopped, true);
  assert.equal(stopPayload.state, "exited");

  const secondStop = await executeTool("process_stop", {
    processId: startPayload.processId,
  });
  assert.notEqual(secondStop.isError, true);
  const secondStopPayload = JSON.parse(secondStop.content) as Record<string, unknown>;
  assert.equal(secondStopPayload.state, "exited");
  assert.equal(secondStopPayload.alreadyExited, true);

  const finalStatus = await executeTool("process_status", {
    processId: startPayload.processId,
  });
  assert.notEqual(finalStatus.isError, true);
  const finalPayload = JSON.parse(finalStatus.content) as Record<string, unknown>;
  assert.equal(finalPayload.state, "exited");
  assert.equal(finalPayload.running, false);
});

test("process_start rejects idempotencyKey conflicts for different launch specs", async () => {
  const label = `worker-${Date.now().toString(36)}`;
  const idempotencyKey = `${label}-request`;
  const nodeExec = process.execPath;

  const started = await executeTool("process_start", {
    command: nodeExec,
    args: ["-e", "setInterval(() => {}, 1000);"],
    label,
    idempotencyKey,
  });
  assert.notEqual(started.isError, true);
  const startPayload = JSON.parse(started.content) as Record<string, unknown>;

  try {
    const conflicting = await executeTool("process_start", {
      command: nodeExec,
      args: ["-e", "console.log('different'); setInterval(() => {}, 1000);"],
      label: `${label}-other`,
      idempotencyKey,
    });
    assert.equal(conflicting.isError, true);
    const payload = JSON.parse(conflicting.content) as Record<string, unknown>;
    assert.match(
      String(payload.error ?? ""),
      /already exists for that idempotencyKey/i,
    );
  } finally {
    await executeTool("process_stop", {
      processId: startPayload.processId,
      gracePeriodMs: 500,
    });
  }
});

test("process_start rejects label conflicts while the managed process is still running", async () => {
  const label = `service-${Date.now().toString(36)}`;
  const nodeExec = process.execPath;

  const started = await executeTool("process_start", {
    command: nodeExec,
    args: ["-e", "setInterval(() => {}, 1000);"],
    label,
    idempotencyKey: `${label}-request-a`,
  });
  assert.notEqual(started.isError, true);
  const startPayload = JSON.parse(started.content) as Record<string, unknown>;

  try {
    const conflicting = await executeTool("process_start", {
      command: nodeExec,
      args: ["-e", "console.log('different'); setInterval(() => {}, 1000);"],
      label,
      idempotencyKey: `${label}-request-b`,
    });
    assert.equal(conflicting.isError, true);
    const payload = JSON.parse(conflicting.content) as Record<string, unknown>;
    assert.match(String(payload.error ?? ""), /already exists for that label/i);
  } finally {
    await executeTool("process_stop", {
      processId: startPayload.processId,
      gracePeriodMs: 500,
    });
  }
});

test("process_start rejects shell wrapper commands", async () => {
  const result = await executeTool("process_start", {
    command: "bash",
    args: ["-lc", "sleep 5"],
  });
  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content) as Record<string, unknown>;
  assert.match(
    String(payload.error ?? ""),
    /not allowed in process_start/i,
  );
});

test("managed-process registry writes are serialized and stay valid on overlapping updates", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "agenc-managed-process-log-"));
  const logPath = join(logDir, "proc.log");
  const processId = `proc_test_${Date.now().toString(36)}`;

  try {
    await __managedProcessTestHooks.reset();
    __managedProcessTestHooks.seed([
      {
        processId,
        label: "registry-race-test",
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000);"],
        cwd: process.cwd(),
        logPath,
        pid: process.pid,
        pgid: process.pid,
        state: "running",
        startedAt: Date.now(),
        launchFingerprint: "seed-fingerprint",
      },
    ]);

    await Promise.all([
      __managedProcessTestHooks.persist(),
      __managedProcessTestHooks.finalizeExit(processId, 0, null),
      __managedProcessTestHooks.persist(),
    ]);

    const raw = await readFile(__managedProcessTestHooks.getRegistryPath(), "utf8");
    const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.processId, processId);
    assert.equal(parsed[0]?.state, "exited");
    assert.equal(parsed[0]?.exitCode, 0);
  } finally {
    await __managedProcessTestHooks.reset();
    await rm(logDir, { recursive: true, force: true });
  }
});

test("process_status fails closed for legacy running records without identity metadata", async () => {
  const processId = `proc_legacy_${Date.now().toString(36)}`;

  try {
    await __managedProcessTestHooks.reset();
    __managedProcessTestHooks.seed([
      {
        processId,
        label: "legacy-running",
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000);"],
        cwd: process.cwd(),
        logPath: join(tmpdir(), `${processId}.log`),
        pid: process.pid,
        pgid: process.pid,
        state: "running",
        startedAt: Date.now(),
        launchFingerprint: "legacy-fingerprint",
      },
    ]);

    const status = await executeTool("process_status", {
      processId,
    });
    assert.notEqual(status.isError, true);
    const payload = JSON.parse(status.content) as Record<string, unknown>;
    assert.equal(payload.state, "exited");
    assert.equal(payload.running, false);
  } finally {
    await __managedProcessTestHooks.reset();
  }
});

test("process_stop does not signal a stale handle after identity mismatch", async () => {
  const processId = `proc_stale_${Date.now().toString(36)}`;

  try {
    await __managedProcessTestHooks.reset();
    __managedProcessTestHooks.seed([
      {
        processId,
        label: "stale-running",
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000);"],
        cwd: process.cwd(),
        logPath: join(tmpdir(), `${processId}.log`),
        pid: process.pid,
        pgid: process.pid,
        processStartToken: "stale-start-token",
        processBootId: "stale-boot-id",
        state: "running",
        startedAt: Date.now(),
        launchFingerprint: "stale-fingerprint",
      },
    ]);

    const stopped = await executeTool("process_stop", {
      processId,
      gracePeriodMs: 100,
    });
    assert.notEqual(stopped.isError, true);
    const payload = JSON.parse(stopped.content) as Record<string, unknown>;
    assert.equal(payload.state, "exited");
    assert.equal(payload.stopped, false);
    assert.equal(payload.alreadyExited, true);
  } finally {
    await __managedProcessTestHooks.reset();
  }
});
