import { Button, Image, PageMeta, ScrollView, Slider, Swiper, SwiperItem, Text, View, type ScrollViewProps } from "@tarojs/components";
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
  RECORDER_OCCUPIED_GUIDANCE,
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
  abandonRecordingMachine,
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
  isRecorderStateConflictError,
  type RecorderCoordinatorPhase,
  type RecorderNativeStopResult,
  type RecorderOwner,
  type RecorderTerminalSink,
} from "@/features/listeningPractice/recorderCoordinator";
import type { PendingCheckIn } from "@/features/listeningPractice/pendingCheckInStore";
import { getPendingCheckInStore, logRecordingDiagnostic, diagnoseLocalRecordingFailure } from "@/features/listeningPractice/pendingCheckInRuntime";
import { getRecordingSessionJournal } from "@/features/listeningPractice/recordingSessionJournal";
import { ensureUnfinishedRecordingRecovery, scheduleExitedRecordingSettlement } from "@/features/listeningPractice/recordingSessionRecovery";
import type { DeviceLayoutState } from "@/hooks/useDeviceLayout";
import PracticeDirectory from "./PracticeDirectory";
import { PracticeBookZoom } from "./PracticeBookZoom";

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
const RECORDER_AUTO_ABANDON_MS = 1500;
const RECORDER_AUTO_RECOVERY_MESSAGE = "正在自动恢复录音设备，请稍候…";
const RECORDER_RECOVERY_STALLED_GUIDANCE = "录音设备暂未恢复。请稍后返回本页重试；若仍无法录音，再关闭并重新打开微信。";
const HIDDEN_RECORDER_STOP_RETRY_MS = 120;
const HIDDEN_RECORDER_STOP_MAX_ATTEMPTS = 3;
const RECORDER_RECOVERY_MESSAGE = "正在自动处理上次录音，请稍候…";
const RECORDER_STORAGE_GUIDANCE = "读取录音状态失败。请清理手机存储空间后返回本页重试；若仍无法恢复，再关闭并重新打开微信。";

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

const getRecorderVisibleErrorMessage = (error: unknown) =>
  isRecorderStateConflictError(error)
    ? RECORDER_OCCUPIED_GUIDANCE
    : getRecordingErrorMessage(error);

const getRecorderFailureMessage = (error: unknown, recoveryRequired: boolean) =>
  recoveryRequired
    ? `${RECORDER_AUTO_RECOVERY_MESSAGE}\n${getRecorderVisibleErrorMessage(error)}`
    : getRecorderVisibleErrorMessage(error);

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

