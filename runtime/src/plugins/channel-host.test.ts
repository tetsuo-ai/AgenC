import { describe, expect, it, vi } from "vitest";
import type {
  ChannelAdapter,
  ChannelAdapterContext,
  ChannelAdapterManifest,
  ChannelOutboundMessage,
} from "@tetsuo-ai/plugin-kit";
import { HostedChannelPlugin } from "./channel-host.js";
import { silentLogger } from "../utils/logger.js";

const manifest: ChannelAdapterManifest = {
  schema_version: 1,
  plugin_id: "fixtures/channel-host",
  channel_name: "fixture-slack",
  plugin_type: "channel_adapter",
  version: "0.0.0",
  display_name: "Fixture Slack Channel",
  plugin_api_version: "1.0.0",
  host_api_version: "1.0.0",
};

class FixtureAdapter implements ChannelAdapter<Record<string, unknown>> {
  readonly name = "fixture-slack";
  context: ChannelAdapterContext<Record<string, unknown>> | null = null;
  readonly sent: ChannelOutboundMessage[] = [];

  async initialize(
    context: ChannelAdapterContext<Record<string, unknown>>,
  ): Promise<void> {
    this.context = context;
  }

  async start(): Promise<void> {
    return;
  }

  async stop(): Promise<void> {
    return;
  }

  async send(message: ChannelOutboundMessage): Promise<void> {
    this.sent.push(message);
  }

  isHealthy(): boolean {
    return this.context !== null;
  }
}

describe("HostedChannelPlugin", () => {
  it("normalizes inbound and outbound message payloads", async () => {
    const adapter = new FixtureAdapter();
    const host = new HostedChannelPlugin({
      manifest,
      adapter,
      config: { token: "abc" },
      moduleSpecifier: "@tetsuo-ai/plugin-kit-channel-fixture/slack",
    });
    const onMessage = vi.fn();

    await host.initialize({
      logger: silentLogger,
      config: {},
      onMessage,
    });

    await adapter.context!.on_message({
      id: "msg-1",
      channel: "spoofed",
      sender_id: "user-1",
      sender_name: "Fixture User",
      session_id: "fixture:1",
      content: "hello",
      scope: "dm",
      timestamp: 1234,
      metadata: { source: "fixture" },
      attachments: [
        {
          type: "file",
          mime_type: "text/plain",
          filename: "hello.txt",
        },
      ],
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0]?.[0]).toMatchObject({
      id: "msg-1",
      channel: "fixture-slack",
      senderId: "user-1",
      senderName: "Fixture User",
      sessionId: "fixture:1",
      content: "hello",
      scope: "dm",
      timestamp: 1234,
      metadata: { source: "fixture" },
      attachments: [
        {
          type: "file",
          mimeType: "text/plain",
          filename: "hello.txt",
        },
      ],
    });

    await host.send({
      sessionId: "fixture:1",
      content: "reply",
      isPartial: true,
      tts: true,
      attachments: [
        {
          type: "file",
          mimeType: "text/plain",
          filename: "reply.txt",
        },
      ],
    });

    expect(adapter.sent).toEqual([
      {
        session_id: "fixture:1",
        content: "reply",
        is_partial: true,
        tts: true,
        attachments: [
          {
            type: "file",
            mime_type: "text/plain",
            filename: "reply.txt",
            url: undefined,
            data: undefined,
            size_bytes: undefined,
            duration_seconds: undefined,
          },
        ],
      },
    ]);
  });

  it("rejects invalid inbound payloads from adapters", async () => {
    const adapter = new FixtureAdapter();
    const host = new HostedChannelPlugin({
      manifest,
      adapter,
      config: {},
      moduleSpecifier: "@tetsuo-ai/plugin-kit-channel-fixture/slack",
    });

    await host.initialize({
      logger: silentLogger,
      config: {},
      onMessage: vi.fn(),
    });

    await expect(
      adapter.context!.on_message({
        id: "",
        channel: "fixture-slack",
        sender_id: "user-1",
        sender_name: "Fixture User",
        session_id: "fixture:1",
        content: "hello",
        scope: "dm",
      }),
    ).rejects.toThrow(
      'Channel plugin "fixture-slack" emitted message.id without a non-empty string',
    );
  });
});
