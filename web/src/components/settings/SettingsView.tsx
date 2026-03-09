import { useEffect, useState } from 'react';
import type { GatewaySettings, UseSettingsReturn, VoiceName, EnvironmentMode } from '../../hooks/useSettings';
import { LLM_PROVIDERS } from '../../constants/llm';

interface SettingsViewProps {
  settings: UseSettingsReturn;
  autoApprove?: boolean;
  onAutoApproveChange?: (value: boolean) => void;
}

export function SettingsView({ settings, autoApprove = false, onAutoApproveChange }: SettingsViewProps) {
  const {
    settings: config,
    loaded,
    saving,
    lastError,
    save,
    ollamaModels,
    ollamaError,
    fetchOllamaModels,
  } = settings;

  const [provider, setProvider] = useState(config.llm.provider);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(config.llm.model);
  const [voiceEnabled, setVoiceEnabled] = useState(config.voice.enabled);
  const [voiceMode, setVoiceMode] = useState(config.voice.mode);
  const [voiceName, setVoiceName] = useState<VoiceName>(config.voice.voice);
  const [voiceApiKey] = useState('');
  const [useCustomVoiceKey, setUseCustomVoiceKey] = useState(!!config.voice.apiKey);
  const [environment, setEnvironment] = useState<EnvironmentMode>(config.desktop.environment);
  const [memoryBackend, setMemoryBackend] = useState(config.memory.backend);
  const [rpcCluster, setRpcCluster] = useState<'devnet' | 'mainnet' | 'custom'>(
    config.connection.rpcUrl.includes('mainnet') ? 'mainnet' : 'devnet',
  );
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (provider === 'ollama') {
      fetchOllamaModels();
    }
  }, [provider, fetchOllamaModels]);

  useEffect(() => {
    if (provider === 'ollama' && ollamaModels.length > 0 && !ollamaModels.includes(model)) {
      setModel(ollamaModels[0]);
    }
  }, [provider, ollamaModels, model]);

  useEffect(() => {
    if (!loaded) return;
    setProvider(config.llm.provider);
    setModel(config.llm.model);
    setVoiceEnabled(config.voice.enabled);
    setVoiceMode(config.voice.mode);
    setVoiceName(config.voice.voice);
    setUseCustomVoiceKey(!!config.voice.apiKey);
    setEnvironment(config.desktop.environment);
    setMemoryBackend(config.memory.backend);
    setRpcCluster(config.connection.rpcUrl.includes('mainnet') ? 'mainnet' : 'devnet');
  }, [loaded, config]);

  const markDirty = () => {
    setDirty(true);
    setSaved(false);
  };

  const handleProviderChange = (nextProvider: string) => {
    setProvider(nextProvider as GatewaySettings['llm']['provider']);
    const match = LLM_PROVIDERS.find((item) => item.value === nextProvider);
    if (nextProvider === 'ollama') {
      setModel(ollamaModels.length > 0 ? ollamaModels[0] : '');
    } else if (match) {
      setModel(match.defaultModel);
    }
    setApiKey('');
    markDirty();
  };

  const handleSave = () => {
    const rpcUrl = rpcCluster === 'mainnet'
      ? 'https://api.mainnet-beta.solana.com'
      : 'https://api.devnet.solana.com';
    const baseUrl = LLM_PROVIDERS.find((item) => item.value === provider)?.defaultBaseUrl ?? '';
    const patch: Partial<GatewaySettings> = {
      llm: {
        provider,
        model,
        baseUrl,
        apiKey: apiKey && !apiKey.startsWith('****') ? apiKey : config.llm.apiKey,
      },
      voice: {
        enabled: voiceEnabled,
        mode: voiceMode,
        voice: voiceName,
        apiKey: useCustomVoiceKey && voiceApiKey && !voiceApiKey.startsWith('****')
          ? voiceApiKey
          : useCustomVoiceKey ? config.voice.apiKey : '',
      },
      desktop: { environment },
      memory: { backend: memoryBackend },
      connection: { rpcUrl },
    };
    save(patch);
    setDirty(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  const modelList = provider === 'ollama'
    ? ollamaModels
    : (LLM_PROVIDERS.find((item) => item.value === provider)?.models ?? []);
  const modelOptions = modelList.map((item) => ({ value: item, label: item }));

  return (
    <div className="flex h-full flex-col bg-bbs-black font-mono text-bbs-lightgray animate-chat-enter">
      <header className="border-b border-bbs-border bg-bbs-surface px-4 py-4 md:px-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-bbs-gray">
              <span className="text-bbs-purple">SETTINGS&gt;</span>
              <span>gateway control plane</span>
            </div>
            <h2 className="mt-2 text-sm font-bold uppercase tracking-[0.18em] text-bbs-white md:text-base">
              Runtime configuration
            </h2>
            <p className="mt-1 text-xs text-bbs-gray">
              provider selection, voice routing, environment boundaries, and persistence backends
            </p>
          </div>

          <button
            type="button"
            onClick={handleSave}
            disabled={saving || (!dirty && !apiKey)}
            className={[
              'border px-4 py-3 text-xs uppercase tracking-[0.14em] transition-colors disabled:opacity-50',
              saved
                ? 'border-bbs-green/40 bg-bbs-dark text-bbs-green'
                : dirty || apiKey
                  ? 'border-bbs-purple-dim bg-bbs-dark text-bbs-purple hover:text-bbs-white'
                  : 'border-bbs-border bg-bbs-dark text-bbs-gray',
            ].join(' ')}
          >
            {saving ? '[saving...]' : saved ? '[saved]' : '[save & apply]'}
          </button>
        </div>
      </header>

      {!loaded ? (
        <div className="border-b border-bbs-yellow/40 bg-bbs-dark px-4 py-3 text-sm text-bbs-yellow md:px-6">
          [loading configuration]
        </div>
      ) : null}

      {lastError ? (
        <div className="border-b border-bbs-red/40 bg-bbs-dark px-4 py-3 text-sm text-bbs-red md:px-6">
          {lastError}
        </div>
      ) : null}

      <div className="flex-1 overflow-y-auto px-4 py-4 md:px-6 md:py-6">
        <div className="mx-auto grid max-w-5xl gap-4 xl:grid-cols-2">
          <Panel title="LLM provider" subtitle="active inference backend">
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {LLM_PROVIDERS.map((item) => {
                const active = provider === item.value;
                return (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => handleProviderChange(item.value)}
                    className={[
                      'border px-3 py-3 text-left text-xs uppercase tracking-[0.14em] transition-colors',
                      active
                        ? 'border-bbs-purple-dim bg-bbs-surface text-bbs-white'
                        : 'border-bbs-border bg-bbs-dark text-bbs-gray hover:border-bbs-purple-dim hover:text-bbs-white',
                    ].join(' ')}
                  >
                    [{item.label}]
                  </button>
                );
              })}
            </div>
          </Panel>

          {provider !== 'ollama' ? (
            <Panel
              title="API key"
              subtitle={config.llm.apiKey && config.llm.apiKey.startsWith('****')
                ? `configured ending ${config.llm.apiKey.slice(-4)}`
                : 'no key configured'}
            >
              <input
                type="password"
                value={apiKey || config.llm.apiKey}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  markDirty();
                }}
                onFocus={() => {
                  if (!apiKey) setApiKey('');
                }}
                placeholder="enter provider api key"
                className="w-full border border-bbs-border bg-bbs-dark px-3 py-3 text-sm text-bbs-white outline-none placeholder:text-bbs-gray focus:border-bbs-purple-dim"
              />
            </Panel>
          ) : null}

          <Panel
            title="Model"
            subtitle={provider === 'ollama' && ollamaError ? ollamaError : 'active inference model'}
            subtitleTone={provider === 'ollama' && ollamaError ? 'text-bbs-yellow' : undefined}
          >
            {modelOptions.length > 0 ? (
              <Picker
                value={model}
                options={modelOptions}
                onChange={(value) => {
                  setModel(value);
                  markDirty();
                }}
                title="select model"
              />
            ) : (
              <div className="border border-bbs-border bg-bbs-dark px-3 py-3 text-sm text-bbs-gray">
                [no models available]
              </div>
            )}
          </Panel>

          <Panel title="Voice" subtitle="speech synthesis and interaction mode">
            <div className="space-y-4">
              <ToggleRow
                label="enabled"
                description="allow voice interaction"
                value={voiceEnabled}
                onChange={(value) => {
                  setVoiceEnabled(value);
                  markDirty();
                }}
              />
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <div className="mb-2 text-[10px] uppercase tracking-[0.16em] text-bbs-gray">voice</div>
                  <Picker
                    value={voiceName}
                    options={[
                      { value: 'Ara', label: 'Ara' },
                      { value: 'Rex', label: 'Rex' },
                      { value: 'Sal', label: 'Sal' },
                      { value: 'Eve', label: 'Eve' },
                      { value: 'Leo', label: 'Leo' },
                    ]}
                    onChange={(value) => {
                      setVoiceName(value as VoiceName);
                      markDirty();
                    }}
                    title="select voice"
                  />
                </div>
                <div>
                  <div className="mb-2 text-[10px] uppercase tracking-[0.16em] text-bbs-gray">mode</div>
                  <Picker
                    value={voiceMode}
                    options={[
                      { value: 'vad', label: 'VAD (auto)' },
                      { value: 'push-to-talk', label: 'Push-to-talk' },
                    ]}
                    onChange={(value) => {
                      setVoiceMode(value as 'vad' | 'push-to-talk');
                      markDirty();
                    }}
                    title="select mode"
                  />
                </div>
              </div>
            </div>
          </Panel>

          <Panel title="Tool approvals" subtitle="operator confirmation policy">
            <ToggleRow
              label="auto-approve all tool calls"
              description="skip confirmation prompts for filesystem, bash, and http tools"
              value={autoApprove}
              onChange={(value) => onAutoApproveChange?.(value)}
            />
          </Panel>

          <Panel title="Environment" subtitle="tool boundary and sandbox exposure">
            <Picker
              value={environment}
              options={[
                { value: 'both', label: 'Host + Desktop' },
                { value: 'desktop', label: 'Desktop Only (sandbox)' },
                { value: 'host', label: 'Host Only' },
              ]}
              onChange={(value) => {
                setEnvironment(value as EnvironmentMode);
                markDirty();
              }}
              title="environment mode"
            />
          </Panel>

          <Panel title="Memory" subtitle="persistence backend">
            <Picker
              value={memoryBackend}
              options={[
                { value: 'memory', label: 'In-Memory' },
                { value: 'sqlite', label: 'SQLite' },
                { value: 'redis', label: 'Redis' },
              ]}
              onChange={(value) => {
                setMemoryBackend(value as 'memory' | 'sqlite' | 'redis');
                markDirty();
              }}
              title="memory backend"
            />
          </Panel>

          <Panel title="Network" subtitle="solana rpc target">
            <div className="space-y-3">
              <Picker
                value={rpcCluster}
                options={[
                  { value: 'devnet', label: 'Devnet' },
                  { value: 'mainnet', label: 'Mainnet' },
                ]}
                onChange={(value) => {
                  setRpcCluster(value as 'devnet' | 'mainnet');
                  markDirty();
                }}
                title="rpc cluster"
              />
              <div className="text-[10px] uppercase tracking-[0.16em] text-bbs-yellow">[restart required]</div>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function Panel({
  title,
  subtitle,
  subtitleTone,
  children,
}: {
  title: string;
  subtitle?: string;
  subtitleTone?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border border-bbs-border bg-bbs-dark px-4 py-4">
      <div className="mb-4">
        <div className="text-[10px] uppercase tracking-[0.16em] text-bbs-gray">section</div>
        <h3 className="mt-1 text-sm font-bold uppercase tracking-[0.14em] text-bbs-white">{title}</h3>
        {subtitle ? <p className={`mt-1 text-xs ${subtitleTone ?? 'text-bbs-gray'}`}>{subtitle}</p> : null}
      </div>
      {children}
    </section>
  );
}

