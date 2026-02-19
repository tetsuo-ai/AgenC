import { useCallback, useEffect, useRef, useState } from 'react';
import type { VoiceState, VoiceMode } from '../../types';
import { VoiceButton } from './VoiceButton';

interface ChatInputProps {
  onSend: (content: string) => void;
  disabled?: boolean;
  voiceState?: VoiceState;
  voiceMode?: VoiceMode;
  onVoiceToggle?: () => void;
  onPushToTalkStart?: () => void;
  onPushToTalkStop?: () => void;
}

export function ChatInput({
  onSend,
  disabled,
  voiceState = 'inactive',
  voiceMode = 'vad',
  onVoiceToggle,
  onPushToTalkStart,
  onPushToTalkStop,
}: ChatInputProps) {
  const [value, setValue] = useState('');
  const [showEmoji, setShowEmoji] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const emojiRef = useRef<HTMLDivElement>(null);

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue('');

    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [value, disabled, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const handleInput = useCallback(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    }
  }, []);

  const insertEmoji = useCallback((emoji: string) => {
    setValue((v) => v + emoji);
    setShowEmoji(false);
    textareaRef.current?.focus();
  }, []);

  // Close emoji picker on outside click
  useEffect(() => {
    if (!showEmoji) return;
    const handler = (e: MouseEvent) => {
      if (emojiRef.current && !emojiRef.current.contains(e.target as Node)) {
        setShowEmoji(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showEmoji]);

  return (
    <div className="px-3 pb-3 md:px-6 md:pb-5">
      {/* Input container */}
      <div className="border border-tetsuo-200 rounded-2xl bg-surface shadow-sm overflow-visible relative">
        {/* Top row: attachment icon + textarea */}
        <div className="flex items-start gap-3 px-4 pt-4 pb-2">
          {/* Attachment icon */}
          <div className="shrink-0 mt-0.5 text-accent">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </div>

          {/* Textarea */}
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            placeholder="Message to AgenC..."
            disabled={disabled}
            rows={2}
            className="flex-1 text-sm text-tetsuo-900 resize-none focus:outline-none placeholder:text-tetsuo-500 disabled:opacity-50 bg-transparent leading-relaxed caret-tetsuo-900"
          />
        </div>

        {/* Bottom row: emoji, mic, send */}
        <div className="flex items-center justify-end gap-2 px-4 pb-3">
          {/* Emoji */}
          <div className="relative" ref={emojiRef}>
            <button
              onClick={() => setShowEmoji((v) => !v)}
              className={`w-9 h-9 rounded-lg flex items-center justify-center transition-colors ${
                showEmoji ? 'text-accent bg-accent-bg' : 'text-tetsuo-400 hover:text-tetsuo-600 hover:bg-tetsuo-50'
              }`}
              title="Emoji"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <circle cx="12" cy="12" r="10" />
                <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                <line x1="9" y1="9" x2="9.01" y2="9" />
                <line x1="15" y1="9" x2="15.01" y2="9" />
              </svg>
            </button>
            {showEmoji && <EmojiPicker onSelect={insertEmoji} />}
          </div>

          {/* Mic / Voice */}
          {onVoiceToggle && (
            <VoiceButton
              voiceState={voiceState}
              mode={voiceMode}
              onToggle={onVoiceToggle}
              onPushToTalkStart={onPushToTalkStart}
              onPushToTalkStop={onPushToTalkStop}
              disabled={disabled}
            />
          )}

          {/* Send button — pill with text + arrow */}
          <button
            onClick={handleSubmit}
            disabled={disabled || !value.trim()}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-accent text-white text-sm font-medium hover:bg-accent-dark transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title="Send message"
          >
            Send
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
              <path d="M3.478 2.405a.75.75 0 0 0-.926.94l2.432 7.905H13.5a.75.75 0 0 1 0 1.5H4.984l-2.432 7.905a.75.75 0 0 0 .926.94 60.519 60.519 0 0 0 18.445-8.986.75.75 0 0 0 0-1.218A60.517 60.517 0 0 0 3.478 2.405z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Disclaimer */}
      <p className="text-center text-xs text-tetsuo-400 mt-3">
        AgenC can make mistakes. Check our Terms &amp; Conditions.
      </p>
    </div>
  );
}

const EMOJI_GROUPS: { label: string; emojis: string[] }[] = [
  { label: 'Smileys', emojis: ['😀','😂','🥹','😊','😎','🤔','😅','🙂','😍','🤩','😤','😭','🥳','😴','🤯','🫡'] },
  { label: 'Gestures', emojis: ['👍','👎','👏','🙌','🤝','✌️','🤞','💪','🫶','👋','🖐️','✋'] },
  { label: 'Objects', emojis: ['🔥','💡','⚡','🚀','💰','🎯','✅','❌','⭐','💎','🔑','🛡️'] },
  { label: 'Symbols', emojis: ['❤️','💜','💙','💚','🧡','🖤','💯','⚠️','🔔','📌','🏷️','📎'] },
];

function EmojiPicker({ onSelect }: { onSelect: (emoji: string) => void }) {
  return (
    <div className="absolute bottom-full right-0 mb-2 w-[280px] bg-surface border border-tetsuo-200 rounded-xl shadow-lg p-3 space-y-2 animate-panel-enter z-50">
      {EMOJI_GROUPS.map((group) => (
        <div key={group.label}>
          <div className="text-[10px] text-tetsuo-400 uppercase tracking-wider mb-1">{group.label}</div>
          <div className="flex flex-wrap gap-0.5">
            {group.emojis.map((emoji) => (
              <button
                key={emoji}
                onClick={() => onSelect(emoji)}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-lg hover:bg-tetsuo-100 transition-colors"
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
