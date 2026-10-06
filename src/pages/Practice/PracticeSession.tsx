import { Button, Image, MovableArea, MovableView, PageMeta, ScrollView, Slider, Swiper, SwiperItem, Text, View, type ScrollViewProps } from "@tarojs/components";
import Taro, {
  useDidHide,
  useDidShow,
  useUnload,
} from "@tarojs/taro";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { saveFullReadingProgress } from "@/features/bookLibrary/readingProgress";
import {
  createTrackAudioController,
  stopPracticePlayback,
} from "@/features/listeningPractice/audioPlayback";
import {
  type BookPracticeBundle,
  type ListeningPractice,
} from "@/features/listeningPractice/bookPractice";
import {
  readBookImageSize,
  readBookStableCanvasSize,
} from "@/features/listeningPractice/bookImageSizes";
import {
  clampHotspotCenter,
  fitImageToBounds,
  fitImageToWidth,
  resolveHotspotAnchorOffset,
} from "@/features/listeningPractice/hotspotLayout";
import {
  isPracticeSwiperTouchChange,
  PAGE_TURN_DURATION_MS,
  retainPracticeSlideIndexes,
} from "@/features/listeningPractice/practiceSwipe";
import { buildPracticeDirectoryGroups } from "@/features/listeningPractice/practiceDirectory";
import {
  getRecordingErrorMessage,
  getRecordingPermissionStep,
  getPracticeSwitchPolicy,
  getRecordingElapsedMs,
  parseNativeRecordingResult,
  pauseRecordingTimeline,
  resumeRecordingTimeline,
  startRecordingTimeline,
  type RecordingTimeline,
} from "@/features/listeningPractice/recordingInteraction";
import {
  createRecordingMachine,
  disposeRecordingMachine,
  handleInterruptionBegin,
  handleInterruptionEnd,
  requestRecorderAction,
  requestRecorderTeardown,
  resetRecordingMachine,
  resolveRecorderCallback,
  resolveRecordingCapabilities,
  restoreRecordedMachine,
  type PauseReason,
  type RecorderAction,
  type RecordingMachine,
} from "@/features/listeningPractice/recordingStateMachine";
import {
  getRecorderCoordinator,
  type RecorderNativeStopResult,
  type RecorderOwner,
  type RecorderTerminalSink,
} from "@/features/listeningPractice/recorderCoordinator";
import type { PendingCheckIn } from "@/features/listeningPractice/pendingCheckInStore";
import { getPendingCheckInStore, logRecordingDiagnostic, diagnoseLocalRecordingFailure } from "@/features/listeningPractice/pendingCheckInRuntime";
import type { DeviceLayoutState } from "@/hooks/useDeviceLayout";
import PracticeDirectory from "./PracticeDirectory";

const formatDuration = (durationMs: number) => {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
};

const formatAudioTime = (seconds: number) =>
  formatDuration(Math.floor(Math.max(0, Number.isFinite(seconds) ? seconds : 0)) * 1000);

const MODEL_PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 2] as const;
type ModelPlaybackRate = typeof MODEL_PLAYBACK_RATES[number];
const MODEL_PLAYBACK_RATE_LABELS = ["0.75×", "1.0×", "1.25×", "1.5×", "2.0×"] as const;
const formatModelPlaybackRate = (rate: ModelPlaybackRate) =>
  MODEL_PLAYBACK_RATE_LABELS[MODEL_PLAYBACK_RATES.indexOf(rate)];

const RECORDER_OPTIONS = {
  duration: 300000,
  sampleRate: 16000,
  numberOfChannels: 1,
  encodeBitRate: 48000,
  format: "mp3" as const,
};
const RECORDER_ACQUIRE_RETRY_MS = 300;
const HIDDEN_RECORDER_STOP_RETRY_MS = 120;
const HIDDEN_RECORDER_STOP_MAX_ATTEMPTS = 3;

const setPlaybackScreenAwake = (keepScreenOn: boolean) => {
  if (typeof Taro.setKeepScreenOn !== "function") return;
  try {
    void Taro.setKeepScreenOn({ keepScreenOn }).catch(() => {});
  } catch {
    // 常亮能力异常不能阻断音频播放本身。
  }
};

const recorderOperationError = (reason: string, error?: unknown) =>
  error || new Error(reason === "busy" ? "录音设备正在收尾，请稍后再试" : "当前录音操作暂不可用");

const getRecorderTimeoutOperation = (error: unknown) => {
  if (!error || typeof error !== "object") return null;
  const detail = error as { code?: unknown; operation?: unknown };
  if (detail.code !== "RECORDER_OPERATION_TIMEOUT") return null;
  return detail.operation === "start" || detail.operation === "stop"
    ? detail.operation
    : null;
};

type NaturalImageSize = { width: number; height: number };
const naturalImageSizeCache = new Map<string, NaturalImageSize>();

const readNaturalImageSize = (value: unknown): NaturalImageSize | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as { width?: unknown; height?: unknown };
  const width = Number(record.width);
  const height = Number(record.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
};

function PracticeControls({ fitted, children }: { fitted: boolean; children: ReactNode }) {
  return fitted ? (
    <ScrollView className='practice-workspace__controls' scrollY>
      {children}
    </ScrollView>
  ) : <View className='practice-workspace__controls'>{children}</View>;
}

function PracticeBookPage({ scrollable, active, imageSize, onScroll, children }: {
  scrollable: boolean;
  active: boolean;
  imageSize: NaturalImageSize | null;
  onScroll?: ScrollViewProps["onScroll"];
  children: ReactNode;
}) {
  const page = (
    <View
      className='practice-book-page'
      style={scrollable && imageSize
        ? { width: `${imageSize.width}px`, height: `${imageSize.height}px` }
        : undefined}
    >
      {children}
    </View>
  );
  return scrollable ? (
    // 离开页归零，当前页允许自由滚动；保留原生节点，避免重建已预加载的图片。
    <ScrollView className='practice-book-scroll' scrollY scrollTop={active ? undefined : 0} onScroll={onScroll}>
      {page}
    </ScrollView>
  ) : page;
}

