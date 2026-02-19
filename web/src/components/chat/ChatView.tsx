import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage, VoiceState, VoiceMode } from '../../types';
import type { ChatSessionInfo } from '../../hooks/useChat';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { VoiceOverlay } from './VoiceOverlay';

interface ChatViewProps {
  messages: ChatMessage[];
  isTyping: boolean;
  onSend: (content: string, attachments?: File[]) => void;
  connected: boolean;
  voiceState?: VoiceState;
  voiceTranscript?: string;
  voiceMode?: VoiceMode;
  onVoiceToggle?: () => void;
  onVoiceModeChange?: (mode: VoiceMode) => void;
  onPushToTalkStart?: () => void;
  onPushToTalkStop?: () => void;
  theme?: 'light' | 'dark';
  onToggleTheme?: () => void;
  chatSessions?: ChatSessionInfo[];
  activeSessionId?: string | null;
  onSelectSession?: (sessionId: string) => void;
  onNewChat?: () => void;
}

export function ChatView({
  messages,
  isTyping,
  onSend,
  connected,
  voiceState = 'inactive',
  voiceTranscript = '',
  voiceMode = 'vad',
  onVoiceToggle,
  onVoiceModeChange,
  onPushToTalkStart,
  onPushToTalkStop,
  theme = 'light',
  onToggleTheme,
  chatSessions = [],
  activeSessionId,
  onSelectSession,
  onNewChat,
}: ChatViewProps) {
  const isDark = theme === 'dark';
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sessionsOpen, setSessionsOpen] = useState(false);
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

  // Keyboard shortcut: Cmd/Ctrl+F opens search, Escape closes
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

  // ── Welcome / landing state ──
  if (isEmpty) {
    return (
      <div className="relative flex flex-col h-full bg-surface">
        {/* Spacer pushes content to center */}
        <div className="flex-1" />

        {/* Logo + wordmark */}
        <div className="flex flex-col items-center gap-4 px-6 animate-welcome-in">
          <img src="/assets/agenc-logo.svg" alt="AgenC" className="w-16 h-16 dark:hidden" />
          <img src="/assets/agenc-logo-white.svg" alt="AgenC" className="w-16 h-16 hidden dark:block" />
          <img src="/assets/agenc-wordmark.svg" alt="AgenC" className="h-6 dark:invert" />
        </div>

        {/* Input */}
        <div className="mt-8 px-4 md:px-6 animate-welcome-in" style={{ animationDelay: '0.15s' }}>
          <div className="animate-input-glow rounded-2xl">
            <ChatInput
              onSend={onSend}
              disabled={!connected}
              voiceState={voiceState}
              voiceMode={voiceMode}
              onVoiceToggle={onVoiceToggle}
              onPushToTalkStart={onPushToTalkStart}
              onPushToTalkStop={onPushToTalkStop}
            />
          </div>
        </div>

        {/* Spacer below (slightly larger so it sits above center) */}
        <div className="flex-[1.4]" />

        {/* Voice overlay */}
        {onVoiceModeChange && onVoiceToggle && (
          <VoiceOverlay
            voiceState={voiceState}
            transcript={voiceTranscript}
            mode={voiceMode}
            onModeChange={onVoiceModeChange}
            onStop={onVoiceToggle}
            onPushToTalkStart={onPushToTalkStart}
            onPushToTalkStop={onPushToTalkStop}
          />
        )}
      </div>
    );
  }

  // ── Active chat state ──
  return (
    <div className="relative flex flex-col h-full bg-surface animate-chat-enter">
      {/* Top header bar — hidden on mobile (MobileHeader used instead) */}
      <div className="hidden md:flex items-center justify-between px-6 py-4 border-b border-tetsuo-200 bg-surface">
        <h1 className="text-xl font-bold text-tetsuo-800 tracking-tight">
          AgenC 1.0
        </h1>
        <div className="flex items-center gap-1">
          <button
            onClick={onToggleTheme}
            className="w-9 h-9 rounded-lg flex items-center justify-center text-tetsuo-400 hover:text-tetsuo-600 hover:bg-tetsuo-100 transition-colors"
            title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {isDark ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
              </svg>
            )}
          </button>
          <button
            onClick={toggleSearch}
            className={`w-9 h-9 rounded-lg flex items-center justify-center transition-colors ${searchOpen ? 'text-accent bg-accent-bg' : 'text-tetsuo-400 hover:text-tetsuo-600 hover:bg-tetsuo-100'}`}
            title="Search messages (⌘F)"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          </button>
          <button className="ml-2 flex items-center gap-2 px-4 py-2 rounded-lg border border-tetsuo-200 text-sm font-medium text-tetsuo-700 hover:bg-tetsuo-50 transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Download App
          </button>
        </div>
      </div>

      {/* Search bar */}
      {searchOpen && (
        <div className="flex items-center gap-3 px-4 py-2.5 border-b border-tetsuo-200 bg-tetsuo-50/50">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-tetsuo-400 shrink-0" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search messages..."
            className="flex-1 bg-transparent text-sm text-tetsuo-700 placeholder:text-tetsuo-400 outline-none"
          />
          {searchQuery.trim() && (
            <span className="text-xs text-tetsuo-400 shrink-0">
              {matchCount} match{matchCount !== 1 ? 'es' : ''}
            </span>
          )}
          <button
            onClick={toggleSearch}
            className="w-6 h-6 rounded flex items-center justify-center text-tetsuo-400 hover:text-tetsuo-600 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      )}

      {/* Mobile-only: Recent Chats button */}
      <div className="flex lg:hidden items-center justify-between px-4 py-2 border-b border-tetsuo-200 bg-tetsuo-50/50">
        <button
          onClick={() => setSessionsOpen(true)}
          className="flex items-center gap-2 text-sm text-tetsuo-500 hover:text-tetsuo-700 transition-colors"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 8v4l3 3" /><circle cx="12" cy="12" r="10" />
          </svg>
          Recent Chats {chatSessions.length > 0 && <span className="text-xs text-tetsuo-400">({chatSessions.length})</span>}
        </button>
        {onNewChat && (
          <button
            onClick={onNewChat}
            className="flex items-center gap-1.5 text-xs font-medium text-accent hover:text-accent/80 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
            New Chat
          </button>
        )}
      </div>

      <MessageList messages={messages} isTyping={isTyping} theme={theme} searchQuery={searchQuery} />
      <ChatInput
        onSend={onSend}
        disabled={!connected}
        voiceState={voiceState}
        voiceMode={voiceMode}
        onVoiceToggle={onVoiceToggle}
        onPushToTalkStart={onPushToTalkStart}
        onPushToTalkStop={onPushToTalkStop}
      />

      {/* Voice overlay */}
      {onVoiceModeChange && onVoiceToggle && (
        <VoiceOverlay
          voiceState={voiceState}
          transcript={voiceTranscript}
          mode={voiceMode}
          onModeChange={onVoiceModeChange}
          onStop={onVoiceToggle}
          onPushToTalkStart={onPushToTalkStart}
          onPushToTalkStop={onPushToTalkStop}
        />
      )}

      {/* Mobile sessions bottom sheet */}
      {sessionsOpen && (
        <div className="absolute inset-0 z-50 lg:hidden flex flex-col justify-end">
          <div className="absolute inset-0 bg-black/40" onClick={() => setSessionsOpen(false)} />
          <div className="relative bg-surface rounded-t-2xl border-t border-tetsuo-200 max-h-[70vh] flex flex-col animate-slide-up">
            <div className="flex items-center justify-between px-5 py-4 border-b border-tetsuo-200">
              <span className="text-sm font-bold text-tetsuo-800">Recent Chats</span>
              <button onClick={() => setSessionsOpen(false)} className="w-8 h-8 rounded-lg flex items-center justify-center text-tetsuo-400 hover:text-tetsuo-600 hover:bg-tetsuo-100 transition-colors">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {chatSessions.length === 0 ? (
                <div className="px-5 py-8 text-sm text-tetsuo-400 text-center">No conversations yet</div>
              ) : (
                chatSessions.map((session) => {
                  const isActive = session.sessionId === activeSessionId;
                  return (
                    <button
                      key={session.sessionId}
                      onClick={() => { onSelectSession?.(session.sessionId); setSessionsOpen(false); }}
                      className={`w-full flex items-center gap-3 px-5 py-3.5 text-left transition-all duration-200 ${isActive ? 'bg-accent-bg' : 'hover:bg-tetsuo-50 active:bg-tetsuo-100'}`}
                    >
                      {isActive && <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />}
                      <div className="min-w-0 flex-1">
                        <div className={`text-sm truncate ${isActive ? 'text-accent font-medium' : 'text-tetsuo-600'}`}>{session.label}</div>
                        <div className="text-xs text-tetsuo-400 mt-0.5">
                          {session.messageCount} messages · {new Date(session.lastActiveAt).toLocaleString()}
                        </div>
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
