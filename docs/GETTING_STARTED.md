# Getting Started With AgenC

This is the quickest way to understand what to install and how to use the
public AgenC surface.

## First Decide What You Need

| If you want to... | Install / run this | Canonical home |
| --- | --- | --- |
| Try AgenC locally in a few minutes | `npm install --no-fund` then `npm run example:simple-usage` | This repo |
| Add AgenC task/proof flows to your app | `npm install @tetsuo-ai/sdk` | `agenc-sdk` |
| Consume the public protocol / IDL / artifacts | `npm install @tetsuo-ai/protocol` | `agenc-protocol` |
| Build a plugin or hosted adapter | `npm install @tetsuo-ai/plugin-kit` | `agenc-plugin-kit` |
| Clone the public AgenC repos side by side | `./scripts/bootstrap-agenc-repos.sh --root /path/to/agenc` | This repo |
| Use the full operator/runtime product | Request private access to `agenc-core` | `agenc-core` |

## Fastest Way To Try AgenC

Clone this repo, install the public example workspace, and run one example from
the root:

```bash
git clone https://github.com/tetsuo-ai/AgenC.git
cd AgenC
npm install --no-fund
npm run example:simple-usage
```

Other root-level example commands:

```bash
npm run example:tetsuo-integration
npm run example:risc0-proof-demo
npm run example:helius-webhook:server
npm run example:helius-webhook:subscribe
```

The Helius commands require `HELIUS_API_KEY`. The server command also requires
`HELIUS_WEBHOOK_SECRET`.

For the Helius example, create a webhook subscription with:

```bash
npm run create --workspace agenc-helius-webhook -- https://your-server.com/webhook
```

## Install AgenC In An App

If you are integrating AgenC into an app or service, the public SDK is usually
the right starting point:

```bash
npm install @tetsuo-ai/sdk
```

Then use the SDK README for the current API and the curated starter example:

- Repo: `https://github.com/tetsuo-ai/agenc-sdk`
- Local pointer: [SDK.md](./SDK.md)

## Consume Protocol Artifacts

If you need the public protocol contract, install the protocol package:

```bash
npm install @tetsuo-ai/protocol
```

Use this when you need:

- committed IDL artifacts
- generated protocol types
- the public trust surface without the private runtime

Canonical repo:

- `https://github.com/tetsuo-ai/agenc-protocol`

## Build A Plugin Or Adapter

If you are extending AgenC through the public plugin ABI, install the plugin
kit:

```bash
npm install @tetsuo-ai/plugin-kit
```

Use this when you need:

- manifest validation helpers
- channel adapter contract types
- certification / compatibility helpers

Canonical repo:

- `https://github.com/tetsuo-ai/agenc-plugin-kit`

## Clone The Full Public Repo Set

If you want the umbrella repo plus the other public repos side by side:

```bash
./scripts/bootstrap-agenc-repos.sh --root /path/to/agenc
```

That creates or updates:

```text
/path/to/agenc/
  AgenC/
  agenc-sdk/
  agenc-protocol/
  agenc-plugin-kit/
```

If you also have private access:

```bash
./scripts/bootstrap-agenc-repos.sh --root /path/to/agenc --private
```

## What This Repo Does Not Contain

The full AgenC operator product is not public in this repo. That includes:

- the runtime
- daemon and TUI-adjacent operator workflow
- web and desktop product surfaces
- internal tooling and private proving infrastructure

Those live in `agenc-core` and `agenc-prover`, which are private.

## Next Reading

- [README.md](../README.md)
- [examples/README.md](../examples/README.md)
- [REPOSITORY_TOPOLOGY.md](./REPOSITORY_TOPOLOGY.md)
- [VERSION_DOCS_MAP.md](./VERSION_DOCS_MAP.md)
