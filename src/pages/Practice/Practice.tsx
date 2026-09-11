import { Button, Image, Text, View } from "@tarojs/components";
import Taro, {
  useDidHide,
  useDidShow,
  useRouter,
  useUnload,
} from "@tarojs/taro";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildDeviceLayoutClassName } from "@/features/layout/deviceLayout";
import {
  createTrackAudioController,
  stopAudioIfLoaded,
  stopPracticePlayback,
} from "@/features/listeningPractice/audioPlayback";
import {
  buildBookPracticeBundle,
  type BookPracticeBundle,
  type ListeningPractice,
} from "@/features/listeningPractice/bookPractice";
import { clampHotspotCenter } from "@/features/listeningPractice/hotspotLayout";
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
  beginRecordingUpload,
  createRecordingMachine,
  disposeRecordingMachine,
  finishRecordingUpload,
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
import { getPendingCheckInStore } from "@/features/listeningPractice/pendingCheckInRuntime";
import { getCheckInSubmissionCoordinator } from "@/features/listeningPractice/checkInSubmissionRuntime";
import type {
  CheckInSubmissionHandle,
  SubmissionProgress,
} from "@/features/listeningPractice/checkInSubmissionCoordinator";
import { getReadableCloudError } from "@/services/cloudCheckIn";
import {
  useDeviceLayout,
  type DeviceLayoutState,
} from "@/hooks/useDeviceLayout";
import PracticeDirectory from "./PracticeDirectory";

import "./Practice.scss";

const formatDuration = (durationMs: number) => {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
};

const RECORDER_OPTIONS = {
  duration: 300000,
  sampleRate: 16000,
  numberOfChannels: 1,
  encodeBitRate: 48000,
  format: "mp3" as const,
};
const RECORDER_ACQUIRE_RETRY_MS = 300;

const recorderOperationError = (reason: string, error?: unknown) =>
  error || new Error(reason === "busy" ? "录音设备正在收尾，请稍后再试" : "当前录音操作暂不可用");

export default function Practice() {
  const layout = useDeviceLayout();
  const layoutClassName = buildDeviceLayoutClassName(layout);
  const router = useRouter();
  const bookId = router.params?.bookId;
  const rawPracticeIndex = router.params?.practice;
  const route = useMemo(() => {
    try {
      if (typeof bookId !== "string" || !bookId) {
        throw new Error("训练链接缺少教材，请重新选择教材");
      }
      // 只接受明确的十进制整数；缺失、负数或越界都不能悄悄落到首尾页。
      if (typeof rawPracticeIndex !== "string" || !/^(?:0|[1-9]\d*)$/.test(rawPracticeIndex)) {
        throw new Error("训练编号无效，请重新选择教材");
      }
      const practiceIndex = Number(rawPracticeIndex);
      const bundle = buildBookPracticeBundle(bookId);
      if (!bundle) throw new Error("找不到这本教材，请重新选择教材");
      if (!Number.isSafeInteger(practiceIndex) || practiceIndex >= bundle.practices.length) {
        throw new Error("训练编号超出本书范围，请重新选择教材");
      }
      return { bundle, practiceIndex, practice: bundle.practices[practiceIndex] };
    } catch (error) {
      return {
        bundle: null,
        errorMessage: error instanceof Error ? error.message : "教材暂时无法读取，请重新选择教材",
      };
    }
  }, [bookId, rawPracticeIndex]);

  if (!route.bundle) {
    return (
      <View className={`practice-empty device-layout__content ${layoutClassName}`}>
        <Text>暂时无法打开训练</Text>
        <Text>{route.errorMessage}</Text>
        <Button
          className='practice-empty__button device-touch-target'
          onClick={() => Taro.navigateTo({ url: "/pages/BookLibrary/BookLibrary" })}
        >
          选择教材
        </Button>
      </View>
    );
  }

  // 验证通过才挂载会话；换书或外部训练路由时先清理旧会话，保持 Hook 顺序稳定。
  return (
    <PracticeSession
      key={`${route.bundle.book.id}:${route.practiceIndex}`}
      bundle={route.bundle}
      initialPracticeIndex={route.practiceIndex}
      initialPractice={route.practice}
      layout={layout}
      layoutClassName={layoutClassName}
    />
  );
}

