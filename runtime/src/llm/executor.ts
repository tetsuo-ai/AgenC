/**
 * LLMTaskExecutor — bridges an LLMProvider to the autonomous TaskExecutor interface.
 *
 * Decodes the 64-byte task description, sends it to the LLM provider,
 * handles tool call loops, and converts the text response to 4 bigints.
 *
 * @module
 */

import type { TaskExecutor, Task } from '../autonomous/types.js';
import type { LLMProvider, LLMMessage, StreamProgressCallback, ToolHandler } from './types.js';
import { responseToOutput } from './response-converter.js';

/**
 * Configuration for LLMTaskExecutor
 */
export interface LLMTaskExecutorConfig {
  /** The LLM provider to use for task execution */
  provider: LLMProvider;
  /** System prompt providing context for task execution */
  systemPrompt?: string;
  /** Whether to use streaming (invokes onStreamChunk per chunk) */
  streaming?: boolean;
  /** Callback for streaming progress */
  onStreamChunk?: StreamProgressCallback;
  /** Tool handler for function calling */
  toolHandler?: ToolHandler;
  /** Maximum tool call rounds before forcing text response (default: 10) */
  maxToolRounds?: number;
  /** Custom response-to-output converter (overrides SHA-256 default) */
  responseToOutput?: (response: string) => bigint[];
  /** Required capabilities bitmask — canExecute returns false if task doesn't match */
  requiredCapabilities?: bigint;
}

/**
 * TaskExecutor implementation that delegates task execution to an LLM provider.
 *
 * The executor:
 * 1. Decodes the 64-byte task description to UTF-8 (strips null padding)
 * 2. Builds a conversation with optional system prompt + task description
 * 3. Sends to the LLM provider (streaming or non-streaming)
 * 4. Handles tool call loops up to maxToolRounds
 * 5. Converts the final text response to 4 bigints
 */
export class LLMTaskExecutor implements TaskExecutor {
  private readonly provider: LLMProvider;
  private readonly systemPrompt?: string;
  private readonly streaming: boolean;
  private readonly onStreamChunk?: StreamProgressCallback;
  private readonly toolHandler?: ToolHandler;
  private readonly maxToolRounds: number;
  private readonly convertResponse: (response: string) => bigint[];
  private readonly requiredCapabilities?: bigint;

  constructor(config: LLMTaskExecutorConfig) {
    this.provider = config.provider;
    this.systemPrompt = config.systemPrompt;
    this.streaming = config.streaming ?? false;
    this.onStreamChunk = config.onStreamChunk;
    this.toolHandler = config.toolHandler;
    this.maxToolRounds = config.maxToolRounds ?? 10;
    this.convertResponse = config.responseToOutput ?? responseToOutput;
    this.requiredCapabilities = config.requiredCapabilities;
  }

  async execute(task: Task): Promise<bigint[]> {
    const description = decodeDescription(task.description);
    const messages = this.buildMessages(task, description);

    let response;
    if (this.streaming && this.onStreamChunk) {
      response = await this.provider.chatStream(messages, this.onStreamChunk);
    } else {
      response = await this.provider.chat(messages);
    }

    // Handle tool call loop
    let rounds = 0;
    while (response.finishReason === 'tool_calls' && response.toolCalls.length > 0 && this.toolHandler) {
      if (rounds >= this.maxToolRounds) {
        break;
      }
      rounds++;

      // Add assistant message with tool calls
      messages.push({
        role: 'assistant',
        content: response.content,
      });

      // Execute each tool call and add results
      for (const toolCall of response.toolCalls) {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(toolCall.arguments) as Record<string, unknown>;
        } catch {
          args = {};
        }
        const result = await this.toolHandler(toolCall.name, args);
        messages.push({
          role: 'tool',
          content: result,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
        });
      }

      if (this.streaming && this.onStreamChunk) {
        response = await this.provider.chatStream(messages, this.onStreamChunk);
      } else {
        response = await this.provider.chat(messages);
      }
    }

    return this.convertResponse(response.content);
  }

  canExecute(task: Task): boolean {
    if (this.requiredCapabilities === undefined) {
      return true;
    }
    return (task.requiredCapabilities & this.requiredCapabilities) === task.requiredCapabilities;
  }

  private buildMessages(task: Task, description: string): LLMMessage[] {
    const messages: LLMMessage[] = [];

    if (this.systemPrompt) {
      messages.push({ role: 'system', content: this.systemPrompt });
    }

    const taskInfo = [
      `Task ID: ${Buffer.from(task.taskId).toString('hex')}`,
      `Reward: ${task.reward} lamports`,
      `Deadline: ${task.deadline > 0 ? new Date(task.deadline * 1000).toISOString() : 'none'}`,
      `Description: ${description}`,
    ].join('\n');

    messages.push({ role: 'user', content: taskInfo });
    return messages;
  }
}

/**
 * Decode a 64-byte task description to a UTF-8 string.
 * Strips trailing null bytes and trims whitespace.
 */
function decodeDescription(description: Uint8Array): string {
  // Find the first null byte to strip padding
  let end = description.length;
  for (let i = 0; i < description.length; i++) {
    if (description[i] === 0) {
      end = i;
      break;
    }
  }
  return Buffer.from(description.subarray(0, end)).toString('utf-8').trim();
}
