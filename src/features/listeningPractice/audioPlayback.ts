interface StoppableAudio {
  src: string;
  stop: () => void;
}

interface TrackAudio extends StoppableAudio {
  play: () => void;
}

interface TrackAudioController {
  toggle: (trackId: string, url: string) => void;
  handleStop: () => void;
  handleEnded: () => void;
  handleError: () => void;
  stop: () => boolean;
}

interface AudioStopController {
  stop: () => unknown;
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
 * 管理同一个 InnerAudioContext 上的音轨切换。
 * 微信的 onStop 可能延迟到达，因此切换时先等待旧音轨确认停止，再启动新音轨。
 */
export const createTrackAudioController = (
  audio: TrackAudio,
  onTrackChange: (trackId: string | null) => void,
): TrackAudioController => {
  let activeTrackId: string | null = null;
  let pendingTrack: { id: string; url: string } | null = null;
  let waitingForStop = false;

  const startTrack = (track: { id: string; url: string }) => {
    activeTrackId = track.id;
    audio.src = track.url;
    audio.play();
    onTrackChange(track.id);
  };

  const clearTrack = () => {
    activeTrackId = null;
    pendingTrack = null;
    onTrackChange(null);
  };

  const stopCurrentTrack = () => {
    if (!audio.src) return false;
    // 先写入等待状态，兼容基础库同步触发 onStop 的情况。
    waitingForStop = true;
    stopAudioIfLoaded(audio);
    return true;
  };

  return {
    toggle(trackId, url) {
      const nextTrack = { id: trackId, url };

      if (activeTrackId === trackId && pendingTrack === null) {
        clearTrack();
        if (!waitingForStop) stopCurrentTrack();
        return;
      }

      if (waitingForStop) {
        // 连续点击时只保留用户最后选择的音轨。
        pendingTrack = nextTrack;
        return;
      }

      if (activeTrackId !== null) {
        pendingTrack = nextTrack;
        if (stopCurrentTrack()) return;
        pendingTrack = null;
      }

      startTrack(nextTrack);
    },

    handleStop() {
      waitingForStop = false;
      if (pendingTrack) {
        const nextTrack = pendingTrack;
        pendingTrack = null;
        startTrack(nextTrack);
        return;
      }
      clearTrack();
    },

    handleEnded() {
      waitingForStop = false;
      clearTrack();
    },

    handleError() {
      waitingForStop = false;
      clearTrack();
    },

    stop() {
      const hasActiveTrack = activeTrackId !== null;
      clearTrack();
      if (!hasActiveTrack || waitingForStop) return false;
      return stopCurrentTrack();
    },
  };
};

/** 页面隐藏时只停止两类播放，不触碰 RecorderManager 正在进行的录音。 */
export const stopPracticePlayback = (
  modelAudioController: AudioStopController | null | undefined,
  recordingAudio: StoppableAudio | null | undefined,
) => {
  modelAudioController?.stop();
  stopAudioIfLoaded(recordingAudio);
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
