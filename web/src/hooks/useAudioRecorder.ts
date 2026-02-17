import { useCallback, useRef, useState } from 'react';
import { VOICE_SAMPLE_RATE, VOICE_CHUNK_INTERVAL_MS } from '../constants';

/**
 * Low-level mic capture hook.
 *
 * Captures audio from the user's microphone via getUserMedia + AudioWorklet/ScriptProcessor,
 * converts Float32 → Int16 LE, base64-encodes, and delivers chunks every ~100ms.
 */
export function useAudioRecorder() {
  const [isRecording, setIsRecording] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const callbackRef = useRef<((base64: string) => void) | null>(null);
  const bufferRef = useRef<Int16Array[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const flush = useCallback(() => {
    const chunks = bufferRef.current;
    if (chunks.length === 0) return;
    bufferRef.current = [];

    // Concatenate all chunks
    const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
    const merged = new Int16Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    // Convert Int16Array to base64
    const bytes = new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength);
    const base64 = uint8ToBase64(bytes);
    callbackRef.current?.(base64);
  }, []);

  const start = useCallback(async (onAudioData: (base64: string) => void) => {
    if (isRecording) return;

    callbackRef.current = onAudioData;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: VOICE_SAMPLE_RATE,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });

    const ctx = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE });
    const source = ctx.createMediaStreamSource(stream);

    // ScriptProcessorNode for wide browser support (AudioWorklet is better but
    // requires a separate worker file which complicates the build)
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (e) => {
      const float32 = e.inputBuffer.getChannelData(0);
      const int16 = float32ToInt16(float32);
      bufferRef.current.push(int16);
    };

    source.connect(processor);
    processor.connect(ctx.destination);

    streamRef.current = stream;
    contextRef.current = ctx;
    processorRef.current = processor;

    // Flush accumulated audio at regular intervals
    timerRef.current = setInterval(flush, VOICE_CHUNK_INTERVAL_MS);

    setIsRecording(true);
  }, [isRecording, flush]);

  const stop = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    // Flush remaining audio
    flush();

    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (contextRef.current) {
      void contextRef.current.close();
      contextRef.current = null;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }

    callbackRef.current = null;
    bufferRef.current = [];
    setIsRecording(false);
  }, [flush]);

  return { isRecording, start, stop };
}

// ============================================================================
// Helpers
// ============================================================================

/** Convert Float32 audio samples (-1..1) to Int16 LE. */
function float32ToInt16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return int16;
}

/** Uint8Array to base64 string (browser). */
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
