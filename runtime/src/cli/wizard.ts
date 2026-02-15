/**
 * Gateway setup wizard, config generation, and workspace scaffolding.
 *
 * @module
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import type { GatewayConfig } from '../gateway/types.js';
import {
  getDefaultConfigPath,
  validateGatewayConfig,
} from '../gateway/config-watcher.js';
import { scaffoldWorkspace as scaffoldWorkspaceFiles } from '../gateway/workspace-files.js';

// ============================================================================
// Types
// ============================================================================

export interface WizardStep {
  readonly name: string;
  readonly prompt: string;
  readonly type: 'select' | 'input' | 'confirm' | 'password';
  readonly options?: readonly string[];
  readonly default?: string;
  readonly validate?: (value: string) => string | true;
}

export interface WizardResult {
  readonly config: GatewayConfig;
  readonly configPath: string;
  readonly workspacePath: string;
  readonly diagnosticsPassed: boolean;
}

// Workspace scaffolding is delegated to gateway/workspace-files.ts
// to avoid duplication. See scaffoldWorkspaceFiles import above.

// ============================================================================
// Wizard steps
// ============================================================================

const WIZARD_STEPS: readonly WizardStep[] = [
  {
    name: 'llmProvider',
    prompt: 'LLM provider',
    type: 'select',
    options: ['grok', 'anthropic', 'ollama'],
    default: 'grok',
  },
  {
    name: 'apiKey',
    prompt: 'API key (leave blank to skip)',
    type: 'password',
    default: '',
  },
  {
    name: 'channels',
    prompt: 'Enabled channels (comma-separated, e.g. discord,telegram)',
    type: 'input',
    default: '',
  },
  {
    name: 'solanaNetwork',
    prompt: 'Solana network',
    type: 'select',
    options: ['devnet', 'mainnet-beta', 'localnet'],
    default: 'devnet',
  },
  {
    name: 'rpcUrl',
    prompt: 'RPC URL',
    type: 'input',
    default: 'https://api.devnet.solana.com',
  },
  {
    name: 'keypairPath',
    prompt: 'Keypair path',
    type: 'input',
    default: '',
  },
];

// ============================================================================
// Solana config detection
// ============================================================================

export function detectSolanaConfig(): string | undefined {
  const defaultPath = join(homedir(), '.config', 'solana', 'id.json');
  return existsSync(defaultPath) ? defaultPath : undefined;
}

// ============================================================================
// Default config generation
// ============================================================================

const NETWORK_RPC_URLS: Record<string, string> = {
  devnet: 'https://api.devnet.solana.com',
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
  localnet: 'http://127.0.0.1:8899',
};

export function generateDefaultConfig(overrides?: Partial<GatewayConfig>): GatewayConfig {
  const keypairPath = detectSolanaConfig();

  const base: GatewayConfig = {
    gateway: {
      port: 9099,
      bind: '127.0.0.1',
    },
    agent: {
      name: 'agenc-agent',
    },
    connection: {
      rpcUrl: 'https://api.devnet.solana.com',
      ...(keypairPath ? { keypairPath } : {}),
    },
    llm: {
      provider: 'grok',
    },
    memory: {
      backend: 'memory',
    },
    logging: {
      level: 'info',
    },
  };

  if (!overrides) return base;

  const llm = overrides.llm ?? base.llm;
  const mergedLlm = llm ? {
    ...base.llm,
    ...overrides.llm,
    provider: overrides.llm?.provider ?? base.llm?.provider ?? 'grok',
  } as GatewayConfig['llm'] : undefined;

  const memory = overrides.memory ?? base.memory;
  const mergedMemory = memory ? {
    ...base.memory,
    ...overrides.memory,
    backend: overrides.memory?.backend ?? base.memory?.backend ?? 'memory',
  } as GatewayConfig['memory'] : undefined;

  return {
    gateway: { ...base.gateway, ...overrides.gateway },
    agent: { ...base.agent, ...overrides.agent },
    connection: { ...base.connection, ...overrides.connection },
    ...(mergedLlm ? { llm: mergedLlm } : {}),
    ...(mergedMemory ? { memory: mergedMemory } : {}),
    ...(overrides.channels ? { channels: overrides.channels } : {}),
    ...(overrides.logging || base.logging ? { logging: { ...base.logging, ...overrides.logging } } : {}),
  };
}

// ============================================================================
// Workspace scaffolding (delegates to gateway/workspace-files.ts)
// ============================================================================

export async function scaffoldWorkspace(workspacePath: string): Promise<void> {
  await scaffoldWorkspaceFiles(workspacePath);
}

// ============================================================================
// Interactive readline helper
// ============================================================================

async function promptUser(question: string, defaultValue: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  return new Promise<string>((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue);
    });
  });
}

// ============================================================================
// Setup wizard
// ============================================================================

export async function runSetupWizard(options?: {
  configPath?: string;
  nonInteractive?: boolean;
}): Promise<WizardResult> {
  const configPath = options?.configPath ?? getDefaultConfigPath();
  const workspacePath = join(dirname(configPath), 'workspace');
  const nonInteractive = options?.nonInteractive ?? false;

  let answers: Record<string, string> = {};

  if (nonInteractive) {
    for (const step of WIZARD_STEPS) {
      answers[step.name] = step.default ?? '';
    }
    const detected = detectSolanaConfig();
    if (detected) {
      answers.keypairPath = detected;
    }
  } else {
    for (const step of WIZARD_STEPS) {
      let effectiveDefault = step.default ?? '';
      if (step.name === 'keypairPath') {
        const detected = detectSolanaConfig();
        if (detected) effectiveDefault = detected;
      }

      if (step.type === 'select' && step.options) {
        const optionsStr = step.options.join(', ');
        const answer = await promptUser(`${step.prompt} (${optionsStr})`, effectiveDefault);
        answers[step.name] = answer;
      } else {
        const answer = await promptUser(step.prompt, effectiveDefault);
        answers[step.name] = answer;
      }
    }
  }

  // Build channels config
  const channelEntries: Record<string, { type: string; enabled: boolean }> = {};
  if (answers.channels) {
    const channelNames = answers.channels.split(',').map((c) => c.trim()).filter(Boolean);
    for (const name of channelNames) {
      channelEntries[name] = { type: name, enabled: true };
    }
  }

  // Determine RPC URL
  const rpcUrl = answers.rpcUrl || NETWORK_RPC_URLS[answers.solanaNetwork] || 'https://api.devnet.solana.com';

  const config = generateDefaultConfig({
    connection: {
      rpcUrl,
      ...(answers.keypairPath ? { keypairPath: answers.keypairPath } : {}),
    },
    llm: {
      provider: answers.llmProvider as 'grok' | 'anthropic' | 'ollama',
      ...(answers.apiKey ? { apiKey: answers.apiKey } : {}),
    },
    ...(Object.keys(channelEntries).length > 0 ? { channels: channelEntries } : {}),
  });

  // Write config
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

  // Scaffold workspace
  await scaffoldWorkspace(workspacePath);

  // Run basic diagnostics
  const validation = validateGatewayConfig(config);
  const diagnosticsPassed = validation.valid;

  return {
    config,
    configPath,
    workspacePath,
    diagnosticsPassed,
  };
}
