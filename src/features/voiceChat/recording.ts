import { getRecorderCoordinator, type RecorderCoordinator, type RecorderOwner } from "@/features/listeningPractice/recorderCoordinator";
import { removeRecordedTempFile } from "@/features/voiceChat/playback";
import { microphoneError, voiceError } from "@/services/voiceChatErrors";

const RECORD_OPTIONS = {
  duration: 30000,
  sampleRate: 16000,
  numberOfChannels: 1,
  encodeBitRate: 48000,
  format: "mp3" as const,
};

type ActiveRecording = {
  owner: RecorderOwner;
  stopping: boolean;
  unsubscribe: () => void;
  onStop: (path: string, durationMs: number) => void;
  onError: (message: string) => void;
};

export const createVoiceRecorder = (coordinator: RecorderCoordinator = getRecorderCoordinator()) => {
  let active: ActiveRecording | null = null;
  const finish = (session: ActiveRecording, discardLate = false) => {
    if (active !== session) return false;
    active = null;
    session.unsubscribe();
    session.owner.release({
      terminalSink: discardLate
        ? (event) => event.type === "stop" && event.result.tempFilePath ? removeRecordedTempFile(event.result.tempFilePath) : undefined
        : () => undefined,
    });
    return true;
  };
  return {
    isActive: () => active !== null,
    start(onStop: ActiveRecording["onStop"], onError: ActiveRecording["onError"]) {
      if (active) throw voiceError("RECORD_BUSY");
      const acquired = coordinator.acquire();
      if (acquired.ok === false) throw voiceError(acquired.reason === "busy" ? "RECORD_BUSY" : "RECORD_START");
      const session: ActiveRecording = { owner: acquired.owner, stopping: false, unsubscribe: () => undefined, onStop, onError };
      active = session;
      const subscribed = session.owner.subscribe({
        onStop: (result) => {
          if (!finish(session)) return;
          if (!result.tempFilePath) { onError(voiceError("RECORD_INVALID").message); return; }
          onStop(result.tempFilePath, Math.round(result.duration || 0));
        },
        onError: (error) => {
          if (finish(session, true)) onError(microphoneError(error).message);
        },
      });
      if (!subscribed.ok) {
        finish(session, true);
        throw voiceError("RECORD_START");
      }
      session.unsubscribe = subscribed.unsubscribe;
      const result = session.owner.start(RECORD_OPTIONS);
      if (result.ok === false) {
        finish(session, true);
        throw result.reason === "busy" ? voiceError("RECORD_BUSY") : microphoneError(result.error);
      }
    },
    stop() {
      if (!active || active.stopping) return;
      const session = active;
      // Native onStop is asynchronous; every UI entry shares this one stop request.
      session.stopping = true;
      const result = session.owner.stop();
      if (result.ok === false && finish(session, true)) session.onError(voiceError("RECORD_STOP").message);
    },
    cancel() {
      if (!active) return;
      finish(active, true);
    },
  };
};
