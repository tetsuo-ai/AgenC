import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { formatTracePayloadForLog } from "../utils/trace-payload-serialization.js";
import type { ObservabilityEventRecord } from "./types.js";

export type TraceLogFanoutCategory =
  | "errors"
  | "provider"
  | "executor"
  | "subagents";

export interface TraceLogFanoutPaths {
  readonly errors: string;
  readonly provider: string;
  readonly executor: string;
  readonly subagents: string;
}

export interface TraceLogFanoutConfig {
  readonly enabled?: boolean;
  readonly daemonLogPath: string;
}

const TRACE_LOG_FANOUT_PREFIX = "[AgenC Runtime]";

function deriveLogStem(daemonLogPath: string): { dir: string; stem: string; ext: string } {
  const dir = dirname(daemonLogPath);
  const ext = extname(daemonLogPath);
  const baseName = basename(daemonLogPath);
  const stem = ext.length > 0
    ? baseName.slice(0, Math.max(0, baseName.length - ext.length))
    : baseName;
  return {
    dir,
    stem: stem.length > 0 ? stem : "daemon",
    ext: ext.length > 0 ? ext : ".log",
  };
}

function isDelegationTraceEventName(eventName: string): boolean {
  return (
    eventName.startsWith("delegation.") ||
    eventName.startsWith("sub_agent.") ||
    eventName.startsWith("subagent.") ||
    eventName.startsWith("subagents.") ||
    eventName.includes(".delegation.") ||
    eventName.includes(".sub_agent.") ||
    eventName.includes(".subagent.") ||
    eventName.includes(".subagents.")
  );
}

function toPayloadRecord(payloadPreview: unknown): Record<string, unknown> {
  if (
    typeof payloadPreview === "object" &&
    payloadPreview !== null &&
    !Array.isArray(payloadPreview)
  ) {
    return payloadPreview as Record<string, unknown>;
  }
  return { payloadPreview };
}

export function deriveTraceLogFanoutPaths(
  daemonLogPath: string,
): TraceLogFanoutPaths {
  const { dir, stem, ext } = deriveLogStem(daemonLogPath);
  return {
    errors: join(dir, `${stem}.errors${ext}`),
    provider: join(dir, `${stem}.provider${ext}`),
    executor: join(dir, `${stem}.executor${ext}`),
    subagents: join(dir, `${stem}.subagents${ext}`),
  };
}

export function classifyTraceLogFanoutCategories(
  event: Pick<ObservabilityEventRecord, "eventName" | "level" | "channel">,
): readonly TraceLogFanoutCategory[] {
  const categories = new Set<TraceLogFanoutCategory>();

  if (event.level === "error" || event.eventName.endsWith(".error")) {
    categories.add("errors");
  }
  if (event.eventName.includes(".provider.")) {
    categories.add("provider");
  }
  if (event.eventName.includes(".executor.")) {
    categories.add("executor");
  }
  if (
    event.channel === "subagents" ||
    isDelegationTraceEventName(event.eventName)
  ) {
    categories.add("subagents");
  }

  return [...categories];
}

export function renderTraceLogFanoutLine(
  event: Pick<
    ObservabilityEventRecord,
    "timestampMs" | "level" | "eventName" | "payloadPreview"
  >,
): string {
  const timestamp = new Date(event.timestampMs).toISOString();
  const level = event.level.toUpperCase().padEnd(5);
  return (
    `${timestamp} ${level} ${TRACE_LOG_FANOUT_PREFIX} [trace] ` +
    `${event.eventName} ${formatTracePayloadForLog(toPayloadRecord(event.payloadPreview))}\n`
  );
}

function writeStreamLine(stream: WriteStream, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(line, "utf8", (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function closeWriteStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    const handleError = (error: Error) => {
      stream.off("close", handleClose);
      reject(error);
    };
    const handleClose = () => {
      stream.off("error", handleError);
      resolve();
    };

    stream.once("error", handleError);
    stream.once("close", handleClose);
    stream.end();
  });
}

export class TraceLogFanout {
  private readonly enabled: boolean;
  private readonly paths: TraceLogFanoutPaths;
  private readonly streams = new Map<TraceLogFanoutCategory, WriteStream>();

  constructor(config: TraceLogFanoutConfig) {
    this.enabled = config.enabled === true;
    this.paths = deriveTraceLogFanoutPaths(config.daemonLogPath);
  }

  getPaths(): TraceLogFanoutPaths {
    return this.paths;
  }

  async writeEvent(event: ObservabilityEventRecord): Promise<void> {
    if (!this.enabled) return;

    const categories = classifyTraceLogFanoutCategories(event);
    if (categories.length === 0) return;

    const line = renderTraceLogFanoutLine(event);
    for (const category of categories) {
      const stream = this.getStream(category);
      await writeStreamLine(stream, line);
    }
  }

  async close(): Promise<void> {
    if (this.streams.size === 0) return;
    const streams = [...this.streams.values()];
    this.streams.clear();
    await Promise.all(streams.map((stream) => closeWriteStream(stream)));
  }

  private getStream(category: TraceLogFanoutCategory): WriteStream {
    const existing = this.streams.get(category);
    if (existing) return existing;

    const path = this.paths[category];
    mkdirSync(dirname(path), { recursive: true });
    const stream = createWriteStream(path, {
      flags: "a",
      encoding: "utf8",
    });
    this.streams.set(category, stream);
    return stream;
  }
}
