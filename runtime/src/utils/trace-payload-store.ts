import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { safeStringify } from "../tools/types.js";
import { sanitizeTracePayloadForArtifact } from "./trace-payload-serialization.js";

const TRACE_PAYLOAD_ROOT = join(homedir(), ".agenc", "trace-payloads");

export interface TracePayloadArtifactRef {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

function sanitizeSegment(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  const collapsed = trimmed.replace(/[^A-Za-z0-9._-]+/g, "_");
  const bounded = collapsed.slice(0, 96).replace(/^_+|_+$/g, "");
  return bounded.length > 0 ? bounded : fallback;
}

export function persistTracePayloadArtifact(params: {
  traceId?: string;
  eventName: string;
  payload: Record<string, unknown>;
}): TracePayloadArtifactRef | undefined {
  try {
    const sanitizedPayload = sanitizeTracePayloadForArtifact(params.payload);
    const document = {
      eventName: params.eventName,
      traceId: params.traceId,
      capturedAt: new Date().toISOString(),
      payload: sanitizedPayload,
    };
    const serialized = safeStringify(document);
    const sha256 = createHash("sha256").update(serialized).digest("hex");
    const traceDir = join(
      TRACE_PAYLOAD_ROOT,
      sanitizeSegment(params.traceId ?? "trace", "trace"),
    );
    mkdirSync(traceDir, { recursive: true });
    const fileName = `${Date.now()}-${sanitizeSegment(params.eventName, "trace-event")}-${sha256.slice(0, 12)}.json`;
    const filePath = join(traceDir, fileName);
    writeFileSync(filePath, `${serialized}\n`, "utf8");
    return {
      path: filePath,
      sha256,
      bytes: Buffer.byteLength(serialized),
    };
  } catch {
    return undefined;
  }
}
