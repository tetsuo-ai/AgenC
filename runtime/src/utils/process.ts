import { execFile } from "node:child_process";

export interface RunCommandOptions {
  cwd: string;
  timeoutMs?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Execute a subprocess and collect stdout/stderr without throwing on non-zero exit.
 */
export function runCommand(
  cmd: string,
  args: string[],
  options: RunCommandOptions,
): Promise<RunCommandResult> {
  const {
    cwd,
    timeoutMs,
    maxBuffer = 10 * 1024 * 1024,
    env = process.env,
  } = options;

  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer,
        env,
      },
      (error, stdout, stderr) => {
        const code = (
          error as NodeJS.ErrnoException & { code?: number | string }
        )?.code;
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode: error
            ? code === "ETIMEDOUT"
              ? 124
              : (child.exitCode ?? 1)
            : 0,
        });
      },
    );
  });
}
