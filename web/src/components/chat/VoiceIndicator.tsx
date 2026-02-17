import type { VoiceState, VoiceMode } from '../../types';

interface VoiceIndicatorProps {
  voiceState: VoiceState;
  transcript: string;
  mode: VoiceMode;
  onModeChange: (mode: VoiceMode) => void;
}

const STATE_LABELS: Record<VoiceState, string> = {
  inactive: '',
  connecting: 'Connecting...',
  listening: 'Listening...',
  speaking: 'Speaking...',
  processing: 'Processing...',
};

/**
 * Status bar shown when voice is active.
 *
 * Displays voice state, running transcript, and mode toggle.
 */
export function VoiceIndicator({
  voiceState,
  transcript,
  mode,
  onModeChange,
}: VoiceIndicatorProps) {
  if (voiceState === 'inactive') return null;

  const stateColor =
    voiceState === 'listening'
      ? 'bg-green-500'
      : voiceState === 'speaking'
      ? 'bg-blue-500'
      : voiceState === 'processing'
      ? 'bg-amber-500'
      : 'bg-tetsuo-500';

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-tetsuo-800 border-b border-tetsuo-700 text-xs">
      {/* Status dot + label */}
      <div className="flex items-center gap-2 shrink-0">
        <span className={`inline-block w-2 h-2 rounded-full ${stateColor} animate-pulse`} />
        <span className="text-tetsuo-300 font-medium">
          {STATE_LABELS[voiceState]}
        </span>
      </div>

      {/* Transcript */}
      {transcript && (
        <span className="text-tetsuo-400 truncate flex-1 min-w-0">
          {transcript}
        </span>
      )}

      {/* Mode toggle */}
      <button
        onClick={() => onModeChange(mode === 'vad' ? 'push-to-talk' : 'vad')}
        className="shrink-0 px-2 py-0.5 rounded border border-tetsuo-600 text-tetsuo-400 hover:text-tetsuo-200 hover:border-tetsuo-500 transition-colors"
      >
        {mode === 'vad' ? 'VAD' : 'PTT'}
      </button>
    </div>
  );
}
