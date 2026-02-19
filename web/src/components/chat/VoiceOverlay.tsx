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
  const transcriptRef = useRef<HTMLDivElement>(null);

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

  // Auto-scroll transcript to bottom as text streams in
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript]);

  if (!rendering) return null;

  const state = voiceState === 'inactive' ? 'connecting' : voiceState;
  const cfg = STATE_CONFIG[state];

  return (
    <div
      className={`
        absolute inset-0 z-40
        flex flex-col items-center
        bg-surface/95 backdrop-blur-sm
        transition-opacity duration-200
        ${visible ? 'opacity-100 animate-voice-overlay-in' : 'opacity-0'}
      `}
    >
      {/* Top spacer — pushes orb toward center-ish */}
      <div className="flex-1 min-h-8" />

      {/* Orb */}
      <VoiceOrb voiceState={state} cfg={cfg} />

      {/* Transcript area — fills available space, controls stay at bottom */}
      <div className="flex-1 flex flex-col items-center justify-start pt-6 min-h-0">
        <span className={`text-xs font-semibold uppercase tracking-[0.2em] ${cfg.labelColor} mb-2 shrink-0`}>
          {STATE_LABELS[voiceState]}
        </span>

        <div ref={transcriptRef} className="flex-1 overflow-y-auto w-full px-6 scroll-smooth" style={{ maskImage: 'linear-gradient(transparent 0%, black 15%, black 100%)', WebkitMaskImage: 'linear-gradient(transparent 0%, black 15%, black 100%)' }}>
          {transcript && (
            <p className="max-w-xs md:max-w-md mx-auto text-center text-base md:text-lg font-medium leading-relaxed">
              <TranscriptWords text={transcript} />
            </p>
          )}
        </div>
      </div>

      {/* Controls — pinned to bottom, stop centered */}
      <div className="shrink-0 pb-8 md:pb-10 pt-4 flex flex-col items-center gap-4">
        {/* Stop button — always centered */}
        <button
          onClick={onStop}
          className="w-16 h-16 rounded-full bg-red-500 hover:bg-red-600 active:scale-95 transition-all flex items-center justify-center shadow-lg shadow-red-500/25"
          title="Stop voice"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="white">
            <rect x="4" y="4" width="16" height="16" rx="2" />
          </svg>
        </button>

        {/* Row below: mode toggle + optional PTT */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => onModeChange(mode === 'vad' ? 'push-to-talk' : 'vad')}
            className="px-4 py-2 rounded-xl border border-tetsuo-200 text-xs font-medium text-tetsuo-500 hover:text-tetsuo-700 hover:border-tetsuo-300 bg-surface transition-colors"
          >
            {mode === 'vad' ? 'VAD mode' : 'Push to talk'}
          </button>

          {mode === 'push-to-talk' && (
            <button
              onMouseDown={onPushToTalkStart}
              onMouseUp={onPushToTalkStop}
              onMouseLeave={onPushToTalkStop}
              onTouchStart={onPushToTalkStart}
              onTouchEnd={onPushToTalkStop}
              className="px-5 py-2 rounded-xl border-2 border-tetsuo-300 text-xs font-semibold text-tetsuo-600 bg-tetsuo-50 active:bg-tetsuo-200 transition-colors select-none"
            >
              Hold to speak
            </button>
          )}
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
  // Last ~8 words fade in, everything before is fully visible
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

function VoiceOrb({
  voiceState,
  cfg,
}: {
  voiceState: Exclude<VoiceState, 'inactive'>;
  cfg: typeof STATE_CONFIG[keyof typeof STATE_CONFIG];
}) {
  const glowFaint = cfg.glowColor.replace(/[\d.]+\)$/, '0.18)');

  return (
    <div className="relative flex items-center justify-center w-40 h-40">
      {/* Rings — state-specific */}
      {voiceState === 'listening' && (
        <>
          <span className={`absolute inset-0 rounded-full border-2 ${cfg.ringColor} animate-ring-breathe`} />
          <span className={`absolute inset-0 rounded-full border ${cfg.ringColor} animate-ring-breathe-2`} />
        </>
      )}

      {voiceState === 'speaking' && (
        <>
          <span className={`absolute inset-0 rounded-full ${cfg.orbBg} animate-ring-expand`} />
          <span className={`absolute inset-0 rounded-full ${cfg.orbBg} animate-ring-expand-2`} />
        </>
      )}

      {voiceState === 'connecting' && (
        <span className={`absolute inset-0 rounded-full border-2 ${cfg.ringColor} animate-ring-connect`} />
      )}

      {voiceState === 'processing' && (
        <span
          className="absolute inset-0 rounded-full animate-ring-shimmer"
          style={{
            background: 'conic-gradient(from 0deg, rgba(245,158,11,0.8), rgba(245,158,11,0.05), rgba(245,158,11,0.8))',
            mask: 'radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 3px))',
            WebkitMask: 'radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 3px))',
          }}
        />
      )}

      {/* Core orb */}
      <div
        className={`relative z-10 w-24 h-24 rounded-full ${cfg.orbBg} animate-orb-breathe flex items-center justify-center`}
        style={{ boxShadow: `0 0 40px 8px ${cfg.glowColor}, 0 0 80px 20px ${glowFaint}` }}
      >
        <svg
          width="28" height="28" viewBox="0 0 24 24" fill="none"
          stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        >
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" x2="12" y1="19" y2="22" />
        </svg>
      </div>
    </div>
  );
}
