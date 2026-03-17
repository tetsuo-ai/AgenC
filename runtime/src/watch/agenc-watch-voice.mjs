import { spawn } from "node:child_process";

const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const CHUNK_INTERVAL_MS = 100;

function uint8ToBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function base64ToBuffer(base64) {
  return Buffer.from(base64, "base64");
}

function tryKill(proc) {
  if (!proc) return;
  try {
    if (!proc.killed) proc.kill("SIGTERM");
  } catch {
    // already dead
  }
}

export function createWatchVoiceController(dependencies = {}) {
  const {
    send,
    authPayload,
    pushEvent,
    setTransientStatus,
  } = dependencies;

  let recorder = null;
  let player = null;
  let chunkTimer = null;
  let audioBuffer = Buffer.alloc(0);
  let active = false;

  function startRecorder() {
    try {
      recorder = spawn("arecord", [
        "-D", "default",
        "-f", "S16_LE",
        "-r", String(SAMPLE_RATE),
        "-c", String(CHANNELS),
        "-t", "raw",
        "-q",
        "-",
      ], { stdio: ["ignore", "pipe", "ignore"] });

      recorder.stdout.on("data", (chunk) => {
        audioBuffer = Buffer.concat([audioBuffer, chunk]);
      });

      recorder.on("error", (err) => {
        pushEvent("error", "Voice Error",
          `Microphone failed: ${err.message}\nMake sure arecord is available and a mic is connected.`, "red");
        cleanupLocal();
      });

      recorder.on("exit", () => {
        recorder = null;
      });

      // Send audio chunks at fixed intervals
      chunkTimer = setInterval(() => {
        if (audioBuffer.length === 0) return;
        const chunk = audioBuffer;
        audioBuffer = Buffer.alloc(0);
        send("voice.audio", authPayload({ audio: uint8ToBase64(chunk) }));
      }, CHUNK_INTERVAL_MS);
    } catch (err) {
      pushEvent("error", "Voice Error", `Could not start mic: ${err.message}`, "red");
    }
  }

  function stopRecorder() {
    if (chunkTimer) {
      clearInterval(chunkTimer);
      chunkTimer = null;
    }
    tryKill(recorder);
    recorder = null;
    audioBuffer = Buffer.alloc(0);
  }

  // Playback: spawn one aplay process and keep its stdin open for streaming.
  // Kill it to interrupt (barge-in).
  function ensurePlayer() {
    if (player && !player.killed) return player;
    try {
      player = spawn("aplay", [
        "-f", "S16_LE",
        "-r", String(SAMPLE_RATE),
        "-c", String(CHANNELS),
        "-t", "raw",
        "-q",
        "-",
      ], { stdio: ["pipe", "ignore", "ignore"] });

      player.stdin.on("error", () => {
        // pipe broken — player died, will be respawned on next audio
      });
      player.on("error", () => { player = null; });
      player.on("exit", () => { player = null; });
      return player;
    } catch {
      return null;
    }
  }

  function playAudio(base64) {
    const p = ensurePlayer();
    if (p && p.stdin.writable) {
      p.stdin.write(base64ToBuffer(base64));
    }
  }

  function interruptPlayback() {
    tryKill(player);
    player = null;
  }

  function cleanupLocal() {
    active = false;
    stopRecorder();
    interruptPlayback();
  }

  function startVoice() {
    if (active) {
      pushEvent("voice", "Voice", "Already active. /voice stop to end.", "amber");
      return;
    }
    active = true;
    setTransientStatus("voice: connecting...");
    send("voice.start", authPayload({}));
  }

  function stopVoice() {
    cleanupLocal();
    try {
      send("voice.stop", authPayload({}));
    } catch {
      // socket might already be closed
    }
    setTransientStatus("voice: stopped");
  }

  function handleVoiceMessage(type, payload) {
    switch (type) {
      case "voice.started":
        setTransientStatus("voice: listening (speak now)");
        pushEvent("voice", "Voice", "Listening. Speak now.", "green");
        startRecorder();
        return true;

      case "voice.stopped":
        cleanupLocal();
        setTransientStatus("voice: disconnected");
        return true;

      case "voice.audio":
        if (payload?.audio) {
          playAudio(payload.audio);
        }
        return true;

      case "voice.transcript":
        if (payload?.done && payload?.text) {
          pushEvent("voice", "Agent", payload.text, "cyan");
        } else if (payload?.delta) {
          setTransientStatus(`agent: ${payload.delta.slice(-60)}`);
        }
        return true;

      case "voice.user_transcript":
        if (payload?.text) {
          pushEvent("voice", "You (voice)", payload.text, "green");
        }
        return true;

      case "voice.speech_started":
        // User started talking — kill playback so agent shuts up
        interruptPlayback();
        setTransientStatus("voice: listening...");
        return true;

      case "voice.speech_stopped":
        setTransientStatus("voice: processing...");
        return true;

      case "voice.response_done":
        setTransientStatus("voice: listening");
        return true;

      case "voice.delegation":
        if (payload?.status === "started") {
          setTransientStatus(`voice: working on "${(payload.task ?? "").slice(0, 40)}..."`);
          pushEvent("voice", "Delegation", `Task: ${payload.task}`, "purple");
        } else if (payload?.status === "completed") {
          pushEvent("voice", "Delegation Done", (payload.content ?? "").slice(0, 500), "teal");
        } else if (payload?.status === "error") {
          pushEvent("voice", "Delegation Error", payload.error ?? "unknown", "red");
        }
        return true;

      case "voice.state":
        if (payload?.connectionState === "disconnected" && active) {
          cleanupLocal();
        }
        setTransientStatus(`voice: ${payload?.connectionState ?? "unknown"}`);
        return true;

      case "voice.error":
        pushEvent("error", "Voice Error", payload?.message ?? "unknown voice error", "red");
        cleanupLocal();
        return true;

      default:
        return false;
    }
  }

  return {
    startVoice,
    stopVoice,
    handleVoiceMessage,
    get active() { return active; },
  };
}
