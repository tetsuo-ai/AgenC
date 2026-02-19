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
      : 'bg-tetsuo-400';

  return (
    <div className="flex items-center gap-3 px-6 py-2.5 bg-tetsuo-50 border-b border-tetsuo-200 text-xs">
      <div className="flex items-center gap-2 shrink-0">
        <span className={`inline-block w-2 h-2 rounded-full ${stateColor} animate-pulse`} />
        <span className="text-tetsuo-600 font-medium">
          {STATE_LABELS[voiceState]}
        </span>
      </div>

      {transcript && (
        <span className="text-tetsuo-500 truncate flex-1 min-w-0">
          {transcript}
        </span>
      )}

      <button
        onClick={() => onModeChange(mode === 'vad' ? 'push-to-talk' : 'vad')}
        className="shrink-0 px-2.5 py-1 rounded-lg border border-tetsuo-200 text-tetsuo-500 hover:text-tetsuo-700 hover:border-tetsuo-300 transition-colors"
      >
        {mode === 'vad' ? 'VAD' : 'PTT'}
      </button>
    </div>
  );
}
