import type { VoiceState, VoiceMode } from '../../types';

interface VoiceButtonProps {
  voiceState: VoiceState;
  mode: VoiceMode;
  onToggle: () => void;
  onPushToTalkStart?: () => void;
  onPushToTalkStop?: () => void;
  disabled?: boolean;
}

/**
 * Mic toggle button with visual state indicators.
 *
 * - Inactive: grey mic icon
 * - Listening: pulsing green ring
 * - Speaking: animated blue ring
 * - Processing: amber pulse
 */
export function VoiceButton({
  voiceState,
  mode,
  onToggle,
  onPushToTalkStart,
  onPushToTalkStop,
  disabled,
}: VoiceButtonProps) {
  const isActive = voiceState !== 'inactive';
  const isListening = voiceState === 'listening';
  const isSpeaking = voiceState === 'speaking';
  const isProcessing = voiceState === 'processing';
  const isConnecting = voiceState === 'connecting';

  const ringColor = isSpeaking
    ? 'ring-blue-400'
    : isListening
    ? 'ring-green-400'
    : isProcessing
    ? 'ring-amber-400'
    : isConnecting
    ? 'ring-tetsuo-400'
    : '';

  const pulseClass = (isListening || isSpeaking || isProcessing)
    ? 'animate-pulse'
    : '';

  const bgColor = isActive
    ? 'bg-red-600 hover:bg-red-700'
    : 'bg-tetsuo-700 hover:bg-tetsuo-600';

  // In PTT mode, use mouse/touch events for press-and-hold
  const isPTT = mode === 'push-to-talk' && isActive;

  return (
    <button
      onClick={isPTT ? undefined : onToggle}
      onMouseDown={isPTT ? onPushToTalkStart : undefined}
      onMouseUp={isPTT ? onPushToTalkStop : undefined}
      onMouseLeave={isPTT ? onPushToTalkStop : undefined}
      onTouchStart={isPTT ? onPushToTalkStart : undefined}
      onTouchEnd={isPTT ? onPushToTalkStop : undefined}
      disabled={disabled}
      title={
        isPTT
          ? 'Hold to talk'
          : isActive
          ? 'Stop voice'
          : 'Start voice'
      }
      className={`
        relative flex items-center justify-center
        w-10 h-10 rounded-lg text-sm transition-colors
        ${bgColor}
        ${isActive ? `ring-2 ${ringColor} ${pulseClass}` : ''}
        disabled:opacity-50 disabled:cursor-not-allowed
      `}
    >
      <MicIcon active={isActive} />
    </button>
  );
}

function MicIcon({ active }: { active: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke={active ? 'white' : '#9ca3af'}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" x2="12" y1="19" y2="22" />
    </svg>
  );
}
