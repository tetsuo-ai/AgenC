/**
 * Signal channel plugin — bridges Signal Messenger to the Gateway.
 *
 * Spawns signal-cli in JSON-RPC mode as a child process. No npm dependency
 * required — uses node:child_process and node:fs/promises directly.
 *
 * Inbound messages are read from stdout as newline-delimited JSON. Outbound
 * messages are sent via JSON-RPC `send` method on stdin.
 *
 * @module
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { BaseChannelPlugin } from '../../gateway/channel.js';
import type { OutboundMessage } from '../../gateway/message.js';
import { createGatewayMessage } from '../../gateway/message.js';
import { GatewayConnectionError } from '../../gateway/errors.js';
import type { SignalChannelConfig } from './types.js';

// ============================================================================
// Constants
// ============================================================================

const SESSION_PREFIX = 'signal';
const SIGTERM_TIMEOUT_MS = 5000;

// ============================================================================
// JSON-RPC types
// ============================================================================

interface JsonRpcMessage {
  jsonrpc?: string;
  method?: string;
  params?: {
    envelope?: SignalEnvelope;
  };
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface SignalEnvelope {
  source?: string;
  sourceName?: string;
  dataMessage?: {
    message?: string;
    timestamp?: number;
    groupInfo?: { groupId?: string };
    attachments?: SignalAttachment[];
  };
}

interface SignalAttachment {
  contentType?: string;
  filename?: string;
  size?: number;
}

// ============================================================================
// SignalChannel Plugin
// ============================================================================

export class SignalChannel extends BaseChannelPlugin {
  readonly name = SESSION_PREFIX;

  private process: ChildProcess | null = null;
  private healthy = false;
  private readonly config: SignalChannelConfig;
  private rpcId = 0;
  private lineBuffer = '';

  constructor(config: SignalChannelConfig) {
    super();
    this.config = config;
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  async start(): Promise<void> {
    const bin = this.config.signalCliBin ?? 'signal-cli';

    // Validate binary exists
    try {
      await access(bin, constants.X_OK);
    } catch {
      throw new GatewayConnectionError(
        `signal-cli binary not found or not executable: ${bin}`,
      );
    }

    const args = [
      '-a', this.config.phoneNumber,
      'jsonRpc',
    ];

    if (this.config.trustMode) {
      args.unshift('--trust-new-identities', this.config.trustMode);
    }

    const child = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process = child;

    child.stdout!.on('data', (chunk: Buffer) => {
      this.handleStdoutData(chunk);
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      this.context.logger.warn(`signal-cli stderr: ${chunk.toString().trim()}`);
    });

    child.on('error', (err: Error) => {
      this.healthy = false;
      this.context.logger.error(`signal-cli process error: ${err.message}`);
    });

    child.on('exit', (code, signal) => {
      this.healthy = false;
      this.context.logger.error(
        `signal-cli process exited (code=${code}, signal=${signal})`,
      );
    });

    this.healthy = true;
    this.context.logger.info(`Signal channel started with signal-cli for ${this.config.phoneNumber}`);
  }

  async stop(): Promise<void> {
    if (this.process) {
      await this.gracefulShutdown();
      this.process = null;
    }
    this.healthy = false;
    this.lineBuffer = '';
  }

  override isHealthy(): boolean {
    return this.healthy;
  }

  // --------------------------------------------------------------------------
  // Outbound
  // --------------------------------------------------------------------------

  async send(message: OutboundMessage): Promise<void> {
    if (!this.process || !this.process.stdin?.writable) {
      this.context.logger.warn('Cannot send message: signal-cli process is not running');
      return;
    }

    const phone = this.extractPhone(message.sessionId);
    if (!phone) {
      this.context.logger.warn(`Cannot resolve phone for session: ${message.sessionId}`);
      return;
    }

    const rpcMessage: JsonRpcMessage = {
      jsonrpc: '2.0',
      method: 'send',
      params: {
        envelope: {
          source: phone,
          dataMessage: { message: message.content },
        },
      } as any,
      id: ++this.rpcId,
    };

    // signal-cli JSON-RPC expects specific params format
    const sendPayload = {
      jsonrpc: '2.0',
      method: 'send',
      id: rpcMessage.id,
      params: {
        recipient: [phone],
        message: message.content,
      },
    };

    try {
      this.process.stdin!.write(JSON.stringify(sendPayload) + '\n');
    } catch (err) {
      this.context.logger.error(`Failed to send message to ${message.sessionId}: ${errorMessage(err)}`);
    }
  }

  // --------------------------------------------------------------------------
  // Stdout processing
  // --------------------------------------------------------------------------

  private handleStdoutData(chunk: Buffer): void {
    this.lineBuffer += chunk.toString();
    const lines = this.lineBuffer.split('\n');

    // Keep the last incomplete line in the buffer
    this.lineBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const parsed = JSON.parse(trimmed) as JsonRpcMessage;
        this.handleJsonRpcMessage(parsed).catch((err) => {
          this.context.logger.error(`Error handling Signal message: ${errorMessage(err)}`);
        });
      } catch {
        this.context.logger.debug(`Non-JSON line from signal-cli: ${trimmed.slice(0, 100)}`);
      }
    }
  }

  private async handleJsonRpcMessage(msg: JsonRpcMessage): Promise<void> {
    // Only handle incoming message notifications
    if (msg.method !== 'receive' || !msg.params?.envelope) return;

    const envelope = msg.params.envelope;
    if (!envelope.source) return;
    if (!envelope.dataMessage?.message) return;

    const phone = envelope.source;

    if (this.config.allowedNumbers && this.config.allowedNumbers.length > 0) {
      if (!this.config.allowedNumbers.includes(phone)) return;
    }

    const sessionId = `${SESSION_PREFIX}:${phone}`;
    const isGroup = !!envelope.dataMessage.groupInfo?.groupId;

    const gateway = createGatewayMessage({
      channel: this.name,
      senderId: phone,
      senderName: envelope.sourceName ?? phone,
      sessionId,
      content: envelope.dataMessage.message,
      metadata: {
        phone,
        timestamp: envelope.dataMessage.timestamp,
        groupId: envelope.dataMessage.groupInfo?.groupId,
      },
      scope: isGroup ? 'group' : 'dm',
    });

    await this.context.onMessage(gateway);
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private extractPhone(sessionId: string): string | null {
    // Session ID format: signal:<phoneNumber>
    const parts = sessionId.split(':');
    if (parts.length < 2 || parts[0] !== SESSION_PREFIX) return null;
    return parts.slice(1).join(':');
  }

  private async gracefulShutdown(): Promise<void> {
    const child = this.process;
    if (!child) return;

    return new Promise<void>((resolve) => {
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          child.kill('SIGKILL');
          resolve();
        }
      }, SIGTERM_TIMEOUT_MS);

      child.once('exit', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve();
        }
      });

      child.kill('SIGTERM');
    });
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Extract a safe error message string. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
