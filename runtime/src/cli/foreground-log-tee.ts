import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";

type TeeWriteChunk = string | Uint8Array<ArrayBufferLike>;
type TeeWriteCallback = ((error?: Error | null) => void) | undefined;

export interface WritableWriteTarget {
  write(buffer: TeeWriteChunk, cb?: TeeWriteCallback): boolean;
  write(
    str: TeeWriteChunk,
    encoding?: BufferEncoding,
    cb?: TeeWriteCallback,
  ): boolean;
}

export interface ForegroundLogTee {
  readonly logPath: string;
  dispose(): Promise<void>;
}

interface InstallForegroundLogTeeParams {
  readonly logPath: string;
  readonly stdout?: WritableWriteTarget;
  readonly stderr?: WritableWriteTarget;
  readonly warn?: (message: string) => void;
}

export function installForegroundLogTee(
  params: InstallForegroundLogTeeParams,
): ForegroundLogTee | null {
  const stdout = params.stdout ?? process.stdout;
  const stderr = params.stderr ?? process.stderr;

  try {
    mkdirSync(dirname(params.logPath), { recursive: true });
    const logStream = createWriteStream(params.logPath, {
      flags: "a",
      encoding: "utf8",
    });

    const originalStdoutWrite = stdout.write.bind(stdout);
    const originalStderrWrite = stderr.write.bind(stderr);
    let disposed = false;

    const teeWrite =
      (originalWrite: WritableWriteTarget["write"]) =>
      (
        chunk: TeeWriteChunk,
        encodingOrCallback?: BufferEncoding | TeeWriteCallback,
        callback?: TeeWriteCallback,
      ): boolean => {
        try {
          if (typeof encodingOrCallback === "function") {
            logStream.write(chunk, encodingOrCallback);
          } else if (encodingOrCallback !== undefined) {
            logStream.write(chunk, encodingOrCallback, callback);
          } else {
            logStream.write(chunk);
          }
        } catch {
          // Best effort: preserve the foreground stream even if file logging breaks.
        }
        if (typeof encodingOrCallback === "function") {
          return originalWrite(chunk, encodingOrCallback);
        }
        return originalWrite(chunk, encodingOrCallback, callback);
      };

    stdout.write = teeWrite(originalStdoutWrite);
    stderr.write = teeWrite(originalStderrWrite);

    return {
      logPath: params.logPath,
      async dispose(): Promise<void> {
        if (disposed) return;
        disposed = true;
        stdout.write = originalStdoutWrite;
        stderr.write = originalStderrWrite;
        await new Promise<void>((resolve) => {
          logStream.end(() => resolve());
        });
      },
    };
  } catch (error) {
    params.warn?.(
      `Failed to install foreground daemon log tee at ${params.logPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}
