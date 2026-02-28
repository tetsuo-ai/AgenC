import { useCallback, useRef, useState } from 'react';
import type { WSMessage, VoiceState, VoiceMode } from '../types';
import { useAudioRecorder } from './useAudioRecorder';
import { useAudioPlayer } from './useAudioPlayer';
import {
  WS_VOICE_START,
  WS_VOICE_STOP,
  WS_VOICE_AUDIO,
  WS_VOICE_COMMIT,
  WS_VOICE_STARTED,
  WS_VOICE_STOPPED,
  WS_VOICE_TRANSCRIPT,
  WS_VOICE_SPEECH_STARTED,
  WS_VOICE_SPEECH_STOPPED,
  WS_VOICE_RESPONSE_DONE,
  WS_VOICE_DELEGATION,
  WS_VOICE_STATE,
  WS_VOICE_ERROR,
  WS_TOOLS_EXECUTING,
} from '../constants';

interface UseVoiceOptions {
  send: (msg: Record<string, unknown>) => void;
  /** Called when a delegation completes with the full result content. */
  onDelegationResult?: (task: string, content: string) => void;
}

/**
 * Voice orchestration hook.
 *
 * Ties together mic capture, audio playback, and the WebSocket voice protocol
 * to provide a complete bidirectional voice experience. Supports the
 * Chat-Supervisor delegation pattern where complex tasks are routed through
 * ChatExecutor and results appear in the chat panel.
 */
export function useVoice({ send, onDelegationResult }: UseVoiceOptions) {
  const [voiceState, setVoiceState] = useState<VoiceState>('inactive');
  const [transcript, setTranscript] = useState('');
  const [mode, setMode] = useState<VoiceMode>('vad');
  const [delegationTask, setDelegationTask] = useState('');
  const transcriptRef = useRef('');

  const recorder = useAudioRecorder();
  const player = useAudioPlayer();

  const isVoiceActive = voiceState !== 'inactive';

  const startVoice = useCallback(async () => {
    if (isVoiceActive) return;

    setVoiceState('connecting');
    setTranscript('');
    setDelegationTask('');
    transcriptRef.current = '';

    try {
      // Tell the server to start a voice session
      send({ type: WS_VOICE_START });

      // Start recording and stream audio chunks to the server
      await recorder.start((base64: string) => {
        send({ type: WS_VOICE_AUDIO, payload: { audio: base64 } });
      });
    } catch {
      // getUserMedia permission denied or no mic available
      setVoiceState('inactive');
      setTranscript('Microphone access denied');
      send({ type: WS_VOICE_STOP });
    }
  }, [isVoiceActive, send, recorder]);

  const stopVoice = useCallback(() => {
    recorder.stop();
    player.stop();
    send({ type: WS_VOICE_STOP });
    setVoiceState('inactive');
    setTranscript('');
    setDelegationTask('');
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
    send({ type: WS_VOICE_COMMIT });
    setVoiceState('processing');
  }, [mode, isVoiceActive, send]);

  /** Handle incoming voice-related WebSocket messages. */
  const handleMessage = useCallback((msg: WSMessage) => {
    const type = msg.type;
    const payload = (msg.payload ?? {}) as Record<string, unknown>;

    switch (type) {
      case WS_VOICE_STARTED:
        setVoiceState('listening');
        break;

      case WS_VOICE_STOPPED:
        recorder.stop();
        player.stop();
        setVoiceState('inactive');
        break;

      case WS_VOICE_AUDIO: {
        const audio = payload.audio;
        if (typeof audio === 'string') {
          player.enqueue(audio);
          if (voiceState !== 'speaking') {
            setVoiceState('speaking');
          }
        }
        break;
      }

      case WS_VOICE_TRANSCRIPT: {
        if (payload.done) {
          transcriptRef.current = '';
          setTranscript(payload.text as string);
        } else {
          transcriptRef.current += payload.delta as string;
          setTranscript(transcriptRef.current);
        }
        break;
      }

      case WS_VOICE_SPEECH_STARTED:
        // User barge-in: interrupt agent audio so it doesn't overlap
        player.interrupt();
        setVoiceState('listening');
        break;

      case WS_VOICE_SPEECH_STOPPED:
        setVoiceState('processing');
        break;

      case WS_VOICE_RESPONSE_DONE:
        // Agent finished speaking, go back to listening
        if (voiceState !== 'inactive') {
          setVoiceState('listening');
        }
        break;

      case WS_VOICE_DELEGATION: {
        const status = payload.status as string;
        switch (status) {
          case 'started':
            setVoiceState('delegating');
            setDelegationTask((payload.task as string) ?? '');
            setTranscript('');
            break;
          case 'completed': {
            const task = (payload.task as string) ?? '';
            const content = (payload.content as string) ?? '';
            // Inject result into chat panel
            onDelegationResult?.(task, content);
            setTranscript('');
            // Transition back — xAI will speak a short summary
            setVoiceState('processing');
            setDelegationTask('');
            break;
          }
          case 'error':
          case 'blocked':
            setTranscript((payload.error as string) ?? 'Delegation failed');
            setVoiceState('listening');
            setDelegationTask('');
            break;
        }
        break;
      }

      // During delegation, show tool names in the voice overlay bar
      case WS_TOOLS_EXECUTING: {
        if (voiceState === 'delegating') {
          const toolName = (payload.toolName as string) ?? '';
          setTranscript(toolName);
        }
        break;
      }

      case WS_VOICE_STATE: {
        const connectionState = payload.connectionState;
        if (connectionState === 'reconnecting') {
          setVoiceState('connecting');
        } else if (connectionState === 'disconnected') {
          setVoiceState('inactive');
        }
        break;
      }

      case WS_VOICE_ERROR: {
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
  }, [recorder, player, voiceState, onDelegationResult]);

  return {
    isVoiceActive,
    isRecording: recorder.isRecording,
    isSpeaking: player.isPlaying,
    voiceState,
    transcript,
    delegationTask,
    startVoice,
    stopVoice,
    mode,
    setMode,
    pushToTalkStart,
    pushToTalkStop,
    handleMessage,
  };
}
