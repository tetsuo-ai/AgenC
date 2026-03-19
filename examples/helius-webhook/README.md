# AgenC Helius Webhook Integration

Real-time monitoring of private task completions via Helius webhooks.

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

This example requires:

- `HELIUS_API_KEY` for all commands
- `HELIUS_WEBHOOK_SECRET` when running the webhook server

## Usage

### Start Webhook Server

```bash
# Required for all Helius API calls
export HELIUS_API_KEY=your-helius-api-key

# Required by the webhook receiver for signature verification
export HELIUS_WEBHOOK_SECRET=your-webhook-secret-from-helius

# Start server on port 3000
npm run server
```

### Create Webhook Subscription

```bash
# Register your webhook URL with Helius
npx tsx index.ts create https://your-server.com/webhook
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

| Program | Address |
|---------|---------|
| AgenC Coordination | `5j9ZbT3mnPX5QjWVMrDaWFuaGf8ddji6LW1HVJw6kUE7` |

Note: private completion verification now routes through router/verifier-entry accounts and the trusted verifier program.

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

function emitTaskCompletion(event: TaskCompletionEvent) {
  await prisma.taskCompletion.create({ data: event });
}
```

## Security

**Server Requirements:**

| Variable | Required | Description |
|----------|----------|-------------|
| `HELIUS_API_KEY` | **Yes** | Helius API key used for webhook management and RPC access |
| `HELIUS_WEBHOOK_SECRET` | **Yes** for `npm run server` | Webhook signature verification secret from Helius dashboard |
| `NODE_ENV` | Recommended | Set to `production` to enforce stricter webhook URL checks |

Without `HELIUS_WEBHOOK_SECRET`, the webhook server will not start because it
cannot verify that requests originate from Helius.

```bash
# Production deployment
export NODE_ENV=production
export HELIUS_API_KEY=your-helius-api-key
export HELIUS_WEBHOOK_SECRET=your-webhook-secret-from-helius
npm run server
```

## Helius API Key

Get your API key at: https://dev.helius.xyz/