function PracticeSession({
  bundle,
  initialPracticeIndex,
  initialPractice,
  layout,
  layoutClassName,
}: {
  bundle: BookPracticeBundle;
  initialPracticeIndex: number;
  initialPractice: ListeningPractice;
  layout: DeviceLayoutState;
  layoutClassName: string;
}) {
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
  const [pendingCheckIn, setPendingCheckIn] = useState<PendingCheckIn | null>(null);
  const [isSavingRecording, setIsSavingRecording] = useState(false);
  const [submissionProgress, setSubmissionProgress] = useState<SubmissionProgress | null>(null);
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const modelAudioControllerRef = useRef<ReturnType<
    typeof createTrackAudioController
  > | null>(null);
  const recordingAudioRef = useRef<Taro.InnerAudioContext | null>(null);
  const recorderOwnerRef = useRef<RecorderOwner | null>(null);
  const recordingTimelineRef = useRef<RecordingTimeline>({
    accumulatedMs: 0,
    activeSinceMs: null,
  });
  const discardNextRecordingRef = useRef(false);
  const pendingCheckInRef = useRef<PendingCheckIn | null>(null);
  const submissionHandleRef = useRef<CheckInSubmissionHandle | null>(null);
  const recorderUnsubscribeRef = useRef<(() => void) | null>(null);
  const recorderTerminalSinkRef = useRef<RecorderTerminalSink | null>(null);
  const mountedRef = useRef(true);
  const pageHiddenRef = useRef(false);
  const savingRecordingRef = useRef(false);
  const saveGenerationRef = useRef(0);
  const replacementPendingIdsRef = useRef(new Set<string>());
  const teardownAwaitingStopRef = useRef(false);
  const practiceContextRef = useRef({ practice, practiceIndex });
  practiceContextRef.current = { practice, practiceIndex };

  const applyRecordingMachine = useCallback((next: RecordingMachine) => {
    recordingMachineRef.current = next;
    if (mountedRef.current) setRecordingMachine(next);
  }, []);

  const applyPendingCheckIn = useCallback((next: PendingCheckIn | null) => {
    pendingCheckInRef.current = next;
    if (mountedRef.current) setPendingCheckIn(next);
  }, []);

  const removeReplacementBackups = useCallback(async () => {
    const store = getPendingCheckInStore();
    for (const requestId of [...replacementPendingIdsRef.current]) {
      if (await store.remove(requestId)) {
        replacementPendingIdsRef.current.delete(requestId);
      }
    }
  }, []);

  const measureBookImage = useMemo(
    () => () => {
      if (typeof Taro.createSelectorQuery !== "function") return;
      Taro.createSelectorQuery()
        .select(".practice-book-page__image")
        .boundingClientRect((rect) => {
          if (
            !rect ||
            Array.isArray(rect) ||
            !Number.isFinite(rect.width) ||
            !Number.isFinite(rect.height) ||
            rect.width <= 0 ||
            rect.height <= 0
          ) {
            return;
          }
          setImageSize({ width: rect.width, height: rect.height });
        })
        .exec();
    },
    [],
  );

  useEffect(() => {
    // 图片加载和窗口尺寸变化都复用同一次实测，不触碰音频或录音实例。
    measureBookImage();
  }, [layout.windowHeight, layout.windowWidth, measureBookImage]);

  const clampedHotspots = useMemo(
    () =>
      practice.tracks.map((track) => {
        if (imageSize.width <= 0 || imageSize.height <= 0) return track;
        const originalCenter = {
          left: Number.parseFloat(track.left),
          top: Number.parseFloat(track.top),
        };
        const center = clampHotspotCenter(originalCenter, {
          width: imageSize.width,
          height: imageSize.height,
        });
        return {
          ...track,
          left: `${center.left}%`,
          top: `${center.top}%`,
        };
      }),
    [imageSize.height, imageSize.width, practice.tracks],
  );

  const runRecorderAction = useCallback((
    action: RecorderAction,
    pauseReason: Exclude<PauseReason, null> = "user",
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
    void Taro.showModal({
      title: "录音操作失败",
      content: getRecordingErrorMessage(error),
      showCancel: false,
    });
    return false;
  }, [applyRecordingMachine]);

  const clearRecordingView = useCallback(() => {
    stopAudioIfLoaded(recordingAudioRef.current);
    if (mountedRef.current) {
      setIsPlayingRecording(false);
      setTempRecordingPath("");
      setRecordingDurationMs(0);
      setRecordingElapsedMs(0);
      setSubmissionProgress(null);
    }
    recordingTimelineRef.current = { accumulatedMs: 0, activeSinceMs: null };
  }, []);

  const releaseRecorderOwner = useCallback(() => {
    teardownAwaitingStopRef.current = false;
    recorderUnsubscribeRef.current?.();
    recorderUnsubscribeRef.current = null;
    recorderTerminalSinkRef.current = null;
    const owner = recorderOwnerRef.current;
    recorderOwnerRef.current = null;
    owner?.release();
    recordingMachineRef.current = disposeRecordingMachine(recordingMachineRef.current);
  }, []);

  useEffect(() => {
    const modelAudioController = createTrackAudioController(
      () => Taro.createInnerAudioContext(),
      setPlayingTrackId,
      (error) => {
        console.error("示范音频播放失败", error.errCode, error.errMsg);
        Taro.showToast({ title: "示范音频播放失败", icon: "none" });
      },
    );
    modelAudioControllerRef.current = modelAudioController;

    const recordingAudio = Taro.createInnerAudioContext();
    recordingAudio.loop = false;
    recordingAudio.onPlay(() => setIsPlayingRecording(true));
    recordingAudio.onEnded(() => setIsPlayingRecording(false));
    recordingAudio.onStop(() => setIsPlayingRecording(false));
    recordingAudio.onError(() => {
      setIsPlayingRecording(false);
      Taro.showToast({ title: "录音回听失败", icon: "none" });
    });
    recordingAudioRef.current = recordingAudio;

    return () => {
      // 路由换书/换训练会卸载会话，两路音频都需先停止再释放。
      stopPracticePlayback(modelAudioController, recordingAudio);
      modelAudioController.dispose();
      recordingAudio.destroy();
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
        const requested = requestRecorderAction(next, "stop", "background");
        if (requested.command) {
          applyRecordingMachine(requested.machine);
          const stopped = owner.stop();
          if (!stopped.ok) {
            const error = recorderOperationError(
              stopped.reason,
              "error" in stopped ? stopped.error : undefined,
            );
            applyRecordingMachine(
              resolveRecorderCallback(requested.machine, {
                type: "error",
                sessionId: requested.command.sessionId,
                operationSeq: requested.command.operationSeq,
                error,
              }),
            );
          }
        }
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
          runRecorderAction("pause", "background");
        } else {
          runRecorderAction("stop", "background");
        }
      }
    };

    const handleStop = async (result: RecorderNativeStopResult) => {
      const releaseAfterStop = teardownAwaitingStopRef.current;
      const current = recordingMachineRef.current;
      const next = resolveRecorderCallback(current, {
        type: "stop",
        sessionId: current.sessionId,
        operationSeq: current.operationSeq,
      });
      if (next === current) {
        if (releaseAfterStop) releaseRecorderOwner();
        return;
      }
      applyRecordingMachine(next);

      if (discardNextRecordingRef.current) {
        discardNextRecordingRef.current = false;
        clearRecordingView();
        applyRecordingMachine(resetRecordingMachine(next));
        if (releaseAfterStop) releaseRecorderOwner();
        return;
      }

      const parsed = parseNativeRecordingResult(result);
      if (!parsed.ok) {
        clearRecordingView();
        applyRecordingMachine(resetRecordingMachine(next));
        if (mountedRef.current) {
          Taro.showToast({ title: parsed.message, icon: "none" });
        }
        if (releaseAfterStop) releaseRecorderOwner();
        return;
      }

      const generation = ++saveGenerationRef.current;
      savingRecordingRef.current = true;
      if (mountedRef.current) setIsSavingRecording(true);
      const { practice: stoppedPractice, practiceIndex: stoppedIndex } =
        practiceContextRef.current;

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
        applyPendingCheckIn(saved.item);
        if (mountedRef.current) {
          setTempRecordingPath(saved.item.localPath);
          setRecordingDurationMs(saved.item.durationMs);
          setRecordingElapsedMs(saved.item.durationMs);
        }
        if (saved.message && mountedRef.current) {
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
        if (generation === saveGenerationRef.current) {
          clearRecordingView();
          applyRecordingMachine(resetRecordingMachine(recordingMachineRef.current));
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
  ]);

  useEffect(() => {
    if (
      recordingState !== "idle" &&
      recordingState !== "unsupported" &&
      recordingState !== "error"
    ) return undefined;
    let active = true;
    const store = getPendingCheckInStore();

    void store.ready().then(async () => {
      await store.cleanup();
      const current = recordingMachineRef.current;
      const canRestorePending =
        active &&
        mountedRef.current &&
        !pendingCheckInRef.current &&
        !savingRecordingRef.current &&
        !current.pendingAction &&
        (current.state === "idle" ||
          current.state === "unsupported" ||
          current.state === "error");
      // ready/cleanup 都可能跨过一次用户操作；恢复前必须以最新状态为准，不能覆盖新录音。
      if (!canRestorePending) return;
      const restored = [...store.list()]
        .filter((item) =>
          item.context.bookId === bundle.book.id &&
          item.context.practiceId === practice.id &&
          item.context.practiceIndex === practiceIndex,
        )
        .sort((left, right) => right.updatedAtMs - left.updatedAtMs)[0];
      if (!restored || !active) return;

      const restoredMachine = restoreRecordedMachine(current);
      if (restoredMachine === current) return;

      replacementPendingIdsRef.current.delete(restored.requestId);
      applyRecordingMachine(restoredMachine);
      applyPendingCheckIn(restored);
      setTempRecordingPath(restored.localPath);
      setRecordingDurationMs(restored.durationMs);
      setRecordingElapsedMs(restored.durationMs);
    }).catch(() => {
      // 本地缓存读取失败不阻断教材与示范音频，用户仍可重新录制。
    });

    return () => {
      active = false;
    };
  }, [
    applyPendingCheckIn,
    applyRecordingMachine,
    bundle.book.id,
    practice.id,
    practiceIndex,
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

  useDidShow(() => {
    pageHiddenRef.current = false;
  });

  useDidHide(() => {
    pageHiddenRef.current = true;
    // 页面隐藏后停止两路播放；录音优先暂停，旧机型不支持暂停时安全停止。
    stopPracticePlayback(
      modelAudioControllerRef.current,
      recordingAudioRef.current,
    );
    setPlayingTrackId(null);
    setIsPlayingRecording(false);
    submissionHandleRef.current?.cancel();

    const current = recordingMachineRef.current;
    if (current.state === "starting") {
      // start 已交给微信但尚未确认时也可能已经占用麦克风，切后台必须覆盖为 stop。
      const owner = recorderOwnerRef.current;
      const teardown = requestRecorderTeardown(current);
      if (owner && teardown.command) {
        applyRecordingMachine(teardown.machine);
        const stopped = owner.stop();
        if (!stopped.ok) {
          applyRecordingMachine(
            resolveRecorderCallback(teardown.machine, {
              type: "error",
              sessionId: teardown.command.sessionId,
              operationSeq: teardown.command.operationSeq,
              error: recorderOperationError(
                stopped.reason,
                "error" in stopped ? stopped.error : undefined,
              ),
            }),
          );
        }
      }
      return;
    }
    if (current.state === "recording") {
      if (current.capabilities?.canPause && current.capabilities.canResume) {
        runRecorderAction("pause", "background");
      } else {
        runRecorderAction("stop", "background");
      }
    }
  });

  useUnload(() => {
    pageHiddenRef.current = true;
    mountedRef.current = false;
    submissionHandleRef.current?.cancel();
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

    stopAudioIfLoaded(recordingAudioRef.current);
    // 示范音频由用户手动控制，录音中和暂停时也允许播放或切换。
    controller.toggle(trackId, url);
  };

  const removeCurrentPending = async () => {
    const pending = pendingCheckInRef.current;
    if (!pending) return true;
    const removed = await getPendingCheckInStore().remove(pending.requestId);
    if (!removed) {
      void Taro.showModal({
        title: "本地录音未删除",
        content: "请先到“我的打卡”清理这条录音后再试。",
        showCancel: false,
      });
      return false;
    }
    applyPendingCheckIn(null);
    return true;
  };

  const performPracticeSwitch = async (nextIndex: number) => {
    if (!(await removeCurrentPending())) return;
    if (recordingState === "recording" || recordingState === "paused") {
      discardNextRecordingRef.current = true;
      if (!runRecorderAction("stop")) {
        discardNextRecordingRef.current = false;
        return;
      }
    } else {
      applyRecordingMachine(resetRecordingMachine(recordingMachineRef.current));
      clearRecordingView();
    }
    modelAudioControllerRef.current?.stop();
    setPlayingTrackId(null);
    // 放弃新录音并切换训练时，之前保留的旧录音继续留在“我的打卡”。
    replacementPendingIdsRef.current.clear();
    setCurrentPractice({ practiceIndex: nextIndex, practice: bundle.practices[nextIndex] });
    Taro.pageScrollTo({ scrollTop: 0, duration: 200 });
  };

  const requestPracticeSwitch = async (nextIndex: number) => {
    if (!Number.isInteger(nextIndex) || nextIndex < 0 || nextIndex >= bundle.practices.length) return;
    if (nextIndex === practiceIndex) {
      setIsDirectoryOpen(false);
      return;
    }

    if (isSavingRecording || recordingState === "starting" || recordingState === "stopping") {
      Taro.showToast({ title: "录音正在处理，请稍候", icon: "none" });
      return;
    }
    const policy = getPracticeSwitchPolicy(recordingState);
    if (policy === "block-uploading") {
      Taro.showToast({ title: "打卡上传中，请稍候", icon: "none" });
      return;
    }
    if (policy === "confirm-discard") {
      const confirmation = await Taro.showModal({
        title: "切换训练？",
        content: "切换后将放弃当前录音，是否继续？",
        confirmText: "放弃并切换",
        confirmColor: "#d85b3f",
      });
      if (!confirmation.confirm) return;
    }

    setIsDirectoryOpen(false);
    await performPracticeSwitch(nextIndex);
  };

  const openPracticeDirectory = () => {
    if (recordingState === "uploading") {
      Taro.showToast({ title: "打卡上传中，请稍候", icon: "none" });
      return;
    }
    setIsDirectoryOpen(true);
  };

  const startRecording = async () => {
    if (
      !recorderOwnerRef.current ||
      isSavingRecording ||
      recordingState === "checking" ||
      recordingState === "unsupported" ||
      recordingState === "starting" ||
      recordingState === "stopping" ||
      recordingState === "uploading"
    ) return;

    stopAudioIfLoaded(recordingAudioRef.current);
    let permission: "granted" | "request" | "open-settings";
    try {
      const settings = await Taro.getSetting();
      permission = getRecordingPermissionStep(
        settings.authSetting["scope.record"],
      );
    } catch (error) {
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
        content: "跟读录音只会在你确认打卡后上传。请在设置中允许使用麦克风。",
        confirmText: "去设置",
      });
      if (choice.confirm) {
        await Taro.openSetting();
        Taro.showToast({ title: "授权后请再次点击录音", icon: "none" });
      }
      return;
    }

    if (permission === "request") {
      try {
        await Taro.authorize({ scope: "scope.record" });
      } catch (_error) {
        const choice = await Taro.showModal({
          title: "需要麦克风权限",
          content: "请允许麦克风权限后再开始跟读录音。",
          confirmText: "去设置",
        });
        if (choice.confirm) await Taro.openSetting();
        return;
      }
    }

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
    const audio = recordingAudioRef.current;
    if (!audio || !tempRecordingPath) return;

    modelAudioControllerRef.current?.stop();
    setPlayingTrackId(null);
    if (isPlayingRecording) {
      stopAudioIfLoaded(audio);
      return;
    }
    audio.src = tempRecordingPath;
    audio.play();
  };

  const submitCheckIn = async () => {
    const pending = pendingCheckInRef.current;
    if (!pending || submissionHandleRef.current || recordingState !== "recorded") return;

    const uploading = beginRecordingUpload(recordingMachineRef.current);
    if (uploading === recordingMachineRef.current) return;
    applyRecordingMachine(uploading);
    setSubmissionProgress({
      requestId: pending.requestId,
      percent: null,
      uncertain: true,
    });
    const handle = getCheckInSubmissionCoordinator().submit(pending, {
      onProgress: (progress) => {
        if (
          mountedRef.current &&
          pendingCheckInRef.current?.requestId === progress.requestId
        ) {
          setSubmissionProgress(progress);
        }
      },
    });
    submissionHandleRef.current = handle;
    const result = await handle.promise;
    if (submissionHandleRef.current === handle) submissionHandleRef.current = null;
    if (!mountedRef.current) return;
    setSubmissionProgress(null);

    if (result.state === "committed") {
      await removeReplacementBackups();
      applyPendingCheckIn(null);
      clearRecordingView();
      const finished = finishRecordingUpload(recordingMachineRef.current, { ok: true });
      applyRecordingMachine(resetRecordingMachine(finished));
      Taro.showToast({ title: "打卡成功", icon: "success" });
      try {
        // 打卡完成后替换训练页，旧页面卸载时即可释放全局录音 owner。
        await Taro.redirectTo({
          url: `/pages/CheckInDetail/CheckInDetail?id=${encodeURIComponent(
            result.id,
          )}&token=${encodeURIComponent(result.shareToken)}`,
        });
      } catch (_navigationError) {
        Taro.showToast({ title: "请到我的打卡中查看", icon: "none" });
      }
      return;
    }

    const refreshed = getPendingCheckInStore()
      .list()
      .find((item) => item.requestId === pending.requestId);
    if (refreshed) applyPendingCheckIn(refreshed);
    applyRecordingMachine(
      finishRecordingUpload(recordingMachineRef.current, {
        ok: false,
        error: result.error,
      }),
    );
    if (result.state === "cancelled") {
      Taro.showToast({ title: "已取消上传，录音仍保存在本机", icon: "none" });
    } else {
      void Taro.showModal({
        title: "打卡未完成",
        content: getReadableCloudError(result.error),
        showCancel: false,
      });
    }
  };

  const cancelSubmission = () => {
    if (!submissionHandleRef.current?.cancel()) {
      Taro.showToast({ title: "正在确认打卡，暂时不能取消", icon: "none" });
    }
  };

  const shownDuration =
    recordingState === "recording" || recordingState === "paused"
      ? recordingElapsedMs
      : recordingDurationMs;
  const uploadLabel = submissionProgress?.uncertain
    ? "正在上传…"
    : submissionProgress?.percent === 100
      ? "上传完成，正在确认"
      : submissionProgress?.percent !== null && submissionProgress !== null
        ? `正在上传 ${submissionProgress.percent}%`
        : "正在上传";

  return (
    <View className={`practice-page ${layoutClassName}`}>
      <View className='practice-page__content device-layout__content'>
        <View className='practice-header'>
          <Text className='practice-header__course'>{bundle.book.title}</Text>
          <Text className='practice-header__section'>{practice.sectionTitle}</Text>
          <View className='practice-header__progress-row'>
            <Text className='practice-header__progress'>
              跟读训练 {practiceIndex + 1} / {bundle.practices.length}
            </Text>
            <Text
              className='practice-header__directory device-touch-target'
              onClick={openPracticeDirectory}
            >
              目录
            </Text>
          </View>
        </View>

        <View className='practice-workspace'>
          <View className='practice-workspace__book'>
            <View className='practice-book-page'>
              <Image
                className='practice-book-page__image'
                src={practice.imageUrl}
                mode='widthFix'
                webp
                lazyLoad
                onLoad={measureBookImage}
              />
              <View className='practice-book-page__hotspots'>
                {clampedHotspots.map((hotspot, index) => (
                  <View
                    key={hotspot.id}
                    className={`audio-hotspot device-touch-target ${
                      playingTrackId === hotspot.id ? "audio-hotspot--playing" : ""
                    }`}
                    style={{ left: hotspot.left, top: hotspot.top }}
                    onClick={() => playModelAudio(hotspot.id, hotspot.url)}
                  >
                    <View className='audio-hotspot__visual'>
                      <Text className='audio-hotspot__icon'>
                        {playingTrackId === hotspot.id ? "◼" : "▶"}
                      </Text>
                      <Text className='audio-hotspot__number'>{index + 1}</Text>
                    </View>
                  </View>
                ))}
              </View>
            </View>
          </View>

          <View className='practice-workspace__controls'>
            <View className='practice-recorder'>
              <View className='practice-recorder__heading'>
                <Text className='practice-recorder__title'>我的跟读</Text>
                <Text className='practice-recorder__time'>
                  {shownDuration > 0 ? formatDuration(shownDuration) : "最长 5:00"}
                </Text>
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

              {(recordingState === "recorded" || recordingState === "uploading") && (
                <>
                  <Text className='practice-recorder__tip'>
                    {isSavingRecording
                      ? "正在安全保存录音，请稍候…"
                      : pendingCheckIn?.recoverable
                        ? `已安全保存在本机（${formatDuration(recordingDurationMs)}），请回听确认。`
                        : `已临时保存在本机（${formatDuration(recordingDurationMs)}），请尽快完成打卡。`}
                  </Text>
                  {!isSavingRecording && pendingCheckIn && (
                    <>
                      <View className='record-actions device-actions'>
                        <Button
                          className='record-actions__secondary device-touch-target'
                          disabled={recordingState === "uploading"}
                          onClick={playRecording}
                        >
                          {isPlayingRecording ? "停止回听" : "回听录音"}
                        </Button>
                        <Button
                          className='record-actions__secondary device-touch-target'
                          disabled={recordingState === "uploading"}
                          onClick={startRecording}
                        >
                          重新录制
                        </Button>
                      </View>
                      <Button
                        className='check-in-button device-touch-target'
                        loading={recordingState === "uploading"}
                        disabled={recordingState === "uploading"}
                        onClick={submitCheckIn}
                      >
                        {recordingState === "uploading" ? uploadLabel : "完成本次打卡"}
                      </Button>
                      {recordingState === "uploading" && (
                        <Button
                          className='upload-cancel-button device-touch-target'
                          onClick={cancelSubmission}
                        >
                          取消上传并保留录音
                        </Button>
                      )}
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
                  practiceIndex > 0 && requestPracticeSwitch(practiceIndex - 1)
                }
              >
                <Text>上一个训练</Text>
              </View>
              <View
                className={`practice-navigation__button device-touch-target practice-navigation__button--primary ${
                  practiceIndex === bundle.practices.length - 1
                    ? "practice-navigation__button--disabled"
                    : ""
                }`}
                onClick={() =>
                  practiceIndex < bundle.practices.length - 1 &&
                  requestPracticeSwitch(practiceIndex + 1)
                }
              >
                <Text>下一个训练</Text>
              </View>
            </View>
          </View>
        </View>
      </View>

      <PracticeDirectory
        groups={directoryGroups}
        currentPracticeIndex={practiceIndex}
        open={isDirectoryOpen}
        onClose={() => setIsDirectoryOpen(false)}
        onSelect={(nextIndex) => requestPracticeSwitch(nextIndex)}
      />
    </View>
  );
}
