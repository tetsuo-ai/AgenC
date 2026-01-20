/**
 * File-based storage backend
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { PublicKey } from '@solana/web3.js';
import type { Message } from '../../types/llm';
import type { OnChainTask, TaskHistoryEntry } from '../../types/task';
import type { MemoryBackend } from '../../types/memory';

export interface FileBackendConfig {
  /** Directory path for storage files */
  directory: string;
  /** Maximum messages to keep */
  maxMessages?: number;
  /** Maximum task history entries */
  maxTaskHistory?: number;
  /** Auto-save on every write */
  autoSave?: boolean;
}

interface StorageData {
  messages: Message[];
  currentTask: OnChainTask | null;
  taskHistory: TaskHistoryEntry[];
  kvStore: Record<string, Record<string, unknown>>;
}

/**
 * File-based backend for MemoryStore
 * Persists data to JSON files
 */
export class FileBackend implements MemoryBackend {
  private messages: Message[] = [];
  private currentTask: OnChainTask | null = null;
  private taskHistory: TaskHistoryEntry[] = [];
  private kvStore: Map<string, Map<string, unknown>> = new Map();

  private directory: string;
  private maxMessages: number;
  private maxTaskHistory: number;
  private autoSave: boolean;
  private dirty: boolean = false;

  constructor(config: FileBackendConfig) {
    this.directory = config.directory;
    this.maxMessages = config.maxMessages ?? 1000;
    this.maxTaskHistory = config.maxTaskHistory ?? 100;
    this.autoSave = config.autoSave ?? false;
  }

  private get filePath(): string {
    return path.join(this.directory, 'memory.json');
  }

  private async maybeSave(): Promise<void> {
    if (this.autoSave && this.dirty) {
      await this.save();
    }
  }

  // === Conversation ===

  async addMessage(message: Message): Promise<void> {
    this.messages.push(message);
    this.dirty = true;

    if (this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(-this.maxMessages);
    }

    await this.maybeSave();
  }

  async getMessages(limit?: number): Promise<Message[]> {
    if (limit === undefined) {
      return [...this.messages];
    }
    return this.messages.slice(-limit);
  }

  async clearConversation(): Promise<void> {
    this.messages = [];
    this.dirty = true;
    await this.maybeSave();
  }

  // === Task Context ===

  async setCurrentTask(task: OnChainTask | null): Promise<void> {
    this.currentTask = task;
    this.dirty = true;
    await this.maybeSave();
  }

  async getCurrentTask(): Promise<OnChainTask | null> {
    return this.currentTask;
  }

  async addTaskResult(entry: TaskHistoryEntry): Promise<void> {
    this.taskHistory.push(entry);
    this.dirty = true;

    if (this.taskHistory.length > this.maxTaskHistory) {
      this.taskHistory = this.taskHistory.slice(-this.maxTaskHistory);
    }

    await this.maybeSave();
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
    this.dirty = true;
    await this.maybeSave();
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
      this.dirty = true;
      await this.maybeSave();
    }
  }

  async keys(namespace: string): Promise<string[]> {
    const ns = this.kvStore.get(namespace);
    if (!ns) return [];
    return Array.from(ns.keys());
  }

  // === Persistence ===

  async save(): Promise<void> {
    const kvStoreObj: Record<string, Record<string, unknown>> = {};
    for (const [ns, map] of this.kvStore.entries()) {
      kvStoreObj[ns] = Object.fromEntries(map.entries());
    }

    // Convert task history for JSON serialization
    const serializableTaskHistory = this.taskHistory.map((entry) => ({
      ...entry,
      taskId: entry.taskId.toString('hex'),
      taskAddress: entry.taskAddress.toBase58(),
      rewardReceived: entry.rewardReceived.toString(),
    }));

    // Convert current task for JSON serialization
    let serializableCurrentTask = null;
    if (this.currentTask) {
      serializableCurrentTask = {
        ...this.currentTask,
        address: this.currentTask.address.toBase58(),
        taskId: this.currentTask.taskId.toString('hex'),
        creator: this.currentTask.creator.toBase58(),
        escrow: this.currentTask.escrow.toBase58(),
        rewardAmount: this.currentTask.rewardAmount.toString(),
        requiredCapabilities: this.currentTask.requiredCapabilities.toString(),
        description: this.currentTask.description.toString('hex'),
        constraintHash: this.currentTask.constraintHash?.toString('hex') ?? null,
        result: this.currentTask.result.toString('hex'),
      };
    }

    const data = {
      messages: this.messages,
      currentTask: serializableCurrentTask,
      taskHistory: serializableTaskHistory,
      kvStore: kvStoreObj,
    };

    await fs.mkdir(this.directory, { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
    this.dirty = false;
  }

  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      const data = JSON.parse(content);

      this.messages = data.messages ?? [];

      // Deserialize task history
      this.taskHistory = (data.taskHistory ?? []).map((entry: {
        taskId: string;
        taskAddress: string;
        result: { success: boolean; output?: unknown; error?: string };
        txSignature: string;
        completedAt: number;
        rewardReceived: string;
      }) => ({
        ...entry,
        taskId: Buffer.from(entry.taskId, 'hex'),
        taskAddress: new PublicKey(entry.taskAddress),
        rewardReceived: BigInt(entry.rewardReceived),
      }));

      // Deserialize current task
      if (data.currentTask) {
        // Note: PublicKey needs to be imported if we want full deserialization
        // For now, store as-is since it might need the connection context
        this.currentTask = data.currentTask;
      } else {
        this.currentTask = null;
      }

      // Deserialize KV store
      this.kvStore.clear();
      if (data.kvStore) {
        for (const [ns, obj] of Object.entries(data.kvStore)) {
          this.kvStore.set(ns, new Map(Object.entries(obj as Record<string, unknown>)));
        }
      }

      this.dirty = false;
    } catch (error) {
      // File doesn't exist or is invalid, start fresh
      this.messages = [];
      this.currentTask = null;
      this.taskHistory = [];
      this.kvStore.clear();
      this.dirty = false;
    }
  }

  async clear(): Promise<void> {
    this.messages = [];
    this.currentTask = null;
    this.taskHistory = [];
    this.kvStore.clear();
    this.dirty = true;

    try {
      await fs.unlink(this.filePath);
    } catch {
      // File might not exist
    }
  }
}