export function PracticeSession({
  bundle,
  initialPracticeIndex,
  initialPractice,
  layout,
  layoutClassName,
  persistReadingProgress = true,
  onPracticeChange,
  onBindLeaveGuard,
}: {
  bundle: BookPracticeBundle;
  initialPracticeIndex: number;
  initialPractice: ListeningPractice;
  layout: DeviceLayoutState;
  layoutClassName: string;
  persistReadingProgress?: boolean;
  onPracticeChange?: (index: number) => void;
  onBindLeaveGuard?: (guard: () => Promise<boolean>) => void;
}) {
  const isLandscapeLayout = layout.orientation === "landscape";
  const isPadPortraitLayout = layout.isPad && !isLandscapeLayout;
  const isFittedLayout = layout.isPad || isLandscapeLayout;
  const directoryGroups = useMemo(
    () => buildPracticeDirectoryGroups(bundle.practices),
    [bundle]
  );
  const [{ practiceIndex, practice }, setCurrentPractice] = useState({
    practiceIndex: initialPracticeIndex,
    practice: initialPractice,
  });
  const [isDirectoryOpen, setIsDirectoryOpen] = useState(false);
  const [isBookPreviewOpen, setIsBookPreviewOpen] = useState(false);
  const [playingTrackId, setPlayingTrackId] = useState<string | null>(null);
  const [modelPlaybackState, setModelPlaybackState] = useState<"idle" | "playing" | "paused" | "buffering">("idle");
  const [modelPlaybackCurrentTime, setModelPlaybackCurrentTime] = useState(0);
  const [modelPlaybackDuration, setModelPlaybackDuration] = useState(0);
  const [modelSeekPreview, setModelSeekPreview] = useState<number | null>(null);
  const [isModelSeekDragging, setIsModelSeekDragging] = useState(false);
  const [modelPlaybackRate, setModelPlaybackRate] = useState<ModelPlaybackRate>(1);
  const [isModelRateMenuOpen, setIsModelRateMenuOpen] = useState(false);
  const activeModelTrack = useMemo(() => {
    if (!playingTrackId) return null;
    for (const item of bundle.practices) {
      const track = item.tracks.find((candidate) => candidate.id === playingTrackId);
      if (track) return { url: track.url, pageNumber: item.pageNumber };
    }
    return null;
  }, [bundle.practices, playingTrackId]);
  const [recordingMachine, setRecordingMachine] = useState<RecordingMachine>(
    () => createRecordingMachine(),
  );
  const [recorderAcquireAttempt, setRecorderAcquireAttempt] = useState(0);
  const [isRecorderBusy, setIsRecorderBusy] = useState(false);
  const recordingMachineRef = useRef(recordingMachine);
  const recordingState = recordingMachine.state;
  const [tempRecordingPath, setTempRecordingPath] = useState("");
  const [recordingDurationMs, setRecordingDurationMs] = useState(0);
  const [recordingElapsedMs, setRecordingElapsedMs] = useState(0);
  const [isPlayingRecording, setIsPlayingRecording] = useState(false);
  const [hasRecordingPlaybackSession, setHasRecordingPlaybackSession] = useState(false);
  const [recordingPlaybackCurrentTime, setRecordingPlaybackCurrentTime] = useState(0);
  const [recordingPlaybackDuration, setRecordingPlaybackDuration] = useState(0);
  const [recordingSeekPreview, setRecordingSeekPreview] = useState<number | null>(null);
  const [pendingCheckIn, setPendingCheckIn] = useState<PendingCheckIn | null>(null);
  const [isSavingRecording, setIsSavingRecording] = useState(false);
  const [isDeletingRecording, setIsDeletingRecording] = useState(false);
  const [pendingRestoreRefresh, setPendingRestoreRefresh] = useState(0);
  const [bookBounds, setBookBounds] = useState({ width: 0, height: 0 });
  const [bookScrollHintDismissed, setBookScrollHintDismissed] = useState(false);
  const [loadedImage, setLoadedImage] = useState<{
    imageUrl: string;
    size: NaturalImageSize;
  } | null>(null);
  const [bookSwiperCurrent, setBookSwiperCurrent] = useState(practiceIndex);
  const [bookSwiperDuration, setBookSwiperDuration] = useState(PAGE_TURN_DURATION_MS);
  const [bookSwipeLocked, setBookSwipeLocked] = useState(false);
  const [retainedSlideIndexes, setRetainedSlideIndexes] = useState(
    () => new Set(retainPracticeSlideIndexes([], initialPracticeIndex, bundle.practices.length)),
  );
  const modelAudioControllerRef = useRef<ReturnType<
    typeof createTrackAudioController
  > | null>(null);
  const recordingAudioRef = useRef<ReturnType<
    typeof createTrackAudioController
  > | null>(null);
  const recorderOwnerRef = useRef<RecorderOwner | null>(null);
  const recordingTimelineRef = useRef<RecordingTimeline>({
    accumulatedMs: 0,
    activeSinceMs: null,
  });
  const discardedRecordingRef = useRef<{
    sessionId: number;
    operationSeq: number;
  } | null>(null);
  const pendingCheckInRef = useRef<PendingCheckIn | null>(null);
  const recordingPlaybackSnapshotRef = useRef<Pick<PendingCheckIn, "requestId" | "localPath" | "contentSha1"> | null>(null);
  const completionInFlightRef = useRef(false);
  const deletingRecordingRef = useRef(false);
  const bookSwiperCurrentRef = useRef(practiceIndex);
  const pendingSwiperPracticeIndexRef = useRef<number | null>(null);
  const bookSwiperDurationRestoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bookMeasurementSeqRef = useRef(0);
  bookSwiperCurrentRef.current = bookSwiperCurrent;
  const recorderUnsubscribeRef = useRef<(() => void) | null>(null);
  const recorderTerminalSinkRef = useRef<RecorderTerminalSink | null>(null);
  const mountedRef = useRef(true);
  const pageHiddenRef = useRef(false);
  const savingRecordingRef = useRef(false);
  const saveGenerationRef = useRef(0);
  const recordingStartAttemptRef = useRef(0);
  const practiceSwitchAttemptRef = useRef(0);
  const practiceSwitchInFlightRef = useRef(false);
  const pendingRestoreAttemptRef = useRef(0);
  const pendingRestoreSuppressedRef = useRef(false);
  const replacementPendingIdsRef = useRef(new Set<string>());
  const teardownAwaitingStopRef = useRef(false);
  const timedOutStopRef = useRef<{
    machine: RecordingMachine;
    practice: ListeningPractice;
    practiceIndex: number;
  } | null>(null);
  const hiddenStopRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hiddenStopAttemptsRef = useRef(0);
  const practiceContextRef = useRef({ practice, practiceIndex });
  practiceContextRef.current = { practice, practiceIndex };

  const openBookImagePreview = useCallback(() => {
    setIsModelRateMenuOpen(false);
    setIsBookPreviewOpen(true);
  }, []);

  const applyRecordingMachine = useCallback((next: RecordingMachine) => {
    recordingMachineRef.current = next;
    if (mountedRef.current) setRecordingMachine(next);
  }, []);

  useEffect(() => () => {
    if (bookSwiperDurationRestoreTimerRef.current !== null) {
      clearTimeout(bookSwiperDurationRestoreTimerRef.current);
      bookSwiperDurationRestoreTimerRef.current = null;
    }
  }, []);

  const applyPendingCheckIn = useCallback((next: PendingCheckIn | null) => {
    pendingCheckInRef.current = next;
    if (mountedRef.current) setPendingCheckIn(next);
  }, []);

  const removeReplacementBackups = useCallback(async () => {
    const store = getPendingCheckInStore();
    for (const requestId of [...replacementPendingIdsRef.current]) {
      const latest = store.list().find((item) => item.requestId === requestId);
      if (latest?.completedAtMs !== undefined) {
        replacementPendingIdsRef.current.delete(requestId);
        continue;
      }
      if (await store.remove(requestId)) {
        replacementPendingIdsRef.current.delete(requestId);
      }
    }
  }, []);

  const measureBookImage = useMemo(
    () => () => {
      if (!mountedRef.current || pageHiddenRef.current || typeof Taro.createSelectorQuery !== "function") return;
      const requestSeq = ++bookMeasurementSeqRef.current;
      Taro.createSelectorQuery()
        .select(".practice-workspace__book")
        .boundingClientRect((rect) => {
          // 图片加载和窗口变化可能连续发起测量，仅接收仍挂载页面的最新请求。
          if (!mountedRef.current || pageHiddenRef.current || requestSeq !== bookMeasurementSeqRef.current) return;
          if (rect && !Array.isArray(rect) && Number.isFinite(rect.width) && rect.width > 0) {
            const height = Number.isFinite(rect.height) && rect.height > 0 ? rect.height : 0;
            setBookBounds((previous) => previous.width === rect.width && previous.height === height
              ? previous : { width: rect.width, height });
          }
        })
        .exec();
    },
    [],
  );

  useEffect(() => {
    setRetainedSlideIndexes((previous) => {
      const nextIndexes = retainPracticeSlideIndexes(
        previous,
        bookSwiperCurrent,
        bundle.practices.length,
      );
      if (
        nextIndexes.length === previous.size &&
        nextIndexes.every((index) => previous.has(index))
      ) {
        return previous;
      }
      return new Set(nextIndexes);
    });
  }, [bookSwiperCurrent, bundle.practices.length]);

  useEffect(() => {
    const cached = naturalImageSizeCache.get(practice.imageUrl);
    if (cached) {
      setLoadedImage({ imageUrl: practice.imageUrl, size: cached });
      return undefined;
    }
    let cancelled = false;
    if (typeof Taro.getImageInfo !== "function") return undefined;
    Taro.getImageInfo({
      src: practice.imageUrl,
      success: (result) => {
        const size = readNaturalImageSize(result);
        if (cancelled || !size) return;
        naturalImageSizeCache.set(practice.imageUrl, size);
        setLoadedImage({ imageUrl: practice.imageUrl, size });
      },
    });
    return () => {
      cancelled = true;
    };
  }, [practice.imageUrl]);

  const naturalImageSize = loadedImage?.imageUrl === practice.imageUrl
    ? loadedImage.size
    : naturalImageSizeCache.get(practice.imageUrl);
  const bookStableCanvasNaturalSize = readBookStableCanvasSize(bundle.book.id);
  const knownImageSize = readBookImageSize(bundle.book.id, practice.imageIndex) ?? bookStableCanvasNaturalSize;
  const resolvedImageSize = naturalImageSize ?? knownImageSize;
  const phoneColumnWidth = bookBounds.width > 0
    ? bookBounds.width
    : !isFittedLayout && layout.windowWidth > 0
      ? layout.windowWidth * (1 - 24 / 750)
      : 0;
  const stablePortraitCanvasNaturalSize = isLandscapeLayout
    ? null
    : bookStableCanvasNaturalSize;
  const stablePortraitCanvasSize = useMemo(
    () => stablePortraitCanvasNaturalSize
      ? isPadPortraitLayout
        ? bookBounds
        : fitImageToWidth(bookBounds.width, stablePortraitCanvasNaturalSize)
      : null,
    [bookBounds, isPadPortraitLayout, stablePortraitCanvasNaturalSize],
  );
  const fittedBookSize = useMemo(
    () => resolvedImageSize
      ? stablePortraitCanvasSize
        ? fitImageToBounds(stablePortraitCanvasSize, resolvedImageSize)
        : isPadPortraitLayout
          ? fitImageToBounds(bookBounds, resolvedImageSize)
          : fitImageToWidth(isFittedLayout ? bookBounds.width : phoneColumnWidth, resolvedImageSize)
      : null,
    [
      bookBounds,
      isFittedLayout,
      isPadPortraitLayout,
      phoneColumnWidth,
      resolvedImageSize,
      stablePortraitCanvasSize,
    ],
  );
  // 热点优先使用登记尺寸首帧定位，真实图片尺寸返回后再校正。
  const imageSize = fittedBookSize ?? { width: 0, height: 0 };

  useEffect(() => {
    // 阅读区由窗口及布局决定，录音状态不参与教材尺寸计算。
    measureBookImage();
  }, [
    layout.windowHeight,
    layout.windowWidth,
    isFittedLayout,
    isLandscapeLayout,
    measureBookImage,
    practice.imageUrl,
  ]);

  const clampedHotspots = useMemo(
    () => {
      return practice.tracks.map((track) => {
        if (imageSize.width <= 0 || imageSize.height <= 0) return track;
        const anchorOffset = resolveHotspotAnchorOffset(bundle.book.id, bundle.book.seriesId, track.id);
        const originalCenter = {
          left: Number.parseFloat(track.left),
          top: Number.parseFloat(track.top),
        };
        const center = clampHotspotCenter(originalCenter, {
          width: imageSize.width,
          height: imageSize.height,
        }, undefined,
        anchorOffset.offsetXPx,
        anchorOffset.offsetYPx);
        return {
          ...track,
          left: `${center.left}%`,
          top: `${center.top}%`,
        };
      });
    },
    [bundle.book.id, bundle.book.seriesId, imageSize.height, imageSize.width, practice.tracks],
  );

  const clearHiddenStopRetry = useCallback(() => {
    if (hiddenStopRetryTimerRef.current !== null) {
      clearTimeout(hiddenStopRetryTimerRef.current);
      hiddenStopRetryTimerRef.current = null;
    }
    hiddenStopAttemptsRef.current = 0;
  }, []);

  const canStartRecordingNow = useCallback((expected: {
    owner: RecorderOwner | null;
    practiceId: string;
    practiceIndex: number;
    attemptId: number;
  }) => {
    const currentOwner = recorderOwnerRef.current;
    const currentMachine = recordingMachineRef.current;
    const currentPractice = practiceContextRef.current;
    return (
      mountedRef.current &&
      !pageHiddenRef.current &&
      currentOwner !== null &&
      currentOwner === expected.owner &&
      recordingStartAttemptRef.current === expected.attemptId &&
      !practiceSwitchInFlightRef.current &&
      !completionInFlightRef.current &&
      !deletingRecordingRef.current &&
      currentPractice.practice.id === expected.practiceId &&
      currentPractice.practiceIndex === expected.practiceIndex &&
      getRecorderCoordinator().getPhase() === "idle" &&
      !savingRecordingRef.current &&
      currentMachine.mounted &&
      !currentMachine.pendingAction &&
      (currentMachine.state === "idle" ||
        currentMachine.state === "recorded" ||
        currentMachine.state === "error")
    );
  }, []);

  const canContinuePracticeSwitch = useCallback((expected: {
    owner: RecorderOwner | null;
    practiceId: string;
    practiceIndex: number;
    attemptId: number;
  }) => {
    const currentPractice = practiceContextRef.current;
    return (
      mountedRef.current &&
      !pageHiddenRef.current &&
      practiceSwitchAttemptRef.current === expected.attemptId &&
      recorderOwnerRef.current === expected.owner &&
      currentPractice.practice.id === expected.practiceId &&
      currentPractice.practiceIndex === expected.practiceIndex
    );
  }, []);

  const runRecorderAction = useCallback((
    action: RecorderAction,
    pauseReason: Exclude<PauseReason, null> = "user",
    silent = false,
  ) => {
    const owner = recorderOwnerRef.current;
    if (!owner) return false;
    const before = recordingMachineRef.current;
    const requested = requestRecorderAction(
      before,
      action,
      pauseReason,
    );
    if (!requested.command) return false;
    applyRecordingMachine(requested.machine);

    const nativeResult =
      action === "start"
        ? owner.start(RECORDER_OPTIONS)
        : action === "pause"
          ? owner.pause()
          : action === "resume"
            ? owner.resume()
            : owner.stop();
    if (nativeResult.ok) return true;

    const error = recorderOperationError(
      nativeResult.reason,
      "error" in nativeResult ? nativeResult.error : undefined,
    );
    if (action !== "start") {
      // 同步暂停、继续或结束失败时原生会话仍可能存活，保留原状态以便用户再次操作或结束。
      applyRecordingMachine(before);
    } else {
      applyRecordingMachine(
        resolveRecorderCallback(requested.machine, {
          type: "error",
          sessionId: requested.command.sessionId,
          operationSeq: requested.command.operationSeq,
          error,
        }),
      );
    }
    if (!silent) {
      void Taro.showModal({
        title: "录音操作失败",
        content: getRecordingErrorMessage(error),
        showCancel: false,
      });
    }
    return false;
  }, [applyRecordingMachine]);

  const stopRecorderWhileHidden = useCallback(function stopRecorderWhileHidden(
    restartAttempts = false,
  ) {
    if (restartAttempts) clearHiddenStopRetry();
    if (!mountedRef.current || !pageHiddenRef.current) {
      clearHiddenStopRetry();
      return false;
    }

    const owner = recorderOwnerRef.current;
    const current = recordingMachineRef.current;
    const teardown = requestRecorderTeardown(current);
    if (!owner || (!teardown.command && current.state !== "stopping")) {
      clearHiddenStopRetry();
      return false;
    }

    if (teardown.command) applyRecordingMachine(teardown.machine);
    hiddenStopAttemptsRef.current += 1;
    const stopped = owner.stop();
    if (stopped.ok) {
      clearHiddenStopRetry();
      return true;
    }

    if (teardown.command) {
      // stop 同步失败表示原生录音可能仍活着；恢复旧状态才能接住迟到的 Start/Resume。
      applyRecordingMachine(current);
    }
    if (
      hiddenStopAttemptsRef.current < HIDDEN_RECORDER_STOP_MAX_ATTEMPTS &&
      hiddenStopRetryTimerRef.current === null
    ) {
      hiddenStopRetryTimerRef.current = setTimeout(() => {
        hiddenStopRetryTimerRef.current = null;
        stopRecorderWhileHidden();
      }, HIDDEN_RECORDER_STOP_RETRY_MS);
    }
    return false;
  }, [applyRecordingMachine, clearHiddenStopRetry]);

  const clearRecordingView = useCallback(() => {
    recordingAudioRef.current?.stop();
    if (mountedRef.current) {
      setIsPlayingRecording(false);
      setHasRecordingPlaybackSession(false);
      setRecordingPlaybackCurrentTime(0);
      setRecordingPlaybackDuration(0);
      setRecordingSeekPreview(null);
      setTempRecordingPath("");
      setRecordingDurationMs(0);
      setRecordingElapsedMs(0);
    }
    recordingTimelineRef.current = { accumulatedMs: 0, activeSinceMs: null };
  }, []);

  const releaseRecorderOwner = useCallback(() => {
    clearHiddenStopRetry();
    teardownAwaitingStopRef.current = false;
    recorderUnsubscribeRef.current?.();
    recorderUnsubscribeRef.current = null;
    recorderTerminalSinkRef.current = null;
    const owner = recorderOwnerRef.current;
    recorderOwnerRef.current = null;
    owner?.release();
    recordingMachineRef.current = disposeRecordingMachine(recordingMachineRef.current);
  }, [clearHiddenStopRetry]);

  useEffect(() => {
    const modelAudioController = createTrackAudioController(
      () => Taro.createInnerAudioContext(),
      (trackId) => {
        if (trackId === null) setPlaybackScreenAwake(false);
        if (mountedRef.current && !pageHiddenRef.current) {
          setPlayingTrackId(trackId);
          setModelPlaybackState(trackId ? "buffering" : "idle");
          setModelPlaybackCurrentTime(0);
          setModelPlaybackDuration(0);
          setModelSeekPreview(null);
          setIsModelSeekDragging(false);
          setIsModelRateMenuOpen(false);
        }
      },
      (error) => {
        console.error("示范音频播放失败", error.errCode, error.errMsg);
        if (mountedRef.current && !pageHiddenRef.current) {
          Taro.showToast({ title: "示范音频播放失败", icon: "none" });
        }
      },
      {
        onPlay: () => {
          setPlaybackScreenAwake(true);
          if (mountedRef.current && !pageHiddenRef.current) {
            setModelPlaybackState("playing");
          }
        },
        onPause: () => {
          setPlaybackScreenAwake(false);
          if (mountedRef.current && !pageHiddenRef.current) {
            setModelPlaybackState("paused");
          }
        },
        onWaiting: () => {
          setPlaybackScreenAwake(true);
          if (mountedRef.current && !pageHiddenRef.current) {
            setModelPlaybackState("buffering");
          }
        },
        onCanplay: (willResume) => {
          if (!willResume) return;
          setPlaybackScreenAwake(true);
          if (mountedRef.current && !pageHiddenRef.current) {
            setModelPlaybackState("playing");
          }
        },
        onTimeUpdate: (currentTime, duration) => {
          if (mountedRef.current && !pageHiddenRef.current) {
            setModelPlaybackCurrentTime(currentTime);
            setModelPlaybackDuration(duration);
          }
        },
      },
      { sameTrackAction: "pause", loop: true },
    );
    modelAudioControllerRef.current = modelAudioController;

    const recordingAudioController = createTrackAudioController(
      () => Taro.createInnerAudioContext(),
      (trackId) => {
        if (trackId === null) setPlaybackScreenAwake(false);
        if (mountedRef.current && !pageHiddenRef.current) {
          setHasRecordingPlaybackSession(trackId !== null);
          if (trackId === null) {
            setIsPlayingRecording(false);
            setRecordingPlaybackCurrentTime(0);
            setRecordingPlaybackDuration(0);
            setRecordingSeekPreview(null);
            setIsModelSeekDragging(false);
          }
        }
      },
      (error) => {
        const snapshot = recordingPlaybackSnapshotRef.current;
        if (snapshot) void diagnoseLocalRecordingFailure(snapshot, error);
        if (mountedRef.current && !pageHiddenRef.current) {
          Taro.showToast({ title: "录音回听失败", icon: "none" });
        }
      },
      {
        onPlay: () => {
          setPlaybackScreenAwake(true);
          if (mountedRef.current && !pageHiddenRef.current) {
            setIsPlayingRecording(true);
          }
        },
        onPause: () => {
          setPlaybackScreenAwake(false);
          if (mountedRef.current && !pageHiddenRef.current) {
            setIsPlayingRecording(false);
          }
        },
        onTimeUpdate: (currentTime, duration) => {
          if (mountedRef.current && !pageHiddenRef.current) {
            setRecordingPlaybackCurrentTime(currentTime);
            setRecordingPlaybackDuration(duration);
          }
        },
      },
    );
    recordingAudioRef.current = recordingAudioController;

    const onAudioInterruptionBegin = () => {
      const modelWasPlaying = modelAudioController.handleInterruptionBegin();
      const recordingWasPlaying = recordingAudioController.handleInterruptionBegin();
      if (modelWasPlaying || recordingWasPlaying) setPlaybackScreenAwake(false);
    };
    const onAudioInterruptionEnd = () => {
      modelAudioController.handleInterruptionEnd();
      recordingAudioController.handleInterruptionEnd();
    };
    if (typeof Taro.onAudioInterruptionBegin === "function") {
      Taro.onAudioInterruptionBegin(onAudioInterruptionBegin);
    }
    if (typeof Taro.onAudioInterruptionEnd === "function") {
      Taro.onAudioInterruptionEnd(onAudioInterruptionEnd);
    }

    return () => {
      if (typeof Taro.offAudioInterruptionBegin === "function") {
        Taro.offAudioInterruptionBegin(onAudioInterruptionBegin);
      }
      if (typeof Taro.offAudioInterruptionEnd === "function") {
        Taro.offAudioInterruptionEnd(onAudioInterruptionEnd);
      }
      // 卸载只释放会话，不再向即将卸载的页面写播放状态。
      modelAudioController.dispose();
      recordingAudioController.dispose();
      setPlaybackScreenAwake(false);
      modelAudioControllerRef.current = null;
      recordingAudioRef.current = null;
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    let acquireRetryTimer: ReturnType<typeof setTimeout> | null = null;
    const acquired = getRecorderCoordinator().acquire();
    if (!acquired.ok) {
      if (acquired.reason === "busy") {
        setIsRecorderBusy(true);
        // 上一页的原生 stop 仍在静默收尾时保持 checking，低频重试而不是误报设备不支持。
        acquireRetryTimer = setTimeout(() => {
          acquireRetryTimer = null;
          if (mountedRef.current) {
            setRecorderAcquireAttempt((attempt) => attempt + 1);
          }
        }, RECORDER_ACQUIRE_RETRY_MS);
        return () => {
          mountedRef.current = false;
          if (acquireRetryTimer !== null) clearTimeout(acquireRetryTimer);
        };
      }
      setIsRecorderBusy(false);
      applyRecordingMachine(
        resolveRecordingCapabilities(recordingMachineRef.current, {
          canRecord: false,
          canPause: false,
          canResume: false,
          canInterrupt: false,
        }),
      );
      return () => {
        mountedRef.current = false;
        recordingMachineRef.current = disposeRecordingMachine(recordingMachineRef.current);
      };
    }

    const { owner, capabilities } = acquired;
    setIsRecorderBusy(false);
    recorderOwnerRef.current = owner;
    applyRecordingMachine(
      resolveRecordingCapabilities(recordingMachineRef.current, capabilities),
    );

    const handleStart = () => {
      const current = recordingMachineRef.current;
      const next = resolveRecorderCallback(current, {
        type: "start",
        sessionId: current.sessionId,
        operationSeq: current.operationSeq,
      });
      if (next === current) return;
      recordingTimelineRef.current = startRecordingTimeline(Date.now());
      setRecordingElapsedMs(0);
      applyRecordingMachine(next);

      // 页面在原生 start 确认前已进入后台时，不允许录音继续悄悄运行。
      if (pageHiddenRef.current) {
        stopRecorderWhileHidden(true);
      }
    };

    const handlePause = () => {
      const current = recordingMachineRef.current;
      const next = resolveRecorderCallback(current, {
        type: "pause",
        sessionId: current.sessionId,
        operationSeq: current.operationSeq,
      });
      if (next === current) return;
      recordingTimelineRef.current = pauseRecordingTimeline(
        recordingTimelineRef.current,
        Date.now(),
      );
      setRecordingElapsedMs(recordingTimelineRef.current.accumulatedMs);
      applyRecordingMachine(next);
    };

    const handleResume = () => {
      const current = recordingMachineRef.current;
      const next = resolveRecorderCallback(current, {
        type: "resume",
        sessionId: current.sessionId,
        operationSeq: current.operationSeq,
      });
      if (next === current) return;
      recordingTimelineRef.current = resumeRecordingTimeline(
        recordingTimelineRef.current,
        Date.now(),
      );
      applyRecordingMachine(next);

      // resume 回调可能晚于页面隐藏；确认后立刻重新暂停，旧机型则直接安全停止。
      if (pageHiddenRef.current) {
        if (next.capabilities?.canPause && next.capabilities.canResume) {
          if (!runRecorderAction("pause", "background", true)) {
            stopRecorderWhileHidden(true);
          }
        } else {
          stopRecorderWhileHidden(true);
        }
      }
    };

    const handleStop = async (result: RecorderNativeStopResult) => {
      const releaseAfterStop = teardownAwaitingStopRef.current;
      const liveCurrent = recordingMachineRef.current;
      const timedOutStop = timedOutStopRef.current;
      const current = timedOutStop?.machine ?? liveCurrent;
      const next = resolveRecorderCallback(current, {
        type: "stop",
        sessionId: current.sessionId,
        operationSeq: current.operationSeq,
      });
      if (next === current) {
        if (releaseAfterStop) releaseRecorderOwner();
        return;
      }
      const stoppedContext = timedOutStop ?? practiceContextRef.current;
      const liveContext = practiceContextRef.current;
      const livePending = pendingCheckInRef.current;
      const restoredReplacement = Boolean(
        livePending &&
        liveCurrent.state === "recorded" &&
        replacementPendingIdsRef.current.has(livePending.requestId)
      );
      const attachToCurrentPage = !timedOutStop || (
        mountedRef.current &&
        liveContext.practiceIndex === timedOutStop.practiceIndex &&
        liveContext.practice.id === timedOutStop.practice.id &&
        (liveCurrent.state === "error" || restoredReplacement)
      );
      timedOutStopRef.current = null;
      if (attachToCurrentPage) applyRecordingMachine(next);

      const canAttachStoppedRecording = () => {
        const currentContext = practiceContextRef.current;
        return (
          attachToCurrentPage &&
          mountedRef.current &&
          currentContext.practice.id === stoppedContext.practice.id &&
          currentContext.practiceIndex === stoppedContext.practiceIndex
        );
      };

      const preserveRestoredReplacement = () => {
        if (
          !canAttachStoppedRecording() ||
          !restoredReplacement ||
          !livePending ||
          pendingCheckInRef.current?.requestId !== livePending.requestId
        ) {
          return false;
        }
        // 新录音无效或保存失败时，旧副本仍是唯一可用数据，必须继续挂在页面供回听。
        replacementPendingIdsRef.current.delete(livePending.requestId);
        applyPendingCheckIn(livePending);
        if (mountedRef.current) {
          setTempRecordingPath(livePending.localPath);
          setRecordingDurationMs(livePending.durationMs);
          setRecordingElapsedMs(livePending.durationMs);
        }
        applyRecordingMachine(restoreRecordedMachine(recordingMachineRef.current));
        return true;
      };

      const discardedRecording = discardedRecordingRef.current;
      const shouldDiscard = Boolean(
        discardedRecording &&
        discardedRecording.sessionId === current.sessionId &&
        discardedRecording.operationSeq === current.operationSeq
      );
      if (shouldDiscard) {
        discardedRecordingRef.current = null;
        if (attachToCurrentPage) {
          clearRecordingView();
          applyRecordingMachine(resetRecordingMachine(next));
        }
        if (releaseAfterStop) releaseRecorderOwner();
        return;
      }

      const parsed = parseNativeRecordingResult(result);
      if (!parsed.ok) {
        if (attachToCurrentPage && !preserveRestoredReplacement()) {
          clearRecordingView();
          applyRecordingMachine(resetRecordingMachine(next));
        }
        if (attachToCurrentPage && mountedRef.current) {
          Taro.showToast({ title: parsed.message, icon: "none" });
        }
        if (releaseAfterStop) releaseRecorderOwner();
        return;
      }

      const generation = ++saveGenerationRef.current;
      savingRecordingRef.current = true;
      if (mountedRef.current) setIsSavingRecording(true);
      const { practice: stoppedPractice, practiceIndex: stoppedIndex } =
        stoppedContext;

      // 录音一停止就先移入小程序持久文件，再允许用户上传、切页或重录。
      try {
        const saved = await getPendingCheckInStore().saveRecording({
          tempFilePath: parsed.tempFilePath,
          durationMs: parsed.durationMs,
          fileSizeBytes: parsed.fileSizeBytes,
          context: {
            bookId: bundle.book.id,
            bookTitle: bundle.book.title,
            practiceId: stoppedPractice.id,
            practiceIndex: stoppedIndex,
            pageNumber: stoppedPractice.pageNumber,
            sectionTitle: stoppedPractice.sectionTitle,
            imageUrl: stoppedPractice.imageUrl,
          },
        });
        if (generation !== saveGenerationRef.current) return;
        const attachSavedRecording = canAttachStoppedRecording();
        if (attachSavedRecording) {
          applyPendingCheckIn(saved.item);
          if (mountedRef.current) {
            setTempRecordingPath(saved.item.localPath);
            setRecordingDurationMs(saved.item.durationMs);
            setRecordingElapsedMs(saved.item.durationMs);
          }
        }
        if (attachSavedRecording && saved.message) {
          void Taro.showModal({
            title: saved.persisted ? "录音已保存" : "录音仅临时保存",
            content: saved.message,
            showCancel: false,
          });
        }
        // 新录音已经有可恢复副本后再清理旧版本；清理失败不影响本次录音的保存结果。
        if (saved.persisted) {
          try {
            await removeReplacementBackups();
          } catch (_error) {
            // 旧副本会继续留在“我的打卡”中，后续仍可手动清理。
          }
        }
      } catch (error) {
        if (canAttachStoppedRecording() && generation === saveGenerationRef.current) {
          if (!preserveRestoredReplacement()) {
            clearRecordingView();
            applyRecordingMachine(resetRecordingMachine(recordingMachineRef.current));
          }
          if (mountedRef.current) {
            void Taro.showModal({
              title: "录音保存失败",
              content: getRecordingErrorMessage(error),
              showCancel: false,
            });
          }
        }
      } finally {
        if (generation === saveGenerationRef.current) {
          savingRecordingRef.current = false;
          if (mountedRef.current) setIsSavingRecording(false);
        }
        // 卸载后的 terminal 由协调器保留到本地持久化真正结束，再允许下一页开始录音。
        if (releaseAfterStop) releaseRecorderOwner();
      }
    };

    const handleError = (error: unknown) => {
      const current = recordingMachineRef.current;
      const timeoutOperation = getRecorderTimeoutOperation(error);
      const terminalMachine = timedOutStopRef.current?.machine ?? current;
      const discardedRecording = discardedRecordingRef.current;
      const matchesDiscardedRecording = Boolean(
        discardedRecording &&
        discardedRecording.sessionId === terminalMachine.sessionId &&
        discardedRecording.operationSeq === terminalMachine.operationSeq
      );
      if (matchesDiscardedRecording && timeoutOperation !== "stop") {
        // 废弃 stop 已以错误结束，不得让裸标记继续误吞下一次训练的新录音。
        discardedRecordingRef.current = null;
      }
      const recoverableStop = timeoutOperation === "stop"
        ? resolveRecorderCallback(current, {
            type: "stop",
            sessionId: current.sessionId,
            operationSeq: current.operationSeq,
          })
        : current;
      if (recoverableStop !== current) {
        // UI 先退出等待态，但保留原停止命令与训练上下文，迟到 onStop 仍能安全落盘。
        timedOutStopRef.current = {
          machine: current,
          ...practiceContextRef.current,
        };
      } else if (!timeoutOperation) {
        timedOutStopRef.current = null;
      }
      const next = resolveRecorderCallback(current, {
        type: "error",
        sessionId: current.sessionId,
        operationSeq: current.operationSeq,
        error,
      });
      if (next === current) return;
      recordingTimelineRef.current = pauseRecordingTimeline(
        recordingTimelineRef.current,
        Date.now(),
      );
      applyRecordingMachine(next);
      if (teardownAwaitingStopRef.current) {
        releaseRecorderOwner();
      } else {
        void Taro.showModal({
          title: "录音未完成",
          content: getRecordingErrorMessage(error),
          showCancel: false,
        });
      }
    };

    recorderTerminalSinkRef.current = (event) =>
      event.type === "stop" ? handleStop(event.result) : handleError(event.error);

    const subscription = owner.subscribe({
      onStart: handleStart,
      onPause: handlePause,
      onResume: handleResume,
      onStop: handleStop,
      onError: handleError,
      onInterruptionBegin: () => {
        const current = recordingMachineRef.current;
        const handled = handleInterruptionBegin(current);
        if (handled.machine === current) return;
        recordingTimelineRef.current = pauseRecordingTimeline(
          recordingTimelineRef.current,
          Date.now(),
        );
        setRecordingElapsedMs(recordingTimelineRef.current.accumulatedMs);
        applyRecordingMachine(handled.machine);
      },
      onInterruptionEnd: () => {
        const current = recordingMachineRef.current;
        applyRecordingMachine(handleInterruptionEnd(current).machine);
      },
    });
    if (subscription.ok) recorderUnsubscribeRef.current = subscription.unsubscribe;

    return () => {
      mountedRef.current = false;
      if (!teardownAwaitingStopRef.current) releaseRecorderOwner();
    };
  }, [
    applyPendingCheckIn,
    applyRecordingMachine,
    bundle.book.id,
    bundle.book.title,
    clearRecordingView,
    releaseRecorderOwner,
    removeReplacementBackups,
    recorderAcquireAttempt,
    runRecorderAction,
    stopRecorderWhileHidden,
  ]);

  useEffect(() => {
    if (pendingRestoreSuppressedRef.current) return undefined;
    if (
      recordingState !== "idle" &&
      recordingState !== "unsupported" &&
      recordingState !== "error"
    ) return undefined;
    let active = true;
    const store = getPendingCheckInStore();
    const requestedContext = practiceContextRef.current;
    const expectedOwner = recorderOwnerRef.current;
    const attemptId = pendingRestoreAttemptRef.current + 1;
    pendingRestoreAttemptRef.current = attemptId;
    const canContinueRestore = () => {
      const currentContext = practiceContextRef.current;
      return (
        active &&
        mountedRef.current &&
        !pageHiddenRef.current &&
        pendingRestoreAttemptRef.current === attemptId &&
        recorderOwnerRef.current === expectedOwner &&
        currentContext.practice.id === requestedContext.practice.id &&
        currentContext.practiceIndex === requestedContext.practiceIndex
      );
    };

    void (async () => {
      await store.ready();
      if (!canContinueRestore()) return;
      await store.cleanup();
      if (!canContinueRestore()) return;
      const current = recordingMachineRef.current;
      const canRestorePending =
        canContinueRestore() &&
        !pendingCheckInRef.current &&
        !savingRecordingRef.current &&
        !current.pendingAction &&
        (current.state === "idle" ||
          current.state === "unsupported" ||
          current.state === "error");
      // ready/cleanup 都可能跨过一次用户操作；恢复前必须以最新状态为准，不能覆盖新录音。
      if (!canRestorePending) return;
      // Think 续页加入后列表索引会变化，旧草稿仍以稳定的教材页 ID 匹配。
      const restored = [...store.list()]
        .filter((item) =>
          item.completedAtMs === undefined &&
          item.context.bookId === bundle.book.id &&
          item.context.practiceId === requestedContext.practice.id,
        )
        .sort((left, right) => right.updatedAtMs - left.updatedAtMs)[0];
      if (!restored || !canContinueRestore()) return;

      const restoredMachine = restoreRecordedMachine(current);
      if (
        restoredMachine === current ||
        recordingMachineRef.current !== current ||
        pendingCheckInRef.current ||
        savingRecordingRef.current ||
        !canContinueRestore()
      ) return;

      // stop 超时等待迟到 terminal 时，恢复旧录音只用于兜底回听，仍保留“待替换”标记。
      if (!timedOutStopRef.current) {
        replacementPendingIdsRef.current.delete(restored.requestId);
      }
      applyRecordingMachine(restoredMachine);
      applyPendingCheckIn(restored);
      setTempRecordingPath(restored.localPath);
      setRecordingDurationMs(restored.durationMs);
      setRecordingElapsedMs(restored.durationMs);
    })().catch(() => {
      // 本地缓存读取失败不阻断教材与示范音频，用户仍可重新录制。
    });

    return () => {
      active = false;
      if (pendingRestoreAttemptRef.current === attemptId) {
        pendingRestoreAttemptRef.current += 1;
      }
    };
  }, [
    applyPendingCheckIn,
    applyRecordingMachine,
    bundle.book.id,
    bundle.book.seriesId,
    practice.id,
    practiceIndex,
    pendingRestoreRefresh,
    recordingState,
  ]);

  useEffect(() => {
    if (recordingState !== "recording") return undefined;

    const timer = setInterval(() => {
      setRecordingElapsedMs(
        getRecordingElapsedMs(recordingTimelineRef.current, Date.now())
      );
    }, 250);
    return () => clearInterval(timer);
  }, [recordingState]);

  const handlePracticeHidden = useCallback(() => {
    if (pageHiddenRef.current) return;
    // 权限弹窗返回前曾进过后台的点击必须作废，即使页面随后又恢复显示也不能自动开麦。
    recordingStartAttemptRef.current += 1;
    practiceSwitchAttemptRef.current += 1;
    pendingRestoreAttemptRef.current += 1;
    pageHiddenRef.current = true;
    bookMeasurementSeqRef.current += 1;
    // 页面隐藏后停止两路播放；录音优先暂停，旧机型不支持暂停时安全停止。
    stopPracticePlayback(
      modelAudioControllerRef.current,
      recordingAudioRef.current,
    );
    setPlayingTrackId(null);
    setModelPlaybackState("idle");
    setModelPlaybackCurrentTime(0);
    setModelPlaybackDuration(0);
    setModelSeekPreview(null);
    setIsModelSeekDragging(false);
    setIsModelRateMenuOpen(false);
    setIsPlayingRecording(false);
    setHasRecordingPlaybackSession(false);
    setRecordingPlaybackCurrentTime(0);
    setRecordingPlaybackDuration(0);
    setRecordingSeekPreview(null);

    const current = recordingMachineRef.current;
    if (current.state === "starting") {
      // start 已交给微信但尚未确认时也可能已经占用麦克风，切后台必须覆盖为 stop。
      stopRecorderWhileHidden(true);
      return;
    }
    if (current.state === "recording") {
      if (current.capabilities?.canPause && current.capabilities.canResume) {
        if (!runRecorderAction("pause", "background", true)) {
          stopRecorderWhileHidden(true);
        }
      } else {
        stopRecorderWhileHidden(true);
      }
    }
  }, [runRecorderAction, stopRecorderWhileHidden]);

  useEffect(() => {
    if (typeof Taro.onAppHide !== "function") return undefined;
    const handleAppHide = () => {
      handlePracticeHidden();
    };
    Taro.onAppHide(handleAppHide);
    return () => {
      if (typeof Taro.offAppHide === "function") Taro.offAppHide(handleAppHide);
    };
  }, [handlePracticeHidden]);

  useDidShow(() => {
    const wasHidden = pageHiddenRef.current;
    pageHiddenRef.current = false;
    // 后台旋转可能暂时没有有效布局；回到前台后重新读取可见阅读区。
    if (wasHidden || isFittedLayout) {
      if (typeof Taro.nextTick === "function") Taro.nextTick(measureBookImage);
      else measureBookImage();
    }
    const visiblePractice = practiceContextRef.current;
    if (persistReadingProgress) {
      saveFullReadingProgress(bundle.book.id, visiblePractice.practice.imageIndex);
    }
    clearHiddenStopRetry();
    // 重试可能在后台完成，返回时用同一录音的最新快照恢复路径和持久状态。
    const latest = getPendingCheckInStore().list().find((item) => item.requestId === pendingCheckInRef.current?.requestId);
    if (latest) {
      applyPendingCheckIn(latest);
      setTempRecordingPath(latest.localPath);
    }
    if (wasHidden) {
      setPendingRestoreRefresh((refresh) => refresh + 1);
    }
  });

  useDidHide(() => {
    handlePracticeHidden();
  });

  useUnload(() => {
    recordingStartAttemptRef.current += 1;
    practiceSwitchAttemptRef.current += 1;
    pendingRestoreAttemptRef.current += 1;
    pageHiddenRef.current = true;
    mountedRef.current = false;
    clearHiddenStopRetry();
    const owner = recorderOwnerRef.current;
    const current = recordingMachineRef.current;
    const teardown = requestRecorderTeardown(current);

    if (!owner || (!teardown.command && current.state !== "stopping")) {
      releaseRecorderOwner();
      return;
    }

    // 返回或重定向离页也要等待一次原生 stop，把已录内容交给本地待上传队列。
    teardownAwaitingStopRef.current = true;
    if (teardown.command) {
      applyRecordingMachine(teardown.machine);
    }

    const terminalSink = recorderTerminalSinkRef.current;
    const released = owner.release({ terminalSink: terminalSink || undefined });
    // release 已把普通 listener 清空；只保留协调器内部的一次 terminal sink。
    recorderOwnerRef.current = null;
    recorderUnsubscribeRef.current = null;
    recorderTerminalSinkRef.current = null;
    if (!released.ok) {
      teardownAwaitingStopRef.current = false;
      recordingMachineRef.current = disposeRecordingMachine(recordingMachineRef.current);
    }
  });

  const playModelAudio = (trackId: string, url: string) => {
    const controller = modelAudioControllerRef.current;
    if (!controller || recordingState === "uploading") return;

    recordingAudioRef.current?.stop();
    // 示范音频由用户手动控制，录音中和暂停时也允许播放或切换。
    if (playingTrackId && activeModelTrack?.url === url) {
      controller.toggle(playingTrackId, url);
      return;
    }
    controller.toggle(trackId, url);
  };

  const toggleModelPlayback = () => {
    if (!playingTrackId || !activeModelTrack) return;
    setIsModelRateMenuOpen(false);
    modelAudioControllerRef.current?.toggle(playingTrackId, activeModelTrack.url);
  };

  const handleModelSeekChanging = (event: { detail: { value: number } }) => {
    const value = Number(event.detail.value);
    if (!Number.isFinite(value)) return;
    const boundedValue = modelPlaybackDuration > 0
      ? Math.min(Math.max(0, value), modelPlaybackDuration)
      : Math.max(0, value);
    setIsModelRateMenuOpen(false);
    setIsModelSeekDragging(true);
    setModelSeekPreview(boundedValue);
  };

  const handleModelSeekChange = (event: { detail: { value: number } }) => {
    const value = Number(event.detail.value);
    if (Number.isFinite(value)) {
      const boundedValue = modelPlaybackDuration > 0
        ? Math.min(Math.max(0, value), modelPlaybackDuration)
        : Math.max(0, value);
      modelAudioControllerRef.current?.seek(boundedValue);
      setModelPlaybackCurrentTime(boundedValue);
    }
    setModelSeekPreview(null);
    setIsModelSeekDragging(false);
  };

  const selectModelPlaybackRate = (nextRate: ModelPlaybackRate) => {
    const controller = modelAudioControllerRef.current;
    if (!controller) return;
    controller.setPlaybackRate(nextRate);
    setModelPlaybackRate(nextRate);
    setIsModelRateMenuOpen(false);
  };

  const removeCurrentPending = async () => {
    const pending = pendingCheckInRef.current;
    if (!pending) return true;
    const latest = getPendingCheckInStore().list().find(
      (item) => item.requestId === pending.requestId,
    );
    if (latest?.completedAtMs !== undefined) {
      applyPendingCheckIn(null);
      return true;
    }
    const removed = await getPendingCheckInStore().remove(pending.requestId);
    if (!removed) {
      void Taro.showModal({
        title: "本地录音未删除",
        content: "请先到“我的打卡”清理这条录音后再试。",
        showCancel: false,
      });
      return false;
    }
    // 删除等待期间可能已有更新的录音落盘，只能摘掉本次实际删除的那一条。
    if (pendingCheckInRef.current?.requestId === pending.requestId) {
      applyPendingCheckIn(null);
    }
    return true;
  };

  const confirmLeaveRef = useRef<() => Promise<boolean>>(async () => true);
  confirmLeaveRef.current = async () => {
    if (deletingRecordingRef.current) return false;
    const state = recordingMachineRef.current.state;
    if (getPracticeSwitchPolicy(state) !== "confirm-discard") return true;
    const confirmation = await Taro.showModal({
      title: "切换训练？",
      content: "切换后将放弃当前录音，是否继续？",
      confirmText: "放弃录音",
      confirmColor: "#d85b3f",
    });
    if (!confirmation.confirm) return false;
    if (state === "recording" || state === "paused") {
      runRecorderAction("stop");
    }
    await removeCurrentPending();
    return true;
  };

  useEffect(() => {
    onBindLeaveGuard?.(() => confirmLeaveRef.current());
    return () => {
      onBindLeaveGuard?.(async () => true);
    };
  }, [onBindLeaveGuard]);

  const performPracticeSwitch = async (nextIndex: number, switchRequest: {
    owner: RecorderOwner | null;
    practiceId: string;
    practiceIndex: number;
    attemptId: number;
    saveGeneration: number;
  }, options?: { preserveRecording?: boolean }) => {
    const beforeRemoval = recordingMachineRef.current;
    if (
      !canContinuePracticeSwitch(switchRequest) ||
      savingRecordingRef.current ||
      completionInFlightRef.current ||
      beforeRemoval.pendingAction ||
      beforeRemoval.state === "starting" ||
      beforeRemoval.state === "stopping" ||
      beforeRemoval.state === "uploading"
    ) {
      Taro.showToast({ title: "录音正在处理，请稍候", icon: "none" });
      return;
    }
    if (options?.preserveRecording) {
      const nextPractice = bundle.practices[nextIndex];
      pendingRestoreSuppressedRef.current = false;
      practiceContextRef.current = { practiceIndex: nextIndex, practice: nextPractice };
      setBookScrollHintDismissed(true);
      setBookSwiperCurrent(nextIndex);
      setCurrentPractice({ practiceIndex: nextIndex, practice: nextPractice });
      void Taro.pageScrollTo({ scrollTop: 0, duration: 0 });
      if (persistReadingProgress) saveFullReadingProgress(bundle.book.id, nextPractice.imageIndex);
      onPracticeChange?.(nextIndex);
      return;
    }
    if (!(await removeCurrentPending())) return;
    if (!canContinuePracticeSwitch(switchRequest)) {
      const current = recordingMachineRef.current;
      if (!pendingCheckInRef.current && (current.state === "recorded" || current.state === "error")) {
        clearRecordingView();
        applyRecordingMachine(resetRecordingMachine(current));
      }
      return;
    }

    const canCommitSwitch = () => (
      canContinuePracticeSwitch(switchRequest) &&
      !savingRecordingRef.current &&
      saveGenerationRef.current === switchRequest.saveGeneration &&
      pendingCheckInRef.current === null
    );
    if (!canCommitSwitch()) {
      Taro.showToast({ title: "录音状态已更新，请确认后再切换", icon: "none" });
      return;
    }

    const current = recordingMachineRef.current;
    if (
      savingRecordingRef.current ||
      current.pendingAction ||
      current.state === "starting" ||
      current.state === "stopping" ||
      current.state === "uploading"
    ) {
      Taro.showToast({ title: "录音正在处理，请稍候", icon: "none" });
      return;
    }

    if (current.state === "recording" || current.state === "paused") {
      const stopRequest = requestRecorderAction(current, "stop");
      if (!stopRequest.command) return;
      // 丢弃意图绑定到本次 stop；旧会话失败或超时不能误吞下一训练的 terminal。
      discardedRecordingRef.current = {
        sessionId: stopRequest.command.sessionId,
        operationSeq: stopRequest.command.operationSeq,
      };
      if (!runRecorderAction("stop")) {
        discardedRecordingRef.current = null;
        return;
      }
    } else {
      applyRecordingMachine(resetRecordingMachine(current));
      clearRecordingView();
    }
    // 示范音频独立于书页切换，翻页只更换教材与录音上下文。
    // 放弃新录音并切换训练时，之前保留的旧录音继续留在“我的打卡”。
    replacementPendingIdsRef.current.clear();
    if (!canCommitSwitch()) {
      Taro.showToast({ title: "录音状态已更新，请确认后再切换", icon: "none" });
      return;
    }
    const nextPractice = bundle.practices[nextIndex];
    // 同步提交上下文后再 setState，切页提交后的迟到录音不能趁下一次 render 前挂到新训练。
    pendingRestoreAttemptRef.current += 1;
    pendingRestoreSuppressedRef.current = false;
    practiceContextRef.current = { practiceIndex: nextIndex, practice: nextPractice };
    setBookScrollHintDismissed(true);
    setBookSwiperCurrent(nextIndex);
    setCurrentPractice({ practiceIndex: nextIndex, practice: nextPractice });
    // 页面允许纵向滚动后，成功切页应从新教材顶部开始阅读。
    void Taro.pageScrollTo({ scrollTop: 0, duration: 0 });
    if (persistReadingProgress) saveFullReadingProgress(bundle.book.id, nextPractice.imageIndex);
    onPracticeChange?.(nextIndex);
  };

  const scheduleBookSwiperAnimationRestore = () => {
    if (bookSwiperDurationRestoreTimerRef.current !== null) {
      clearTimeout(bookSwiperDurationRestoreTimerRef.current);
    }
    bookSwiperDurationRestoreTimerRef.current = setTimeout(() => {
      bookSwiperDurationRestoreTimerRef.current = null;
      if (mountedRef.current) setBookSwiperDuration(PAGE_TURN_DURATION_MS);
    }, 50);
  };

  const restoreBookSwiper = (index: number) => {
    pendingSwiperPracticeIndexRef.current = null;
    setBookSwiperDuration(0);
    setBookSwiperCurrent(index);
    scheduleBookSwiperAnimationRestore();
  };

  const requestPracticeSwitch = async (
    nextIndex: number,
    options?: { animate?: boolean; fromSwiper?: boolean },
  ) => {
    const fromSwiper = options?.fromSwiper === true;
    if (!fromSwiper && pendingSwiperPracticeIndexRef.current !== null) {
      restoreBookSwiper(practiceContextRef.current.practiceIndex);
    }
    if (deletingRecordingRef.current) {
      if (options?.fromSwiper) restoreBookSwiper(practiceContextRef.current.practiceIndex);
      return;
    }
    if (!Number.isInteger(nextIndex) || nextIndex < 0 || nextIndex >= bundle.practices.length) {
      if (options?.fromSwiper) restoreBookSwiper(practiceContextRef.current.practiceIndex);
      return;
    }
    if (nextIndex === practiceContextRef.current.practiceIndex) {
      setIsDirectoryOpen(false);
      setIsModelRateMenuOpen(false);
      if (options?.fromSwiper) setBookSwiperCurrent(nextIndex);
      return;
    }
    setIsModelRateMenuOpen(false);
    const animate = options?.animate !== false && !options?.fromSwiper;
    // 训练切换意图出现后，旧训练尚在等待权限的 continuation 永远不得启动录音。
    recordingStartAttemptRef.current += 1;

    const revertSwiper = () => {
      if (fromSwiper) restoreBookSwiper(practiceContextRef.current.practiceIndex);
    };

    if (practiceSwitchInFlightRef.current) {
      revertSwiper();
      Taro.showToast({ title: "正在切换训练，请稍候", icon: "none" });
      return;
    }

    const currentMachine = recordingMachineRef.current;
    if (
      isSavingRecording ||
      savingRecordingRef.current ||
      currentMachine.pendingAction ||
      currentMachine.state === "starting" ||
      currentMachine.state === "stopping"
    ) {
      revertSwiper();
      Taro.showToast({ title: "录音正在处理，请稍候", icon: "none" });
      return;
    }
    if (
      currentMachine.state === "uploading" ||
      getPracticeSwitchPolicy(currentMachine.state) === "block-uploading"
    ) {
      revertSwiper();
      Taro.showToast({ title: "打卡上传中，请稍候", icon: "none" });
      return;
    }
    const requestedContext = practiceContextRef.current;
    const attemptId = practiceSwitchAttemptRef.current + 1;
    practiceSwitchAttemptRef.current = attemptId;
    const switchRequest = {
      owner: recorderOwnerRef.current,
      practiceId: requestedContext.practice.id,
      practiceIndex: requestedContext.practiceIndex,
      attemptId,
      saveGeneration: saveGenerationRef.current,
    };
    practiceSwitchInFlightRef.current = true;
    setBookSwipeLocked(true);
    try {
      setIsDirectoryOpen(false);
      if (!fromSwiper) {
        setBookSwiperDuration(animate ? PAGE_TURN_DURATION_MS : 0);
        setBookSwiperCurrent(nextIndex);
      }
      await performPracticeSwitch(nextIndex, switchRequest, { preserveRecording: true });
      if (practiceContextRef.current.practiceIndex !== nextIndex) {
        revertSwiper();
        return;
      }
      if (!fromSwiper && !animate && mountedRef.current) {
        scheduleBookSwiperAnimationRestore();
      }
    } finally {
      // 同一时刻只允许一个切页事务；文件删除真正收口后才重新开放录音和提交。
      practiceSwitchInFlightRef.current = false;
      if (mountedRef.current) setBookSwipeLocked(false);
    }
  };

  const handleBookSwiperChange = (event: { detail: { current: number; source: string } }) => {
    if (!isPracticeSwiperTouchChange(event.detail)) return;
    pendingSwiperPracticeIndexRef.current = event.detail.current;
    setBookSwiperCurrent(event.detail.current);
  };

  const handleBookSwiperAnimationFinish = async (event: {
    detail: { current: number; source?: string };
  }) => {
    if (!isPracticeSwiperTouchChange(event.detail)) return;
    const nextIndex = pendingSwiperPracticeIndexRef.current;
    if (nextIndex === null || event.detail.current !== nextIndex) return;
    pendingSwiperPracticeIndexRef.current = null;
    await requestPracticeSwitch(nextIndex, { fromSwiper: true });
  };

  const openPracticeDirectory = () => {
    if (recordingState === "uploading") {
      Taro.showToast({ title: "打卡上传中，请稍候", icon: "none" });
      return;
    }
    setIsModelRateMenuOpen(false);
    setIsDirectoryOpen(true);
  };

  const startRecording = async () => {
    const requestedContext = practiceContextRef.current;
    const attemptId = recordingStartAttemptRef.current + 1;
    recordingStartAttemptRef.current = attemptId;
    const request = {
      owner: recorderOwnerRef.current,
      practiceId: requestedContext.practice.id,
      practiceIndex: requestedContext.practiceIndex,
      attemptId,
    };
    if (!canStartRecordingNow(request)) return;

    let capacity: { allowed: boolean; message: string };
    try {
      capacity = await getPendingCheckInStore().checkCanStartRecording();
    } catch (error) {
      logRecordingDiagnostic("capacity.check.failed", { error });
      if (canStartRecordingNow(request)) {
        Taro.showToast({ title: "无法检查本地录音空间，请稍后重试", icon: "none" });
      }
      return;
    }
    // 只读容量检查期间页面、教材或会话可能已经变化；失效点击不得继续获取权限。
    if (!canStartRecordingNow(request)) return;
    if (!capacity.allowed) {
      Taro.showToast({ title: capacity.message || "无法检查本地录音空间，请稍后重试", icon: "none" });
      return;
    }

    recordingAudioRef.current?.stop();
    let permission: "granted" | "request" | "open-settings";
    try {
      const settings = await Taro.getSetting();
      permission = getRecordingPermissionStep(
        settings.authSetting["scope.record"],
      );
      // 权限接口返回时页面、owner 或录音状态都可能已变化，后续统一以最新引用为准。
      if (!canStartRecordingNow(request)) return;
    } catch (error) {
      if (!canStartRecordingNow(request)) return;
      void Taro.showModal({
        title: "无法检查麦克风权限",
        content: getRecordingErrorMessage(error),
        showCancel: false,
      });
      return;
    }

    if (permission === "open-settings") {
      const choice = await Taro.showModal({
        title: "需要麦克风权限",
        content: "跟读录音只会在你点击分享后上传。请在设置中允许使用麦克风。",
        confirmText: "去设置",
      });
      if (choice.confirm && canStartRecordingNow(request)) {
        await Taro.openSetting();
        if (canStartRecordingNow(request)) {
          Taro.showToast({ title: "授权后请再次点击录音", icon: "none" });
        }
      }
      return;
    }

    if (permission === "request") {
      try {
        await Taro.authorize({ scope: "scope.record" });
      } catch (_error) {
        if (!canStartRecordingNow(request)) return;
        const choice = await Taro.showModal({
          title: "需要麦克风权限",
          content: "请允许麦克风权限后再开始跟读录音。",
          confirmText: "去设置",
        });
        if (choice.confirm && canStartRecordingNow(request)) {
          await Taro.openSetting();
        }
        return;
      }
    }

    // 最后一道门闩必须位于旧 pending 迁移之前，失效请求不能改动用户已保存的录音。
    if (!canStartRecordingNow(request)) return;
    // 消费本次唯一许可，较早或重复点击的异步 continuation 此后都无法再次开麦。
    recordingStartAttemptRef.current += 1;
    timedOutStopRef.current = null;
    discardedRecordingRef.current = null;
    pendingRestoreSuppressedRef.current = false;
    const previousPending = pendingCheckInRef.current;
    if (previousPending) {
      replacementPendingIdsRef.current.add(previousPending.requestId);
      applyPendingCheckIn(null);
    }
    clearRecordingView();
    if (!runRecorderAction("start") && previousPending) {
      replacementPendingIdsRef.current.delete(previousPending.requestId);
      applyPendingCheckIn(previousPending);
      setTempRecordingPath(previousPending.localPath);
      setRecordingDurationMs(previousPending.durationMs);
      setRecordingElapsedMs(previousPending.durationMs);
      applyRecordingMachine(restoreRecordedMachine(recordingMachineRef.current));
    }
  };

  const pauseRecording = () => {
    runRecorderAction("pause");
  };

  const resumeRecording = () => {
    runRecorderAction("resume");
  };

  const stopRecording = () => {
    runRecorderAction("stop");
  };

  const playRecording = () => {
    const controller = recordingAudioRef.current;
    if (!controller || !tempRecordingPath || savingRecordingRef.current || deletingRecordingRef.current) return;

    modelAudioControllerRef.current?.stop();
    setPlayingTrackId(null);
    const pending = pendingCheckInRef.current;
    recordingPlaybackSnapshotRef.current = pending?.localPath === tempRecordingPath ? pending : { requestId: "", localPath: tempRecordingPath };
    logRecordingDiagnostic("playback.local.start", { requestId: pending?.requestId });
    controller.toggle("recording", tempRecordingPath);
  };

  const handleRecordingSeekChanging = (event: { detail: { value: number } }) => {
    const value = Number(event.detail.value);
    if (!Number.isFinite(value)) return;
    const duration = recordingPlaybackDuration > 0
      ? recordingPlaybackDuration
      : recordingDurationMs / 1000;
    setRecordingSeekPreview(
      duration > 0 ? Math.min(Math.max(0, value), duration) : Math.max(0, value),
    );
    setIsModelSeekDragging(true);
  };

  const handleRecordingSeekChange = (event: { detail: { value: number } }) => {
    const value = Number(event.detail.value);
    if (Number.isFinite(value)) {
      const duration = recordingPlaybackDuration > 0
        ? recordingPlaybackDuration
        : recordingDurationMs / 1000;
      const boundedValue = duration > 0
        ? Math.min(Math.max(0, value), duration)
        : Math.max(0, value);
      recordingAudioRef.current?.seek(boundedValue);
      setRecordingPlaybackCurrentTime(boundedValue);
    }
    setRecordingSeekPreview(null);
    setIsModelSeekDragging(false);
  };

  const retrySaveRecording = async () => {
    const pending = pendingCheckInRef.current;
    if (!pending || pending.recoverable || savingRecordingRef.current || deletingRecordingRef.current || completionInFlightRef.current || practiceSwitchInFlightRef.current || pageHiddenRef.current || recordingMachineRef.current.state !== "recorded") return;
    // 用户选择救回本段后，之前尚在等待权限的重录手势永久失效。
    recordingStartAttemptRef.current += 1;
    savingRecordingRef.current = true;
    setIsSavingRecording(true);
    const generation = ++saveGenerationRef.current;
    recordingAudioRef.current?.stop();
    setIsPlayingRecording(false);
    try {
      const result = await getPendingCheckInStore().retrySave(pending.requestId);
      // 保存仅更新原录音；隐藏、卸载或已换录音时由下一次快照恢复接管。
      if (!mountedRef.current || pageHiddenRef.current || generation !== saveGenerationRef.current || pendingCheckInRef.current?.requestId !== pending.requestId) return;
      if (result) {
        applyPendingCheckIn(result.item);
        setTempRecordingPath(result.item.localPath);
      }
      Taro.showToast({ title: result?.persisted ? "录音已安全保存" : "保存失败，请重试", icon: "none" });
    } catch (_error) {
      if (mountedRef.current && !pageHiddenRef.current) Taro.showToast({ title: "保存失败，请重试", icon: "none" });
    } finally {
      if (generation === saveGenerationRef.current) {
        savingRecordingRef.current = false;
        if (mountedRef.current) setIsSavingRecording(false);
      }
    }
  };

  const deleteRecording = async () => {
    const pending = pendingCheckInRef.current;
    if (
      !pending || !mountedRef.current || pageHiddenRef.current ||
      savingRecordingRef.current || deletingRecordingRef.current ||
      completionInFlightRef.current || practiceSwitchInFlightRef.current ||
      recordingMachineRef.current.state !== "recorded"
    ) return;

    // 从确认框开始互斥，并使较早的重录权限请求和草稿恢复作废。
    deletingRecordingRef.current = true;
    setIsDeletingRecording(true);
    recordingStartAttemptRef.current += 1;
    const restoreAttempt = ++pendingRestoreAttemptRef.current;
    try {
      const confirmation = await Taro.showModal({
        title: "删除录音？",
        content: "删除当前录音后无法恢复，是否继续？",
        confirmText: "删除",
        confirmColor: "#d85b3f",
      });
      if (
        !confirmation.confirm || !mountedRef.current || pageHiddenRef.current ||
        pendingRestoreAttemptRef.current !== restoreAttempt ||
        pendingCheckInRef.current?.requestId !== pending.requestId ||
        recordingMachineRef.current.state !== "recorded"
      ) return;

      recordingAudioRef.current?.stop();
      const removed = await getPendingCheckInStore().remove(pending.requestId);
      if (!removed) {
        if (mountedRef.current && !pageHiddenRef.current) {
          Taro.showToast({ title: "删除失败，请稍后重试", icon: "none" });
        }
        return;
      }
      replacementPendingIdsRef.current.delete(pending.requestId);
      if (!mountedRef.current || pendingCheckInRef.current?.requestId !== pending.requestId) return;
      pendingRestoreAttemptRef.current += 1;
      // 明确删除后保持空白录音状态；重新录音或切页才恢复原有草稿恢复逻辑。
      pendingRestoreSuppressedRef.current = true;
      applyPendingCheckIn(null);
      clearRecordingView();
      applyRecordingMachine(resetRecordingMachine(recordingMachineRef.current));
      if (!pageHiddenRef.current) Taro.showToast({ title: "录音已删除", icon: "success" });
    } catch (error) {
      logRecordingDiagnostic("delete.practice.failed", { requestId: pending.requestId, error });
      if (mountedRef.current && !pageHiddenRef.current) {
        Taro.showToast({ title: "删除失败，请稍后重试", icon: "none" });
      }
    } finally {
      deletingRecordingRef.current = false;
      if (mountedRef.current) setIsDeletingRecording(false);
    }
  };

  const submitCheckIn = async () => {
    const pending = pendingCheckInRef.current;
    if (
      !pending ||
      savingRecordingRef.current ||
      pageHiddenRef.current ||
      completionInFlightRef.current ||
      deletingRecordingRef.current ||
      practiceSwitchInFlightRef.current ||
      recordingState !== "recorded"
    ) return;

    if (!pending.recoverable) {
      Taro.showToast({ title: "录音尚未安全保存，不能完成", icon: "none" });
      return;
    }
    completionInFlightRef.current = true;
    let completed = false;
    try {
      completed = await getPendingCheckInStore().complete(pending.requestId, true);
    } catch (_error) {
      completed = false;
    }
    if (!completed || !mountedRef.current) {
      completionInFlightRef.current = false;
      Taro.showToast({ title: "保存完成状态失败，请重试", icon: "none" });
      return;
    }
    // 完成记录从当前草稿会话脱钩；即使导航失败也不能再被“重新录制”当作备份删除。
    replacementPendingIdsRef.current.delete(pending.requestId);
    applyPendingCheckIn(null);
    clearRecordingView();
    applyRecordingMachine(resetRecordingMachine(recordingMachineRef.current));
    Taro.showToast({ title: "已保存到我的录音", icon: "success" });
    try {
      // 保留当前教材会话和翻页位置，详情页的原生返回箭头才能回到刚才的训练。
      await Taro.navigateTo({
        url: `/pages/CheckInDetail/CheckInDetail?localId=${encodeURIComponent(pending.requestId)}&fromPractice=1`,
      });
    } catch (_navigationError) {
      Taro.showToast({ title: "请到我的录音中查看", icon: "none" });
    } finally {
      completionInFlightRef.current = false;
    }
  };

  const shownDuration =
    recordingState === "recording" || recordingState === "paused"
      ? recordingElapsedMs
      : recordingDurationMs;
  // 外框使用本书稳定比例；真实页图和热点在固定外框内等比居中。
  const viewportNaturalSize = resolvedImageSize;
  const hasMeasuredBookBounds = bookBounds.width > 0 && bookBounds.height > 0;
  const bookViewportSize = isLandscapeLayout
    ? bookBounds
    : stablePortraitCanvasNaturalSize && isPadPortraitLayout
      ? hasMeasuredBookBounds ? bookBounds : null
      : stablePortraitCanvasSize ?? (
        stablePortraitCanvasNaturalSize || !viewportNaturalSize
          ? null
          : isPadPortraitLayout
            ? fitImageToBounds(bookBounds, viewportNaturalSize)
            : fitImageToWidth(isFittedLayout ? bookBounds.width : phoneColumnWidth, viewportNaturalSize)
      );
  const bookViewportStyle = bookViewportSize
    ? isPadPortraitLayout ? {
        // Pad 竖屏首帧与测量后始终用同一套 CSS 几何，
        // 避免原生 Image/Swiper 因 100% 切换为 px 而重算 aspectFit。
        width: "100%",
        height: "100%",
      } : {
        width: `${bookViewportSize.width}px`,
        height: `${bookViewportSize.height}px`,
      }
    : stablePortraitCanvasNaturalSize
      ? isPadPortraitLayout ? {
          width: "100%",
          height: "100%",
        } : {
          width: "100%",
          aspectRatio: `${stablePortraitCanvasNaturalSize.width} / ${stablePortraitCanvasNaturalSize.height}`,
        }
      : undefined;
  const shownModelPlaybackTime = modelSeekPreview ?? modelPlaybackCurrentTime;
  const modelProgressMax = Math.max(1, Math.ceil(modelPlaybackDuration));
  const modelProgressValue = Math.min(
    modelPlaybackDuration > 0 ? modelPlaybackDuration : modelProgressMax,
    Math.max(0, shownModelPlaybackTime),
  );
  const resolvedRecordingPlaybackDuration = recordingPlaybackDuration > 0
    ? recordingPlaybackDuration
    : recordingDurationMs / 1000;
  const shownRecordingPlaybackTime = recordingSeekPreview ?? recordingPlaybackCurrentTime;
  const recordingProgressMax = Math.max(1, Math.ceil(resolvedRecordingPlaybackDuration));
  const recordingProgressValue = Math.min(
    resolvedRecordingPlaybackDuration > 0
      ? resolvedRecordingPlaybackDuration
      : recordingProgressMax,
    Math.max(0, shownRecordingPlaybackTime),
  );
  const retryRecordingButton = recordingState === "recorded" && !isSavingRecording && pendingCheckIn ? (
    <Button className='practice-recorder__retry device-touch-target' disabled={isDeletingRecording} onClick={startRecording}>
      重新录制
    </Button>
  ) : null;
  const deleteRecordingButton = recordingState === "recorded" && !isSavingRecording && pendingCheckIn ? (
    <Button
      className='practice-recorder__retry practice-recorder__delete device-touch-target'
      disabled={isDeletingRecording}
      loading={isDeletingRecording}
      onClick={deleteRecording}
    >
      删除录音
    </Button>
  ) : null;

  return (
    <View className={`practice-page ${layoutClassName}${isFittedLayout ? " practice-page--fitted" : ""}${layout.orientation === "landscape" ? " practice-page--landscape" : ""}`}>
      <PageMeta pageStyle={isDirectoryOpen || isBookPreviewOpen ? "overflow: hidden;" : ""} />
      <View className='practice-page__content device-layout__content'>
        <View className='practice-header'>
          <Text className='practice-header__course'>{bundle.book.title}</Text>
          <Text className='practice-header__section'>{isLandscapeLayout ? `· ${practice.sectionTitle}` : practice.sectionTitle}</Text>
          <View className={`practice-header__progress-row${(playingTrackId && activeModelTrack) || hasRecordingPlaybackSession ? " practice-header__progress-row--audio-active" : ""}`}>
            <Text className='practice-header__progress'>
              {practice.pageLabel || `第 ${practice.pageNumber} 页`}
            </Text>
            {playingTrackId && activeModelTrack && (
              <View className='practice-model-player' catchMove>
                <Button
                  className='practice-model-player__toggle device-touch-target'
                  aria-label={modelPlaybackState === "buffering"
                    ? "示范音频缓冲中，点击暂停"
                    : modelPlaybackState === "paused"
                      ? "继续播放示范音频"
                      : "暂停示范音频"}
                  onClick={toggleModelPlayback}
                >
                  <View
                    className={`practice-model-player__play-icon practice-model-player__play-icon--${
                      modelPlaybackState === "buffering"
                        ? "buffering"
                        : modelPlaybackState === "paused" ? "play" : "pause"
                    }`}
                  />
                </Button>
                <View className='practice-model-player__body'>
                  <Slider
                    className='practice-model-player__progress'
                    min={0}
                    max={modelProgressMax}
                    step={1}
                    value={modelProgressValue}
                    disabled={modelPlaybackDuration <= 0}
                    activeColor='#14563f'
                    backgroundColor='#718f84'
                    blockColor='#14563f'
                    blockSize={20}
                    onChanging={handleModelSeekChanging}
                    onChange={handleModelSeekChange}
                  />
                  <Text className='practice-model-player__time'>
                    {formatAudioTime(shownModelPlaybackTime)} / {formatAudioTime(modelPlaybackDuration)}
                  </Text>
                </View>
                <Button
                  className='practice-model-player__rate device-touch-target'
                  aria-label={`选择播放速度，当前 ${formatModelPlaybackRate(modelPlaybackRate)}`}
                  aria-expanded={isModelRateMenuOpen}
                  onClick={() => setIsModelRateMenuOpen((open) => !open)}
                >
                  {formatModelPlaybackRate(modelPlaybackRate)}
                </Button>
                {isModelRateMenuOpen && (
                  <View className='practice-model-player__rate-menu' catchMove>
                    {MODEL_PLAYBACK_RATES.map((rate) => (
                      <Button
                        key={rate}
                        className={`practice-model-player__rate-option${
                          rate === modelPlaybackRate ? " practice-model-player__rate-option--active" : ""
                        }`}
                        aria-label={`使用 ${formatModelPlaybackRate(rate)} 播放`}
                        aria-pressed={rate === modelPlaybackRate}
                        onClick={() => selectModelPlaybackRate(rate)}
                      >
                        {formatModelPlaybackRate(rate)}
                      </Button>
                    ))}
                  </View>
                )}
              </View>
            )}
            {!playingTrackId && hasRecordingPlaybackSession && (
              <View className='practice-model-player' catchMove>
                <Button
                  className='practice-model-player__toggle device-touch-target'
                  aria-label={isPlayingRecording ? "停止回听录音" : "回听录音"}
                  onClick={playRecording}
                >
                  {isPlayingRecording
                    ? <Text aria-hidden>■</Text>
                    : <View className='practice-model-player__play-icon practice-model-player__play-icon--play' />}
                </Button>
                <View className='practice-model-player__body'>
                  <Slider
                    className='practice-model-player__progress'
                    min={0}
                    max={recordingProgressMax}
                    step={1}
                    value={recordingProgressValue}
                    disabled={resolvedRecordingPlaybackDuration <= 0}
                    activeColor='#14563f'
                    backgroundColor='#718f84'
                    blockColor='#14563f'
                    blockSize={20}
                    onChanging={handleRecordingSeekChanging}
                    onChange={handleRecordingSeekChange}
                  />
                  <Text className='practice-model-player__time'>
                    {formatAudioTime(shownRecordingPlaybackTime)} / {formatAudioTime(resolvedRecordingPlaybackDuration)}
                  </Text>
                </View>
                <View className='practice-model-player__rate' aria-label='录音按原速播放'>
                  <Text>1.0×</Text>
                </View>
              </View>
            )}
            <View className='practice-header__actions'>
              {isFittedLayout && !isLandscapeLayout && (
                <Text
                  className='practice-book-expand device-touch-target'
                  onClick={openBookImagePreview}
                >
                  放大查看
                </Text>
              )}
              <Text
                className='practice-header__directory device-touch-target'
                onClick={openPracticeDirectory}
              >
                目录
              </Text>
            </View>
          </View>
        </View>

        <View className='practice-workspace'>
          <View className='practice-workspace__book'>
            <View
              className='practice-book-viewport'
              style={bookViewportStyle}
            >
              <Swiper
                className='practice-book-swiper'
                current={bookSwiperCurrent}
                duration={bookSwiperDuration}
                circular={false}
                easingFunction='easeOutCubic'
                disableTouch={
                  bookSwipeLocked ||
                  isModelSeekDragging ||
                  recordingState === "uploading" ||
                  recordingState === "starting" ||
                  recordingState === "stopping" ||
                  isSavingRecording
                }
                onChange={handleBookSwiperChange}
                onAnimationFinish={handleBookSwiperAnimationFinish}
              >
                {bundle.practices.map((item, index) => {
                  const isSlideRetained = retainedSlideIndexes.has(index);
                  const retainedNaturalSize = naturalImageSizeCache.get(item.imageUrl) ??
                    readBookImageSize(bundle.book.id, item.imageIndex) ??
                    bookStableCanvasNaturalSize;
                  const retainedImageSize = isSlideRetained && isLandscapeLayout && retainedNaturalSize
                    ? fitImageToWidth(bookBounds.width, retainedNaturalSize)
                    : null;
                  const slideImageSize = index === practiceIndex
                    ? fittedBookSize
                    : retainedImageSize;
                  return (
                    <SwiperItem
                      key={item.id}
                      className={`practice-book-slide${stablePortraitCanvasNaturalSize ? " practice-book-slide--stable-canvas" : ""}`}
                    >
                      <PracticeBookPage
                        scrollable={isLandscapeLayout && isSlideRetained}
                        active={index === practiceIndex}
                        imageSize={slideImageSize}
                        onScroll={index === practiceIndex ? (event) => {
                          if (event.detail.scrollTop > 0 && index === practiceContextRef.current.practiceIndex) {
                            setBookScrollHintDismissed(true);
                          }
                        } : undefined}
                      >
                        {isSlideRetained ? (
                          <Image
                            className={
                              index === practiceIndex
                                ? "practice-book-page__image"
                                : "practice-book-page__neighbor"
                            }
                            src={item.imageUrl}
                            style={stablePortraitCanvasNaturalSize && !isLandscapeLayout ? { height: "100%" } : undefined}
                            mode={
                              isLandscapeLayout || (!isFittedLayout && !stablePortraitCanvasNaturalSize)
                                ? "widthFix"
                                : "aspectFit"
                            }
                            webp
                            onLoad={(event) => {
                              const size = readNaturalImageSize(event.detail);
                              if (size) {
                                naturalImageSizeCache.set(item.imageUrl, size);
                                if (index === practiceContextRef.current.practiceIndex) {
                                  setLoadedImage({ imageUrl: item.imageUrl, size });
                                }
                              }
                              if (index === practiceContextRef.current.practiceIndex) {
                                measureBookImage();
                              }
                            }}
                          />
                        ) : null}
                        {index === practiceIndex && (!stablePortraitCanvasNaturalSize || fittedBookSize) ? (
                          <View
                            className={`practice-book-page__hotspots${
                              stablePortraitCanvasNaturalSize && fittedBookSize
                                ? " practice-book-page__hotspots--fitted"
                                : ""
                            }`}
                            style={stablePortraitCanvasNaturalSize && fittedBookSize
                              ? { width: `${fittedBookSize.width}px`, height: `${fittedBookSize.height}px` }
                              : undefined}
                          >
                          {clampedHotspots.map((hotspot, hotspotIndex) => {
                            const isActiveModelTrack = playingTrackId === hotspot.id ||
                              activeModelTrack?.url === hotspot.url;
                            const isPlayingModelTrack = isActiveModelTrack &&
                              (modelPlaybackState === "playing" || modelPlaybackState === "buffering");
                            return (
                              <View
                                key={hotspot.id}
                                className={`audio-hotspot device-touch-target${
                                  isPlayingModelTrack
                                    ? " audio-hotspot--playing"
                                    : isActiveModelTrack
                                      ? " audio-hotspot--paused"
                                      : ""
                                }`}
                                style={{ left: hotspot.left, top: hotspot.top }}
                                onClick={() => playModelAudio(hotspot.id, hotspot.url)}
                              >
                                <View className='audio-hotspot__visual'>
                                  <Text className='audio-hotspot__icon'>
                                    {isPlayingModelTrack ? "Ⅱ" : "▶"}
                                  </Text>
                                  <Text className='audio-hotspot__number'>{hotspotIndex + 1}</Text>
                                </View>
                              </View>
                            );
                          })}
                          </View>
                        ) : null}
                      </PracticeBookPage>
                    </SwiperItem>
                  );
                })}
              </Swiper>
              {isLandscapeLayout && !bookScrollHintDismissed && fittedBookSize && fittedBookSize.height > bookBounds.height && (
                <Text className='practice-book-scroll-hint'>上下滑动阅读</Text>
              )}
            </View>
          </View>

          <PracticeControls fitted={isFittedLayout}>
            <View className={`practice-recorder practice-recorder--${recordingState}`}>
              <View className='practice-recorder__heading'>
                <Text className='practice-recorder__title'>我的跟读</Text>
                <View className='practice-recorder__heading-actions'>
                  {!isLandscapeLayout && retryRecordingButton}
                  {!isLandscapeLayout && deleteRecordingButton}
                  <Text className='practice-recorder__time'>
                    {shownDuration > 0 ? formatDuration(shownDuration) : "最长 5:00"}
                  </Text>
                </View>
              </View>
              {recordingState === "checking" && (
                <View className='recorder-status recorder-status--neutral'>
                  <Text>
                    {isRecorderBusy
                      ? "录音设备正在收尾，请稍候…"
                      : "正在检查当前设备的录音能力…"}
                  </Text>
                </View>
              )}

              {recordingState === "unsupported" && (
                <View className='recorder-status recorder-status--warning'>
                  <Text>当前微信或设备暂不支持跟读录音，请升级微信后在真机重试。</Text>
                </View>
              )}

              {recordingState === "starting" && (
                <View className='recorder-status recorder-status--neutral'>
                  <Text>正在启动麦克风，请稍候…</Text>
                </View>
              )}

              {recordingState === "idle" && (
                <Button
                  className='record-button device-touch-target'
                  onClick={startRecording}
                >
                  <Text className='record-button__dot' />
                  开始跟读录音
                </Button>
              )}

              {recordingState === "recording" && (
                <>
                  <View className='recording-indicator'>
                    <Text className='recording-indicator__pulse' />
                    <Text>正在录音，请完成本页跟读</Text>
                  </View>
                  <View className='recording-controls device-actions'>
                    {recordingMachine.capabilities?.canPause &&
                      recordingMachine.capabilities.canResume && (
                        <Button
                          className='record-button device-touch-target record-button--pause'
                          onClick={pauseRecording}
                        >
                          暂停录音
                        </Button>
                      )}
                    <Button
                      className='record-button device-touch-target record-button--stop'
                      onClick={stopRecording}
                    >
                      结束录音
                    </Button>
                  </View>
                </>
              )}

              {recordingState === "paused" && (
                <>
                  <View className='recording-indicator recording-indicator--paused'>
                    <Text className='recording-indicator__pulse' />
                    <Text>
                      {recordingMachine.needsManualResume
                        ? recordingMachine.pauseReason === "interruption"
                          ? "录音被系统打断，请确认环境恢复后手动继续"
                          : "页面切换时已暂停，请确认后手动继续"
                        : "录音已暂停，可播放示范音频后继续"}
                    </Text>
                  </View>
                  <View className='recording-controls device-actions'>
                    {recordingMachine.capabilities?.canResume && (
                      <Button
                        className='record-button device-touch-target record-button--resume'
                        onClick={resumeRecording}
                      >
                        继续录音
                      </Button>
                    )}
                    <Button
                      className='record-button device-touch-target record-button--stop'
                      onClick={stopRecording}
                    >
                      结束录音
                    </Button>
                  </View>
                </>
              )}

              {recordingState === "stopping" && (
                <View className='recorder-status recorder-status--neutral'>
                  <Text>正在保存本次录音，请勿离开…</Text>
                </View>
              )}

              {recordingState === "error" && (
                <>
                  <View className='recorder-status recorder-status--warning'>
                    <Text>
                      {getRecordingErrorMessage(recordingMachine.lastError) ||
                        "录音未完成，请重新尝试。"}
                    </Text>
                  </View>
                  <Button
                    className='record-button device-touch-target'
                    onClick={startRecording}
                  >
                    重新尝试录音
                  </Button>
                </>
              )}

              {recordingState === "recorded" && (
                <>
                  <Text className='practice-recorder__tip'>
                    {isSavingRecording
                      ? "正在安全保存录音，请稍候…"
                      : pendingCheckIn?.recoverable
                        ? "已保存录音文件。"
                        : `录音保存失败（${formatDuration(recordingDurationMs)}），请重试保存；关闭小程序后可能无法恢复。`}
                  </Text>
                  {!isSavingRecording && pendingCheckIn && (
                    <>
                      {!pendingCheckIn.recoverable && (
                        <Button className='record-actions__secondary device-touch-target' disabled={isDeletingRecording} onClick={retrySaveRecording}>重试保存</Button>
                      )}
                      <View className='record-actions device-actions'>
                        <Button
                          className='record-actions__secondary device-touch-target'
                          disabled={isDeletingRecording}
                          onClick={playRecording}
                        >
                          {isPlayingRecording ? "停止回听" : "回听录音"}
                        </Button>
                        <Button
                          className='check-in-button device-touch-target'
                          disabled={isDeletingRecording}
                          onClick={submitCheckIn}
                        >
                          完成练习
                        </Button>
                      </View>
                      {isLandscapeLayout && retryRecordingButton}
                      {isLandscapeLayout && deleteRecordingButton}
                    </>
                  )}
                </>
              )}
            </View>

            <View className='practice-navigation device-actions'>
              <View
                className={`practice-navigation__button device-touch-target ${
                  practiceIndex === 0 ? "practice-navigation__button--disabled" : ""
                }`}
                onClick={() =>
                  practiceIndex > 0 && requestPracticeSwitch(practiceIndex - 1, { animate: false })
                }
              >
                <Text>上一页</Text>
              </View>
              <View
                className={`practice-navigation__button device-touch-target practice-navigation__button--primary ${
                  practiceIndex === bundle.practices.length - 1
                    ? "practice-navigation__button--disabled"
                    : ""
                }`}
                onClick={() =>
                  practiceIndex < bundle.practices.length - 1 &&
                  requestPracticeSwitch(practiceIndex + 1, { animate: false })
                }
              >
                <Text>下一页</Text>
              </View>
            </View>
          </PracticeControls>
        </View>
      </View>

      <PracticeDirectory
        groups={directoryGroups}
        currentPracticeIndex={practiceIndex}
        open={isDirectoryOpen}
        onClose={() => setIsDirectoryOpen(false)}
        onSelect={(nextIndex) => requestPracticeSwitch(nextIndex, { animate: false })}
      />
      {isBookPreviewOpen && (
        <View className='practice-book-preview' catchMove>
          <View className='practice-book-preview__toolbar'>
            <Text
              className='practice-book-preview__close device-touch-target'
              onClick={() => setIsBookPreviewOpen(false)}
            >
              关闭
            </Text>
            <Text className='practice-book-preview__hint'>双指缩放 · 拖动查看</Text>
          </View>
          <MovableArea className='practice-book-preview__area' scaleArea>
            <MovableView
              className='practice-book-preview__canvas'
              direction='all'
              inertia
              outOfBounds
              scale
              scaleMin={1}
              scaleMax={4}
            >
              <Image
                className='practice-book-preview__image'
                src={practice.imageUrl}
                mode='aspectFit'
                webp
              />
            </MovableView>
          </MovableArea>
        </View>
      )}
    </View>
  );
}
