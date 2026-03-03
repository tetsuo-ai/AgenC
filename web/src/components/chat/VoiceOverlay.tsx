import { useEffect, useState } from 'react';
import type { VoiceState, VoiceMode } from '../../types';

interface VoiceOverlayProps {
  voiceState: VoiceState;
  transcript: string;
  mode: VoiceMode;
  onModeChange: (mode: VoiceMode) => void;
  onStop: () => void;
  onPushToTalkStart?: () => void;
  onPushToTalkStop?: () => void;
  delegationTask?: string;
}

const STATE_LABELS: Record<VoiceState, { text: string; color: string }> = {
  inactive: { text: '', color: 'text-bbs-gray' },
  connecting: { text: '[CONNECTING...]', color: 'text-bbs-yellow animate-pulse' },
  listening: { text: '[MIC]', color: 'text-bbs-green' },
  speaking: { text: '[SPK]', color: 'text-bbs-cyan' },
  processing: { text: '[...]', color: 'text-bbs-yellow animate-pulse' },
  delegating: { text: '[WORK]', color: 'text-bbs-purple animate-pulse' },
};

export function VoiceOverlay({
  voiceState,
  transcript,
  mode,
  onModeChange,
  onStop,
  onPushToTalkStart,
  onPushToTalkStop,
  delegationTask,
}: VoiceOverlayProps) {
  const [visible, setVisible] = useState(false);
  const [rendering, setRendering] = useState(false);

  const isActive = voiceState !== 'inactive';

  useEffect(() => {
    if (isActive) {
      setRendering(true);
      const id = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(id);
    } else {
      setVisible(false);
      const t = setTimeout(() => setRendering(false), 200);
      return () => clearTimeout(t);
    }
  }, [isActive]);

  if (!rendering) return null;

  const stateLabel = STATE_LABELS[voiceState] || STATE_LABELS.inactive;
  const displayText = voiceState === 'delegating'
    ? (transcript || delegationTask || '')
    : transcript;

  return (
    <div
      className={`
        shrink-0 border-t border-bbs-border bg-bbs-surface
        overflow-hidden transition-all duration-200 ease-out
        ${visible ? 'max-h-16 opacity-100 animate-voice-bar-in' : 'max-h-0 opacity-0'}
      `}
    >
      <div className="flex items-center gap-3 px-4 h-10">
        {/* State indicator */}
        <span className={`text-xs font-bold shrink-0 ${stateLabel.color}`}>
          {stateLabel.text}
        </span>

        {/* Transcript — single line, truncated */}
        <span className="flex-1 min-w-0 text-xs text-bbs-lightgray truncate font-mono">
          {displayText}
        </span>

        {/* Controls */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => onModeChange(mode === 'vad' ? 'push-to-talk' : 'vad')}
            className="text-xs text-bbs-gray hover:text-bbs-white transition-colors"
          >
            [{mode === 'vad' ? 'VAD' : 'PTT'}]
          </button>

          {mode === 'push-to-talk' && (
            <button
              onMouseDown={onPushToTalkStart}
              onMouseUp={onPushToTalkStop}
              onMouseLeave={onPushToTalkStop}
              onTouchStart={onPushToTalkStart}
              onTouchEnd={onPushToTalkStop}
              className="text-xs text-bbs-gray hover:text-bbs-white transition-colors select-none"
            >
              [HOLD]
            </button>
          )}

          <button
            onClick={onStop}
            className="text-xs text-bbs-red hover:text-bbs-white font-bold transition-colors"
            title="Stop voice"
          >
            [X]
          </button>
        </div>
      </div>
    </div>
  );
}
