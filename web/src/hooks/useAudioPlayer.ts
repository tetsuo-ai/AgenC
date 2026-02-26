import { useCallback, useRef, useState } from 'react';
import { VOICE_SAMPLE_RATE } from '../constants';

/**
 * Streaming audio playback hook.
 *
 * Receives base64-encoded PCM16 chunks, decodes them, and queues
 * them for gapless playback via the Web Audio API.
 *
 * Drift prevention: `nextStartTimeRef` is reset whenever playback
 * drains completely (all sources finished), so each new response
 * starts with a fresh scheduling chain. This prevents floating-point
 * accumulation from degrading audio quality over long sessions.
 */
export function useAudioPlayer() {
  const [isPlaying, setIsPlaying] = useState(false);
  const contextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);
  const activeSourcesRef = useRef(0);
  /**
   * Track live AudioBufferSourceNodes so we can stop + disconnect them
   * on interrupt (barge-in) without closing the entire AudioContext.
   */
  const liveSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  const ensureContext = useCallback(() => {
    if (!contextRef.current || contextRef.current.state === 'closed') {
      contextRef.current = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE });
      nextStartTimeRef.current = 0;
    }
    if (contextRef.current.state === 'suspended') {
      void contextRef.current.resume();
    }
    return contextRef.current;
  }, []);

  const enqueue = useCallback((base64: string) => {
    const ctx = ensureContext();
    if (ctx.state === 'closed') return;
    const pcm = base64ToInt16(base64);

    // Create AudioBuffer from Int16 PCM
    const audioBuffer = ctx.createBuffer(1, pcm.length, VOICE_SAMPLE_RATE);
    const channel = audioBuffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) {
      channel[i] = pcm[i] / (pcm[i] < 0 ? 0x8000 : 0x7FFF);
    }

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    // Schedule for gapless playback
    const now = ctx.currentTime;
    const startTime = Math.max(now, nextStartTimeRef.current);
    source.start(startTime);
    nextStartTimeRef.current = startTime + audioBuffer.duration;

    activeSourcesRef.current++;
    liveSourcesRef.current.add(source);
    setIsPlaying(true);

    source.onended = () => {
      // Disconnect from audio graph to release Web Audio resources immediately
      // rather than waiting for GC. Prevents graph degradation on long sessions.
      source.disconnect();
      liveSourcesRef.current.delete(source);

      activeSourcesRef.current--;
      if (activeSourcesRef.current <= 0) {
        activeSourcesRef.current = 0;
        // Reset scheduling chain so the next response starts fresh.
        // This prevents floating-point drift from accumulating across responses.
        nextStartTimeRef.current = 0;
        setIsPlaying(false);
      }
    };
  }, [ensureContext]);

  /**
   * Interrupt playback immediately (e.g. user barge-in).
   * Stops all scheduled sources and resets the scheduling chain,
   * but keeps the AudioContext alive so the next response can play
   * without the overhead of recreating it.
   */
  const interrupt = useCallback(() => {
    for (const source of liveSourcesRef.current) {
      try {
        source.stop();
        source.disconnect();
      } catch {
        // Already stopped or ended — ignore
      }
    }
    liveSourcesRef.current.clear();
    activeSourcesRef.current = 0;
    nextStartTimeRef.current = 0;
    setIsPlaying(false);
  }, []);

  const stop = useCallback(() => {
    // Stop all live sources before closing context
    for (const source of liveSourcesRef.current) {
      try {
        source.stop();
        source.disconnect();
      } catch {
        // Already stopped — ignore
      }
    }
    liveSourcesRef.current.clear();

    if (contextRef.current) {
      void contextRef.current.close();
      contextRef.current = null;
    }
    nextStartTimeRef.current = 0;
    activeSourcesRef.current = 0;
    setIsPlaying(false);
  }, []);

  return { isPlaying, enqueue, interrupt, stop };
}

// ============================================================================
// Helpers
// ============================================================================

/** Decode base64 string to Int16Array (browser). */
function base64ToInt16(base64: string): Int16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  // Interpret as Int16 LE
  return new Int16Array(bytes.buffer);
}
