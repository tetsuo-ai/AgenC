/**
 * In-memory storage backend
 */

import type { Message } from '../../types/llm';
import type { OnChainTask, TaskHistoryEntry } from '../../types/task';
import type { MemoryBackend, InMemoryBackendConfig } from '../../types/memory';

/**
 * In-memory backend for MemoryStore
 * Useful for development and testing
 */
export class InMemoryBackend implements MemoryBackend {
  private messages: Message[] = [];
  private currentTask: OnChainTask | null = null;
  private taskHistory: TaskHistoryEntry[] = [];
  private kvStore: Map<string, Map<string, unknown>> = new Map();

  private maxMessages: number;
  private maxTaskHistory: number;

  constructor(config: InMemoryBackendConfig = {}) {
    this.maxMessages = config.maxMessages ?? 1000;
    this.maxTaskHistory = config.maxTaskHistory ?? 100;
  }

  // === Conversation ===

  async addMessage(message: Message): Promise<void> {
    this.messages.push(message);

    // Trim old messages if over limit
    if (this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(-this.maxMessages);
    }
  }

  async getMessages(limit?: number): Promise<Message[]> {
    if (limit === undefined) {
      return [...this.messages];
    }
    return this.messages.slice(-limit);
  }

  async clearConversation(): Promise<void> {
    this.messages = [];
  }

  // === Task Context ===

  async setCurrentTask(task: OnChainTask | null): Promise<void> {
    this.currentTask = task;
  }

  async getCurrentTask(): Promise<OnChainTask | null> {
    return this.currentTask;
  }

  async addTaskResult(entry: TaskHistoryEntry): Promise<void> {
    this.taskHistory.push(entry);

    // Trim old history if over limit
    if (this.taskHistory.length > this.maxTaskHistory) {
      this.taskHistory = this.taskHistory.slice(-this.maxTaskHistory);
    }
  }

  async getTaskHistory(limit?: number): Promise<TaskHistoryEntry[]> {
    if (limit === undefined) {
      return [...this.taskHistory];
    }
    return this.taskHistory.slice(-limit);
  }

  async getTaskResult(taskId: Buffer): Promise<TaskHistoryEntry | null> {
    const taskIdHex = taskId.toString('hex');
    return this.taskHistory.find(
      (entry) => entry.taskId.toString('hex') === taskIdHex
    ) ?? null;
  }

  // === Key-Value Store ===

  async set(namespace: string, key: string, value: unknown): Promise<void> {
    if (!this.kvStore.has(namespace)) {
      this.kvStore.set(namespace, new Map());
    }
    this.kvStore.get(namespace)!.set(key, value);
  }

  async get<T>(namespace: string, key: string): Promise<T | null> {
    const ns = this.kvStore.get(namespace);
    if (!ns) return null;
    return (ns.get(key) as T) ?? null;
  }

  async delete(namespace: string, key: string): Promise<void> {
    const ns = this.kvStore.get(namespace);
    if (ns) {
      ns.delete(key);
    }
  }

  async keys(namespace: string): Promise<string[]> {
    const ns = this.kvStore.get(namespace);
    if (!ns) return [];
    return Array.from(ns.keys());
  }

  // === Persistence (no-op for in-memory) ===

  async save(): Promise<void> {
    // In-memory backend doesn't persist
  }

  async load(): Promise<void> {
    // In-memory backend doesn't persist
  }

  async clear(): Promise<void> {
    this.messages = [];
    this.currentTask = null;
    this.taskHistory = [];
    this.kvStore.clear();
  }

  // === Utilities ===

  /**
   * Export all data (for debugging or migration)
   */
  export(): {
    messages: Message[];
    currentTask: OnChainTask | null;
    taskHistory: TaskHistoryEntry[];
    kvStore: Record<string, Record<string, unknown>>;
  } {
    const kvStoreObj: Record<string, Record<string, unknown>> = {};
    for (const [ns, map] of this.kvStore.entries()) {
      kvStoreObj[ns] = Object.fromEntries(map.entries());
    }

    return {
      messages: [...this.messages],
      currentTask: this.currentTask,
      taskHistory: [...this.taskHistory],
      kvStore: kvStoreObj,
    };
  }

  /**
   * Import data (for debugging or migration)
   */
  import(data: {
    messages?: Message[];
    currentTask?: OnChainTask | null;
    taskHistory?: TaskHistoryEntry[];
    kvStore?: Record<string, Record<string, unknown>>;
  }): void {
    if (data.messages) {
      this.messages = [...data.messages];
    }
    if (data.currentTask !== undefined) {
      this.currentTask = data.currentTask;
    }
    if (data.taskHistory) {
      this.taskHistory = [...data.taskHistory];
    }
    if (data.kvStore) {
      this.kvStore.clear();
      for (const [ns, obj] of Object.entries(data.kvStore)) {
        this.kvStore.set(ns, new Map(Object.entries(obj)));
      }
    }
  }
}
