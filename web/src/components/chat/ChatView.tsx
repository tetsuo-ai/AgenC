import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, TokenUsage, VoiceState, VoiceMode } from '../../types';

import type { ChatSessionInfo } from '../../hooks/useChat';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { VoiceOverlay } from './VoiceOverlay';
import { DesktopPanel } from './DesktopPanel';

interface ChatViewProps {
  messages: ChatMessage[];
  isTyping: boolean;
  onSend: (content: string, attachments?: File[]) => void;
  onStop?: () => void;
  connected: boolean;
  voiceState?: VoiceState;
  voiceTranscript?: string;
  voiceMode?: VoiceMode;
  onVoiceToggle?: () => void;
  onVoiceModeChange?: (mode: VoiceMode) => void;
  onPushToTalkStart?: () => void;
  onPushToTalkStop?: () => void;
  delegationTask?: string;
  theme?: 'light' | 'dark';
  onToggleTheme?: () => void;
  chatSessions?: ChatSessionInfo[];
  activeSessionId?: string | null;
  onSelectSession?: (sessionId: string) => void;
  onNewChat?: () => void;
  desktopUrl?: string | null;
  desktopOpen?: boolean;
  onToggleDesktop?: () => void;
  tokenUsage?: TokenUsage | null;
}

export function ChatView({
  messages,
  isTyping,
  onSend,
  onStop,
  connected,
  voiceState = 'inactive',
  voiceTranscript = '',
  voiceMode = 'vad',
  onVoiceToggle,
  onVoiceModeChange,
  onPushToTalkStart,
  onPushToTalkStop,
  delegationTask = '',
  theme = 'dark',
  chatSessions = [],
  activeSessionId,
  onSelectSession,
  onNewChat,
  desktopUrl,
  desktopOpen = false,
  onToggleDesktop,
  tokenUsage,
}: ChatViewProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [contextPanelOpen, setContextPanelOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const toggleSearch = useCallback(() => {
    setSearchOpen((prev) => {
      if (prev) setSearchQuery('');
      return !prev;
    });
  }, []);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        setSearchOpen(true);
      }
      if (e.key === 'Escape' && searchOpen) {
        setSearchOpen(false);
        setSearchQuery('');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [searchOpen]);

  const matchCount = searchQuery.trim()
    ? messages.filter((m) => m.content.toLowerCase().includes(searchQuery.trim().toLowerCase())).length
    : 0;

  const isEmpty = messages.length === 0 && !isTyping;
  const contextWindowTokens =
    tokenUsage && tokenUsage.contextWindowTokens && tokenUsage.contextWindowTokens > 0
      ? tokenUsage.contextWindowTokens
      : 0;
  const promptTokens =
    tokenUsage && tokenUsage.promptTokens && tokenUsage.promptTokens > 0
      ? tokenUsage.promptTokens
      : tokenUsage?.totalTokens ?? 0;
  const contextUsageRatio = contextWindowTokens > 0
    ? promptTokens / contextWindowTokens
    : 0;
  const sessionBudgetTokens =
    tokenUsage && tokenUsage.budget > 0
      ? tokenUsage.budget
      : 0;
  const sessionBudgetRatio = sessionBudgetTokens > 0
    ? (tokenUsage?.totalTokens ?? 0) / sessionBudgetTokens
    : 0;
  const hasModelContextWindow = contextWindowTokens > 0;
  const displayUsedTokens = hasModelContextWindow
    ? promptTokens
    : tokenUsage?.totalTokens ?? 0;
  const displayTotalTokens = hasModelContextWindow
    ? contextWindowTokens
    : sessionBudgetTokens;
  const displayRatio = hasModelContextWindow
    ? contextUsageRatio
    : sessionBudgetRatio;
  const displayPercent = displayRatio * 100;
  const contextUsageLabel =
    displayUsedTokens > 0 && displayPercent < 1
      ? '<1%'
      : `${Math.round(displayPercent)}%`;
  const contextBarPercent = Math.min(100, Math.max(0, displayPercent));

  // BBS-style context bar
  const contextBarFilled = Math.round(contextBarPercent / 100 * 30);
  const contextBarEmpty = 30 - contextBarFilled;
  const contextBarStr = '\u2588'.repeat(contextBarFilled) + '\u2591'.repeat(contextBarEmpty);

  const delegationSummary = useMemo(() => {
    const latestSubagentMessage = [...messages]
      .reverse()
      .find((message) => (message.subagents?.length ?? 0) > 0);
    if (!latestSubagentMessage?.subagents?.length) return null;

    const bySession = new Map<string, string>();
    for (const subagent of latestSubagentMessage.subagents) {
      const id = subagent.subagentSessionId;
      if (!id || id === '__synthesis__') continue;
      bySession.set(id, subagent.status);
    }
    if (bySession.size === 0) return null;

    let running = 0;
    let failed = 0;
    let completed = 0;
    for (const status of bySession.values()) {
      if (status === 'running' || status === 'started' || status === 'spawned' || status === 'planned') {
        running += 1;
      } else if (status === 'failed' || status === 'cancelled') {
        failed += 1;
      } else if (status === 'completed' || status === 'synthesized') {
        completed += 1;
      }
    }

    return { total: bySession.size, running, failed, completed };
  }, [messages]);

  // ── Welcome / splash state ──
  if (isEmpty) {
    const splashLabel = connected
      ? 'R E A D Y'
      : 'C O N N E C T I N G   T O   A G E N C';
    const splashHint = connected
      ? 'type a message to begin...'
      : 'initializing agent runtime...';
    const progressFilled = connected ? 28 : 0;
    const progressEmpty = 28 - progressFilled;
    const progressPercent = connected ? '100' : '0';

    return (
      <div className="relative flex flex-col h-full bg-bbs-black">
        <div className="flex-1" />

        {/* BBS splash */}
        <div className="flex flex-col items-center gap-6 px-6 animate-welcome-in">
          <img
            src="/assets/ansi_girl.png"
            alt="AgenC"
            className="max-w-[300px] w-full h-auto pixelated"
            style={{ imageRendering: 'auto' }}
          />
          <div className={`text-sm tracking-[6px] font-bold ${connected ? 'text-bbs-green' : 'text-bbs-purple'}`}>
            {splashLabel}
          </div>
          <div className="w-full max-w-md">
            <div className="text-bbs-pink font-mono text-xs">
              {connected
                ? `[${'\u2588'.repeat(progressFilled)}${'\u2591'.repeat(progressEmpty)}] ${progressPercent}%`
                : <>[<span className="animate-bbs-progress inline-block overflow-hidden whitespace-nowrap" style={{ maxWidth: '100%' }}>{'\u2588'.repeat(28)}</span>{'\u2591'.repeat(28)}]</>
              }
            </div>
          </div>
          <div className="text-bbs-gray text-xs">
            {splashHint}
          </div>
        </div>

        {/* Input */}
        <div className="mt-8 px-4 md:px-6 animate-welcome-in" style={{ animationDelay: '0.15s' }}>
          <ChatInput
            onSend={onSend}
            onStop={onStop}
            isGenerating={isTyping}
            voiceState={voiceState}
            voiceMode={voiceMode}
            onVoiceToggle={onVoiceToggle}
            onPushToTalkStart={onPushToTalkStart}
            onPushToTalkStop={onPushToTalkStop}
          />
        </div>

        {/* Voice bar */}
        {onVoiceModeChange && onVoiceToggle && (
          <VoiceOverlay
            voiceState={voiceState}
            transcript={voiceTranscript}
            mode={voiceMode}
            onModeChange={onVoiceModeChange}
            onStop={onVoiceToggle}
            onPushToTalkStart={onPushToTalkStart}
            onPushToTalkStop={onPushToTalkStop}
            delegationTask={delegationTask}
          />
        )}

        <div className="flex-[1.4]" />
      </div>
    );
  }

  // ── Active chat state ──
  return (
    <div className="relative flex flex-col h-full bg-bbs-black animate-chat-enter">
      {/* Search bar */}
      {searchOpen && (
        <div className="flex items-center gap-3 px-4 py-2 border-b border-bbs-border bg-bbs-surface">
          <span className="text-bbs-purple text-xs shrink-0">SEARCH{'>'}</span>
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="___"
            className="flex-1 bg-transparent text-xs text-bbs-white placeholder:text-bbs-gray outline-none font-mono"
          />
          {searchQuery.trim() && (
            <span className="text-xs text-bbs-gray shrink-0">
              {matchCount} match{matchCount !== 1 ? 'es' : ''}
            </span>
          )}
          <button
            onClick={toggleSearch}
            className="text-xs text-bbs-gray hover:text-bbs-white transition-colors"
          >
            [X]
          </button>
        </div>
      )}

      {/* Mobile-only: Recent Chats + delegation info */}
      <div className="flex lg:hidden flex-col gap-1 px-4 py-2 border-b border-bbs-border bg-bbs-surface">
        <div className="flex items-center justify-between">
          <button
            onClick={() => setSessionsOpen(true)}
            className="text-xs text-bbs-gray hover:text-bbs-white transition-colors"
          >
            [SESSIONS] {chatSessions.length > 0 && `(${chatSessions.length})`}
          </button>
          <div className="flex items-center gap-3">
            {onNewChat && (
              <button
                onClick={onNewChat}
                className="text-xs text-bbs-purple hover:text-bbs-white transition-colors"
              >
                [NEW]
              </button>
            )}
            {desktopUrl && onToggleDesktop && (
              <button
                onClick={onToggleDesktop}
                className={`text-xs transition-colors ${desktopOpen ? 'text-bbs-green' : 'text-bbs-gray hover:text-bbs-white'}`}
              >
                [DESKTOP]
              </button>
            )}
            <button
              onClick={toggleSearch}
              className={`text-xs transition-colors ${searchOpen ? 'text-bbs-purple' : 'text-bbs-gray hover:text-bbs-white'}`}
            >
              [SEARCH]
            </button>
          </div>
        </div>
        {delegationSummary && (
          <span className="text-xs text-bbs-cyan">
            [{delegationSummary.total} agents: {delegationSummary.running > 0 ? `${delegationSummary.running} running` : `${delegationSummary.completed} done`}]
          </span>
        )}
      </div>

      {/* Desktop-only controls row */}
      <div className="hidden md:flex items-center justify-between px-4 py-1.5 border-b border-bbs-border bg-bbs-surface">
        <div className="flex items-center gap-4">
          {delegationSummary && (
            <span className="text-xs text-bbs-cyan">
              [{delegationSummary.total} agents: {delegationSummary.running > 0 ? `${delegationSummary.running} running` : `${delegationSummary.completed} done`}]
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {desktopUrl && onToggleDesktop && (
            <button
              onClick={onToggleDesktop}
              className={`text-xs transition-colors ${desktopOpen ? 'text-bbs-green' : 'text-bbs-gray hover:text-bbs-white'}`}
            >
              [{desktopOpen ? 'HIDE' : 'SHOW'} DESKTOP]
            </button>
          )}
          <button
            onClick={toggleSearch}
            className={`text-xs transition-colors ${searchOpen ? 'text-bbs-purple' : 'text-bbs-gray hover:text-bbs-white'}`}
          >
            [SEARCH]
          </button>
        </div>
      </div>

      {/* Message list + optional desktop panel */}
      <div className="flex-1 min-h-0 flex">
        <MessageList messages={messages} isTyping={isTyping} theme={theme} searchQuery={searchQuery} />
        {desktopOpen && desktopUrl && (
          <div className="hidden md:block w-[55%] min-w-[480px] h-full shrink-0">
            <DesktopPanel vncUrl={desktopUrl} onClose={onToggleDesktop!} />
          </div>
        )}
      </div>

      {/* Voice bar */}
      {onVoiceModeChange && onVoiceToggle && (
        <VoiceOverlay
          voiceState={voiceState}
          transcript={voiceTranscript}
          mode={voiceMode}
          onModeChange={onVoiceModeChange}
          onStop={onVoiceToggle}
          onPushToTalkStart={onPushToTalkStart}
          onPushToTalkStop={onPushToTalkStop}
          delegationTask={delegationTask}
        />
      )}

      {/* Context usage bar */}
      {tokenUsage && displayTotalTokens > 0 && (
        <div className="relative px-4 py-1.5 border-t border-bbs-border bg-bbs-surface">
          <div className="flex items-center justify-between">
            <button
              onClick={() => setContextPanelOpen((prev) => !prev)}
              className="text-xs text-bbs-purple hover:text-bbs-white transition-colors font-mono"
            >
              CONTEXT [{contextBarStr}] {contextUsageLabel}
            </button>
          </div>

          {contextPanelOpen && (
            <div className="absolute bottom-[40px] right-4 z-20 w-[min(420px,calc(100vw-2rem))] border border-bbs-border bg-bbs-dark p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-bold text-bbs-white">
                    {hasModelContextWindow ? 'Model Context Window' : 'Session Token Budget'}
                  </p>
                  <p className="text-xs text-bbs-gray">
                    {displayUsedTokens.toLocaleString()} / {displayTotalTokens.toLocaleString()} tokens
                  </p>
                </div>
                <span className="text-xs font-mono text-bbs-purple">{contextUsageLabel}</span>
              </div>

              <div className="mt-2 text-xs font-mono text-bbs-pink">
                [{contextBarStr}]
              </div>

              <div className="mt-3 space-y-1">
                {tokenUsage.sections && tokenUsage.sections.length > 0 ? (
                  tokenUsage.sections.map((section) => (
                    <div key={section.id} className="flex items-center justify-between text-xs">
                      <span className="text-bbs-lightgray">{section.label}</span>
                      <span className="font-mono text-bbs-gray">
                        {section.percent.toFixed(section.percent >= 10 ? 0 : 1)}% - {section.tokens.toLocaleString()}
                      </span>
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-bbs-gray">
                    Section breakdown appears after the next model response.
                  </p>
                )}
              </div>

              {tokenUsage.compacted && (
                <p className="mt-2 text-xs text-bbs-yellow">
                  * Context was auto-compacted to stay within budget.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      <ChatInput
        onSend={onSend}
        onStop={onStop}
        isGenerating={isTyping}
        voiceState={voiceState}
        voiceMode={voiceMode}
        onVoiceToggle={onVoiceToggle}
        onPushToTalkStart={onPushToTalkStart}
        onPushToTalkStop={onPushToTalkStop}
      />

      {/* Mobile sessions bottom sheet */}
      {sessionsOpen && (
        <div className="absolute inset-0 z-50 lg:hidden flex flex-col justify-end">
          <div className="absolute inset-0 bg-black/60" onClick={() => setSessionsOpen(false)} />
          <div className="relative bg-bbs-dark border-t border-bbs-border max-h-[70vh] flex flex-col animate-slide-up">
            <div className="flex items-center justify-between px-4 py-3 border-b border-bbs-border">
              <span className="text-xs font-bold text-bbs-white">RECENT SESSIONS</span>
              <button onClick={() => setSessionsOpen(false)} className="text-xs text-bbs-gray hover:text-bbs-white">[X]</button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {chatSessions.length === 0 ? (
                <div className="px-4 py-8 text-xs text-bbs-gray text-center">No sessions</div>
              ) : (
                chatSessions.map((session) => {
                  const isActive = session.sessionId === activeSessionId;
                  return (
                    <button
                      key={session.sessionId}
                      onClick={() => { onSelectSession?.(session.sessionId); setSessionsOpen(false); }}
                      className={`w-full text-left px-4 py-3 text-xs transition-colors border-b border-bbs-border/50 ${
                        isActive ? 'bg-bbs-surface text-bbs-purple' : 'text-bbs-lightgray hover:bg-bbs-surface'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        {isActive && <span className="text-bbs-purple">{'>'}</span>}
                        <span className="truncate">{session.label}</span>
                      </div>
                      <div className="text-bbs-gray mt-0.5 ml-4">
                        {session.messageCount} msgs - {new Date(session.lastActiveAt).toLocaleString()}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
