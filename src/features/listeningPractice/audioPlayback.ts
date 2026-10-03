interface StoppableAudio {
  src: string;
  stop: () => void;
}

interface TrackAudioError {
  errCode?: number;
  errMsg?: string;
}

interface TrackAudio {
  src: string;
  loop: boolean;
  currentTime: number;
  duration: number;
  paused: boolean;
  playbackRate: number;
  play: () => void;
  pause: () => void;
  seek: (seconds: number) => void;
  destroy: () => void;
  onEnded: (callback: () => void) => void;
  onError: (callback: (error: TrackAudioError) => void) => void;
  onPause: (callback: () => void) => void;
  onPlay: (callback: () => void) => void;
  onStop: (callback: () => void) => void;
  onTimeUpdate: (callback: () => void) => void;
}

interface TrackAudioController {
  toggle: (trackId: string, url: string) => void;
  seek: (seconds: number) => boolean;
  setPlaybackRate: (rate: number) => void;
  stop: () => boolean;
  dispose: () => boolean;
}

interface AudioStopController {
  stop: () => unknown;
}

interface TrackAudioHooks {
  onPlay?: () => void;
  onPause?: () => void;
  onTimeUpdate?: (currentTime: number, duration: number) => void;
}

interface TrackAudioControllerOptions {
  sameTrackAction?: "stop" | "pause";
  loop?: boolean;
}

/**
 * 只停止已经绑定音源的实例。
 * 真机上对全新的 InnerAudioContext 直接 stop，可能会错误触发 onError。
 */
export const stopAudioIfLoaded = (
  audio: StoppableAudio | null | undefined,
) => {
  if (!audio?.src) return false;
  audio.stop();
  return true;
};

/**
 * 为每次示范播放创建独立会话，并用代次隔离旧实例的迟到事件。
 * 这样旧音轨的 onStop、onEnded 或 onError 都不会覆盖新音轨状态。
 */
export const createTrackAudioController = (
  createAudio: () => TrackAudio,
  onTrackChange: (trackId: string | null) => void,
  onPlaybackError?: (error: TrackAudioError) => void,
  hooks: TrackAudioHooks = {},
  options: TrackAudioControllerOptions = {},
): TrackAudioController => {
  let generation = 0;
  let playbackRate = 1;
  let activeSession: {
    audio: TrackAudio;
    generation: number;
    trackId: string;
  } | null = null;

  const isCurrentSession = (sessionGeneration: number) =>
    activeSession?.generation === sessionGeneration;

  const releaseActiveSession = (notify: boolean) => {
    const session = activeSession;
    activeSession = null;
    if (!session) {
      if (notify) onTrackChange(null);
      return false;
    }

    // 先让会话失效再销毁；destroy 同步触发的旧回调也会被代次检查拦截。
    session.audio.destroy();
    if (notify) onTrackChange(null);
    return true;
  };

  const startTrack = (trackId: string, url: string) => {
    const audio = createAudio();
    const sessionGeneration = generation + 1;
    generation = sessionGeneration;
    activeSession = { audio, generation: sessionGeneration, trackId };
    audio.loop = options.loop ?? false;
    if (playbackRate !== 1) audio.playbackRate = playbackRate;

    const finishCurrentSession = () => {
      if (!isCurrentSession(sessionGeneration)) return;
      activeSession = null;
      audio.destroy();
      onTrackChange(null);
    };

    audio.onEnded(finishCurrentSession);
    audio.onStop(finishCurrentSession);
    audio.onPlay(() => {
      if (!isCurrentSession(sessionGeneration)) return;
      hooks.onPlay?.();
    });
    audio.onPause(() => {
      if (!isCurrentSession(sessionGeneration)) return;
      hooks.onPause?.();
    });
    audio.onTimeUpdate(() => {
      if (!isCurrentSession(sessionGeneration)) return;
      hooks.onTimeUpdate?.(audio.currentTime, audio.duration);
    });
    audio.onError((error) => {
      if (!isCurrentSession(sessionGeneration)) return;
      activeSession = null;
      audio.destroy();
      onTrackChange(null);
      onPlaybackError?.(error);
    });

    audio.src = url;
    if (!isCurrentSession(sessionGeneration)) return;
    onTrackChange(trackId);
    audio.play();
  };

  return {
    toggle(trackId, url) {
      if (activeSession?.trackId === trackId) {
        if (options.sameTrackAction === "pause") {
          if (activeSession.audio.paused) activeSession.audio.play();
          else activeSession.audio.pause();
        } else {
          releaseActiveSession(true);
        }
        return;
      }

      releaseActiveSession(false);
      startTrack(trackId, url);
    },

    seek(seconds) {
      const audio = activeSession?.audio;
      if (!audio || !Number.isFinite(seconds)) return false;
      const nonNegativeSeconds = Math.max(0, seconds);
      const boundedSeconds = Number.isFinite(audio.duration) && audio.duration > 0
        ? Math.min(nonNegativeSeconds, audio.duration)
        : nonNegativeSeconds;
      audio.seek(boundedSeconds);
      return true;
    },

    setPlaybackRate(rate) {
      if (!Number.isFinite(rate)) return;
      playbackRate = Math.min(2, Math.max(0.5, rate));
      if (activeSession) activeSession.audio.playbackRate = playbackRate;
    },

    stop() {
      return releaseActiveSession(true);
    },

    dispose() {
      return releaseActiveSession(false);
    },
  };
};

/** 页面隐藏时只停止两类播放，不触碰 RecorderManager 正在进行的录音。 */
export const stopPracticePlayback = (
  modelAudioController: AudioStopController | null | undefined,
  recordingAudioController: AudioStopController | null | undefined,
) => {
  modelAudioController?.stop();
  recordingAudioController?.stop();
};

/** 把播放器的秒进度换算成整秒毫秒值，并限制在录音总时长内。 */
export const getPlaybackPositionMs = (
  currentTimeSeconds: number,
  durationMs: number,
) => {
  const safeDurationMs = Number.isFinite(durationMs)
    ? Math.max(0, durationMs)
    : 0;
  const safeCurrentSeconds = Number.isFinite(currentTimeSeconds)
    ? Math.max(0, currentTimeSeconds)
    : 0;
  const currentMs = Math.floor(safeCurrentSeconds) * 1000;
  return Math.min(currentMs, safeDurationMs);
};
