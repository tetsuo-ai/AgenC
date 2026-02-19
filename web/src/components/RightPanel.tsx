import { useState, useEffect, useRef, useCallback } from 'react';
import type { UseSettingsReturn, GatewaySettings } from '../hooks/useSettings';
import type { UseWalletReturn } from '../hooks/useWallet';

type Tab = 'main' | 'settings' | 'payment';
const TABS: Tab[] = ['main', 'settings', 'payment'];
const TAB_LABELS: Record<Tab, string> = { main: 'Main', settings: 'Settings', payment: 'Payment' };

const AGENTS = [
  { name: 'AgenC Runtime', icon: 'runtime', desc: 'Core agent orchestration' },
  { name: 'Compute Agent', icon: 'compute', desc: 'Task execution & processing' },
  { name: 'Inference Agent', icon: 'inference', desc: 'LLM & AI model routing' },
  { name: 'Storage Agent', icon: 'storage', desc: 'Memory & data persistence' },
  { name: 'Validator Agent', icon: 'validator', desc: 'Proof verification & disputes' },
  { name: 'Coordinator', icon: 'coordinator', desc: 'Workflow & team orchestration' },
];

const RECENT_CHATS = [
  { label: 'How to deploy to Solana?', time: '2m ago' },
  { label: 'Agent coordination protocol', time: '5m ago' },
  { label: 'ZK proof generation help', time: '12m ago' },
  { label: 'Task marketplace design', time: '1h ago' },
  { label: 'Memory backend setup', time: '2h ago' },
  { label: 'Dispute resolution flow', time: '3h ago' },
  { label: 'Skill registry integration', time: '5h ago' },
];