interface PickerOption {
  value: string;
  label: string;
}

function Picker({
  value,
  options,
  onChange,
  title,
}: {
  value: string;
  options: PickerOption[];
  onChange: (value: string) => void;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((option) => option.value === value);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-between gap-2 border border-bbs-border bg-bbs-surface px-3 py-3 text-left text-sm text-bbs-lightgray transition-colors hover:border-bbs-purple-dim"
      >
        <span className="truncate">{current?.label ?? value}</span>
        <span className="text-xs uppercase tracking-[0.14em] text-bbs-gray">[select]</span>
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center" onClick={() => setOpen(false)}>
          <div
            className="w-full max-w-md border border-bbs-border bg-bbs-black"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="border-b border-bbs-border bg-bbs-surface px-4 py-3 text-xs uppercase tracking-[0.16em] text-bbs-white">
              {title}
            </div>
            <div className="p-3">
              {options.map((option) => {
                const active = option.value === value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => {
                      onChange(option.value);
                      setOpen(false);
                    }}
                    className={[
                      'mb-2 flex w-full items-center justify-between border px-3 py-3 text-left text-sm transition-colors last:mb-0',
                      active
                        ? 'border-bbs-purple-dim bg-bbs-surface text-bbs-white'
                        : 'border-bbs-border bg-bbs-dark text-bbs-gray hover:border-bbs-purple-dim hover:text-bbs-white',
                    ].join(' ')}
                  >
                    <span>{option.label}</span>
                    <span className="text-xs uppercase tracking-[0.14em]">{active ? '[active]' : '[pick]'}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function ToggleRow({
  label,
  description,
  value,
  onChange,
}: {
  label: string;
  description?: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border border-bbs-border bg-bbs-black/40 px-3 py-3">
      <div>
        <div className="text-sm text-bbs-lightgray">{label}</div>
        {description ? <div className="mt-1 text-xs text-bbs-gray">{description}</div> : null}
      </div>
      <button
        type="button"
        onClick={() => onChange(!value)}
        className={[
          'border px-3 py-2 text-xs uppercase tracking-[0.14em] transition-colors',
          value
            ? 'border-bbs-green/40 bg-bbs-dark text-bbs-green hover:text-bbs-white'
            : 'border-bbs-border bg-bbs-dark text-bbs-gray hover:border-bbs-purple-dim hover:text-bbs-white',
        ].join(' ')}
      >
        {value ? '[on]' : '[off]'}
      </button>
    </div>
  );
}
