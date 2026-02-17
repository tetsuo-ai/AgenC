import { useCallback, useRef, useState } from 'react';
import type { WSMessage, VoiceState, VoiceMode } from '../types';
import { useAudioRecorder } from './useAudioRecorder';
import { useAudioPlayer } from './useAudioPlayer';

interface UseVoiceOptions {
  send: (msg: Record<string, unknown>) => void;
}

/**
 * Voice orchestration hook.
 *
 * Ties together mic capture, audio playback, and the WebSocket voice protocol
 * to provide a complete bidirectional voice experience.
 */
export function useVoice({ send }: UseVoiceOptions) {
  const [voiceState, setVoiceState] = useState<VoiceState>('inactive');
  const [transcript, setTranscript] = useState('');
  const [mode, setMode] = useState<VoiceMode>('vad');
  const transcriptRef = useRef('');

  const recorder = useAudioRecorder();
  const player = useAudioPlayer();

  const isVoiceActive = voiceState !== 'inactive';

  const startVoice = useCallback(async () => {
    if (isVoiceActive) return;

    setVoiceState('connecting');
    setTranscript('');
    transcriptRef.current = '';

    try {
      // Tell the server to start a voice session
      send({ type: 'voice.start' });

      // Start recording and stream audio chunks to the server
      await recorder.start((base64: string) => {
        send({ type: 'voice.audio', payload: { audio: base64 } });
      });
    } catch {
      // getUserMedia permission denied or no mic available
      setVoiceState('inactive');
      setTranscript('Microphone access denied');
      send({ type: 'voice.stop' });
    }
  }, [isVoiceActive, send, recorder]);

  const stopVoice = useCallback(() => {
    recorder.stop();
    player.stop();
    send({ type: 'voice.stop' });
    setVoiceState('inactive');
    setTranscript('');
    transcriptRef.current = '';
  }, [recorder, player, send]);

  /** For push-to-talk: user presses and holds. */
  const pushToTalkStart = useCallback(() => {
    if (mode !== 'push-to-talk' || !isVoiceActive) return;
    setVoiceState('listening');
  }, [mode, isVoiceActive]);

  /** For push-to-talk: user releases. */
  const pushToTalkStop = useCallback(() => {
    if (mode !== 'push-to-talk' || !isVoiceActive) return;
    send({ type: 'voice.commit' });
    setVoiceState('processing');
  }, [mode, isVoiceActive, send]);

  /** Handle incoming voice-related WebSocket messages. */
  const handleMessage = useCallback((msg: WSMessage) => {
    const type = msg.type;
    const payload = (msg.payload ?? {}) as Record<string, unknown>;

    switch (type) {
      case 'voice.started':
        setVoiceState('listening');
        break;

      case 'voice.stopped':
        recorder.stop();
        player.stop();
        setVoiceState('inactive');
        break;

      case 'voice.audio': {
        const audio = payload.audio;
        if (typeof audio === 'string') {
          player.enqueue(audio);
          if (voiceState !== 'speaking') {
            setVoiceState('speaking');
          }
        }
        break;
      }

      case 'voice.transcript': {
        if (payload.done) {
          transcriptRef.current = '';
          setTranscript(payload.text as string);
        } else {
          transcriptRef.current += payload.delta as string;
          setTranscript(transcriptRef.current);
        }
        break;
      }

      case 'voice.speech_started':
        setVoiceState('listening');
        break;

      case 'voice.speech_stopped':
        setVoiceState('processing');
        break;

      case 'voice.response_done':
        // Agent finished speaking, go back to listening
        if (voiceState !== 'inactive') {
          setVoiceState('listening');
        }
        break;

      case 'voice.state': {
        const connectionState = payload.connectionState;
        if (connectionState === 'reconnecting') {
          setVoiceState('connecting');
        } else if (connectionState === 'disconnected') {
          setVoiceState('inactive');
        }
        break;
      }

      case 'voice.error': {
        const errMsg = (payload.message as string) ?? 'Voice error';
        setTranscript(errMsg);
        // If we were connecting, the session failed to start — go inactive
        if (voiceState === 'connecting') {
          recorder.stop();
          player.stop();
          setVoiceState('inactive');
        }
        break;
      }

      default:
        // Not a voice message — ignore
        break;
    }
  }, [recorder, player, voiceState]);

  return {
    isVoiceActive,
    isRecording: recorder.isRecording,
    isSpeaking: player.isPlaying,
    voiceState,
    transcript,
    startVoice,
    stopVoice,
    mode,
    setMode,
    pushToTalkStart,
    pushToTalkStop,
    handleMessage,
  };
}
