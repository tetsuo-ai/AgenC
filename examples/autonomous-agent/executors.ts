/**
 * Example Task Executors
 *
 * Reference implementations showing how to create custom executors.
 * Copy and modify these for your own use cases.
 *
 * @module
 */

import { Task, TaskExecutor } from '@agenc/runtime';

/**
 * Echo executor - returns a deterministic output based on task ID
 * Useful for testing and demos
 */
export class EchoExecutor implements TaskExecutor {
  async execute(task: Task): Promise<bigint[]> {
    // Generate deterministic output from task ID
    const output: bigint[] = [];
    for (let i = 0; i < 4; i++) {
      let value = 0n;
      for (let j = 0; j < 8; j++) {
        const idx = (i * 8 + j) % task.taskId.length;
        value |= BigInt(task.taskId[idx]) << BigInt(j * 8);
      }
      output.push(value);
    }
    return output;
  }

  canExecute(_task: Task): boolean {
    return true;
  }
}

/**
 * HTTP executor - calls an external webhook to execute tasks
 */
export interface HttpExecutorConfig {
  /** Webhook URL to call */
  url: string;
  /** Authorization header value */
  authorization?: string;
  /** Request timeout in ms */
  timeoutMs?: number;
}

export class HttpExecutor implements TaskExecutor {
  private readonly url: string;
  private readonly authorization?: string;
  private readonly timeoutMs: number;

  constructor(config: HttpExecutorConfig) {
    this.url = config.url;
    this.authorization = config.authorization;
    this.timeoutMs = config.timeoutMs ?? 30000;
  }

  async execute(task: Task): Promise<bigint[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this.authorization) {
        headers['Authorization'] = this.authorization;
      }

      const response = await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          taskId: Array.from(task.taskId),
          taskPda: task.pda.toBase58(),
          creator: task.creator.toBase58(),
          description: Buffer.from(task.description).toString('utf-8').replace(/\0/g, ''),
          reward: task.reward.toString(),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = (await response.json()) as { output: string[] };

      if (!result.output || !Array.isArray(result.output) || result.output.length !== 4) {
        throw new Error('Invalid response: expected { output: [4 bigint strings] }');
      }

      return result.output.map((s: string) => BigInt(s));
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Random executor - generates random output
 * Useful for load testing
 */
export class RandomExecutor implements TaskExecutor {
  async execute(_task: Task): Promise<bigint[]> {
    const output: bigint[] = [];
    for (let i = 0; i < 4; i++) {
      const bytes = new Uint8Array(8);
      crypto.getRandomValues(bytes);
      let value = 0n;
      for (let j = 0; j < 8; j++) {
        value |= BigInt(bytes[j]) << BigInt(j * 8);
      }
      output.push(value);
    }
    return output;
  }
}

/**
 * Delayed executor - wraps another executor with a delay
 * Useful for simulating real work
 */
export class DelayedExecutor implements TaskExecutor {
  constructor(
    private readonly inner: TaskExecutor,
    private readonly delayMs: number
  ) {}

  async execute(task: Task): Promise<bigint[]> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return this.inner.execute(task);
  }

  canExecute(task: Task): boolean {
    return this.inner.canExecute?.(task) ?? true;
  }
}

/**
 * Capability-filtered executor - only handles tasks with specific capabilities
 */
export class CapabilityExecutor implements TaskExecutor {
  constructor(
    private readonly inner: TaskExecutor,
    private readonly capabilities: bigint
  ) {}

  async execute(task: Task): Promise<bigint[]> {
    return this.inner.execute(task);
  }

  canExecute(task: Task): boolean {
    // Check if task requires capabilities we have
    if ((task.requiredCapabilities & this.capabilities) !== task.requiredCapabilities) {
      return false;
    }
    return this.inner.canExecute?.(task) ?? true;
  }
}
