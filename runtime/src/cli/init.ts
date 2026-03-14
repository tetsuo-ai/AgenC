import { readFile, stat } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import type { InitRunControlResponsePayload } from "../gateway/types.js";
import {
  getDefaultPidPath,
  readPidFile,
  isProcessAlive,
} from "../gateway/daemon.js";
import { getDefaultConfigPath } from "../gateway/config-watcher.js";
import {
  resolveInitGuidePath,
  validateInitGuideContent,
} from "../gateway/init-runner.js";
import { toErrorMessage } from "../utils/async.js";
import { runStartCommand } from "./daemon.js";
import type {
  CliRuntimeContext,
  CliStatusCode,
  DaemonStartOptions,
  InitOptions,
} from "./types.js";

const INIT_CONTROL_TIMEOUT_MS = 10 * 60_000;

export interface InitCommandDeps {
  readonly readPidFile: typeof readPidFile;
  readonly isProcessAlive: typeof isProcessAlive;
  readonly runStartCommand: (
    context: CliRuntimeContext,
    options: DaemonStartOptions,
  ) => Promise<CliStatusCode>;
  readonly requestInitRun: (params: {
    port: number;
    projectRoot: string;
    force: boolean;
    timeoutMs: number;
  }) => Promise<InitRunControlResponsePayload>;
  readonly readFile: typeof readFile;
}

const defaultDeps: InitCommandDeps = {
  readPidFile,
  isProcessAlive,
  runStartCommand,
  requestInitRun: requestInitRunOverControlPlane,
  readFile,
};

function isInitRunControlResponsePayload(
  value: unknown,
): value is InitRunControlResponsePayload {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as Record<string, unknown>;
  return (
    typeof payload.projectRoot === "string" &&
    typeof payload.filePath === "string" &&
    (payload.result === "created" ||
      payload.result === "updated" ||
      payload.result === "skipped") &&
    typeof payload.delegatedInvestigations === "number" &&
    typeof payload.attempts === "number" &&
    payload.modelBacked === true
  );
}

async function requestInitRunOverControlPlane(params: {
  port: number;
  projectRoot: string;
  force: boolean;
  timeoutMs: number;
}): Promise<InitRunControlResponsePayload> {
  type WsLike = {
    on(event: string, handler: (...args: unknown[]) => void): void;
    send(data: string): void;
    close(): void;
  };

  let WsConstructor: new (url: string) => WsLike;
  try {
    const wsModule = (await import("ws")) as {
      default: new (url: string) => WsLike;
    };
    WsConstructor = wsModule.default;
  } catch {
    throw new Error("ws module not available");
  }

  return new Promise<InitRunControlResponsePayload>((resolve, reject) => {
    const ws = new WsConstructor(`ws://127.0.0.1:${params.port}`);
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        try {
          ws.close();
        } catch {
          // best effort
        }
        reject(
          new Error(
            `init.run timed out after ${Math.round(params.timeoutMs / 1000)}s`,
          ),
        );
      });
    }, params.timeoutMs);

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "init.run",
          payload: {
            path: params.projectRoot,
            force: params.force,
          },
        }),
      );
    });

    ws.on("message", (data: unknown) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        return;
      }
      if (typeof parsed !== "object" || parsed === null) {
        return;
      }
      const message = parsed as {
        type?: string;
        payload?: unknown;
        error?: string;
      };
      if (message.type !== "init.run") {
        return;
      }
      finish(() => {
        try {
          ws.close();
        } catch {
          // best effort
        }
        if (typeof message.error === "string" && message.error.length > 0) {
          reject(new Error(message.error));
          return;
        }
        if (!isInitRunControlResponsePayload(message.payload)) {
          reject(new Error("Daemon returned a malformed init.run payload"));
          return;
        }
        resolve(message.payload);
      });
    });

    ws.on("close", () => {
      finish(() => {
        reject(new Error("Control plane connection closed before init completed"));
      });
    });

    ws.on("error", () => {
      finish(() => {
        reject(new Error("Control plane connection failed"));
      });
    });
  });
}

async function ensureDaemonPort(
  context: CliRuntimeContext,
  options: InitOptions,
  deps: InitCommandDeps,
): Promise<number> {
  const pidPath = resolvePath(options.pidPath ?? getDefaultPidPath());
  const existing = await deps.readPidFile(pidPath);
  if (existing && deps.isProcessAlive(existing.pid)) {
    return options.controlPlanePort ?? existing.port;
  }

  const bootstrapErrors: unknown[] = [];
  const bootstrapContext: CliRuntimeContext = {
    logger: context.logger,
    outputFormat: context.outputFormat,
    output: () => {},
    error: (value) => bootstrapErrors.push(value),
  };
  const code = await deps.runStartCommand(bootstrapContext, {
    configPath: options.configPath ?? getDefaultConfigPath(),
    pidPath,
  });
  if (code !== 0) {
    const bootstrapMessage = bootstrapErrors
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as Record<string, unknown>).message === "string"
        ) {
          return String((entry as Record<string, unknown>).message);
        }
        return "";
      })
      .find((value) => value.length > 0);
    throw new Error(
      bootstrapMessage ?? "Failed to start the AgenC daemon for init",
    );
  }

  const started = await deps.readPidFile(pidPath);
  if (!started || !deps.isProcessAlive(started.pid)) {
    throw new Error("Daemon did not expose a live PID file after startup");
  }
  return options.controlPlanePort ?? started.port;
}

export async function runInitCommand(
  context: CliRuntimeContext,
  options: InitOptions,
  deps: InitCommandDeps = defaultDeps,
): Promise<CliStatusCode> {
  const projectRoot = resolvePath(options.path ?? process.cwd());
  const filePath = resolveInitGuidePath(projectRoot);

  try {
    const projectStats = await stat(projectRoot).catch(() => null);
    if (!projectStats) {
      throw new Error(`Target path does not exist: ${projectRoot}`);
    }
    if (!projectStats.isDirectory()) {
      throw new Error(`Target path is not a directory: ${projectRoot}`);
    }

    const existing = await deps.readFile(filePath, "utf-8").catch(() => null);
    if (existing !== null && options.force !== true) {
      context.output({
        status: "ok",
        command: "init",
        projectRoot,
        filePath,
        result: "skipped",
        force: false,
      });
      return 0;
    }

    const port = await ensureDaemonPort(context, options, deps);
    const response = await deps.requestInitRun({
      port,
      projectRoot,
      force: options.force === true,
      timeoutMs: INIT_CONTROL_TIMEOUT_MS,
    });

    const content = await deps.readFile(response.filePath, "utf-8").catch(
      (error) => {
        throw new Error(
          `Daemon reported success but ${response.filePath} could not be read: ${toErrorMessage(error)}`,
        );
      },
    );
    const validationError = validateInitGuideContent(content);
    if (validationError) {
      throw new Error(
        `Daemon reported success but generated AGENC.md failed validation: ${validationError}`,
      );
    }

    context.output({
      status: "ok",
      command: "init",
      projectRoot,
      filePath: response.filePath,
      result: response.result,
      force: options.force === true,
      delegatedInvestigations: response.delegatedInvestigations,
      attempts: response.attempts,
      modelBacked: response.modelBacked,
      ...(response.provider ? { provider: response.provider } : {}),
      ...(response.model ? { model: response.model } : {}),
      ...(typeof response.usedFallback === "boolean"
        ? { usedFallback: response.usedFallback }
        : {}),
    });
    return 0;
  } catch (error) {
    context.error({
      status: "error",
      command: "init",
      projectRoot,
      message: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}
