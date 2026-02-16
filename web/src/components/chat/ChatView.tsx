import type { ChatMessage } from '../../types';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';

interface ChatViewProps {
  messages: ChatMessage[];
  isTyping: boolean;
  onSend: (content: string) => void;
  connected: boolean;
}

export function ChatView({ messages, isTyping, onSend, connected }: ChatViewProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-tetsuo-700">
        <h2 className="text-sm font-semibold text-tetsuo-200">Chat</h2>
      </div>

      <MessageList messages={messages} isTyping={isTyping} />
      <ChatInput onSend={onSend} disabled={!connected} />
    </div>
  );
}
