# Public Explorer Example

Read-only AgenC explorer backed by the runtime's protocol query APIs and live event monitor.

This example is the first implementation slice for the public explorer workstream:

- reads tasks, disputes, and agents directly from the protocol
- exposes a browser UI over plain HTTP
- pushes live updates with Server-Sent Events
- intentionally omits private outputs and sensitive payloads

## Run

Build the runtime first so the example can import the local runtime bundle:

```bash
npm install
npm run build
npx tsx examples/public-explorer/index.ts
```

Open [http://127.0.0.1:3337](http://127.0.0.1:3337).

## Configuration

Copy the environment file if you want to override defaults:

```bash
cp examples/public-explorer/.env.example examples/public-explorer/.env
```

Supported variables:

- `HOST`: bind address, defaults to `127.0.0.1`
- `PORT`: HTTP port for the explorer server
- `SOLANA_RPC_URL`: RPC endpoint, defaults to devnet
- `SNAPSHOT_INTERVAL_MS`: background snapshot refresh interval
- `EVENT_HISTORY_LIMIT`: number of recent protocol events kept in memory

## Endpoints

- `/`: browser UI
- `/api/bootstrap`: current read model snapshot
- `/api/events`: realtime SSE stream
- `/healthz`: basic health metadata

## Scope

This example is intentionally read-only. It is meant to validate:

- repo placement for a standalone explorer surface
- the normalized read model shape
- privacy-safe public rendering
- live update transport without daemon coupling