const LLM_PROVIDERS = [
  {
    value: 'grok',
    label: 'Grok (x.ai)',
    defaultModel: 'grok-3-fast',
    defaultBaseUrl: 'https://api.x.ai/v1',
    models: ['grok-3-fast', 'grok-3', 'grok-3-mini', 'grok-4-1-fast-reasoning'],
  },
  {
    value: 'anthropic',
    label: 'Anthropic',
    defaultModel: 'claude-sonnet-4-5-20250929',
    defaultBaseUrl: '',
    models: ['claude-sonnet-4-5-20250929', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'],
  },
  {
    value: 'ollama',
    label: 'Ollama (local)',
    defaultModel: 'llama3',
    defaultBaseUrl: 'http://localhost:11434',
    models: ['llama3', 'llama3.1', 'mistral', 'codellama', 'phi3', 'gemma2'],
  },
] as const;

interface RightPanelProps {
  settings: UseSettingsReturn;
  wallet: UseWalletReturn;
}

// =============================================================================
// Sliding Tab Bar
// =============================================================================

function TabBar({ active, onChange }: { active: Tab; onChange: (t: Tab) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Map<Tab, HTMLButtonElement>>(new Map());
  const [indicator, setIndicator] = useState({ left: 0, width: 0 });

  const measure = useCallback(() => {
    const btn = tabRefs.current.get(active);
    const container = containerRef.current;
    if (!btn || !container) return;
    const cr = container.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    setIndicator({ left: br.left - cr.left, width: br.width });
  }, [active]);

  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);

  return (
    <div ref={containerRef} className="relative flex border-b border-tetsuo-200">
      {TABS.map((tab) => (
        <button
          key={tab}
          ref={(el) => { if (el) tabRefs.current.set(tab, el); }}
          onClick={() => onChange(tab)}
          className={`flex-1 py-3 text-sm font-medium transition-colors duration-200 ${
            active === tab ? 'text-tetsuo-800' : 'text-tetsuo-400 hover:text-tetsuo-600'
          }`}
        >
          {TAB_LABELS[tab]}
        </button>
      ))}
      {/* Sliding indicator */}
      <span
        className="absolute bottom-0 h-[2px] bg-accent rounded-full transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]"
        style={{ left: indicator.left, width: indicator.width }}
      />
    </div>
  );
}

// =============================================================================
// Main Component
// =============================================================================

export function RightPanel({ settings, wallet }: RightPanelProps) {
  const [activeTab, setActiveTab] = useState<Tab>('main');
  const [tabKey, setTabKey] = useState(0);

  const handleTabChange = (tab: Tab) => {
    if (tab === activeTab) return;
    setActiveTab(tab);
    setTabKey((k) => k + 1);
  };

  return (
    <div className="w-[360px] h-full border-l border-tetsuo-200 bg-surface flex flex-col">
      {/* User header */}
      <div className="px-6 py-5 border-b border-tetsuo-200">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-accent-bg flex items-center justify-center overflow-hidden">
              <img src="/assets/agenc-logo.svg" alt="AgenC" className="w-7 h-7 dark:hidden" />
              <img src="/assets/agenc-logo-white.svg" alt="AgenC" className="w-7 h-7 hidden dark:block" />
            </div>
            <div>
              <img src="/assets/agenc-wordmark.svg" alt="AgenC" className="h-4 dark:invert opacity-90" />
              <div className="text-xs text-tetsuo-400 flex items-center gap-1.5 mt-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />
                Online
              </div>
            </div>
          </div>
          <button className="w-8 h-8 rounded-lg flex items-center justify-center text-tetsuo-400 hover:text-tetsuo-600 transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
        </div>
      </div>

      {/* Tabs with sliding indicator */}
      <TabBar active={activeTab} onChange={handleTabChange} />

      {/* Tab content with entrance animation */}
      <div key={tabKey} className="flex-1 min-h-0 animate-panel-enter">
        {activeTab === 'main' && <MainTab />}
        {activeTab === 'settings' && <SettingsTab settings={settings} />}
        {activeTab === 'payment' && <PaymentTab wallet={wallet} />}
      </div>
    </div>
  );
}

// =============================================================================
// Main Tab
// =============================================================================

function MainTab() {
  const [activeAgent, setActiveAgent] = useState(0);
  const [hoveredChat, setHoveredChat] = useState<number | null>(null);

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Agent capabilities */}
      <div className="py-4">
        <div className="flex items-center justify-between px-6 mb-2">
          <span className="text-sm font-bold text-tetsuo-800">Agents</span>
          <button className="text-tetsuo-400 hover:text-tetsuo-600 transition-colors">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" />
            </svg>
          </button>
        </div>
        {AGENTS.map((agent, i) => (
          <button
            key={agent.name}
            onClick={() => setActiveAgent(i)}
            className="animate-list-item w-full flex items-center gap-3 px-6 py-3 text-left transition-all duration-200 relative"
            style={{ animationDelay: `${i * 40}ms` }}
          >
            {/* Active indicator bar */}
            <span
              className={`absolute left-0 top-1/2 -translate-y-1/2 w-[3px] rounded-r-full bg-accent transition-all duration-300 ${
                activeAgent === i ? 'h-8 opacity-100' : 'h-0 opacity-0'
              }`}
            />
            <div className={`transition-all duration-200 ${activeAgent === i ? 'scale-110' : ''}`}>
              <AgentIcon type={agent.icon} active={activeAgent === i} />
            </div>
            <div className="min-w-0">
              <div className={`text-sm truncate transition-colors duration-200 ${activeAgent === i ? 'font-medium text-accent' : 'text-tetsuo-600'}`}>{agent.name}</div>
              <div className={`text-xs truncate transition-colors duration-200 ${activeAgent === i ? 'text-accent/60' : 'text-tetsuo-400'}`}>{agent.desc}</div>
            </div>
          </button>
        ))}
      </div>

      {/* Recent chats */}
      <div className="py-4">
        <div className="flex items-center justify-between px-6 mb-2">
          <span className="text-sm font-bold text-tetsuo-800">Recent Chats</span>
          <button className="text-tetsuo-400 hover:text-tetsuo-600 transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
        </div>
        {RECENT_CHATS.map((chat, i) => (
          <div
            key={i}
            onMouseEnter={() => setHoveredChat(i)}
            onMouseLeave={() => setHoveredChat(null)}
            className="animate-list-item flex items-center justify-between px-6 py-3.5 hover:bg-tetsuo-50 transition-all duration-200 cursor-pointer"
            style={{ animationDelay: `${(AGENTS.length + i) * 40}ms` }}
          >
            <span className="text-sm text-tetsuo-600 truncate flex-1 min-w-0 pr-3">{chat.label}</span>
            {hoveredChat === i ? (
              <div className="flex items-center gap-1 shrink-0 animate-panel-enter">
                <button className="w-6 h-6 rounded flex items-center justify-center text-tetsuo-400 hover:text-accent transition-colors">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
                </button>
                <button className="w-6 h-6 rounded flex items-center justify-center text-tetsuo-400 hover:text-red-500 transition-colors">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                </button>
                <button className="w-6 h-6 rounded flex items-center justify-center text-tetsuo-400 hover:text-tetsuo-600 transition-colors">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></svg>
                </button>
              </div>
            ) : (
              <span className="text-xs text-tetsuo-400 shrink-0">{chat.time}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// =============================================================================
// Settings Tab
// =============================================================================

function SettingsTab({ settings }: { settings: UseSettingsReturn }) {
  const { settings: config, loaded, saving, lastError, save } = settings;

  const [provider, setProvider] = useState(config.llm.provider);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(config.llm.model);
  const [voiceEnabled, setVoiceEnabled] = useState(config.voice.enabled);
  const [voiceMode, setVoiceMode] = useState(config.voice.mode);
  const [memoryBackend, setMemoryBackend] = useState(config.memory.backend);
  const [rpcCluster, setRpcCluster] = useState<'devnet' | 'mainnet' | 'custom'>(
    config.connection.rpcUrl.includes('mainnet') ? 'mainnet' : 'devnet',
  );
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!loaded) return;
    setProvider(config.llm.provider);
    setModel(config.llm.model);
    setVoiceEnabled(config.voice.enabled);
    setVoiceMode(config.voice.mode);
    setMemoryBackend(config.memory.backend);
    setRpcCluster(config.connection.rpcUrl.includes('mainnet') ? 'mainnet' : 'devnet');
  }, [loaded, config]);

  const markDirty = () => { setDirty(true); setSaved(false); };

  const handleProviderChange = (p: typeof provider) => {
    setProvider(p);
    const match = LLM_PROVIDERS.find((lp) => lp.value === p);
    if (match) setModel(match.defaultModel);
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
      voice: { enabled: voiceEnabled, mode: voiceMode },
      memory: { backend: memoryBackend },
      connection: { rpcUrl },
    };
    save(patch);
    setDirty(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  let sectionIdx = 0;
  const sectionDelay = () => `${(sectionIdx++) * 50}ms`;

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      {!loaded && (
        <div className="text-xs text-tetsuo-400 text-center py-4">Loading config...</div>
      )}

      {/* LLM Provider */}
      <div className="animate-list-item" style={{ animationDelay: sectionDelay() }}>
        <div className="text-xs text-tetsuo-400 uppercase tracking-wider mb-3">LLM Provider</div>
        <div className="space-y-2">
          {LLM_PROVIDERS.map((p) => (
            <label
              key={p.value}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border cursor-pointer transition-all duration-200 ${
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
              <span className={`text-sm transition-colors duration-200 ${provider === p.value ? 'text-accent font-medium' : 'text-tetsuo-700'}`}>
                {p.label}
              </span>
            </label>
          ))}
        </div>
      </div>

      {/* API Key */}
      {provider !== 'ollama' && (
        <div className="animate-list-item" style={{ animationDelay: sectionDelay() }}>
          <div className="text-xs text-tetsuo-400 uppercase tracking-wider mb-2">API Key</div>
          <input
            type="password"
            value={apiKey || config.llm.apiKey}
            onChange={(e) => { setApiKey(e.target.value); markDirty(); }}
            onFocus={() => { if (!apiKey) setApiKey(''); }}
            placeholder={`Enter ${provider === 'grok' ? 'x.ai' : 'Anthropic'} API key`}
            className="w-full bg-tetsuo-50 border border-tetsuo-200 rounded-lg px-3 py-2 text-sm text-tetsuo-700 font-mono placeholder:text-tetsuo-400 focus:outline-none focus:border-accent focus:shadow-[0_0_0_3px_rgba(var(--accent),0.1)] transition-all duration-200"
          />
          <p className="text-xs text-tetsuo-400 mt-1.5">
            {config.llm.apiKey && config.llm.apiKey.startsWith('****')
              ? `Key configured (ending ...${config.llm.apiKey.slice(-4)})`
              : 'No key configured'}
          </p>
        </div>
      )}

      {/* Model */}
      <div className="animate-list-item" style={{ animationDelay: sectionDelay() }}>
        <div className="text-xs text-tetsuo-400 uppercase tracking-wider mb-2">Model</div>
        <select
          value={model}
          onChange={(e) => { setModel(e.target.value); markDirty(); }}
          className="w-full bg-tetsuo-50 border border-tetsuo-200 rounded-lg px-3 py-2 text-sm text-tetsuo-700 font-mono focus:outline-none focus:border-accent focus:shadow-[0_0_0_3px_rgba(var(--accent),0.1)] transition-all duration-200"
        >
          {(LLM_PROVIDERS.find((p) => p.value === provider)?.models ?? []).map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </div>

      {/* Voice */}
      <div className="animate-list-item" style={{ animationDelay: sectionDelay() }}>
        <div className="text-xs text-tetsuo-400 uppercase tracking-wider mb-3">Voice</div>
        <div className="space-y-3">
          <SettingToggle
            label="Voice enabled"
            on={voiceEnabled}
            onChange={(v) => { setVoiceEnabled(v); markDirty(); }}
          />
          <div className="flex items-center justify-between">
            <span className="text-sm text-tetsuo-600">Mode</span>
            <select
              value={voiceMode}
              onChange={(e) => { setVoiceMode(e.target.value as 'vad' | 'push-to-talk'); markDirty(); }}
              className="bg-tetsuo-50 border border-tetsuo-200 rounded-lg px-2.5 py-1.5 text-sm text-tetsuo-700 focus:outline-none focus:border-accent transition-all duration-200"
            >
              <option value="vad">VAD (auto-detect)</option>
              <option value="push-to-talk">Push-to-talk</option>
            </select>
          </div>
        </div>
      </div>

      {/* Memory */}
      <div className="animate-list-item" style={{ animationDelay: sectionDelay() }}>
        <div className="text-xs text-tetsuo-400 uppercase tracking-wider mb-3">Memory</div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-tetsuo-600">Backend</span>
          <select
            value={memoryBackend}
            onChange={(e) => { setMemoryBackend(e.target.value as 'memory' | 'sqlite' | 'redis'); markDirty(); }}
            className="bg-tetsuo-50 border border-tetsuo-200 rounded-lg px-2.5 py-1.5 text-sm text-tetsuo-700 focus:outline-none focus:border-accent transition-all duration-200"
          >
            <option value="memory">In-Memory</option>
            <option value="sqlite">SQLite</option>
            <option value="redis">Redis</option>
          </select>
        </div>
      </div>

      {/* Network */}
      <div className="animate-list-item" style={{ animationDelay: sectionDelay() }}>
        <div className="text-xs text-tetsuo-400 uppercase tracking-wider mb-3">Network</div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-tetsuo-600">RPC Cluster</span>
          <select
            value={rpcCluster}
            onChange={(e) => { setRpcCluster(e.target.value as 'devnet' | 'mainnet'); markDirty(); }}
            className="bg-tetsuo-50 border border-tetsuo-200 rounded-lg px-2.5 py-1.5 text-sm text-tetsuo-700 focus:outline-none focus:border-accent transition-all duration-200"
          >
            <option value="devnet">Devnet</option>
            <option value="mainnet">Mainnet</option>
          </select>
        </div>
        <p className="text-xs text-amber-500 mt-2">
          Network changes require gateway restart.
        </p>
      </div>

      {/* Save button */}
      <div className="animate-list-item pt-2" style={{ animationDelay: sectionDelay() }}>
        {lastError && (
          <div className="text-xs text-red-500 mb-2 px-1">{lastError}</div>
        )}
        <button
          onClick={handleSave}
          disabled={saving || (!dirty && !apiKey)}
          className={`w-full py-2.5 rounded-lg text-sm font-medium transition-all duration-300 ${
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
              Saved & Applied
            </span>
          ) : 'Save & Apply'}
        </button>
      </div>
    </div>
  );
}

function SettingToggle({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-tetsuo-600">{label}</span>
      <button
        onClick={() => onChange(!on)}
        className={`relative w-10 h-6 rounded-full transition-all duration-300 ${on ? 'bg-accent shadow-[0_0_8px_rgba(var(--accent),0.3)]' : 'bg-tetsuo-300'}`}
      >
        <span className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow-sm transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] ${on ? 'translate-x-4' : 'translate-x-0'}`} />
      </button>
    </div>
  );
}

// =============================================================================
// Payment Tab (functional — reads real wallet data from gateway)
// =============================================================================

function PaymentTab({ wallet: w }: { wallet: UseWalletReturn }) {
  const { wallet, loading, airdropping, lastError, refresh, airdrop } = w;
  const isMainnet = wallet?.network === 'mainnet-beta';
  const isDevnet = wallet?.network === 'devnet';
  const [copied, setCopied] = useState(false);
  const [airdropSuccess, setAirdropSuccess] = useState(false);
  const prevSol = useRef(wallet?.sol ?? 0);

  // Track airdrop success for flash animation
  useEffect(() => {
    if (wallet && wallet.sol !== prevSol.current) {
      if (wallet.sol > prevSol.current) {
        setAirdropSuccess(true);
        setTimeout(() => setAirdropSuccess(false), 1500);
      }
      prevSol.current = wallet.sol;
    }
  }, [wallet?.sol]);

  const truncateAddress = (addr: string) => {
    if (addr.length <= 12) return addr;
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  const copyAddress = () => {
    if (wallet?.address) {
      void navigator.clipboard.writeText(wallet.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  let itemIdx = 0;
  const itemDelay = () => `${(itemIdx++) * 60}ms`;

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      {/* Balance card */}
      <div className="animate-list-item rounded-xl border border-tetsuo-200 p-5 relative overflow-hidden" style={{ animationDelay: itemDelay() }}>
        {airdropSuccess && <div className="absolute inset-0 animate-shimmer pointer-events-none" />}
        <div className="flex items-center justify-between mb-1 relative">
          <div className="text-xs text-tetsuo-400 uppercase tracking-wider">SOL Balance</div>
          <button
            onClick={refresh}
            disabled={loading}
            className="text-tetsuo-400 hover:text-tetsuo-600 transition-all duration-200 disabled:opacity-50 active:scale-90"
            title="Refresh"
          >
            <svg className={`w-4 h-4 transition-transform duration-500 ${loading ? 'animate-spin' : 'hover:rotate-90'}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </button>
        </div>
        {loading && !wallet ? (
          <div className="h-8 w-32 rounded bg-tetsuo-100 animate-pulse" />
        ) : wallet ? (
          <div className="relative">
            <div className={`text-2xl font-bold text-tetsuo-800 transition-all duration-300 ${airdropSuccess ? 'text-emerald-500' : ''}`}>
              {wallet.sol.toFixed(4)} SOL
            </div>
            <div className="text-xs text-tetsuo-400 mt-1 capitalize">
              {wallet.network === 'mainnet-beta' ? 'Mainnet' : wallet.network}
            </div>
          </div>
        ) : lastError ? (
          <div className="text-sm text-red-500">{lastError}</div>
        ) : (
          <div className="text-2xl font-bold text-tetsuo-400">--</div>
        )}
      </div>

      {/* Wallet address */}
      {wallet && (
        <div className="animate-list-item" style={{ animationDelay: itemDelay() }}>
          <div className="text-xs text-tetsuo-400 uppercase tracking-wider mb-2">Wallet Address</div>
          <button
            onClick={copyAddress}
            className="w-full flex items-center justify-between px-4 py-3 rounded-lg bg-tetsuo-50 border border-tetsuo-200 hover:bg-tetsuo-100 hover:border-tetsuo-300 transition-all duration-200 group active:scale-[0.98]"
            title="Click to copy"
          >
            <span className="text-sm text-tetsuo-600 font-mono truncate">{truncateAddress(wallet.address)}</span>
            {copied ? (
              <svg className="w-4 h-4 text-emerald-500 shrink-0 ml-2 animate-dot-pop" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12" /></svg>
            ) : (
              <svg className="w-4 h-4 text-tetsuo-400 group-hover:text-tetsuo-600 shrink-0 ml-2 transition-colors duration-200" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
          </button>
        </div>
      )}

      {/* Protocol Fees */}
      <div className="animate-list-item" style={{ animationDelay: itemDelay() }}>
        <div className="text-xs text-tetsuo-400 uppercase tracking-wider mb-3">Protocol Fees</div>
        <div className="space-y-2">
          <div className="flex items-center justify-between px-4 py-2.5 rounded-lg bg-tetsuo-50 border border-tetsuo-200">
            <span className="text-sm text-tetsuo-600">Base fee</span>
            <span className="text-sm text-tetsuo-700">2.5%</span>
          </div>
          <div className="flex items-center justify-between px-4 py-2.5 rounded-lg bg-tetsuo-50 border border-tetsuo-200">
            <span className="text-sm text-tetsuo-600">Fee tier</span>
            <span className="text-sm text-tetsuo-700">Base</span>
          </div>
        </div>
        <p className="text-xs text-tetsuo-400 mt-2">
          Complete more tasks to unlock fee discounts (Bronze 50+, Silver 200+, Gold 1000+).
        </p>
      </div>

      {/* Error banner */}
      {lastError && (
        <div className="text-xs text-red-500 px-1 animate-panel-enter">{lastError}</div>
      )}

      {/* Actions */}
      <div className="animate-list-item space-y-2" style={{ animationDelay: itemDelay() }}>
        {!isMainnet && (
          <button
            onClick={() => airdrop(1)}
            disabled={airdropping || !wallet}
            className={`w-full py-2.5 rounded-lg text-sm font-medium transition-all duration-300 active:scale-[0.98] ${
              airdropping
                ? 'bg-accent/70 text-white cursor-wait'
                : 'bg-accent text-white hover:opacity-90 hover:shadow-lg hover:shadow-accent/20'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {airdropping ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" strokeLinecap="round" />
                </svg>
                Requesting Airdrop...
              </span>
            ) : `Airdrop 1 SOL${isDevnet ? ' (Devnet)' : ''}`}
          </button>
        )}
        <button
          onClick={() => wallet?.explorerUrl && window.open(wallet.explorerUrl, '_blank')}
          disabled={!wallet}
          className="w-full py-2.5 rounded-lg border border-tetsuo-200 text-sm font-medium text-tetsuo-700 hover:bg-tetsuo-50 hover:border-tetsuo-300 transition-all duration-200 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          View on Explorer
        </button>
      </div>
    </div>
  );
}

// =============================================================================
// Shared Components
// =============================================================================

function AgentIcon({ type, active }: { type: string; active: boolean }) {
  const cls = `w-5 h-5 shrink-0 transition-colors duration-200 ${active ? 'text-accent' : 'text-tetsuo-400'}`;
  switch (type) {
    case 'runtime':
      return (
        <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
        </svg>
      );
    case 'compute':
      return (
        <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="4" width="16" height="16" rx="2" /><line x1="9" y1="9" x2="9.01" y2="9" /><line x1="15" y1="9" x2="15.01" y2="9" /><line x1="9" y1="15" x2="9.01" y2="15" /><line x1="15" y1="15" x2="15.01" y2="15" />
        </svg>
      );
    case 'inference':
      return (
        <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2a4 4 0 0 1 4 4c0 1.95-1.4 3.58-3.25 3.93L12 22" /><path d="M12 2a4 4 0 0 0-4 4c0 1.95 1.4 3.58 3.25 3.93" /><circle cx="12" cy="14" r="1" />
        </svg>
      );
    case 'storage':
      return (
        <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
        </svg>
      );
    case 'validator':
      return (
        <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><polyline points="9 12 11 14 15 10" />
        </svg>
      );
    case 'coordinator':
      return (
        <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" /><line x1="12" y1="3" x2="12" y2="9" /><line x1="12" y1="15" x2="12" y2="21" /><line x1="3" y1="12" x2="9" y2="12" /><line x1="15" y1="12" x2="21" y2="12" />
        </svg>
      );
    default:
      return null;
  }
}