function PracticeBookPage({ scrollable, sized = false, active, imageSize, onScroll, children }: {
  scrollable: boolean;
  sized?: boolean;
  active: boolean;
  imageSize: NaturalImageSize | null;
  onScroll?: ScrollViewProps["onScroll"];
  children: ReactNode;
}) {
  const page = (
    <View
      className='practice-book-page'
      style={(scrollable || sized) && imageSize
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
  const [recorderPhaseRefresh, setRecorderPhaseRefresh] = useState(0);
  const [isRecorderBusy, setIsRecorderBusy] = useState(false);
  const [isRecorderRecoveryRequired, setIsRecorderRecoveryRequired] = useState(false);
  const [nativeRecorderOccupied, setNativeRecorderOccupied] = useState(false);
  const [autoRecoveryFailureMessage, setAutoRecoveryFailureMessage] = useState<string | null>(null);
  const autoAbandonCountRef = useRef(0);
  const recordingMachineRef = useRef(recordingMachine);
  const recordingState = recordingMachine.state;
  const recorderPhase = getRecorderCoordinator().getPhase();
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
  const [bookZoomActive, setBookZoomActive] = useState(false);
  const hotspotGestureBlockedRef = useRef(false);
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
  const recordingContextRef = useRef<{ practice: ListeningPractice; practiceIndex: number } | null>(null);
  const recordingSessionIdRef = useRef<string | null>(null);

  const applyRecordingMachine = useCallback((next: RecordingMachine) => {
    recordingMachineRef.current = next;
    if (mountedRef.current) setRecordingMachine(next);
  }, []);

  useEffect(() => () => {
    mountedRef.current = false;
    if (bookSwiperDurationRestoreTimerRef.current !== null) {
      clearTimeout(bookSwiperDurationRestoreTimerRef.current);
      bookSwiperDurationRestoreTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    // 只有已提交的切页或屏幕方向改变，才清除当前书页的缩放状态。
    setBookZoomActive(false);
    hotspotGestureBlockedRef.current = false;
  }, [practiceIndex, layout.orientation]);

  const applyPendingCheckIn = useCallback((next: PendingCheckIn | null) => {
    pendingCheckInRef.current = next;
    if (mountedRef.current) setPendingCheckIn(next);
  }, []);

  const clearSessionJournalBeforeRemoving = (pending: PendingCheckIn): boolean => {
    try {
      const journal = getRecordingSessionJournal();
      const entry = journal.read();
      if (!entry) return true;
      const belongsToPending = entry.id.toLowerCase() === pending.requestId.toLowerCase() ||
        (entry.stage === "terminal" && entry.context.practiceId === pending.context.practiceId &&
          entry.context.practiceIndex === pending.context.practiceIndex &&
          entry.terminal.tempFilePath === pending.localPath);
      if (!belongsToPending) return true;
      if (!journal.clear(entry.id)) return false;
      if (recordingSessionIdRef.current === entry.id) recordingSessionIdRef.current = null;
      return true;
    } catch (error) {
      logRecordingDiagnostic("session.clear.failed", { error });
      return false;
    }
  };

  const removeReplacementBackups = useCallback(async (requestIds: string[]) => {
    const store = getPendingCheckInStore();
    for (const requestId of requestIds) {
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
    if (isRecorderStateConflictError(error)) setNativeRecorderOccupied(true);
    // 原生可能先同步发 onStart 再从 start() 抛错；协调器已锁定并请求安全停止，
    // 页面需显示等待态，同时保留这次已确认会话，供迟到的 onStop 落盘。
    if (recordingMachineRef.current !== requested.machine) {
      const live = recordingMachineRef.current;
      if (action === "start" && getRecorderCoordinator().getPhase() === "uncertain") {
        const recoverableStop = resolveRecorderCallback(live, {
          type: "stop",
          sessionId: live.sessionId,
          operationSeq: live.operationSeq,
        });
        if (recoverableStop !== live) {
          timedOutStopRef.current = {
            machine: live,
            ...(recordingContextRef.current ?? practiceContextRef.current),
          };
          recordingTimelineRef.current = pauseRecordingTimeline(recordingTimelineRef.current, Date.now());
          setRecordingElapsedMs(recordingTimelineRef.current.accumulatedMs);
          applyRecordingMachine(resolveRecorderCallback(live, {
            type: "error",
            sessionId: live.sessionId,
            operationSeq: live.operationSeq,
            error,
          }));
          if (!silent) void Taro.showModal({
            title: "录音操作失败",
            content: getRecorderFailureMessage(error, true),
            showCancel: false,
          });
        }
      }
      return false;
    }
    const stateConflict = isRecorderStateConflictError(error);
    const recoveryRequired = stateConflict || getRecorderCoordinator().getPhase() === "uncertain";
    if (action !== "start" && !recoveryRequired) {
      // 同步暂停、继续或结束失败时原生会话仍可能存活，保留原状态以便用户再次操作或结束。
      applyRecordingMachine(before);
    } else {
      if (recoveryRequired && action !== "start") {
        const recoverableStop = resolveRecorderCallback(requested.machine, {
          type: "stop",
          sessionId: requested.command.sessionId,
          operationSeq: requested.command.operationSeq,
        });
        if (recoverableStop !== requested.machine) {
          timedOutStopRef.current = {
            machine: requested.machine,
            ...(recordingContextRef.current ?? practiceContextRef.current),
          };
        }
      }
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
        content: getRecorderFailureMessage(error, recoveryRequired),
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
    if (current.state === "stopping") {
      clearHiddenStopRetry();
      return true;
    }
    const teardown = requestRecorderTeardown(current);
    if (!owner || !teardown.command) {
      clearHiddenStopRetry();
      return false;
    }

    applyRecordingMachine(teardown.machine);
    hiddenStopAttemptsRef.current += 1;
    const stopped = owner.stop();
    if (stopped.ok) {
      clearHiddenStopRetry();
      return true;
    }

    if (getRecorderCoordinator().getPhase() === "uncertain") {
      clearHiddenStopRetry();
      if (recordingMachineRef.current === teardown.machine) {
        // 原生状态未确认时保留停止命令与起始页，迟到 onStop 仍可安全保存。
        timedOutStopRef.current = {
          machine: teardown.machine,
          ...(recordingContextRef.current ?? practiceContextRef.current),
        };
        const error = recorderOperationError(
          stopped.reason,
          "error" in stopped ? stopped.error : undefined,
        );
        const failed = resolveRecorderCallback(teardown.machine, {
          type: "error",
          sessionId: teardown.machine.sessionId,
          operationSeq: teardown.machine.operationSeq,
          error,
        });
        recordingTimelineRef.current = pauseRecordingTimeline(recordingTimelineRef.current, Date.now());
        applyRecordingMachine(failed);
      }
      return false;
    }

    if (recordingMachineRef.current === teardown.machine) {
      // stop 可能先同步触发 onStop 再报错；仅在回调未改动状态时回退。
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
    // 隐藏的页面仍可能留在微信页面栈；释放全局 owner 后保留状态，回前台再获取 owner。
    if (!mountedRef.current) {
      recordingMachineRef.current = disposeRecordingMachine(recordingMachineRef.current);
    }
  }, [clearHiddenStopRetry]);

  const detachRecorderOwner = useCallback(() => {
    clearHiddenStopRetry();
    const owner = recorderOwnerRef.current;
    if (!owner) {
      // useUnload 可能已把原生回调交给协调器；React cleanup 不得再废弃待保存会话。
      if (!teardownAwaitingStopRef.current) releaseRecorderOwner();
      return;
    }
    const current = recordingMachineRef.current;
    const teardown = requestRecorderTeardown(current);
    const phase = getRecorderCoordinator().getPhase();
    if (!teardown.command && current.state !== "stopping" && phase !== "draining" && phase !== "uncertain") {
      releaseRecorderOwner();
      return;
    }

    // 若 onStop 已同步到达（phase 已 draining），保存任务已被协调器持有；
    // 不要把这次已完成的 stop 标记延续到页面下一次录音。
    teardownAwaitingStopRef.current = Boolean(teardown.command) || current.state === "stopping";
    if (teardown.command) applyRecordingMachine(teardown.machine);
    const released = owner.release({ terminalSink: recorderTerminalSinkRef.current || undefined });
    recorderOwnerRef.current = null;
    recorderUnsubscribeRef.current = null;
    recorderTerminalSinkRef.current = null;
    if (!released.ok && released.phase !== "draining" && released.phase !== "uncertain") {
      teardownAwaitingStopRef.current = false;
      if (!mountedRef.current) {
        recordingMachineRef.current = disposeRecordingMachine(recordingMachineRef.current);
      }
    }
  }, [applyRecordingMachine, clearHiddenStopRetry, releaseRecorderOwner]);

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
    if (pageHiddenRef.current) {
      return () => { mountedRef.current = false; };
    }
    let acquireRetryTimer: ReturnType<typeof setTimeout> | null = null;
    const acquired = getRecorderCoordinator().acquire();
    if (!acquired.ok) {
      if (acquired.reason === "busy") {
        setIsRecorderBusy(true);
        setIsRecorderRecoveryRequired(acquired.phase === "uncertain" || getRecorderCoordinator().getEntryRecoveryStatus() !== "none");
        // 上一页的原生 stop 仍在静默收尾时保持 checking，低频重试而不是误报设备不支持。
        acquireRetryTimer = setTimeout(() => {
          acquireRetryTimer = null;
          if (mountedRef.current && !pageHiddenRef.current) {
            setRecorderAcquireAttempt((attempt) => attempt + 1);
          }
        }, RECORDER_ACQUIRE_RETRY_MS);
        return () => {
          mountedRef.current = false;
          if (acquireRetryTimer !== null) clearTimeout(acquireRetryTimer);
        };
      }
      setIsRecorderBusy(false);
      setIsRecorderRecoveryRequired(false);
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
    setIsRecorderRecoveryRequired(false);
    recorderOwnerRef.current = owner;
    applyRecordingMachine(
      resolveRecordingCapabilities(recordingMachineRef.current, capabilities),
    );

    const handleStart = () => {
      setNativeRecorderOccupied(false);
      autoAbandonCountRef.current = 0;
      const current = recordingMachineRef.current;
      const next = resolveRecorderCallback(current, {
        type: "start",
        sessionId: current.sessionId,
        operationSeq: current.operationSeq,
      });
      if (next === current) return;
      const sessionId = recordingSessionIdRef.current;
      let contextConfirmed = true;
      if (sessionId) {
        try { contextConfirmed = getRecordingSessionJournal().confirm(sessionId); }
        catch (error) { contextConfirmed = false; logRecordingDiagnostic("session.confirm.failed", { error }); }
      }
      recordingTimelineRef.current = startRecordingTimeline(Date.now());
      setRecordingElapsedMs(0);
      applyRecordingMachine(next);

      if (!contextConfirmed) {
        // 无法持久确认 A 页归属时立即结束，避免继续录制一段重启后无法安全找回的音频。
        Taro.showToast({ title: "录音保存失败，正在结束录音", icon: "none" });
        runRecorderAction("stop");
        return;
      }

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
      if (pageHiddenRef.current) stopRecorderWhileHidden(true);
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

      // resume 回调可能晚于页面隐藏；隐藏页必须停止并交还录音器。
      if (pageHiddenRef.current) {
        stopRecorderWhileHidden(true);
      }
    };

    const handleStop = async (result: RecorderNativeStopResult) => {
      const releaseAfterStop = teardownAwaitingStopRef.current;
      const ownerAtStop = recorderOwnerRef.current;
      const releaseStoppedOwner = () => {
        if (releaseAfterStop && recorderOwnerRef.current === ownerAtStop) releaseRecorderOwner();
      };
      const liveCurrent = recordingMachineRef.current;
      const timedOutStop = timedOutStopRef.current;
      const current = timedOutStop?.machine ?? liveCurrent;
      const next = resolveRecorderCallback(current, {
        type: "stop",
        sessionId: current.sessionId,
        operationSeq: current.operationSeq,
      });
      if (next === current) {
        releaseStoppedOwner();
        return;
      }
      const sessionId = recordingSessionIdRef.current;
      let terminalAccepted = true;
      if (sessionId) {
        try { terminalAccepted = getRecordingSessionJournal().recordTerminal(sessionId, result); }
        catch (error) { logRecordingDiagnostic("session.terminal.failed", { error }); }
      }
      const stoppedContext = timedOutStop ?? recordingContextRef.current ?? practiceContextRef.current;
      const liveContext = practiceContextRef.current;
      const livePending = pendingCheckInRef.current;
      const restoredReplacement = Boolean(
        livePending &&
        liveCurrent.state === "recorded" &&
        replacementPendingIdsRef.current.has(livePending.requestId)
      );
      const samePractice = liveContext.practiceIndex === stoppedContext.practiceIndex &&
        liveContext.practice.id === stoppedContext.practice.id;
      // 正常录音允许边录边翻页。停止后面板可留在当前书页，但保存归属始终用 stoppedContext。
      // 迟到的超时回调和已有录音的替换恢复仍沿用更严格的原页校验。
      const attachAcrossPractice = !samePractice && !timedOutStop && !livePending &&
        !pageHiddenRef.current && liveCurrent.sessionId === current.sessionId &&
        (liveCurrent.state === "recording" || liveCurrent.state === "paused" || liveCurrent.state === "stopping");
      const attachToCurrentPage = mountedRef.current && (samePractice || attachAcrossPractice) && (!timedOutStop || (
        mountedRef.current &&
        (liveCurrent.state === "error" || restoredReplacement ||
          (liveCurrent.state === "idle" && !livePending))
      ));
      timedOutStopRef.current = null;
      recordingContextRef.current = null;
      if (attachToCurrentPage) applyRecordingMachine(next);

      const canAttachStoppedRecording = () => {
        const currentContext = practiceContextRef.current;
        return (
          attachToCurrentPage &&
          mountedRef.current &&
          recordingMachineRef.current.sessionId === current.sessionId &&
          currentContext.practice.id === liveContext.practice.id &&
          currentContext.practiceIndex === liveContext.practiceIndex
        );
      };
      const finishStoppedPage = () => {
        if (attachToCurrentPage || !mountedRef.current || recordingMachineRef.current !== liveCurrent) return;
        // 未挂到面板的迟到回调只解除操作锁，不覆盖当前页的新录音。
        if (liveCurrent.state === "recorded" && pendingCheckInRef.current) return;
        const settled = resetRecordingMachine(
          liveCurrent.state === "error" || liveCurrent.state === "recorded" ? liveCurrent : next,
        );
        if (settled !== liveCurrent) applyRecordingMachine(settled);
      };

      const preserveRestoredReplacement = () => {
        if (!canAttachStoppedRecording()) return false;
        const replacement = restoredReplacement && livePending &&
          pendingCheckInRef.current?.requestId === livePending.requestId
          ? livePending
          : !pendingCheckInRef.current
            ? getPendingCheckInStore().list().find((item) =>
              replacementPendingIdsRef.current.has(item.requestId) &&
              item.recoverable && item.completedAtMs === undefined &&
              item.context.bookId === bundle.book.id &&
              item.context.practiceId === stoppedContext.practice.id)
            : undefined;
        if (!replacement) return false;
        // 新录音无效或保存失败时，旧副本仍是唯一可用数据，跨页也应继续挂在面板供处理。
        replacementPendingIdsRef.current.delete(replacement.requestId);
        applyPendingCheckIn(replacement);
        if (mountedRef.current) {
          setTempRecordingPath(replacement.localPath);
          setRecordingDurationMs(replacement.durationMs);
          setRecordingElapsedMs(replacement.durationMs);
        }
        applyRecordingMachine(restoreRecordedMachine(recordingMachineRef.current));
        return true;
      };

      const discardUnsavedExit = async (failedItem?: PendingCheckIn) => {
        const store = getPendingCheckInStore();
        if (sessionId) {
          try {
            const temporary = failedItem && !failedItem.recoverable ? failedItem :
              store.list().find((item) => item.requestId === sessionId && !item.recoverable);
            if (temporary) await store.remove(temporary.requestId);
          } catch (error) { logRecordingDiagnostic("session.temporary.remove.failed", { error }); }
          try {
            const journal = getRecordingSessionJournal();
            journal.markAbandoned(sessionId);
            journal.clear(sessionId);
            if (recordingSessionIdRef.current === sessionId) recordingSessionIdRef.current = null;
          } catch (error) { logRecordingDiagnostic("session.clear.failed", { error }); }
        }
        if (canAttachStoppedRecording() && !preserveRestoredReplacement()) {
          clearRecordingView();
          applyRecordingMachine(resetRecordingMachine(recordingMachineRef.current));
        }
      };

      const discardedRecording = discardedRecordingRef.current;
      const shouldDiscard = Boolean(
        discardedRecording &&
        discardedRecording.sessionId === current.sessionId &&
        discardedRecording.operationSeq === current.operationSeq
      );
      if (shouldDiscard) {
        if (sessionId) {
          try { getRecordingSessionJournal().clear(sessionId); if (recordingSessionIdRef.current === sessionId) recordingSessionIdRef.current = null; }
          catch (error) { logRecordingDiagnostic("session.clear.failed", { error }); }
        }
        discardedRecordingRef.current = null;
        replacementPendingIdsRef.current.clear();
        if (attachToCurrentPage) {
          clearRecordingView();
          applyRecordingMachine(resetRecordingMachine(next));
        }
        finishStoppedPage();
        releaseStoppedOwner();
        return;
      }

      const parsed = parseNativeRecordingResult(result);
      if (!parsed.ok || !terminalAccepted) {
        if (sessionId) {
          try { getRecordingSessionJournal().clear(sessionId); if (recordingSessionIdRef.current === sessionId) recordingSessionIdRef.current = null; }
          catch (error) { logRecordingDiagnostic("session.clear.failed", { error }); }
        }
        if (attachToCurrentPage && !preserveRestoredReplacement()) {
          clearRecordingView();
          applyRecordingMachine(resetRecordingMachine(next));
        }
        if (attachToCurrentPage && mountedRef.current) {
          Taro.showToast({ title: parsed.ok ? "录音开始未确认，本次录音已放弃" : parsed.message, icon: "none" });
        }
        replacementPendingIdsRef.current.clear();
        finishStoppedPage();
        releaseStoppedOwner();
        return;
      }

      const generation = ++saveGenerationRef.current;
      const replacementBackupIds = [...replacementPendingIdsRef.current];
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
          ...(sessionId ? { recordingSessionId: sessionId } : {}),
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
        if (!saved.persisted && (releaseAfterStop || pageHiddenRef.current || !canAttachStoppedRecording())) {
          await discardUnsavedExit(saved.item);
          return;
        }
        if (saved.persisted && sessionId) {
          try { getRecordingSessionJournal().clear(sessionId); if (recordingSessionIdRef.current === sessionId) recordingSessionIdRef.current = null; }
          catch (error) { logRecordingDiagnostic("session.clear.failed", { error }); }
        }
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
        if (saved.persisted && recordingMachineRef.current.sessionId === current.sessionId) {
          try {
            await removeReplacementBackups(replacementBackupIds);
          } catch (_error) {
            // 旧副本会继续留在“我的打卡”中，后续仍可手动清理。
          }
        }
      } catch (error) {
        // 连临时副本都没拿到时，保留 terminal 只会让录音按钮永久锁住。
        // 清除本会话并交还录音器；可恢复的旧副本由 discardUnsavedExit 保留。
        const showFailure = canAttachStoppedRecording() && generation === saveGenerationRef.current;
        await discardUnsavedExit();
        if (showFailure && mountedRef.current && !pageHiddenRef.current) {
          void Taro.showModal({
            title: "录音保存失败",
            content: getRecordingErrorMessage(error),
            showCancel: false,
          });
        }
      } finally {
        // 旧副本仅能由这次替换录音清理；失败或清理未完成时，后续其他页录音不能继承删除意图。
        if (recordingMachineRef.current.sessionId === current.sessionId) replacementPendingIdsRef.current.clear();
        if (generation === saveGenerationRef.current) {
          savingRecordingRef.current = false;
          if (mountedRef.current) {
            setIsSavingRecording(false);
          }
        }
        finishStoppedPage();
        // 卸载后的 terminal 由协调器保留到本地持久化真正结束，再允许下一页开始录音。
        releaseStoppedOwner();
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
      const stateConflict = isRecorderStateConflictError(error);
      if (stateConflict) setNativeRecorderOccupied(true);
      const recoveryRequired = stateConflict || getRecorderCoordinator().getPhase() === "uncertain";
      const recoverableStop = (timeoutOperation === "stop" || recoveryRequired)
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
          ...(recordingContextRef.current ?? practiceContextRef.current),
        };
      } else if (!timeoutOperation && !recoveryRequired) {
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
          content: getRecorderFailureMessage(error, Boolean(recoveryRequired || timeoutOperation)),
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
      // AppHide 已主动交还 owner，当前 cleanup 只是为前台重新 acquire。
      if (mountedRef.current && recorderOwnerRef.current !== owner) return;
      mountedRef.current = false;
      detachRecorderOwner();
    };
  }, [
    applyPendingCheckIn,
    applyRecordingMachine,
    bundle.book.id,
    bundle.book.title,
    clearRecordingView,
    detachRecorderOwner,
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
    if (recordingState !== "error") return undefined;
    const error = recordingMachineRef.current.lastError;
    if (
      !isRecorderStateConflictError(error) &&
      getRecorderTimeoutOperation(error) === null &&
      getRecorderCoordinator().getPhase() === "idle"
    ) return undefined;

    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = () => {
      if (!active) return;
      if (
        mountedRef.current &&
        !pageHiddenRef.current &&
        !savingRecordingRef.current &&
        getRecorderCoordinator().getPhase() === "idle" &&
        recordingMachineRef.current.state === "error"
      ) {
        applyRecordingMachine(resetRecordingMachine(recordingMachineRef.current));
        return;
      }
      timer = setTimeout(check, RECORDER_ACQUIRE_RETRY_MS);
    };
    timer = setTimeout(check, RECORDER_ACQUIRE_RETRY_MS);
    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [applyRecordingMachine, recordingMachine.lastError, recordingState]);

  useEffect(() => {
    if ((recordingState !== "recorded" && recordingState !== "idle") ||
      recorderPhase === "idle") return undefined;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = () => {
      if (!active) return;
      if (getRecorderCoordinator().getPhase() === "idle") {
        setRecorderPhaseRefresh((value) => value + 1);
        return;
      }
      timer = setTimeout(check, RECORDER_ACQUIRE_RETRY_MS);
    };
    timer = setTimeout(check, RECORDER_ACQUIRE_RETRY_MS);
    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [recordingState, recorderPhase, recorderPhaseRefresh]);

  useEffect(() => {
    if (recordingState !== "recording") return undefined;

    const timer = setInterval(() => {
      setRecordingElapsedMs(
        getRecordingElapsedMs(recordingTimelineRef.current, Date.now())
      );
    }, 250);
    return () => clearInterval(timer);
  }, [recordingState]);

  const scheduleExitedRecordingCleanup = useCallback(() => {
    const sessionId = recordingSessionIdRef.current;
    if (!sessionId) return;
    scheduleExitedRecordingSettlement(sessionId, () => {
      if (recordingSessionIdRef.current !== sessionId) return;
      recordingSessionIdRef.current = null;
      teardownAwaitingStopRef.current = false;
      if (savingRecordingRef.current) {
        // 保存已越过收尾期限；旧 Promise 迟到时不得再改动本页或新录音的状态。
        saveGenerationRef.current += 1;
        savingRecordingRef.current = false;
        if (mountedRef.current) setIsSavingRecording(false);
      }
      if (!mountedRef.current) return;
      if (!pendingCheckInRef.current) clearRecordingView();
      applyRecordingMachine(abandonRecordingMachine(
        recordingMachineRef.current,
        Boolean(pendingCheckInRef.current),
      ));
      if (!pageHiddenRef.current) setRecorderAcquireAttempt((attempt) => attempt + 1);
    });
  }, [applyRecordingMachine, clearRecordingView]);

  const handlePracticeHidden = useCallback(() => {
    if (pageHiddenRef.current) return;
    // 权限弹窗返回前曾进过后台的点击必须作废，即使页面随后又恢复显示也不能自动开麦。
    recordingStartAttemptRef.current += 1;
    practiceSwitchAttemptRef.current += 1;
    pendingRestoreAttemptRef.current += 1;
    pageHiddenRef.current = true;
    bookMeasurementSeqRef.current += 1;
    // 页面隐藏后停止播放和录音；A 页的终止回调交给全局协调器持有。
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
    if (current.state === "starting" || current.state === "recording" || current.state === "paused") {
      stopRecorderWhileHidden(true);
    }
    // 即使当前没有录音也要释放 owner，否则仍挂载的 A 页会一直挡住 B 页。
    detachRecorderOwner();
    scheduleExitedRecordingCleanup();
  }, [detachRecorderOwner, scheduleExitedRecordingCleanup, stopRecorderWhileHidden]);

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
    // 热返回不会再运行 App.onLaunch；若原生文件已经结束但还没落盘，立即自动保存。
    // 正在由旧页面保存的任务保持原归属，避免重复写入同一临时文件。
    if (!savingRecordingRef.current) {
      try {
        const entry = getRecordingSessionJournal().read();
        const coordinator = getRecorderCoordinator();
        if (entry?.stage === "terminal" && coordinator.getPhase() === "idle" &&
          coordinator.getEntryRecoveryStatus() === "none") {
          releaseRecorderOwner();
          ensureUnfinishedRecordingRecovery();
          setRecorderAcquireAttempt((attempt) => attempt + 1);
        }
      } catch (error) {
        logRecordingDiagnostic("session.read.failed", { error });
        if (getRecorderCoordinator().getEntryRecoveryStatus() !== "saving") {
          ensureUnfinishedRecordingRecovery();
          setRecorderAcquireAttempt((attempt) => attempt + 1);
        }
      }
    }
    if (wasHidden) {
      autoAbandonCountRef.current = 0;
      setAutoRecoveryFailureMessage(null);
      const oldSessionId = recordingSessionIdRef.current;
      if (oldSessionId) {
        try {
          const currentEntry = getRecordingSessionJournal().read();
          if (!currentEntry || currentEntry.id !== oldSessionId) {
            recordingSessionIdRef.current = null;
            if (!savingRecordingRef.current && !pendingCheckInRef.current) {
              clearRecordingView();
              applyRecordingMachine(resetRecordingMachine(recordingMachineRef.current));
            }
          }
        } catch (error) { logRecordingDiagnostic("session.read.failed", { error }); }
      }
    }
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
    if (latest?.completedAtMs !== undefined) {
      replacementPendingIdsRef.current.delete(latest.requestId);
      applyPendingCheckIn(null);
      if (recordingMachineRef.current.state === "recorded") {
        clearRecordingView();
        applyRecordingMachine(resetRecordingMachine(recordingMachineRef.current));
      }
    } else if (latest) {
      applyPendingCheckIn(latest);
      setTempRecordingPath(latest.localPath);
    }
    if (wasHidden) {
      if (!recorderOwnerRef.current) {
        setRecorderAcquireAttempt((attempt) => attempt + 1);
      }
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
    // 返回、重定向和组件重挂统一等待原生结束回调并保存原页录音。
    detachRecorderOwner();
    scheduleExitedRecordingCleanup();
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
    if (!clearSessionJournalBeforeRemoving(pending)) {
      void Taro.showModal({ title: "本地录音未删除", content: "录音状态暂时无法更新，请稍后重试。", showCancel: false });
      return false;
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
    const unfinishedSaved = pendingCheckInRef.current?.recoverable === true;
    if (!unfinishedSaved && getPracticeSwitchPolicy(state) !== "confirm-discard") return true;
    const maySaveActiveRecording = state !== "recorded" && state !== "uploading";
    const confirmation = await Taro.showModal({
      title: "离开训练？",
      content: unfinishedSaved
        ? "这段录音尚未完成练习，文件已保存。离开后可以回来继续处理，确定离开训练吗？"
        : maySaveActiveRecording
        ? "离开前将结束并保存当前录音；如果微信生成有效文件，可在“我的打卡”中查看。是否继续？"
        : "当前录音尚未处理，确定离开训练吗？",
      confirmText: unfinishedSaved ? "离开训练" : maySaveActiveRecording ? "结束并保存" : "离开训练",
      confirmColor: "#d85b3f",
    });
    if (!confirmation.confirm) return false;
    if (state === "recording" || state === "paused") {
      runRecorderAction("stop");
    }
    // 已保存的文件留给用户回到训练页继续处理；退出不代替“删除录音”。
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
      // 书页已经切换时停止本地回听，已保存的录音和操作区仍留在当前训练会话。
      recordingAudioRef.current?.stop();
      setIsPlayingRecording(false);
      // 已保存但尚未完成的录音继续占用唯一“我的跟读”面板，直到完成、重录或删除。
      // stop 超时留下的 terminal 上下文单独保存在 timedOutStopRef，不能随视图一起清掉。
      if (beforeRemoval.state === "recorded" && !pendingCheckInRef.current) {
        applyPendingCheckIn(null);
        clearRecordingView();
        applyRecordingMachine(resetRecordingMachine(beforeRemoval));
        if (!timedOutStopRef.current) replacementPendingIdsRef.current.clear();
      }
      pendingRestoreAttemptRef.current += 1;
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

    let capacity: { allowed: boolean; message: string; reason?: "local-recordings-full" | "capacity-check-failed" };
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
      if (capacity.reason === "local-recordings-full") {
        const choice = await Taro.showModal({
          title: "本地录音空间不足",
          content: capacity.message,
          confirmText: "整理录音",
          cancelText: "稍后",
        });
        if (choice.confirm && canStartRecordingNow(request)) {
          await Taro.navigateTo({ url: "/pages/MyCheckIns/MyCheckIns" });
        }
      } else {
        void Taro.showModal({
          title: "无法检查录音空间",
          content: `${capacity.message}。当前无法判断是本地录音占用还是设备空间问题，请稍后重试。`,
          showCancel: false,
        });
      }
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
    teardownAwaitingStopRef.current = false;
    discardedRecordingRef.current = null;
    pendingRestoreSuppressedRef.current = false;
    recordingContextRef.current = requestedContext;
    let sessionId: string;
    try {
      sessionId = getRecordingSessionJournal().begin({
        bookId: bundle.book.id,
        bookTitle: bundle.book.title,
        practiceId: requestedContext.practice.id,
        practiceIndex: requestedContext.practiceIndex,
        pageNumber: requestedContext.practice.pageNumber,
        sectionTitle: requestedContext.practice.sectionTitle,
        imageUrl: requestedContext.practice.imageUrl,
      }).id;
      recordingSessionIdRef.current = sessionId;
    } catch (error) {
      recordingContextRef.current = null;
      logRecordingDiagnostic("session.begin.failed", { error });
      void Taro.showModal({
        title: "暂不能录音",
        content: "录音状态正在自动恢复，请稍后再试。若一直无法录音，请检查手机存储空间后返回本页重试。",
        showCancel: false,
      });
      return;
    }
    replacementPendingIdsRef.current.clear();
    const previousPending = pendingCheckInRef.current;
    if (previousPending) {
      replacementPendingIdsRef.current.add(previousPending.requestId);
      applyPendingCheckIn(null);
    }
    clearRecordingView();
    if (!runRecorderAction("start")) {
      const liveState = recordingMachineRef.current.state;
      const startAlreadyConfirmed = Boolean(timedOutStopRef.current) || liveState === "starting" || liveState === "recording" ||
        liveState === "paused" || liveState === "stopping" || liveState === "recorded";
      // 原生可能先同步发 onStart/onStop 再抛错；此时仍是本次会话，不能丢归属或恢复旧录音。
      if (!startAlreadyConfirmed && getRecorderCoordinator().getPhase() === "idle") {
        recordingContextRef.current = null;
        try { getRecordingSessionJournal().clear(sessionId); recordingSessionIdRef.current = null; }
        catch (error) { logRecordingDiagnostic("session.clear.failed", { error }); }
      }
      if (!startAlreadyConfirmed && previousPending) {
        replacementPendingIdsRef.current.delete(previousPending.requestId);
        applyPendingCheckIn(previousPending);
        setTempRecordingPath(previousPending.localPath);
        setRecordingDurationMs(previousPending.durationMs);
        setRecordingElapsedMs(previousPending.durationMs);
        applyRecordingMachine(restoreRecordedMachine(recordingMachineRef.current));
      }
    }
  };

  const notifyPendingRecorderAction = () => {
    Taro.showToast({ title: "录音正在处理，请稍候", icon: "none" });
  };

  const pauseRecording = () => {
    if (recordingMachineRef.current.pendingAction) return notifyPendingRecorderAction();
    runRecorderAction("pause");
  };

  const resumeRecording = () => {
    if (recordingMachineRef.current.pendingAction) return notifyPendingRecorderAction();
    runRecorderAction("resume");
  };

  const stopRecording = () => {
    if (recordingMachineRef.current.pendingAction) return notifyPendingRecorderAction();
    runRecorderAction("stop");
  };

  const checkRecorderRecovery = async (options?: { autoDiscard?: boolean }): Promise<boolean> => {
    const autoDiscard = options?.autoDiscard === true;
    const coordinator = getRecorderCoordinator();
    if (autoDiscard && coordinator.getEntryRecoveryStatus() !== "none") return false;
    const journal = getRecordingSessionJournal();
    let entry;
    let unreadable = false;
    try { entry = journal.read(); }
    catch (error) { unreadable = true; logRecordingDiagnostic("session.read.failed", { error }); }
    if (autoDiscard && unreadable) return false;
    // 已取得可恢复文件时交给保存流程，自动放弃只针对还没有结束结果的旧录音。
    if (autoDiscard && entry?.stage === "terminal") return false;
    if (!entry && !unreadable && coordinator.getPhase() === "idle" && !(autoDiscard && isRecorderBusy)) {
      applyRecordingMachine(resetRecordingMachine(recordingMachineRef.current));
      return true;
    }
    if (coordinator.getEntryRecoveryStatus() === "saving" || savingRecordingRef.current) {
      if (!autoDiscard) Taro.showToast({ title: "录音正在保存，请稍候", icon: "none" });
      return false;
    }
    const canAttemptSave = coordinator.getEntryRecoveryStatus() !== "none" || coordinator.getPhase() === "idle";
    const choice = autoDiscard ? { confirm: true } : await Taro.showModal({
      title: "处理上次录音",
      content: !canAttemptSave
        ? "上次录音还在结束中。可以继续等待；若不需要这段录音，可放弃后重新录制。"
        : entry?.stage === "terminal"
          ? "上次录音尚未安全保存。可尝试保存，或放弃后重新录制。"
          : "上次录音尚未安全保存。可尝试结束并保存，或放弃后重新录制。",
      confirmText: "放弃并重录",
      cancelText: canAttemptSave ? "尝试保存" : "继续等待",
    });
    let latestEntry;
    let latestUnreadable = false;
    try { latestEntry = journal.read(); }
    catch (_error) { latestUnreadable = true; }
    if (entry?.id !== latestEntry?.id || unreadable !== latestUnreadable) {
      if (!latestEntry && !latestUnreadable && coordinator.getPhase() === "idle") {
        setRecorderAcquireAttempt((attempt) => attempt + 1);
        if (!autoDiscard) Taro.showToast({ title: "上次录音已处理，可重新录制", icon: "none" });
      } else {
        if (!autoDiscard) Taro.showToast({ title: "录音状态已更新，请重新确认", icon: "none" });
      }
      return false;
    }
    if (!choice.confirm) {
      // 热返回不会再触发 App.onLaunch；协调器已 idle 时先用残留 journal 注册恢复任务。
      if (coordinator.getPhase() === "idle" && coordinator.getEntryRecoveryStatus() === "none") {
        releaseRecorderOwner();
        ensureUnfinishedRecordingRecovery();
        setRecorderAcquireAttempt((attempt) => attempt + 1);
      }
      if (coordinator.getEntryRecoveryStatus() === "none") {
        Taro.showToast({ title: "录音正在结束，可稍后再试或放弃重录", icon: "none" });
        return false;
      }
      void coordinator.retryEntryRecovery().then((saved) => {
        if (!mountedRef.current || pageHiddenRef.current) return;
        if (saved) {
          return;
        }
        const status = coordinator.getEntryRecoveryStatus();
        if (status === "none") return;
        Taro.showToast({
          title: status === "failed"
            ? "保存失败，可重试或放弃重录"
            : status === "saving"
              ? "录音正在保存，请稍候"
              : "正在等待录音结束，可放弃重录",
          icon: "none",
        });
      });
      return false;
    }
    if (coordinator.getEntryRecoveryStatus() === "saving" || savingRecordingRef.current) {
      if (!autoDiscard) Taro.showToast({ title: "录音正在保存，请稍候", icon: "none" });
      return false;
    }
    const idleLocalSession = autoDiscard && coordinator.getPhase() === "idle" && entry?.id === recordingSessionIdRef.current;
    if ((autoDiscard || coordinator.getPhase() !== "idle") &&
      !coordinator.abandonUnconfirmedRecording() && !idleLocalSession) {
      if (!autoDiscard) Taro.showToast({ title: "录音正在处理，请稍候", icon: "none" });
      return false;
    }
    try {
      if (unreadable) journal.discardUnreadable();
      else if (entry) {
        if (!journal.markAbandoned(entry.id) || !journal.clear(entry.id)) throw new Error("上次录音状态已变化");
      }
      recordingSessionIdRef.current = null;
    }
    catch (error) {
      logRecordingDiagnostic("session.discard.failed", { error });
      if (autoDiscard) {
        const message = getRecordingErrorMessage(error);
        setAutoRecoveryFailureMessage(message.includes("存储空间不足")
          ? "设备存储空间不足，请清理手机存储空间后返回本页重试。"
          : "清理上次录音失败。请检查手机存储空间，返回本页重试；若仍无法恢复，再关闭并重新打开微信。");
      } else {
        void Taro.showToast({ title: "清理失败，请稍后重试", icon: "none" });
      }
      return false;
    }
    recordingStartAttemptRef.current += 1;
    timedOutStopRef.current = null;
    discardedRecordingRef.current = null;
    recordingContextRef.current = null;
    replacementPendingIdsRef.current.clear();
    applyRecordingMachine(abandonRecordingMachine(
      recordingMachineRef.current,
      Boolean(pendingCheckInRef.current),
    ));
    setAutoRecoveryFailureMessage(null);
    setRecorderAcquireAttempt((attempt) => attempt + 1);
    if (!autoDiscard) Taro.showToast({ title: "已放弃上次录音，可重新尝试录制", icon: "none" });
    return true;
  };

  const autoAbandonHandlerRef = useRef<() => Promise<boolean>>(async () => false);
  autoAbandonHandlerRef.current = () => checkRecorderRecovery({ autoDiscard: true });
  useEffect(() => {
    const coordinator = getRecorderCoordinator();
    const phase = coordinator.getPhase();
    const hasLocalUnfinishedSession = () => {
      try {
        const entry = getRecordingSessionJournal().read();
        return entry?.stage !== "terminal" && entry?.id === recordingSessionIdRef.current && Boolean(recordingSessionIdRef.current);
      }
      catch (_error) { return false; }
    };
    const hasTerminalSession = () => {
      try { return getRecordingSessionJournal().read()?.stage === "terminal"; }
      catch (_error) { return true; }
    };
    const canAbandonPhase = (currentPhase: RecorderCoordinatorPhase) =>
      currentPhase === "draining" || currentPhase === "uncertain" ||
      (currentPhase === "idle" && (isRecorderBusy || hasLocalUnfinishedSession()));
    const canAbandonCurrentState = () =>
      ["checking", "idle", "error", "recorded"].includes(recordingMachineRef.current.state) ||
      (recordingMachineRef.current.state === "stopping" && teardownAwaitingStopRef.current);
    if (
      pageHiddenRef.current || !mountedRef.current ||
      autoAbandonCountRef.current >= 2 ||
      coordinator.getEntryRecoveryStatus() !== "none" ||
      savingRecordingRef.current || isSavingRecording || isDeletingRecording ||
      hasTerminalSession() ||
      !canAbandonCurrentState() ||
      !canAbandonPhase(phase)
    ) return undefined;
    const timer = setTimeout(() => {
      const latestPhase = coordinator.getPhase();
      if (
        !mountedRef.current || pageHiddenRef.current || savingRecordingRef.current ||
        hasTerminalSession() ||
        !canAbandonCurrentState() ||
        coordinator.getEntryRecoveryStatus() !== "none" ||
        !canAbandonPhase(latestPhase)
      ) return;
      autoAbandonCountRef.current += 1;
      void autoAbandonHandlerRef.current().then((recovered) => {
        if (!recovered && mountedRef.current && !pageHiddenRef.current) {
          setRecorderPhaseRefresh((refresh) => refresh + 1);
        }
      });
    }, RECORDER_AUTO_ABANDON_MS);
    return () => clearTimeout(timer);
  }, [isRecorderBusy, isSavingRecording, isDeletingRecording, recordingState, recorderPhase, recorderPhaseRefresh]);

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

  const sessionIdForPendingRecording = (pending: PendingCheckIn): string | null => {
    try {
      const entry = getRecordingSessionJournal().read();
      if (!entry || entry.stage !== "terminal") return null;
      return entry.id.toLowerCase() === pending.requestId.toLowerCase() ||
        (entry.context.practiceId === pending.context.practiceId &&
        entry.context.practiceIndex === pending.context.practiceIndex &&
        entry.terminal.tempFilePath === pending.localPath) ? entry.id : null;
    } catch (error) {
      logRecordingDiagnostic("session.read.failed", { error });
      return null;
    }
  };

  const retrySaveRecording = async () => {
    const pending = pendingCheckInRef.current;
    if (!pending || pending.recoverable || savingRecordingRef.current || deletingRecordingRef.current || completionInFlightRef.current || practiceSwitchInFlightRef.current || pageHiddenRef.current || recordingMachineRef.current.state !== "recorded") return;
    const sessionId = sessionIdForPendingRecording(pending);
    // 用户选择救回本段后，之前尚在等待权限的重录手势永久失效。
    recordingStartAttemptRef.current += 1;
    savingRecordingRef.current = true;
    setIsSavingRecording(true);
    const generation = ++saveGenerationRef.current;
    recordingAudioRef.current?.stop();
    setIsPlayingRecording(false);
    try {
      const result = await getPendingCheckInStore().retrySave(pending.requestId);
      if (result?.persisted && sessionId) {
        try { getRecordingSessionJournal().clear(sessionId); recordingSessionIdRef.current = null; }
        catch (error) { logRecordingDiagnostic("session.clear.failed", { error }); }
      }
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
      if (!clearSessionJournalBeforeRemoving(pending)) {
        if (mountedRef.current && !pageHiddenRef.current) {
          Taro.showToast({ title: "删除失败，请稍后重试", icon: "none" });
        }
        return;
      }
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
      // 在别的教材页处理这段录音后，该页原有草稿可重新显示；原页删除后保持空白。
      pendingRestoreSuppressedRef.current = practiceContextRef.current.practice.id === pending.context.practiceId;
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
  let hasUnfinishedRecording = true;
  let unfinishedSessionId: string | null = null;
  let unfinishedSessionHasResult = false;
  let unfinishedSessionUnreadable = false;
  try {
    const unfinished = getRecordingSessionJournal().read();
    hasUnfinishedRecording = Boolean(unfinished);
    unfinishedSessionId = unfinished?.id ?? null;
    unfinishedSessionHasResult = unfinished?.stage === "terminal";
  }
  catch (_error) { unfinishedSessionUnreadable = true; }
  const hasEntryRecovery = getRecorderCoordinator().getEntryRecoveryStatus() !== "none" ||
    unfinishedSessionUnreadable ||
    (unfinishedSessionHasResult && !isSavingRecording) ||
    (hasUnfinishedRecording && recorderPhase === "idle" && !isRecorderBusy &&
      (!unfinishedSessionId || unfinishedSessionId !== recordingSessionIdRef.current));
  const recordingRecoveryRequired = recordingState === "error" && (
    isRecorderStateConflictError(recordingMachine.lastError) ||
    getRecorderTimeoutOperation(recordingMachine.lastError) !== null ||
    getRecorderCoordinator().getPhase() !== "idle" ||
    hasUnfinishedRecording
  );
  const recorderStateLocked = !recorderOwnerRef.current || recorderPhase !== "idle" || hasUnfinishedRecording;
  const stoppingRecoveryRequired = recordingState === "stopping" && !isSavingRecording && (
    (hasUnfinishedRecording && getRecorderCoordinator().getPhase() === "idle") ||
    getRecorderCoordinator().getPhase() === "uncertain" ||
    (teardownAwaitingStopRef.current && getRecorderCoordinator().getPhase() === "draining")
  );
  const recorderLockMessage = unfinishedSessionUnreadable
      ? RECORDER_STORAGE_GUIDANCE
    : autoRecoveryFailureMessage && autoAbandonCountRef.current >= 2
      ? autoRecoveryFailureMessage
    : nativeRecorderOccupied && autoAbandonCountRef.current >= 2
      ? RECORDER_OCCUPIED_GUIDANCE
      : autoAbandonCountRef.current >= 2
        ? RECORDER_RECOVERY_STALLED_GUIDANCE
        : hasEntryRecovery
          ? RECORDER_RECOVERY_MESSAGE
        : recordingState === "recorded" && !hasUnfinishedRecording && recorderPhase === "draining"
          ? "录音正在收尾，请稍候"
        : RECORDER_AUTO_RECOVERY_MESSAGE;
  const recordedRecorderLocked = recordingState === "recorded" && recorderStateLocked;
  const retryRecordingLocked = !pendingCheckIn || isSavingRecording || isDeletingRecording || recordedRecorderLocked;
  const retryRecordingLockMessage = isSavingRecording
    ? "录音正在保存，请稍候"
    : isDeletingRecording
      ? "正在删除录音，请稍候"
    : recordedRecorderLocked
          ? recorderLockMessage
          : "录音正在处理，请稍候";
  const pendingRecorderActionClass = recordingMachine.pendingAction ? " record-button--locked" : "";
  const retryRecordedPractice = async () => {
    const pending = pendingCheckInRef.current;
    if (!pending) return;
    const originIndex = bundle.book.id === pending.context.bookId
      ? bundle.practices.findIndex((item) => item.id === pending.context.practiceId)
      : -1;
    if (originIndex < 0) {
      Taro.showToast({ title: "原训练页暂不可用，请先完成或删除录音", icon: "none" });
      return;
    }
    if (originIndex !== practiceContextRef.current.practiceIndex) {
      await requestPracticeSwitch(originIndex, { animate: false });
      if (
        practiceContextRef.current.practiceIndex !== originIndex ||
        pendingCheckInRef.current?.requestId !== pending.requestId ||
        recordingMachineRef.current.state !== "recorded"
      ) return;
    }
    await startRecording();
  };
  const retryRecordingButton = recordingState === "recorded" ? (
    <Button
      className={`practice-recorder__retry device-touch-target${retryRecordingLocked ? " practice-recorder__retry--locked" : ""}`}
      aria-disabled={retryRecordingLocked}
      onClick={() => {
        if (retryRecordingLocked) {
          Taro.showToast({ title: retryRecordingLockMessage, icon: "none" });
          return;
        }
        return retryRecordedPractice();
      }}
    >
      重新录制
    </Button>
  ) : null;
  const withDeletionFeedback = (action: () => unknown) => {
    if (isDeletingRecording || deletingRecordingRef.current) {
      Taro.showToast({ title: "正在删除录音，请稍候", icon: "none" });
      return;
    }
    return action();
  };
  const deleteRecordingButton = recordingState === "recorded" && !isSavingRecording && pendingCheckIn ? (
    <Button
      className={`practice-recorder__retry practice-recorder__delete device-touch-target${isDeletingRecording ? " practice-recorder__retry--locked" : ""}`}
      aria-disabled={isDeletingRecording}
      loading={isDeletingRecording}
      onClick={() => withDeletionFeedback(deleteRecording)}
    >
      删除录音
    </Button>
  ) : null;

  // 当前图层在 Swiper 同级接收手势；微信不支持 Swiper.disableTouch。
  let activeBookZoomLayer: ReactNode = null;

  return (
    <View className={`practice-page ${layoutClassName}${isFittedLayout ? " practice-page--fitted" : ""}${layout.orientation === "landscape" ? " practice-page--landscape" : ""}`}>
      <PageMeta pageStyle={isDirectoryOpen ? "overflow: hidden;" : ""} />
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
                  bookZoomActive ||
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
                  const isActiveSlide = index === practiceIndex;
                  const canZoom = Boolean(isActiveSlide && bookViewportSize &&
                    bookViewportSize.width > 0 && bookViewportSize.height > 0 &&
                    (!isLandscapeLayout || fittedBookSize));
                  const renderSlidePage = (inZoomLayer: boolean, showHotspots: boolean) => (
                      <PracticeBookPage
                        scrollable={isLandscapeLayout && isSlideRetained && !inZoomLayer}
                        sized={isLandscapeLayout && inZoomLayer}
                        active={isActiveSlide}
                        imageSize={slideImageSize}
                        onScroll={isActiveSlide ? (event) => {
                          if (event.detail.scrollTop > 0 && index === practiceContextRef.current.practiceIndex) {
                            setBookScrollHintDismissed(true);
                          }
                        } : undefined}
                      >
                        {isSlideRetained ? (
                          <Image
                            className={
                              isActiveSlide && (inZoomLayer || !canZoom)
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
                        {showHotspots && isActiveSlide && (!stablePortraitCanvasNaturalSize || fittedBookSize) ? (
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
                                style={{
                                  left: hotspot.left,
                                  top: hotspot.top,
                                  transform: "translate(-50%, -50%)",
                                }}
                                onClick={() => {
                                  if (!hotspotGestureBlockedRef.current) {
                                    playModelAudio(hotspot.id, hotspot.url);
                                  }
                                }}
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
                  );
                  if (canZoom) {
                    activeBookZoomLayer = (
                      <PracticeBookZoom
                        key={`${item.id}:${layout.orientation}`}
                        viewportSize={bookViewportSize!}
                        contentSize={isLandscapeLayout ? fittedBookSize! : bookViewportSize!}
                        renderContent={() => renderSlidePage(true, true)}
                        onZoomActiveChange={setBookZoomActive}
                        onHotspotGestureBlockChange={(blocked) => {
                          hotspotGestureBlockedRef.current = blocked;
                        }}
                        onVerticalMove={() => setBookScrollHintDismissed(true)}
                        onEdgeTurn={(direction) => {
                          void requestPracticeSwitch(practiceContextRef.current.practiceIndex + direction);
                        }}
                      />
                    );
                  }
                  return (
                    <SwiperItem
                      key={item.id}
                      className={`practice-book-slide${stablePortraitCanvasNaturalSize ? " practice-book-slide--stable-canvas" : ""}`}
                    >
                      <View className={`practice-book-static${canZoom ? " practice-book-static--covered" : ""}`}>
                        {renderSlidePage(false, !canZoom)}
                      </View>
                    </SwiperItem>
                  );
                })}
              </Swiper>
              {activeBookZoomLayer}
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
                    {isRecorderRecoveryRequired
                      ? recorderLockMessage
                      : isRecorderBusy
                        ? recorderLockMessage
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
                <>
                  {recorderStateLocked && (
                    <>
                      <Text className='practice-recorder__tip'>{recorderLockMessage}</Text>
                    </>
                  )}
                  {!recorderStateLocked && nativeRecorderOccupied && (
                    <Text className='practice-recorder__tip'>{RECORDER_OCCUPIED_GUIDANCE}</Text>
                  )}
                  <Button
                    className={`record-button device-touch-target${recorderStateLocked ? " record-button--locked" : ""}`}
                    aria-disabled={recorderStateLocked}
                    onClick={() => {
                      if (recorderStateLocked) {
                        if (autoAbandonCountRef.current >= 2) {
                          void Taro.showModal({ title: "录音设备暂未恢复", content: recorderLockMessage, showCancel: false });
                        } else {
                          Taro.showToast({ title: "录音设备正在自动恢复", icon: "none" });
                        }
                        return;
                      }
                      return startRecording();
                    }}
                  >
                    <Text className='record-button__dot' />
                    {recorderStateLocked ? "录音设备收尾中" : nativeRecorderOccupied ? "重新尝试录音" : "开始跟读录音"}
                  </Button>
                </>
              )}

              {recordingState === "recording" && (
                <>
                  <View className='recording-indicator'>
                    <Text className='recording-indicator__pulse' />
                    <Text>{recordingMachine.pendingAction === "pause"
                      ? "正在暂停录音，请稍候…"
                      : "正在录音，请继续跟读"}</Text>
                  </View>
                  <View className='recording-controls device-actions'>
                    {recordingMachine.capabilities?.canPause &&
                      recordingMachine.capabilities.canResume && (
                        <Button
                          className={`record-button device-touch-target record-button--pause${pendingRecorderActionClass}`}
                          aria-disabled={Boolean(recordingMachine.pendingAction)}
                          onClick={pauseRecording}
                        >
                          暂停录音
                        </Button>
                      )}
                    <Button
                      className={`record-button device-touch-target record-button--stop${pendingRecorderActionClass}`}
                      aria-disabled={Boolean(recordingMachine.pendingAction)}
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
                        {recordingMachine.pendingAction === "resume"
                          ? "正在继续录音，请稍候…"
                          : recordingMachine.needsManualResume
                        ? recordingMachine.pauseReason === "interruption"
                          ? "录音被系统打断，请确认环境恢复后手动继续"
                          : "页面切换时已暂停，请确认后手动继续"
                        : "录音已暂停，可播放示范音频后继续"}
                    </Text>
                  </View>
                  <View className='recording-controls device-actions'>
                    {recordingMachine.capabilities?.canResume && (
                      <Button
                        className={`record-button device-touch-target record-button--resume${pendingRecorderActionClass}`}
                        aria-disabled={Boolean(recordingMachine.pendingAction)}
                        onClick={resumeRecording}
                      >
                        继续录音
                      </Button>
                    )}
                    <Button
                      className={`record-button device-touch-target record-button--stop${pendingRecorderActionClass}`}
                      aria-disabled={Boolean(recordingMachine.pendingAction)}
                      onClick={stopRecording}
                    >
                      结束录音
                    </Button>
                  </View>
                </>
              )}

              {recordingState === "stopping" && (
                <View className='recorder-status recorder-status--neutral'>
                  <Text>{stoppingRecoveryRequired
                    ? recorderLockMessage
                    : "正在保存本次录音，请勿离开…"}</Text>
                </View>
              )}

              {recordingState === "error" && (
                <>
                  <View className='recorder-status recorder-status--warning'>
                    <Text>
                      {getRecorderVisibleErrorMessage(recordingMachine.lastError) ||
                        "录音未完成，请重新尝试。"}
                    </Text>
                  </View>
                  {recordingRecoveryRequired ? (
                    <Text className='practice-recorder__tip'>{recorderLockMessage}</Text>
                  ) : (
                    <Button
                      className='record-button device-touch-target'
                      onClick={startRecording}
                    >
                      重新尝试录音
                    </Button>
                  )}
                </>
              )}

              {recordingState === "recorded" && (
                <>
                  <Text className='practice-recorder__tip'>
                    {isSavingRecording
                      ? "正在安全保存录音，请稍候…"
                      : pendingCheckIn?.recoverable
                        ? pendingCheckIn.context.practiceId === practice.id
                          ? "已保存录音文件。"
                          : "这段录音尚未完成，请选择完成练习、重新录制或删除录音。"
                        : `录音保存失败（${formatDuration(recordingDurationMs)}），请重试保存；关闭小程序后可能无法恢复。`}
                  </Text>
                  {recordedRecorderLocked && (
                    <>
                      <Text className='practice-recorder__tip'>{recorderLockMessage}</Text>
                    </>
                  )}
                  {!isSavingRecording && pendingCheckIn && (
                    <>
                      {!pendingCheckIn.recoverable && (
                        <Button
                          className={`record-actions__secondary device-touch-target${isDeletingRecording ? " record-actions__secondary--locked" : ""}`}
                          aria-disabled={isDeletingRecording}
                          onClick={() => withDeletionFeedback(retrySaveRecording)}
                        >重试保存</Button>
                      )}
                      <View className='record-actions device-actions'>
                        <Button
                          className={`record-actions__secondary device-touch-target${isDeletingRecording ? " record-actions__secondary--locked" : ""}`}
                          aria-disabled={isDeletingRecording}
                          onClick={() => withDeletionFeedback(playRecording)}
                        >
                          {isPlayingRecording ? "停止回听" : "回听录音"}
                        </Button>
                        <Button
                          className={`check-in-button device-touch-target${isDeletingRecording ? " check-in-button--locked" : ""}`}
                          aria-disabled={isDeletingRecording}
                          onClick={() => withDeletionFeedback(submitCheckIn)}
                        >
                          完成练习
                        </Button>
                      </View>
                    </>
                  )}
                  {isLandscapeLayout && retryRecordingButton}
                  {isLandscapeLayout && !isSavingRecording && pendingCheckIn && deleteRecordingButton}
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
    </View>
  );
}
