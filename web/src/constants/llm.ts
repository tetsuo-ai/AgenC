export interface LLMProviderDef {
  value: 'grok' | 'ollama';
  label: string;
  defaultModel: string;
  defaultBaseUrl: string;
  models: string[];
}

export const GROK_MODEL_OPTIONS = [
  'grok-4-1-fast-reasoning',
  'grok-4-1-fast-non-reasoning',
  'grok-4.20-experimental-beta-0304-reasoning',
  'grok-4.20-experimental-beta-0304-non-reasoning',
  'grok-4.20-multi-agent-experimental-beta-0304',
  'grok-code-fast-1',
] as const;

export const LLM_PROVIDERS: LLMProviderDef[] = [
  {
    value: 'grok',
    label: 'Grok (x.ai)',
    defaultModel: 'grok-4-1-fast-reasoning',
    defaultBaseUrl: 'https://api.x.ai/v1',
    models: [...GROK_MODEL_OPTIONS],
  },
  {
    value: 'ollama',
    label: 'Ollama (local)',
    defaultModel: 'llama3',
    defaultBaseUrl: 'http://localhost:11434',
    models: [],
  },
];
