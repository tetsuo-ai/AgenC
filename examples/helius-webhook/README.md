# AgenC Helius Webhook Integration

Real-time monitoring of private task completions via Helius webhooks.

## Network Scope (read this first)

As shipped, this example points mainnet Helius infrastructure at devnet-only
programs: `index.ts` hardcodes the mainnet RPC URL
(`https://mainnet.helius-rpc.com`) and creates a mainnet `enhanced` webhook,
but the three program IDs it monitors are the legacy devnet framework
deployment and do not exist on mainnet. The code runs, but it can never
observe a real AgenC completion until you pick one of these fixes:

- **Watch the live mainnet marketplace:** change `AGENC_PROGRAM_ID` in
  `index.ts` to `HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK`, the
  `agenc-coordination` program behind the marketplace at
  [agenc.ag](https://agenc.ag) (verified build, source in
  [tetsuo-ai/agenc-protocol](https://github.com/tetsuo-ai/agenc-protocol)),
  and drop the devnet-only router/verifier IDs from the webhook's
  `accountAddresses`.
- **Exercise the legacy devnet flow end to end:** keep the program IDs,
  switch the RPC URL to `https://devnet.helius-rpc.com`, and create the
  webhook with `webhookType: 'enhancedDevnet'`.

## Features

- Subscribe to AgenC program events
- Parse task completion transactions
- REST API for task history and stats
- WebSocket log subscription (alternative)
- Ready for Discord/Telegram bot integration

## Setup

```bash
cd examples/helius-webhook
npm install
```

This example requires both environment variables for every command, not just
the server: `index.ts` checks them at startup and exits if either is missing.

- `HELIUS_API_KEY`
- `HELIUS_WEBHOOK_SECRET`

## Usage

### Start Webhook Server

```bash
# Required for all commands
export HELIUS_API_KEY=your-helius-api-key
export HELIUS_WEBHOOK_SECRET=your-shared-webhook-secret

# Start server on port 3000
npm run server
```

### Create Webhook Subscription

```bash
# Register your webhook URL with Helius
npx tsx index.ts create https://your-server.com/webhook
```

### List or Delete Webhooks

```bash
npx tsx index.ts list
npx tsx index.ts delete <webhook-id>
```

### WebSocket Subscription (Alternative)

```bash
# Subscribe to program logs directly
npm run subscribe
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/webhook` | POST | Helius webhook receiver |
| `/health` | GET | Health check |
| `/api/tasks` | GET | List completed tasks |
| `/api/stats` | GET | Task statistics |

## Example Response

```json
{
  "count": 42,
  "tasks": [
    {
      "taskId": 1,
      "worker": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      "proofVerified": true,
      "timestamp": 1705123456,
      "txSignature": "5KtP..."
    }
  ]
}
```

## Monitored Programs

| Program | Address | Network |
|---------|---------|---------|
| AgenC Coordination (legacy framework) | `6UcJzbTEemBz3aY5wK5qKHGMD7bdRsmR4smND29gB2ab` | Devnet only |
| RISC0 Router | `E9ZiqfCdr6gGeB2UhBbkWnFP9vGnRYQwqnDsS1LM3NJZ` | Devnet only |
| RISC0 Verifier | `3ZrAHZKjk24AKgXFekpYeG7v3Rz7NucLXTB3zxGGTjsc` | Devnet only |

`6UcJ...` is the legacy devnet framework program and is not deployed on
mainnet. The live mainnet marketplace program is
`HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK`; see Network Scope above for
how to point this example at it.

Note: private completion verification routes through router/verifier-entry
accounts and the trusted verifier program.

## Integration Examples

### Discord Bot

```typescript
import { Client } from 'discord.js';

function emitTaskCompletion(event: TaskCompletionEvent) {
  const channel = discordClient.channels.cache.get('CHANNEL_ID');
  channel.send(`Task #${event.taskId} completed by ${event.worker.slice(0,8)}...`);
}
```

### Database Storage

```typescript
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function emitTaskCompletion(event: TaskCompletionEvent) {
  await prisma.taskCompletion.create({ data: event });
}
```

## Security

**Server Requirements:**

| Variable | Required | Description |
|----------|----------|-------------|
| `HELIUS_API_KEY` | **Yes**, all commands | Helius API key used for webhook management and RPC access |
| `HELIUS_WEBHOOK_SECRET` | **Yes**, all commands (checked at startup) | Shared secret the webhook receiver verifies deliveries against |
| `NODE_ENV` | Recommended | Set to `production` to enforce stricter webhook URL checks |

Without `HELIUS_WEBHOOK_SECRET`, no command will run, and the webhook server
in particular cannot verify that requests originate from Helius.

### Known gap: `create` never sends the secret to Helius

The `create` command registers the webhook without an `authHeader`, so Helius
has nothing to attach to deliveries and the server's signature check rejects
every real delivery with 401. To close the gap, add one line to the request
body in `createWebhook()` in `index.ts`:

```typescript
body: JSON.stringify({
  webhookURL: webhookUrl,
  transactionTypes: ['ANY'],
  accountAddresses: [ROUTER_PROGRAM_ID, VERIFIER_PROGRAM_ID, AGENC_PROGRAM_ID],
  webhookType: 'enhanced',
  txnStatus: 'success',
  authHeader: process.env.HELIUS_WEBHOOK_SECRET, // add this line
}),
```

Per the current
[Helius create-webhook API reference](https://www.helius.dev/docs/api-reference/webhooks/create-webhook),
`authHeader` is an authorization header value included verbatim in webhook
deliveries for verifying the sender; Helius does not compute a per-payload
HMAC. The shipped server instead expects a hex HMAC of the body in an
`x-helius-signature` header, so after adding `authHeader`, also update
`verifyWebhookSignature()` to timing-safe-compare the header Helius actually
sends against the shared secret.

```bash
# Production deployment
export NODE_ENV=production
export HELIUS_API_KEY=your-helius-api-key
export HELIUS_WEBHOOK_SECRET=your-shared-webhook-secret
npm run server
```

## Helius API Key

Get your API key at: https://dashboard.helius.dev/
