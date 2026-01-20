/**
 * Memory Store implementation with pluggable backends
 */

import type { PublicKey } from '@solana/web3.js';
import type { Message } from '../types/llm';
import type { OnChainTask, TaskResult, TaskHistoryEntry } from '../types/task';
import type {
  MemoryStore,
  MemoryBackend,
  MemoryStats,
} from '../types/memory';

export interface MemoryStoreConfig {
  /** Backend to use for storage */
  backend: MemoryBackend;
  /** LLM adapter for summarization (optional) */
  summarizer?: {
    summarize(messages: Message[]): Promise<string>;
  };
}

/**
 * Memory store with conversation history, task context, and key-value storage
 */
export class DefaultMemoryStore implements MemoryStore {
  private backend: MemoryBackend;
  private summarizer?: { summarize(messages: Message[]): Promise<string> };

  constructor(config: MemoryStoreConfig) {
    this.backend = config.backend;
    this.summarizer = config.summarizer;
  }

  // === Conversation ===

  async addMessage(message: Message): Promise<void> {
    await this.backend.addMessage(message);
  }

  async getMessages(limit?: number): Promise<Message[]> {
    return this.backend.getMessages(limit);
  }

  async summarize(): Promise<string> {
    const messages = await this.getMessages();

    if (messages.length === 0) {
      return '';
    }

    if (this.summarizer) {
      return this.summarizer.summarize(messages);
    }

    // Basic summarization without LLM
    const roleCount: Record<string, number> = {};
    let totalLength = 0;

    for (const msg of messages) {
      roleCount[msg.role] = (roleCount[msg.role] || 0) + 1;
      totalLength += msg.content.length;
    }

    return `Conversation with ${messages.length} messages (${Object.entries(roleCount).map(([r, c]) => `${c} ${r}`).join(', ')}). Total length: ${totalLength} characters.`;
  }

  async clearConversation(): Promise<void> {
    await this.backend.clearConversation();
  }

  // === Task Context ===

  async setCurrentTask(task: OnChainTask | null): Promise<void> {
    await this.backend.setCurrentTask(task);
  }

  async getCurrentTask(): Promise<OnChainTask | null> {
    return this.backend.getCurrentTask();
  }

  async addTaskResult(
    taskId: Buffer,
    taskAddress: PublicKey,
    result: TaskResult,
    txSignature: string,
    rewardReceived: bigint
  ): Promise<void> {
    const entry: TaskHistoryEntry = {
      taskId,
      taskAddress,
      result,
      txSignature,
      completedAt: Date.now(),
      rewardReceived,
    };
    await this.backend.addTaskResult(entry);
  }

  async getTaskHistory(limit?: number): Promise<TaskHistoryEntry[]> {
    return this.backend.getTaskHistory(limit);
  }

  async getTaskResult(taskId: Buffer): Promise<TaskHistoryEntry | null> {
    return this.backend.getTaskResult(taskId);
  }

  // === Key-Value Store ===

  async set(namespace: string, key: string, value: unknown): Promise<void> {
    await this.backend.set(namespace, key, value);
  }

  async get<T>(namespace: string, key: string): Promise<T | null> {
    return this.backend.get<T>(namespace, key);
  }

  async delete(namespace: string, key: string): Promise<void> {
    await this.backend.delete(namespace, key);
  }

  async keys(namespace: string): Promise<string[]> {
    return this.backend.keys(namespace);
  }

  // === Persistence ===

  async save(): Promise<void> {
    await this.backend.save();
  }

  async load(): Promise<void> {
    await this.backend.load();
  }

  async clear(): Promise<void> {
    await this.backend.clear();
  }

  // === Stats ===

  async getStats(): Promise<MemoryStats> {
    const messages = await this.getMessages();
    const taskHistory = await this.getTaskHistory();

    let totalChars = 0;
    for (const msg of messages) {
      totalChars += msg.content.length;
    }

    // Rough token estimate: 4 chars per token
    const tokenCount = Math.ceil(totalChars / 4);

    // Rough size estimate
    const sizeBytes = JSON.stringify({ messages, taskHistory }).length;

    return {
      messageCount: messages.length,
      tokenCount,
      taskHistoryCount: taskHistory.length,
      sizeBytes,
    };
  }
}
