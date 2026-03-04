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
