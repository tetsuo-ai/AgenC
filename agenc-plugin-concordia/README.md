# @tetsuo-ai/plugin-concordia

A channel-adapter plugin for the AgenC runtime that bridges [Google DeepMind's Concordia](https://github.com/google-deepmind/concordia) generative agent simulation engine to AgenC agents. Concordia characters become AgenC agents with persistent memory, identity, and knowledge graphs; the simulation talks to them over a local HTTP bridge.

## Status

- Local workspace package, version 0.1.0, tracked in this umbrella repo.
- Not published to npm: the registry lookup for `@tetsuo-ai/plugin-concordia` returns Not Found (checked 2026-07-10).
- `package.json` declares `"license": "UNLICENSED"`; the source is visible here but carries no open-source license grant.

## How it works

The plugin implements the `@tetsuo-ai/plugin-kit` channel-adapter contract (plugin id `ai.tetsuo.channel.concordia`, channel name `concordia`). The AgenC daemon loads it as a channel plugin:

1. On launch, the plugin spawns a Concordia simulation runner: `python3 -m concordia_bridge.cli run-json` (Python side tracked in [`../concordia_bridge/`](../concordia_bridge/)).
2. Concordia's Python `ProxyEntity` POSTs `/act` to the plugin's bridge HTTP server.
3. The adapter wraps the request as a `ChannelInboundMessage` and hands it to the daemon, which runs the standard ChatExecutor pipeline: system prompt, identity, memory retrieval, LLM, tools.
4. The daemon calls `adapter.send()` with the agent's response, which resolves the pending `/act` request back to Python.

Bridge endpoints (plain `node:http`, no external runtime dependencies): `/act`, `/observe`, `/setup`, `/event`, `/launch`, `/generate-agents`, `/checkpoint`, `/resume`, `/reset`, `/simulations`, `/simulation/status`, `/health`, `/metrics`, `/compatibility`, `/migration/status`.

## Entry points

- [`src/index.ts`](src/index.ts): the plugin-kit contract surface (`manifest`, `validateConfig`, `createChannelAdapter`) plus re-exported helpers for memory wiring, checkpoint manifests, memory namespaces, migration compatibility, and benchmark alignment.
- [`src/adapter.ts`](src/adapter.ts): `ConcordiaChannelAdapter`, the main adapter implementation.
- [`src/bridge-http.ts`](src/bridge-http.ts): the HTTP bridge server and route handlers.
- [`src/simulation-registry.ts`](src/simulation-registry.ts) and [`src/simulation-runner.ts`](src/simulation-runner.ts): concurrent simulation lifecycle, port reservation, and the spawned Python runner process.
- [`src/memory-wiring.ts`](src/memory-wiring.ts): persistent agent memory (identity setup, observation ingestion, social events, graph context, shared memory, procedures).
- [`src/types.ts`](src/types.ts): all request/response and config types, including `ConcordiaChannelConfig`.

## Configuration

Every `ConcordiaChannelConfig` field is optional, and `validateConfig` accepts an empty config. Notable fields: `bridge_port` and `event_port`, `world_id`, `workspace_id`, `python_command` (defaults to `python3`), concurrency and retention limits such as `max_concurrent_simulations` and `replay_buffer_limit`, and timeout budgets such as `act_timeout_ms`, `runner_startup_timeout_ms`, and `proxy_action_timeout_seconds`. See `src/types.ts` for the full list.

## Build and test

Script results in this checkout, verified 2026-07-10:

```bash
npm test          # vitest: 199 tests in 15 files, all passing
npm run typecheck # currently fails (see below)
npm run build     # tsup esm + dts: currently fails at the dts step (see below)
```

The package depends on `@tetsuo-ai/plugin-kit` through `file:../agenc-plugin-kit`. That sibling's current `src/index.ts` is an empty export (its channel-adapter host types were removed from source), so `typecheck` and `build` fail with TS2305 missing-member errors on `ChannelAdapter`, `ChannelAdapterManifest`, `ChannelConfigValidationResult`, and `ChannelAdapterLogger`. The test suite still passes because every plugin-kit import in this package is type-only and is erased at runtime. The published `@tetsuo-ai/plugin-kit` 0.2.0 on npm still ships the full channel-adapter type declarations, and this plugin's source typechecks cleanly against them, so building `dist/` again means either restoring those exports in the sibling checkout or pointing the dependency at the registry package.
