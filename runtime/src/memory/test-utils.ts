/**
 * Shared mock MemoryBackend factory for tests.
 *
 * Provides a fully functional in-memory mock that uses `vi.fn()` spies,
 * making it easy to assert calls and inject failures.
 *
 * @module
 */

import { vi } from "vitest";
import type { MemoryBackend } from "./types.js";

/**
 * Create a mock MemoryBackend backed by a plain Map.
 * All methods are vi.fn() spies for assertion.
 * Values are deep-cloned on set/get to mirror real backend behavior.
 */
export function createMockMemoryBackend(): MemoryBackend {
  const store = new Map<string, unknown>();
  return {
    name: "mock",
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, JSON.parse(JSON.stringify(value)));
    }),
    get: vi.fn(async <T = unknown>(key: string): Promise<T | undefined> => {
      const v = store.get(key);
      return v !== undefined ? (JSON.parse(JSON.stringify(v)) as T) : undefined;
    }),
    delete: vi.fn(async (key: string) => {
      return store.delete(key);
    }),
    has: vi.fn(async (key: string) => store.has(key)),
    listKeys: vi.fn(async () => [...store.keys()]),
    appendToThread: vi.fn(),
    getThread: vi.fn(async () => []),
    getThreadCount: vi.fn(async () => 0),
    clearThread: vi.fn(),
    listSessions: vi.fn(async () => []),
    close: vi.fn(),
  } as unknown as MemoryBackend;
}
