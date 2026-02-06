# Writing Framework Adapters for AgenC

AgenC adapters wrap the coordination and privacy layer so developers using other agent frameworks can add private Solana coordination without rewriting their agent logic.

## What an Adapter Does

An adapter translates between AgenC's coordination API and a framework's tool/action system:

```
Framework Agent  -->  Adapter  -->  @agenc/sdk  -->  Solana
(LangChain, etc.)   (your code)   (coordination)  (on-chain)
```

The adapter does NOT wrap DeFi operations or general Solana tools. It wraps coordination: creating tasks, claiming tasks, generating ZK proofs, and verifying completion.

## Adapter Structure

```
adapters/your-framework/
  package.json
  src/
    index.ts        # Main export: toolkit class + conversion helpers
  tsconfig.json
```

### package.json Template

```json
{
  "name": "@agenc/adapter-your-framework",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "dependencies": {
    "@agenc/sdk": "file:../../sdk"
  },
  "peerDependencies": {
    "your-framework": ">=X.0.0",
    "@solana/web3.js": ">=1.90.0"
  }
}
```

`@agenc/sdk` is a direct dependency. The framework itself is a peer dependency to avoid version conflicts with the user's installation.

## Implementation Pattern

Every adapter exposes two things:

1. A **toolkit class** that takes AgenC config and returns tool definitions in the framework's native format
2. A **conversion helper** for users who need to customize the tool wrapping

### Step 1: Define Your Toolkit

```typescript
import { Keypair } from '@solana/web3.js';
import {
  createCoordinator,
  createAgent,
  type CoordinatorConfig,
  type Coordinator,
  type Agent,
} from '@agenc/sdk';

export interface AgenCToolkitConfig {
  coordinator: CoordinatorConfig;
  agentWallet: Keypair;
}

export class AgenCToolkit {
  private coordinator: Coordinator;
  private agent: Agent;

  constructor(config: AgenCToolkitConfig) {
    this.coordinator = createCoordinator(config.coordinator);
    this.agent = createAgent({ wallet: config.agentWallet });
  }

  getTools(): YourFrameworkTool[] {
    return [
      this.buildPrivateCoordinationTool(),
      this.buildTaskStatusTool(),
    ];
  }

  // ...
}
```

### Step 2: Build the Core Tools

Every adapter should expose at least these two tools:

**privateCoordinate** - Creates a task, claims it, generates ZK proof, verifies on-chain:

```typescript
private buildPrivateCoordinationTool(): YourFrameworkTool {
  const coordinator = this.coordinator;
  const fromAgent = this.agent;

  return {
    name: 'agenc_private_coordinate',
    description:
      'Send a private coordination task to another agent on Solana, ' +
      'verified via zero-knowledge proof.',
    parameters: {
      instruction: { type: 'string', required: true },
      targetAgentPublicKey: { type: 'string', required: true },
      proof: { type: 'string', enum: ['zk', 'none'], default: 'zk' },
      escrowLamports: { type: 'number' },
    },
    async execute(input) {
      const toAgent = createAgent({ wallet: Keypair.generate() });
      const task = coordinator.createPrivateTask({
        from: fromAgent,
        to: toAgent,
        instruction: input.instruction,
        proof: input.proof ?? 'zk',
        escrowLamports: input.escrowLamports,
      });
      return task.execute();
    },
  };
}
```

**getTaskStatus** - Checks current state of a coordination task:

```typescript
private buildTaskStatusTool(): YourFrameworkTool {
  const coordinator = this.coordinator;

  return {
    name: 'agenc_get_task_status',
    description: 'Check the status of an AgenC coordination task.',
    parameters: {
      taskId: { type: 'number', required: true },
    },
    async execute(input) {
      return coordinator.getTaskStatus(input.taskId);
    },
  };
}
```

### Step 3: Write a Conversion Helper

Frameworks have different tool formats. Write a helper that converts your generic definitions to the framework's native format:

```typescript
export function toFrameworkTools(tools: YourFrameworkTool[]): NativeTool[] {
  return tools.map((tool) => new NativeTool({
    name: tool.name,
    description: tool.description,
    schema: tool.parameters,
    func: tool.execute,
  }));
}
```

## Existing Adapters as Reference

### LangChain (`adapters/langchain/`)

Tools follow the `DynamicStructuredTool` pattern with JSON Schema parameter definitions and string return values.

### Vercel AI SDK (`adapters/vercel-ai/`)

Tools follow the `tool()` pattern with Zod-compatible parameter schemas and structured return values.

## Testing Your Adapter

Write at least these tests:

1. **Toolkit creation** - Does the constructor accept valid config without throwing?
2. **Tool list** - Does `getTools()` return the expected tool names and descriptions?
3. **Parameter validation** - Do tools reject missing required parameters?
4. **Conversion** - Does the conversion helper produce the correct framework-native format?

Integration tests against devnet are optional but recommended for verifying the full flow.

## Adding a New Adapter

1. Create `adapters/your-framework/` with the structure above
2. Implement the toolkit class and conversion helper
3. Add a usage example in the adapter's README or in `docs/quickstart.md`
4. Submit a PR following the [contributing guide](../CONTRIBUTING.md)

### Frameworks Worth Adding

- CrewAI (`@agenc/adapter-crewai`)
- Eliza (`@agenc/adapter-eliza`)
- AutoGen (`@agenc/adapter-autogen`)
- Semantic Kernel (`@agenc/adapter-semantic-kernel`)
