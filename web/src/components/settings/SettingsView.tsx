import { useState, useEffect } from 'react';
import type { UseSettingsReturn, GatewaySettings, VoiceName } from '../../hooks/useSettings';

interface LLMProviderDef {
  value: string;
  label: string;
  defaultModel: string;
  defaultBaseUrl: string;
  models: string[];
}

const LLM_PROVIDERS: LLMProviderDef[] = [
  {
    value: 'grok',
    label: 'Grok (x.ai)',
    defaultModel: 'grok-4-fast-reasoning',
    defaultBaseUrl: 'https://api.x.ai/v1',
    models: ['grok-4', 'grok-4-fast-reasoning', 'grok-4-fast-non-reasoning', 'grok-code-fast-1', 'grok-3'],
  },
  {
    value: 'ollama',
    label: 'Ollama (local)',
    defaultModel: 'llama3',
    defaultBaseUrl: 'http://localhost:11434',
    models: [],
  },
];

interface SettingsViewProps {
  settings: UseSettingsReturn;
  autoApprove?: boolean;
  onAutoApproveChange?: (v: boolean) => void;
}

export function SettingsView({ settings, autoApprove = false, onAutoApproveChange }: SettingsViewProps) {
  const { settings: config, loaded, saving, lastError, save, ollamaModels, ollamaError, fetchOllamaModels } = settings;

  const [provider, setProvider] = useState(config.llm.provider);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(config.llm.model);
  const [voiceEnabled, setVoiceEnabled] = useState(config.voice.enabled);
  const [voiceMode, setVoiceMode] = useState(config.voice.mode);
  const [voiceName, setVoiceName] = useState<VoiceName>(config.voice.voice);
  const [voiceApiKey] = useState('');
  const [useCustomVoiceKey, setUseCustomVoiceKey] = useState(!!config.voice.apiKey);
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

  // Auto-select first Ollama model when list arrives
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
    setMemoryBackend(config.memory.backend);
    setRpcCluster(config.connection.rpcUrl.includes('mainnet') ? 'mainnet' : 'devnet');
  }, [loaded, config]);

  const markDirty = () => { setDirty(true); setSaved(false); };

  const handleProviderChange = (p: string) => {
    setProvider(p as GatewaySettings['llm']['provider']);
    const match = LLM_PROVIDERS.find((lp) => lp.value === p);
    if (p === 'ollama') {
      // Clear model — will be auto-set when ollamaModels arrive
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
    const baseUrl = LLM_PROVIDERS.find((p) => p.value === provider)?.defaultBaseUrl ?? '';
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
      memory: { backend: memoryBackend },
      connection: { rpcUrl },
    };
    save(patch);
    setDirty(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  const modelList = provider === 'ollama' ? ollamaModels : (LLM_PROVIDERS.find((p) => p.value === provider)?.models ?? []);
  const modelOptions = modelList.map((m) => ({ value: m, label: m }));

  return (
    <div className="flex flex-col h-full bg-surface">
      {/* Header */}
      <div className="px-6 py-4 border-b border-tetsuo-200">
        <h1 className="text-xl font-bold text-tetsuo-800 tracking-tight">Settings</h1>
        <p className="text-sm text-tetsuo-400 mt-1">Gateway configuration</p>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {!loaded && (
          <div className="text-sm text-tetsuo-400 text-center py-12">Loading configuration...</div>
        )}

        <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6">
          {/* LLM Provider */}
          <section>
            <h2 className="text-sm font-semibold text-tetsuo-800 mb-1">LLM Provider</h2>
            <p className="text-xs text-tetsuo-400 mb-3">Select the AI model provider for agent responses.</p>
            <div className="grid gap-2 grid-cols-2 sm:grid-cols-3">
              {LLM_PROVIDERS.map((p) => (
                <label
                  key={p.value}
                  className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl border cursor-pointer transition-all duration-200 ${
                    provider === p.value
                      ? 'border-accent bg-accent-bg shadow-[0_0_0_1px_rgba(var(--accent),0.15)]'
                      : 'border-tetsuo-200 hover:bg-tetsuo-50 hover:border-tetsuo-300'
                  }`}
                >
                  <input
                    type="radio"
                    name="llm-provider"
                    checked={provider === p.value}
                    onChange={() => handleProviderChange(p.value)}
                    className="sr-only"
                  />
                  <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors duration-200 ${
                    provider === p.value ? 'border-accent' : 'border-tetsuo-300'
                  }`}>
                    {provider === p.value && <div className="w-2 h-2 rounded-full bg-accent animate-dot-pop" />}
                  </div>
                  <span className={`text-sm truncate transition-colors duration-200 ${provider === p.value ? 'text-accent font-medium' : 'text-tetsuo-700'}`}>
                    {p.label}
                  </span>
                </label>
              ))}
            </div>
          </section>

          {/* API Key */}
          {provider !== 'ollama' && (
            <section>
              <h2 className="text-sm font-semibold text-tetsuo-800 mb-1">API Key</h2>
              <p className="text-xs text-tetsuo-400 mb-2">
                {config.llm.apiKey && config.llm.apiKey.startsWith('****')
                  ? `Key configured (ending ...${config.llm.apiKey.slice(-4)})`
                  : 'No key configured'}
              </p>
              <input
                type="password"
                value={apiKey || config.llm.apiKey}
                onChange={(e) => { setApiKey(e.target.value); markDirty(); }}
                onFocus={() => { if (!apiKey) setApiKey(''); }}
                placeholder="Enter x.ai API key"
                className="w-full bg-tetsuo-50 border border-tetsuo-200 rounded-xl px-4 py-2.5 text-sm text-tetsuo-700 font-mono placeholder:text-tetsuo-400 focus:outline-none focus:border-accent focus:shadow-[0_0_0_3px_rgba(var(--accent),0.1)] transition-all duration-200"
              />
            </section>
          )}

          {/* Model */}
          <section>
            <h2 className="text-sm font-semibold text-tetsuo-800 mb-1">Model</h2>
            <p className="text-xs text-tetsuo-400 mb-2">
              {provider === 'ollama' && ollamaError
                ? <span className="text-amber-500">{ollamaError}</span>
                : 'Select the model for inference.'}
            </p>
            {modelOptions.length > 0 ? (
              <Picker
                value={model}
                options={modelOptions}
                onChange={(v) => { setModel(v); markDirty(); }}
                title="Select Model"
              />
            ) : (
              <div className="w-full bg-tetsuo-50 border border-tetsuo-200 rounded-lg px-3 py-2 text-sm text-tetsuo-400 italic">
                {provider === 'ollama' ? 'No models available' : 'No models'}
              </div>
            )}
          </section>

          {/* Voice */}
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-tetsuo-800">Voice</h2>
            <div className="flex items-center justify-between">
              <span className="text-sm text-tetsuo-600">Enabled</span>
              <ToggleSwitch on={voiceEnabled} onChange={(v) => { setVoiceEnabled(v); markDirty(); }} />
            </div>
            <div className="grid gap-3 grid-cols-2">
              <div>
                <span className="text-xs text-tetsuo-400 mb-1 block">Voice</span>
                <Picker
                  value={voiceName}
                  options={[
                    { value: 'Ara', label: 'Ara' },
                    { value: 'Rex', label: 'Rex' },
                    { value: 'Sal', label: 'Sal' },
                    { value: 'Eve', label: 'Eve' },
                    { value: 'Leo', label: 'Leo' },
                  ]}
                  onChange={(v) => { setVoiceName(v as VoiceName); markDirty(); }}
                  title="Select Voice"
                />
              </div>
              <div>
                <span className="text-xs text-tetsuo-400 mb-1 block">Mode</span>
                <Picker
                  value={voiceMode}
                  options={[
                    { value: 'vad', label: 'VAD (auto)' },
                    { value: 'push-to-talk', label: 'Push-to-talk' },
                  ]}
                  onChange={(v) => { setVoiceMode(v as 'vad' | 'push-to-talk'); markDirty(); }}
                  title="Select Mode"
                />
              </div>
            </div>
          </section>

          {/* Tool Approvals */}
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-tetsuo-800">Tool Approvals</h2>
            <div className="flex items-center justify-between">
              <div>
                <span className="text-sm text-tetsuo-600">Auto-approve all tool calls</span>
                <p className="text-xs text-tetsuo-400 mt-0.5">Skip confirmation dialogs for bash, HTTP, filesystem, etc.</p>
              </div>
              <ToggleSwitch on={autoApprove} onChange={(v) => onAutoApproveChange?.(v)} />
            </div>
          </section>

          {/* Memory + Network — side by side */}
          <div className="grid gap-6 grid-cols-2">
            {/* Memory */}
            <section className="space-y-3">
              <h2 className="text-sm font-semibold text-tetsuo-800">Memory</h2>
              <div>
                <span className="text-xs text-tetsuo-400 mb-1 block">Backend</span>
                <Picker
                  value={memoryBackend}
                  options={[
                    { value: 'memory', label: 'In-Memory' },
                    { value: 'sqlite', label: 'SQLite' },
                    { value: 'redis', label: 'Redis' },
                  ]}
                  onChange={(v) => { setMemoryBackend(v as 'memory' | 'sqlite' | 'redis'); markDirty(); }}
                  title="Memory Backend"
                />
              </div>
            </section>

            {/* Network */}
            <section className="space-y-3">
              <h2 className="text-sm font-semibold text-tetsuo-800">Network</h2>
              <div>
                <span className="text-xs text-tetsuo-400 mb-1 block">RPC Cluster</span>
                <Picker
                  value={rpcCluster}
                  options={[
                    { value: 'devnet', label: 'Devnet' },
                    { value: 'mainnet', label: 'Mainnet' },
                  ]}
                  onChange={(v) => { setRpcCluster(v as 'devnet' | 'mainnet'); markDirty(); }}
                  title="RPC Cluster"
                />
              </div>
              <p className="text-xs text-amber-500">Requires restart.</p>
            </section>
          </div>

          {/* Error + Save */}
          {lastError && (
            <div className="text-sm text-red-500 px-1">{lastError}</div>
          )}
          <div className="pt-2">
            <button
              onClick={handleSave}
              disabled={saving || (!dirty && !apiKey)}
              className={`w-full sm:w-auto sm:float-right px-8 py-2.5 rounded-xl text-sm font-medium transition-all duration-300 ${
                saved
                  ? 'bg-emerald-500 text-white animate-save-glow'
                  : dirty || apiKey
                    ? 'bg-accent text-white hover:opacity-90 hover:shadow-lg hover:shadow-accent/20 active:scale-[0.98]'
                    : 'bg-tetsuo-100 text-tetsuo-400 cursor-not-allowed'
              }`}
            >
              {saving ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" strokeLinecap="round" />
                  </svg>
                  Saving...
                </span>
              ) : saved ? (
                <span className="flex items-center justify-center gap-1.5">
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12" /></svg>
                  Saved
                </span>
              ) : 'Save & Apply'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Custom Picker (replaces native <select> — bottom-sheet popup on mobile)
// =============================================================================

interface PickerOption {
  value: string;
  label: string;
}

function Picker({ value, options, onChange, title }: {
  value: string;
  options: PickerOption[];
  onChange: (v: string) => void;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full bg-tetsuo-50 border border-tetsuo-200 rounded-lg px-3 py-2 text-sm text-tetsuo-700 text-left flex items-center justify-between gap-2 focus:outline-none focus:border-accent transition-all duration-200 active:scale-[0.98]"
      >
        <span className="truncate">{current?.label ?? value}</span>
        <svg className="w-4 h-4 shrink-0 text-tetsuo-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="6 9 12 15 18 9" /></svg>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" onClick={() => setOpen(false)}>
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/50" />

          {/* Sheet */}
          <div
            className="relative w-full sm:max-w-sm bg-surface rounded-t-2xl sm:rounded-2xl overflow-hidden animate-slide-up"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Handle bar (mobile) */}
            <div className="flex justify-center pt-3 pb-1 sm:hidden">
              <div className="w-10 h-1 rounded-full bg-tetsuo-300" />
            </div>

            {/* Title */}
            <div className="px-5 pt-3 pb-2">
              <span className="text-sm font-semibold text-tetsuo-800">{title}</span>
            </div>

            {/* Options */}
            <div className="px-3 pb-6 sm:pb-4">
              {options.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => { onChange(o.value); setOpen(false); }}
                  className={`w-full text-left px-4 py-3 rounded-xl text-sm transition-all duration-150 flex items-center justify-between ${
                    value === o.value
                      ? 'bg-accent/10 text-accent font-medium'
                      : 'text-tetsuo-700 active:bg-tetsuo-100'
                  }`}
                >
                  <span>{o.label}</span>
                  {value === o.value && (
                    <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12" /></svg>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// =============================================================================
// Toggle Switch
// =============================================================================

function ToggleSwitch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!on)}
      className={`relative w-10 h-6 rounded-full transition-all duration-300 ${on ? 'bg-accent shadow-[0_0_8px_rgba(var(--accent),0.3)]' : 'bg-tetsuo-300'}`}
    >
      <span className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow-sm transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] ${on ? 'translate-x-4' : 'translate-x-0'}`} />
    </button>
  );
}
