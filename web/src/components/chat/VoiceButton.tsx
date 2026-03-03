import type { VoiceState, VoiceMode } from '../../types';

interface VoiceButtonProps {
  voiceState: VoiceState;
  mode: VoiceMode;
  onToggle: () => void;
  onPushToTalkStart?: () => void;
  onPushToTalkStop?: () => void;
  disabled?: boolean;
}

export function VoiceButton({
  voiceState,
  mode,
  onToggle,
  onPushToTalkStart,
  onPushToTalkStop,
  disabled,
}: VoiceButtonProps) {
  const isActive = voiceState !== 'inactive';
  const isPTT = mode === 'push-to-talk' && isActive;

  const label = isActive ? '[MIC ON]' : '[MIC]';
  const color = isActive ? 'text-bbs-green' : 'text-bbs-gray hover:text-bbs-white';

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
      className={`text-xs font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${color}`}
    >
      {label}
    </button>
  );
}
