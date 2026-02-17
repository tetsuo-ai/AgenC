import { useCallback, useRef, useState } from 'react';
import { VOICE_SAMPLE_RATE } from '../constants';

/**
 * Streaming audio playback hook.
 *
 * Receives base64-encoded PCM16 chunks, decodes them, and queues
 * them for gapless playback via the Web Audio API.
 */
export function useAudioPlayer() {
  const [isPlaying, setIsPlaying] = useState(false);
  const contextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);
  const activeSourcesRef = useRef(0);

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
    setIsPlaying(true);

    source.onended = () => {
      activeSourcesRef.current--;
      if (activeSourcesRef.current <= 0) {
        activeSourcesRef.current = 0;
        setIsPlaying(false);
      }
    };
  }, [ensureContext]);

  const stop = useCallback(() => {
    if (contextRef.current) {
      void contextRef.current.close();
      contextRef.current = null;
    }
    nextStartTimeRef.current = 0;
    activeSourcesRef.current = 0;
    setIsPlaying(false);
  }, []);

  return { isPlaying, enqueue, stop };
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
