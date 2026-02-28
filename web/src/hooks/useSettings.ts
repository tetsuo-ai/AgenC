import { useCallback, useEffect, useRef, useState } from 'react';
import type { WSMessage } from '../types';

export type VoiceName = 'Ara' | 'Rex' | 'Sal' | 'Eve' | 'Leo';

export interface GatewaySettings {
  llm: {
    provider: 'grok' | 'ollama';
    apiKey: string;
    model: string;
    baseUrl: string;
  };
  voice: {
    enabled: boolean;
    mode: 'vad' | 'push-to-talk';
    voice: VoiceName;
    apiKey: string;
  };
  memory: {
    backend: 'memory' | 'sqlite' | 'redis';
  };
  connection: {
    rpcUrl: string;
  };
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
  };
}

const DEFAULT_SETTINGS: GatewaySettings = {
  llm: { provider: 'grok', apiKey: '', model: 'grok-4-1-fast-reasoning', baseUrl: 'https://api.x.ai/v1' },
  voice: { enabled: true, mode: 'vad', voice: 'Ara', apiKey: '' },
  memory: { backend: 'memory' },
  connection: { rpcUrl: 'https://api.devnet.solana.com' },
  logging: { level: 'info' },
};
const SAVE_TIMEOUT_MS = 10_000;

interface UseSettingsOptions {
  send: (msg: Record<string, unknown>) => void;
  connected: boolean;
}

export interface UseSettingsReturn {
  settings: GatewaySettings;
  loaded: boolean;
  saving: boolean;
  lastError: string | null;
  ollamaModels: string[];
  ollamaError: string | null;
  refresh: () => void;
  save: (partial: Partial<GatewaySettings>) => void;
  fetchOllamaModels: () => void;
  handleMessage: (msg: WSMessage) => void;
}

export function useSettings({ send, connected }: UseSettingsOptions): UseSettingsReturn {
  const [settings, setSettings] = useState<GatewaySettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaError, setOllamaError] = useState<string | null>(null);
  const requestedRef = useRef(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSaveTimeout = useCallback(() => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
  }, []);

  const refresh = useCallback(() => {
    send({ type: 'config.get' });
  }, [send]);

  const fetchOllamaModels = useCallback(() => {
    setOllamaError(null);
    send({ type: 'ollama.models' });
  }, [send]);

  // Auto-fetch config on connect
  useEffect(() => {
    if (connected && !requestedRef.current) {
      requestedRef.current = true;
      refresh();
    }
    if (!connected) {
      requestedRef.current = false;
    }
  }, [connected, refresh]);

  const save = useCallback((partial: Partial<GatewaySettings>) => {
    clearSaveTimeout();
    setSaving(true);
    setLastError(null);
    send({ type: 'config.set', payload: partial });
    saveTimeoutRef.current = setTimeout(() => {
      setSaving(false);
      setLastError('Saving settings timed out. Check daemon/WebSocket connection and try again.');
    }, SAVE_TIMEOUT_MS);
  }, [clearSaveTimeout, send]);

  useEffect(() => {
    if (!connected && saving) {
      clearSaveTimeout();
      setSaving(false);
      setLastError('Disconnected while saving settings.');
    }
  }, [clearSaveTimeout, connected, saving]);

  useEffect(() => () => clearSaveTimeout(), [clearSaveTimeout]);

  const handleMessage = useCallback((msg: WSMessage) => {
    if (msg.type === 'config.get' && !msg.error) {
      const p = msg.payload as Record<string, unknown> | undefined;
      if (p) {
        setSettings(parseConfig(p));
        setLoaded(true);
      }
    }
    if (msg.type === 'config.set') {
      clearSaveTimeout();
      setSaving(false);
      if (msg.error) {
        setLastError(msg.error);
      } else {
        const p = msg.payload as Record<string, unknown> | undefined;
        const config = p?.config as Record<string, unknown> | undefined;
        if (config) {
          setSettings(parseConfig(config));
        }
        setLastError(null);
      }
    }
    if (msg.type === 'ollama.models') {
      if (msg.error) {
        setOllamaModels([]);
        setOllamaError(msg.error);
      } else {
        const p = msg.payload as { models?: string[] } | undefined;
        const models = p?.models ?? [];
        setOllamaModels(models);
        setOllamaError(models.length === 0 ? 'No models installed in Ollama' : null);
      }
    }
  }, [clearSaveTimeout]);

  return { settings, loaded, saving, lastError, ollamaModels, ollamaError, refresh, save, fetchOllamaModels, handleMessage };
}

function parseConfig(raw: Record<string, unknown>): GatewaySettings {
  const llm = (raw.llm ?? {}) as Record<string, unknown>;
  const voice = (raw.voice ?? {}) as Record<string, unknown>;
  const memory = (raw.memory ?? {}) as Record<string, unknown>;
  const connection = (raw.connection ?? {}) as Record<string, unknown>;
  const logging = (raw.logging ?? {}) as Record<string, unknown>;

  return {
    llm: {
      provider: (llm.provider as GatewaySettings['llm']['provider']) ?? 'grok',
      apiKey: (llm.apiKey as string) ?? '',
      model: (llm.model as string) ?? '',
      baseUrl: (llm.baseUrl as string) ?? '',
    },
    voice: {
      enabled: voice.enabled !== false,
      mode: (voice.mode as 'vad' | 'push-to-talk') ?? 'vad',
      voice: (voice.voice as VoiceName) ?? 'Ara',
      apiKey: (voice.apiKey as string) ?? '',
    },
    memory: {
      backend: (memory.backend as GatewaySettings['memory']['backend']) ?? 'memory',
    },
    connection: {
      rpcUrl: (connection.rpcUrl as string) ?? 'https://api.devnet.solana.com',
    },
    logging: {
      level: (logging.level as GatewaySettings['logging']['level']) ?? 'info',
    },
  };
}
