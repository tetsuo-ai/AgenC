import type { ChatMessage, VoiceState, VoiceMode } from '../../types';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { VoiceIndicator } from './VoiceIndicator';

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
}: ChatViewProps) {
  const isDark = theme === 'dark';

  return (
    <div className="flex flex-col h-full bg-surface">
      {/* Top header bar — hidden on mobile (MobileHeader used instead) */}
      <div className="hidden md:flex items-center justify-between px-6 py-4 border-b border-tetsuo-200 bg-surface">
        {/* Left: title */}
        <h1 className="text-xl font-bold text-tetsuo-800 tracking-tight">
          AgenC 1.0
        </h1>

        {/* Right: action buttons */}
        <div className="flex items-center gap-1">
          {/* Theme toggle */}
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
          {/* Search */}
          <button className="w-9 h-9 rounded-lg flex items-center justify-center text-tetsuo-400 hover:text-tetsuo-600 hover:bg-tetsuo-100 transition-colors" title="Search">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          </button>
          {/* Download App button */}
          <button className="ml-2 flex items-center gap-2 px-4 py-2 rounded-lg border border-tetsuo-200 text-sm font-medium text-tetsuo-700 hover:bg-tetsuo-50 transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Download App
          </button>
        </div>
      </div>

      {onVoiceModeChange && (
        <VoiceIndicator
          voiceState={voiceState}
          transcript={voiceTranscript}
          mode={voiceMode}
          onModeChange={onVoiceModeChange}
        />
      )}

      <MessageList messages={messages} isTyping={isTyping} theme={theme} />
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
  );
}
