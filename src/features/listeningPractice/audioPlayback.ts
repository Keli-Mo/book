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
  onCanplay?: (callback: () => void) => void;
  onEnded: (callback: () => void) => void;
  onError: (callback: (error: TrackAudioError) => void) => void;
  onPause: (callback: () => void) => void;
  onPlay: (callback: () => void) => void;
  onStop: (callback: () => void) => void;
  onTimeUpdate: (callback: () => void) => void;
  onWaiting?: (callback: () => void) => void;
}

interface TrackAudioController {
  toggle: (trackId: string, url: string) => void;
  seek: (seconds: number) => boolean;
  setPlaybackRate: (rate: number) => void;
  handleInterruptionBegin: () => boolean;
  handleInterruptionEnd: () => boolean;
  stop: () => boolean;
  dispose: () => boolean;
}

interface AudioStopController {
  stop: () => unknown;
}

interface TrackAudioHooks {
  onCanplay?: (willResume: boolean) => void;
  onPlay?: () => void;
  onPause?: () => void;
  onTimeUpdate?: (currentTime: number, duration: number) => void;
  onWaiting?: () => void;
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
  let interruptionActive = false;
  let activeSession: {
    audio: TrackAudio;
    generation: number;
    trackId: string;
    wantsToPlay: boolean;
    userPaused: boolean;
    waiting: boolean;
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
    let loopEndedRecently = false;
    const isAtLoopBoundary = () =>
      options.loop && Number.isFinite(audio.duration) && audio.duration > 0 &&
      audio.currentTime >= audio.duration - 0.25;
    const resumeLoopIfPaused = () => {
      if (!audio.paused) return;
      audio.seek(0);
      audio.play();
    };
    const sessionGeneration = generation + 1;
    generation = sessionGeneration;
    activeSession = {
      audio,
      generation: sessionGeneration,
      trackId,
      wantsToPlay: true,
      userPaused: false,
      waiting: false,
    };
    audio.loop = options.loop ?? false;
    if (playbackRate !== 1) audio.playbackRate = playbackRate;

    const finishCurrentSession = () => {
      if (!isCurrentSession(sessionGeneration)) return;
      activeSession = null;
      audio.destroy();
      onTrackChange(null);
    };

    audio.onEnded(() => {
      if (!isCurrentSession(sessionGeneration) || !activeSession) return;
      if (options.loop) {
        // 微信客户端可能先派发 Pause 再派发 Ended，也可能原生循环后仍派发 Ended。
        // 保留会话；若原生未自动续播，主动回到开头播放。
        loopEndedRecently = true;
        if (!activeSession.userPaused && !interruptionActive) {
          activeSession.wantsToPlay = true;
          resumeLoopIfPaused();
        }
        return;
      }
      finishCurrentSession();
    });
    audio.onStop(finishCurrentSession);
    audio.onPlay(() => {
      if (!isCurrentSession(sessionGeneration) || !activeSession) return;
      if (!activeSession.wantsToPlay || interruptionActive) {
        audio.pause();
        return;
      }
      activeSession.waiting = false;
      hooks.onPlay?.();
    });
    audio.onPause(() => {
      if (!isCurrentSession(sessionGeneration) || !activeSession) return;
      if (options.loop && activeSession.wantsToPlay && !interruptionActive &&
        (isAtLoopBoundary() || loopEndedRecently)) {
        // 有的微信客户端只发 Pause，不发 Ended。循环边界若真的暂停，
        // 立即回到开头续播；迟到的 Ended 发现已播放时不会重复启动。
        loopEndedRecently = true;
        resumeLoopIfPaused();
        return;
      }
      // 某些真机会在恢复播放之后才补发中断期间的 Pause。
      // 原生实例仍在播放时，该迟到事件不能覆盖新的播放态。
      if (activeSession.wantsToPlay && !interruptionActive && !audio.paused) return;
      // 没有系统中断事件却发生真实暂停时，也要把播放意图同步回来，
      // 这样下一次点击会恢复播放，而不是再次执行 pause。
      if (!interruptionActive && audio.paused) {
        activeSession.wantsToPlay = false;
        activeSession.waiting = false;
      }
      hooks.onPause?.();
    });
    audio.onTimeUpdate(() => {
      if (!isCurrentSession(sessionGeneration)) return;
      if (audio.currentTime > 0.5 && !isAtLoopBoundary()) loopEndedRecently = false;
      hooks.onTimeUpdate?.(audio.currentTime, audio.duration);
    });
    audio.onWaiting?.(() => {
      if (!isCurrentSession(sessionGeneration) || !activeSession?.wantsToPlay || interruptionActive) return;
      activeSession.waiting = true;
      hooks.onWaiting?.();
    });
    audio.onCanplay?.(() => {
      if (!isCurrentSession(sessionGeneration) || !activeSession) return;
      const wasWaiting = activeSession.waiting;
      const shouldResume = wasWaiting && activeSession.wantsToPlay && !interruptionActive;
      activeSession.waiting = false;
      if (wasWaiting) hooks.onCanplay?.(shouldResume);
      if (shouldResume) audio.play();
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
    if (!interruptionActive) audio.play();
  };

  return {
    toggle(trackId, url) {
      if (activeSession?.trackId === trackId) {
        if (options.sameTrackAction === "pause") {
          if (activeSession.wantsToPlay) {
            activeSession.wantsToPlay = false;
            activeSession.userPaused = true;
            activeSession.waiting = false;
            activeSession.audio.pause();
          } else {
            activeSession.wantsToPlay = true;
            activeSession.userPaused = false;
            if (!interruptionActive) activeSession.audio.play();
          }
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

    handleInterruptionBegin() {
      interruptionActive = true;
      if (!activeSession) return false;
      const wasPlaying = activeSession.wantsToPlay;
      return wasPlaying;
    },

    handleInterruptionEnd() {
      if (!interruptionActive) return false;
      interruptionActive = false;
      if (!activeSession) return false;
      if (!activeSession.wantsToPlay) return false;
      activeSession.audio.play();
      return true;
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
