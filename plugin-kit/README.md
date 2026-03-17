# @tetsuo-ai/plugin-kit

Public plugin authoring contract for AgenC hosted extensions.

Phase 2 exposes exactly one hosted extension class: `channel_adapter`.

## Public Contract

This package intentionally exposes only the public authoring boundary. It does
not re-export runtime-private gateway, policy, orchestration, or provider
internals.

Primary exports:

- manifest constants and validation helpers
- channel runtime contract types
- published compatibility matrix helpers
- certification / conformance harness
- structured error classes

## Compatibility Matrix

The canonical compatibility tuple is published in two stable forms:

- JS wrapper: `@tetsuo-ai/plugin-kit/channel-host-matrix`
- raw JSON artifact: `@tetsuo-ai/plugin-kit/channel-host-matrix.json`

Phase 2 ships one supported tuple:

- `plugin_type: "channel_adapter"`
- `plugin_api_version: "1.0.0"`
- `host_api_version: "1.0.0"`

## Module Exports

Plugin modules must expose named exports:

- `manifest`
- `validateConfig`
- `createChannelAdapter`

ESM named exports are the primary contract. CommonJS default-object interop is
supported when the default export contains the same properties.

## Serialized ABI

The public serialized ABI is snake_case in Phase 2. That applies to manifest
fields and public message/config payload fields owned by this package.
