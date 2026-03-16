import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile, unlink, access } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { ToolResult, ScreenshotResult, ScreenSizeResult, VideoRecordingState } from "./types.js";
import { DISPLAY, exec, ok, fail, warnBestEffort } from "./tools-shared.js";
import { screenSize } from "./tools-window.js";

// --- Screenshot tool ---

export async function screenshot(): Promise<ToolResult> {
  const path = `/tmp/screenshot-${randomUUID()}.png`;
  try {
    await exec("scrot", ["-o", path]);
    const buf = await readFile(path);
    const size = await screenSize();
    const sizeData = JSON.parse(size.content) as ScreenSizeResult;
    const result: ScreenshotResult = {
      image: buf.toString("base64"),
      width: sizeData.width,
      height: sizeData.height,
    };
    return ok(result);
  } catch (e) {
    return fail(`Screenshot failed: ${e instanceof Error ? e.message : e}`);
  } finally {
    unlink(path).catch((error) => {
      warnBestEffort("screenshot cleanup failed", error);
    });
  }
}

// --- Video recording tools ---

let activeRecording: (VideoRecordingState & { process: ChildProcess }) | null =
  null;
const RECORDING_PID_FILE = "/tmp/recording.pid";

/** Kill orphaned ffmpeg recording from a previous server crash. */
async function cleanupOrphanedRecording(): Promise<void> {
  try {
    const pidStr = await readFile(RECORDING_PID_FILE, "utf-8");
    const pid = parseInt(pidStr.trim(), 10);
    if (Number.isFinite(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already dead */
      }
    }
    await unlink(RECORDING_PID_FILE).catch((error) => {
      warnBestEffort("orphaned recording PID cleanup failed", error);
    });
  } catch {
    /* no pid file */
  }
}

// Run cleanup on module load
void cleanupOrphanedRecording();

export async function videoStart(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (activeRecording) {
    return fail(
      `Already recording to ${activeRecording.path}. Stop the current recording first.`,
    );
  }

  const framerate = Number(args.framerate ?? 15);
  if (!Number.isFinite(framerate) || framerate < 1 || framerate > 60) {
    return fail("framerate must be 1-60");
  }

  // Get current screen size for recording dimensions
  const sizeResult = await screenSize();
  const sizeData = JSON.parse(sizeResult.content) as ScreenSizeResult;

  const path = `/tmp/recording-${randomUUID()}.mp4`;

  try {
    const ffmpeg = spawn(
      "ffmpeg",
      [
        "-video_size",
        `${sizeData.width}x${sizeData.height}`,
        "-framerate",
        String(framerate),
        "-f",
        "x11grab",
        "-i",
        DISPLAY,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "28",
        path,
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, DISPLAY },
        detached: false,
      },
    );

    if (!ffmpeg.pid) {
      return fail("Failed to start ffmpeg process");
    }

    activeRecording = {
      pid: ffmpeg.pid,
      path,
      startedAt: Date.now(),
      process: ffmpeg,
    };

    // Write PID file for crash recovery
    await writeFile(RECORDING_PID_FILE, String(ffmpeg.pid), "utf-8");

    // Auto-cleanup if ffmpeg exits unexpectedly
    ffmpeg.on("exit", () => {
      if (activeRecording?.pid === ffmpeg.pid) {
        activeRecording = null;
        unlink(RECORDING_PID_FILE).catch((error) => {
          warnBestEffort("recording PID cleanup after exit failed", error);
        });
      }
    });

    return ok({ recording: true, path, pid: ffmpeg.pid, framerate });
  } catch (e) {
    return fail(`video_start failed: ${e instanceof Error ? e.message : e}`);
  }
}

export async function videoStop(): Promise<ToolResult> {
  if (!activeRecording) {
    return fail("No active recording");
  }

  const { process: ffmpeg, path, startedAt } = activeRecording;

  try {
    // Send SIGINT for graceful ffmpeg shutdown (writes trailer)
    ffmpeg.kill("SIGINT");

    // Wait for exit with 2s timeout
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          ffmpeg.kill("SIGKILL");
        } catch {
          /* already dead */
        }
        resolve();
      }, 2000);
      ffmpeg.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    const durationMs = Date.now() - startedAt;
    activeRecording = null;
    await unlink(RECORDING_PID_FILE).catch((error) => {
      warnBestEffort("recording PID cleanup after stop failed", error);
    });

    // Verify the file exists
    try {
      await access(path);
    } catch {
      return fail(`Recording file not found at ${path}`);
    }

    return ok({ stopped: true, path, durationMs });
  } catch (e) {
    activeRecording = null;
    await unlink(RECORDING_PID_FILE).catch((error) => {
      warnBestEffort("recording PID cleanup after failure failed", error);
    });
    return fail(`video_stop failed: ${e instanceof Error ? e.message : e}`);
  }
}
