export interface ChannelAdapterLogger {
  debug?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

export interface ChannelInboundAttachment {
  readonly type: string;
  readonly url?: string;
  readonly data?: Uint8Array;
  readonly mime_type: string;
  readonly filename?: string;
  readonly size_bytes?: number;
  readonly duration_seconds?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ChannelInboundMessage {
  readonly id: string;
  readonly channel: string;
  readonly sender_id: string;
  readonly sender_name: string;
  readonly identity_id?: string;
  readonly content: string;
  readonly session_id: string;
  readonly scope: "dm" | "group" | "thread";
  readonly timestamp?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly attachments?: readonly ChannelInboundAttachment[];
}

export interface ChannelOutboundMessage {
  readonly session_id: string;
  readonly content: string;
  readonly attachments?: readonly ChannelInboundAttachment[];
  readonly is_partial?: boolean;
  readonly tts?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ChannelAdapterContext<
  TConfig extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly logger: ChannelAdapterLogger;
  readonly config: Readonly<TConfig>;
  readonly on_message: (message: ChannelInboundMessage) => Promise<void>;
}

export interface ChannelAdapter<
  TConfig extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly name: string;
  initialize(context: ChannelAdapterContext<TConfig>): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(message: ChannelOutboundMessage): Promise<void>;
  isHealthy(): boolean;
}

export interface ChannelConfigValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export interface ChannelAdapterModuleExports<
  TConfig extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly manifest: import("./channel-manifest.js").ChannelAdapterManifest;
  readonly validateConfig: (config: unknown) => ChannelConfigValidationResult;
  readonly createChannelAdapter: () => ChannelAdapter<TConfig>;
}
