import { useCallback, useEffect, useRef, useState } from 'react';
import type { WSMessage } from '../types';

export interface GatewaySettings {
  llm: {
    provider: 'grok' | 'anthropic' | 'ollama';
    apiKey: string;
    model: string;
    baseUrl: string;
  };
  voice: {
    enabled: boolean;
    mode: 'vad' | 'push-to-talk';
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
  llm: { provider: 'grok', apiKey: '', model: 'grok-3-fast', baseUrl: 'https://api.x.ai/v1' },
  voice: { enabled: true, mode: 'vad' },
  memory: { backend: 'memory' },
  connection: { rpcUrl: 'https://api.devnet.solana.com' },
  logging: { level: 'info' },
};

interface UseSettingsOptions {
  send: (msg: Record<string, unknown>) => void;
  connected: boolean;
}

export interface UseSettingsReturn {
  settings: GatewaySettings;
  loaded: boolean;
  saving: boolean;
  lastError: string | null;
  refresh: () => void;
  save: (partial: Partial<GatewaySettings>) => void;
  handleMessage: (msg: WSMessage) => void;
}

export function useSettings({ send, connected }: UseSettingsOptions): UseSettingsReturn {
  const [settings, setSettings] = useState<GatewaySettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const requestedRef = useRef(false);

  const refresh = useCallback(() => {
    send({ type: 'config.get' });
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
    setSaving(true);
    setLastError(null);
    send({ type: 'config.set', payload: partial });
  }, [send]);

  const handleMessage = useCallback((msg: WSMessage) => {
    if (msg.type === 'config.get' && !msg.error) {
      const p = msg.payload as Record<string, unknown> | undefined;
      if (p) {
        setSettings(parseConfig(p));
        setLoaded(true);
      }
    }
    if (msg.type === 'config.set') {
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
  }, []);

  return { settings, loaded, saving, lastError, refresh, save, handleMessage };
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
