import type { ChatMessage, VoiceState, VoiceMode } from '../../types';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { VoiceIndicator } from './VoiceIndicator';

interface ChatViewProps {
  messages: ChatMessage[];
  isTyping: boolean;
  onSend: (content: string) => void;
  connected: boolean;
  voiceState?: VoiceState;
  voiceTranscript?: string;
  voiceMode?: VoiceMode;
  onVoiceToggle?: () => void;
  onVoiceModeChange?: (mode: VoiceMode) => void;
  onPushToTalkStart?: () => void;
  onPushToTalkStop?: () => void;
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
}: ChatViewProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-tetsuo-700">
        <h2 className="text-sm font-semibold text-tetsuo-200">Chat</h2>
      </div>

      {onVoiceModeChange && (
        <VoiceIndicator
          voiceState={voiceState}
          transcript={voiceTranscript}
          mode={voiceMode}
          onModeChange={onVoiceModeChange}
        />
      )}

      <MessageList messages={messages} isTyping={isTyping} />
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
