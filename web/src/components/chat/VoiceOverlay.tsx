import { useEffect, useMemo, useRef, useState } from 'react';
import type { VoiceState, VoiceMode } from '../../types';

interface VoiceOverlayProps {
  voiceState: VoiceState;
  transcript: string;
  mode: VoiceMode;
  onModeChange: (mode: VoiceMode) => void;
  onStop: () => void;
  onPushToTalkStart?: () => void;
  onPushToTalkStop?: () => void;
}

const STATE_LABELS: Record<VoiceState, string> = {
  inactive: '',
  connecting: 'Connecting...',
  listening: 'Listening',
  speaking: 'Speaking',
  processing: 'Processing...',
};

const STATE_CONFIG: Record<
  Exclude<VoiceState, 'inactive'>,
  {
    orbBg: string;
    ringColor: string;
    glowColor: string;
    labelColor: string;
  }
> = {
  connecting: {
    orbBg: 'bg-tetsuo-400',
    ringColor: 'border-tetsuo-400',
    glowColor: 'rgba(148, 163, 184, 0.4)',
    labelColor: 'text-tetsuo-500',
  },
  listening: {
    orbBg: 'bg-green-500',
    ringColor: 'border-green-400',
    glowColor: 'rgba(34, 197, 94, 0.45)',
    labelColor: 'text-green-500',
  },
  speaking: {
    orbBg: 'bg-blue-500',
    ringColor: 'border-blue-400',
    glowColor: 'rgba(59, 130, 246, 0.45)',
    labelColor: 'text-blue-500',
  },
  processing: {
    orbBg: 'bg-amber-500',
    ringColor: 'border-amber-400',
    glowColor: 'rgba(245, 158, 11, 0.45)',
    labelColor: 'text-amber-500',
  },
};

export function VoiceOverlay({
  voiceState,
  transcript,
  mode,
  onModeChange,
  onStop,
  onPushToTalkStart,
  onPushToTalkStop,
}: VoiceOverlayProps) {
  const [visible, setVisible] = useState(false);
  const [rendering, setRendering] = useState(false);
  const transcriptRef = useRef<HTMLSpanElement>(null);

  const isActive = voiceState !== 'inactive';

  useEffect(() => {
    if (isActive) {
      setRendering(true);
      const id = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(id);
    } else {
      setVisible(false);
      const t = setTimeout(() => setRendering(false), 220);
      return () => clearTimeout(t);
    }
  }, [isActive]);

  if (!rendering) return null;

  const state = voiceState === 'inactive' ? 'connecting' : voiceState;
  const cfg = STATE_CONFIG[state];

  return (
    <div
      className={`
        shrink-0 border-t border-tetsuo-200 bg-tetsuo-50/80 backdrop-blur-sm
        overflow-hidden transition-all duration-200 ease-out
        ${visible ? 'max-h-16 opacity-100 animate-voice-bar-in' : 'max-h-0 opacity-0'}
      `}
    >
      <div className="flex items-center gap-3 px-4 h-14">
        {/* Mini orb */}
        <MiniVoiceOrb voiceState={state} cfg={cfg} />

        {/* State label */}
        <span className={`text-xs font-semibold uppercase tracking-[0.15em] ${cfg.labelColor} shrink-0 w-24`}>
          {STATE_LABELS[voiceState]}
        </span>

        {/* Transcript — single line, truncated */}
        <span
          ref={transcriptRef}
          className="flex-1 min-w-0 text-sm text-tetsuo-700 truncate"
        >
          {transcript && <TranscriptWords text={transcript} />}
        </span>

        {/* Controls row */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => onModeChange(mode === 'vad' ? 'push-to-talk' : 'vad')}
            className="px-3 py-1.5 rounded-lg border border-tetsuo-200 text-xs font-medium text-tetsuo-500 hover:text-tetsuo-700 hover:border-tetsuo-300 bg-surface transition-colors"
          >
            {mode === 'vad' ? 'VAD' : 'PTT'}
          </button>

          {mode === 'push-to-talk' && (
            <button
              onMouseDown={onPushToTalkStart}
              onMouseUp={onPushToTalkStop}
              onMouseLeave={onPushToTalkStop}
              onTouchStart={onPushToTalkStart}
              onTouchEnd={onPushToTalkStop}
              className="px-3 py-1.5 rounded-lg border-2 border-tetsuo-300 text-xs font-semibold text-tetsuo-600 bg-tetsuo-50 active:bg-tetsuo-200 transition-colors select-none"
            >
              Hold
            </button>
          )}

          <button
            onClick={onStop}
            className="w-8 h-8 rounded-full bg-red-500 hover:bg-red-600 active:scale-95 transition-all flex items-center justify-center shadow-sm shadow-red-500/20"
            title="Stop voice"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="white">
              <rect x="4" y="4" width="16" height="16" rx="2" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Word-by-word fade-in: recent words are bright, older ones dim

function TranscriptWords({ text }: { text: string }) {
  const words = useMemo(() => text.split(/\s+/).filter(Boolean), [text]);
  const total = words.length;
  const fadeWindow = 8;

  return (
    <>
      {words.map((word, i) => {
        const distFromEnd = total - 1 - i;
        const opacity = distFromEnd >= fadeWindow ? 1 : 0.35 + 0.65 * (1 - distFromEnd / fadeWindow);
        const isNew = distFromEnd < 3;
        return (
          <span
            key={`${i}-${word}`}
            className={isNew ? 'animate-word-in' : ''}
            style={{
              opacity,
              color: 'rgb(var(--tetsuo-800))',
              transition: 'opacity 0.3s ease',
            }}
          >
            {word}{' '}
          </span>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------

function MiniVoiceOrb({
  voiceState,
  cfg,
}: {
  voiceState: Exclude<VoiceState, 'inactive'>;
  cfg: typeof STATE_CONFIG[keyof typeof STATE_CONFIG];
}) {
  const glowFaint = cfg.glowColor.replace(/[\d.]+\)$/, '0.15)');

  return (
    <div className="relative flex items-center justify-center w-10 h-10 shrink-0">
      {/* State-specific ring effects */}
      {voiceState === 'listening' && (
        <span className={`absolute inset-0 rounded-full border ${cfg.ringColor} animate-ring-breathe`} />
      )}
      {voiceState === 'speaking' && (
        <span className={`absolute inset-0 rounded-full ${cfg.orbBg} animate-ring-expand`} />
      )}
      {voiceState === 'connecting' && (
        <span className={`absolute inset-0 rounded-full border ${cfg.ringColor} animate-ring-connect`} />
      )}
      {voiceState === 'processing' && (
        <span
          className="absolute inset-0 rounded-full animate-ring-shimmer"
          style={{
            background: 'conic-gradient(from 0deg, rgba(245,158,11,0.8), rgba(245,158,11,0.05), rgba(245,158,11,0.8))',
            mask: 'radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px))',
            WebkitMask: 'radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px))',
          }}
        />
      )}

      {/* Core orb */}
      <div
        className={`relative z-10 w-6 h-6 rounded-full ${cfg.orbBg} animate-orb-breathe flex items-center justify-center`}
        style={{ boxShadow: `0 0 12px 2px ${cfg.glowColor}, 0 0 24px 6px ${glowFaint}` }}
      >
        <svg
          width="12" height="12" viewBox="0 0 24 24" fill="none"
          stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
        >
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        </svg>
      </div>
    </div>
  );
}
