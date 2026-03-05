export interface GatewaySocketBackoffConfig {
  baseDelayMs: number;
  maxDelayMs: number;
  jitterFactor: number;
}

export const DEFAULT_GATEWAY_SOCKET_BACKOFF: GatewaySocketBackoffConfig = {
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  jitterFactor: 0.2,
};

export const DEFAULT_GATEWAY_PING_INTERVAL_MS = 30_000;
export const DEFAULT_GATEWAY_MAX_OFFLINE_QUEUE = 1_000;

export function computeReconnectDelayMs(
  attempt: number,
  config: GatewaySocketBackoffConfig = DEFAULT_GATEWAY_SOCKET_BACKOFF,
): number {
  const base = Math.min(
    config.baseDelayMs * Math.pow(2, attempt),
    config.maxDelayMs,
  );
  const jitter = 1 + Math.random() * config.jitterFactor;
  return Math.round(base * jitter);
}

export function enqueueBounded(
  queue: string[],
  payload: string,
  maxSize: number,
): void {
  if (queue.length >= maxSize) {
    queue.shift();
  }
  queue.push(payload);
}

export interface SocketLike {
  readyState: number;
  send(data: string): void;
}

export function flushQueueIfOpen(
  socket: SocketLike | null | undefined,
  openState: number,
  queue: string[],
): number {
  if (!socket || socket.readyState !== openState) {
    return queue.length;
  }
  while (queue.length > 0) {
    const next = queue.shift();
    if (next !== undefined) {
      socket.send(next);
    }
  }
  return queue.length;
}

export function serializePingMessage(): string {
  return JSON.stringify({ type: "ping" });
}

export function serializeAuthMessage(token: string): string {
  return JSON.stringify({ type: "auth", payload: { token } });
}

export function parseJsonMessage(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  return JSON.parse(raw);
}

export type GatewayControlMessageKind =
  | "auth_ok"
  | "auth_error"
  | "pong"
  | "other";

export interface GatewayControlMessage {
  kind: GatewayControlMessageKind;
  error?: string;
}

export function classifyGatewayControlMessage(
  parsed: unknown,
): GatewayControlMessage {
  if (!parsed || typeof parsed !== "object") {
    return { kind: "other" };
  }
  const message = parsed as Record<string, unknown>;
  if (message.type === "auth") {
    if (message.error) {
      return { kind: "auth_error", error: String(message.error) };
    }
    return { kind: "auth_ok" };
  }
  if (message.type === "pong") {
    return { kind: "pong" };
  }
  return { kind: "other" };
}
