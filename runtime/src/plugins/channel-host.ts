import type {
  ChannelAdapter,
  ChannelAdapterContext,
  ChannelAdapterLogger,
  ChannelInboundAttachment,
  ChannelInboundMessage,
  ChannelAdapterManifest,
} from "@tetsuo-ai/plugin-kit";
import type { ChannelContext, ChannelPlugin } from "../gateway/channel.js";
import type {
  GatewayMessage,
  MessageAttachment,
  OutboundMessage,
} from "../gateway/message.js";
import { GatewayConnectionError } from "../gateway/errors.js";
import { isRecord } from "../utils/type-guards.js";

export interface HostedChannelPluginOptions<
  TConfig extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly manifest: ChannelAdapterManifest;
  readonly adapter: ChannelAdapter<TConfig>;
  readonly config: Readonly<TConfig>;
  readonly moduleSpecifier: string;
}

function isValidScope(value: unknown): value is GatewayMessage["scope"] {
  return value === "dm" || value === "group" || value === "thread";
}

function normalizeInboundAttachment(
  value: unknown,
  channelName: string,
): MessageAttachment {
  if (!isRecord(value)) {
    throw new GatewayConnectionError(
      `Channel plugin "${channelName}" emitted an invalid attachment payload`,
    );
  }
  if (typeof value.type !== "string" || value.type.trim().length === 0) {
    throw new GatewayConnectionError(
      `Channel plugin "${channelName}" emitted attachment.type without a non-empty string`,
    );
  }
  if (typeof value.mime_type !== "string" || value.mime_type.trim().length === 0) {
    throw new GatewayConnectionError(
      `Channel plugin "${channelName}" emitted attachment.mime_type without a non-empty string`,
    );
  }

  return {
    type: value.type,
    url: typeof value.url === "string" ? value.url : undefined,
    data: value.data instanceof Uint8Array ? value.data : undefined,
    mimeType: value.mime_type,
    filename: typeof value.filename === "string" ? value.filename : undefined,
    sizeBytes:
      typeof value.size_bytes === "number" ? value.size_bytes : undefined,
    durationSeconds:
      typeof value.duration_seconds === "number"
        ? value.duration_seconds
        : undefined,
  };
}

function normalizeInboundMessage(
  channelName: string,
  value: ChannelInboundMessage,
): GatewayMessage {
  if (typeof value.id !== "string" || value.id.trim().length === 0) {
    throw new GatewayConnectionError(
      `Channel plugin "${channelName}" emitted message.id without a non-empty string`,
    );
  }
  if (
    typeof value.sender_id !== "string" ||
    value.sender_id.trim().length === 0
  ) {
    throw new GatewayConnectionError(
      `Channel plugin "${channelName}" emitted sender_id without a non-empty string`,
    );
  }
  if (
    typeof value.sender_name !== "string" ||
    value.sender_name.trim().length === 0
  ) {
    throw new GatewayConnectionError(
      `Channel plugin "${channelName}" emitted sender_name without a non-empty string`,
    );
  }
  if (
    typeof value.session_id !== "string" ||
    value.session_id.trim().length === 0
  ) {
    throw new GatewayConnectionError(
      `Channel plugin "${channelName}" emitted session_id without a non-empty string`,
    );
  }
  if (typeof value.content !== "string") {
    throw new GatewayConnectionError(
      `Channel plugin "${channelName}" emitted content that is not a string`,
    );
  }
  if (!isValidScope(value.scope)) {
    throw new GatewayConnectionError(
      `Channel plugin "${channelName}" emitted unsupported scope "${String(value.scope)}"`,
    );
  }
  if (
    value.timestamp !== undefined &&
    (!Number.isFinite(value.timestamp) || value.timestamp < 0)
  ) {
    throw new GatewayConnectionError(
      `Channel plugin "${channelName}" emitted timestamp that is not a non-negative finite number`,
    );
  }

  return {
    id: value.id,
    channel: channelName,
    senderId: value.sender_id,
    senderName: value.sender_name,
    identityId:
      typeof value.identity_id === "string" ? value.identity_id : undefined,
    sessionId: value.session_id,
    content: value.content,
    scope: value.scope,
    timestamp: value.timestamp ?? Date.now(),
    metadata: isRecord(value.metadata) ? value.metadata : undefined,
    attachments: Array.isArray(value.attachments)
      ? value.attachments.map((attachment) =>
          normalizeInboundAttachment(attachment, channelName),
        )
      : undefined,
  };
}

function toOutboundAttachment(
  attachment: MessageAttachment,
): ChannelInboundAttachment {
  return {
    type: attachment.type,
    url: attachment.url,
    data: attachment.data,
    mime_type: attachment.mimeType,
    filename: attachment.filename,
    size_bytes: attachment.sizeBytes,
    duration_seconds: attachment.durationSeconds,
  };
}

function createAdapterLogger(
  baseLogger: ChannelContext["logger"],
  manifest: ChannelAdapterManifest,
): ChannelAdapterLogger {
  const prefix = `[channel-plugin:${manifest.plugin_id}]`;
  return {
    debug: (...args) => baseLogger.debug?.(prefix, ...args),
    info: (...args) => baseLogger.info?.(prefix, ...args),
    warn: (...args) => baseLogger.warn?.(prefix, ...args),
    error: (...args) => baseLogger.error?.(prefix, ...args),
  };
}

export class HostedChannelPlugin<
  TConfig extends Record<string, unknown> = Record<string, unknown>,
> implements ChannelPlugin {
  readonly name: string;
  readonly manifest: ChannelAdapterManifest;
  readonly moduleSpecifier: string;

  private readonly adapter: ChannelAdapter<TConfig>;
  private readonly config: Readonly<TConfig>;

  constructor(options: HostedChannelPluginOptions<TConfig>) {
    this.name = options.manifest.channel_name;
    this.manifest = options.manifest;
    this.moduleSpecifier = options.moduleSpecifier;
    this.adapter = options.adapter;
    this.config = options.config;
  }

  async initialize(context: ChannelContext): Promise<void> {
    const adapterContext: ChannelAdapterContext<TConfig> = {
      logger: createAdapterLogger(context.logger, this.manifest),
      config: this.config,
      on_message: async (message) => {
        await context.onMessage(normalizeInboundMessage(this.name, message));
      },
    };
    await this.adapter.initialize(adapterContext);
  }

  async start(): Promise<void> {
    await this.adapter.start();
  }

  async stop(): Promise<void> {
    await this.adapter.stop();
  }

  async send(message: OutboundMessage): Promise<void> {
    await this.adapter.send({
      session_id: message.sessionId,
      content: message.content,
      attachments: message.attachments?.map(toOutboundAttachment),
      is_partial: message.isPartial,
      tts: message.tts,
    });
  }

  isHealthy(): boolean {
    return this.adapter.isHealthy();
  }
}
