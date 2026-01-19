# AgenC Helius Webhook Integration

Real-time monitoring of private task completions via Helius webhooks.

## Features

- Subscribe to Sunspot verifier events
- Parse task completion transactions
- REST API for task history and stats
- WebSocket log subscription (alternative)
- Ready for Discord/Telegram bot integration

## Setup

```bash
cd examples/helius-webhook
npm install
```

## Usage

### Start Webhook Server

```bash
# Set your Helius API key (or use default)
export HELIUS_API_KEY=9b627fa6-114a-4a92-843e-3ad38c64565a

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
| Sunspot Verifier | `8fHUGmjNzSh76r78v1rPt7BhWmAu2gXrvW9A2XXonwQQ` |
| AgenC Coordination | `EopUaCV2svxj9j4hd7KjbrWfdjkspmm2BCBe7jGpKzKZ` |

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

**Production Requirements:**

| Variable | Required | Description |
|----------|----------|-------------|
| `HELIUS_WEBHOOK_SECRET` | **Yes** | Webhook signature verification secret from Helius dashboard |
| `NODE_ENV` | Recommended | Set to `production` to enforce security checks |

Without `HELIUS_WEBHOOK_SECRET`, the webhook endpoint cannot verify that requests originate from Helius. The server will reject all webhooks in production mode if this is not set.

```bash
# Production deployment
export NODE_ENV=production
export HELIUS_WEBHOOK_SECRET=your-webhook-secret-from-helius
npm run server
```

## Helius API Key

Get your API key at: https://dev.helius.xyz/
