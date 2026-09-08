import { Button, Image, Text, View } from "@tarojs/components";
import Taro, { useDidHide, useRouter } from "@tarojs/taro";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createTrackAudioController,
  stopAudioIfLoaded,
  stopPracticePlayback,
} from "@/features/listeningPractice/audioPlayback";
import {
  SAMPLE_BOOK_ID,
  SAMPLE_BOOK_PRACTICES,
  SAMPLE_BOOK_TITLE,
} from "@/features/listeningPractice/book3Practice";
import { buildPracticeDirectoryGroups } from "@/features/listeningPractice/practiceDirectory";
import {
  getPracticeSwitchPolicy,
  getRecordingElapsedMs,
  pauseRecordingTimeline,
  resumeRecordingTimeline,
  startRecordingTimeline,
  type RecordingState,
  type RecordingTimeline,
} from "@/features/listeningPractice/recordingInteraction";
import {
  createCheckIn,
  getReadableCloudError,
  removeUploadedRecording,
  uploadCheckInRecording,
} from "@/services/cloudCheckIn";
import PracticeDirectory from "./PracticeDirectory";

import "./Practice.scss";

const normalizePracticeIndex = (rawIndex?: string) => {
  const parsed = Number(rawIndex || 0);
  if (!Number.isInteger(parsed)) return 0;
  return Math.min(SAMPLE_BOOK_PRACTICES.length - 1, Math.max(0, parsed));
};

const formatDuration = (durationMs: number) => {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
};

export default function Practice() {
  const router = useRouter();
  const directoryGroups = useMemo(
    () => buildPracticeDirectoryGroups(SAMPLE_BOOK_PRACTICES),
    []
  );
  const [practiceIndex, setPracticeIndex] = useState(() =>
    normalizePracticeIndex(router.params?.practice),
  );
  const [isDirectoryOpen, setIsDirectoryOpen] = useState(false);
  const [playingTrackId, setPlayingTrackId] = useState<string | null>(null);
  const [recordingState, setRecordingState] = useState<RecordingState>("idle");
  const [tempRecordingPath, setTempRecordingPath] = useState("");
  const [recordingDurationMs, setRecordingDurationMs] = useState(0);
  const [recordingElapsedMs, setRecordingElapsedMs] = useState(0);
  const [isPlayingRecording, setIsPlayingRecording] = useState(false);
  const modelAudioControllerRef = useRef<ReturnType<
    typeof createTrackAudioController
  > | null>(null);
  const recordingAudioRef = useRef<Taro.InnerAudioContext | null>(null);
  const recorderRef = useRef<WechatMiniprogram.RecorderManager | null>(null);
  const recordingTimelineRef = useRef<RecordingTimeline>({
    accumulatedMs: 0,
    activeSinceMs: null,
  });
  const pendingRecorderActionRef = useRef<"pause" | "resume" | null>(null);
  const discardNextRecordingRef = useRef(false);
  const submittingRef = useRef(false);

  const practice = SAMPLE_BOOK_PRACTICES[practiceIndex];

  useEffect(() => {
    const modelAudio = Taro.createInnerAudioContext();
    modelAudio.loop = false;
    const modelAudioController = createTrackAudioController(
      modelAudio,
      setPlayingTrackId,
    );
    modelAudio.onEnded(modelAudioController.handleEnded);
    modelAudio.onStop(modelAudioController.handleStop);
    modelAudio.onError((error) => {
      modelAudioController.handleError();
      console.error("示范音频播放失败", error.errCode, error.errMsg);
      Taro.showToast({ title: "示范音频播放失败", icon: "none" });
    });
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

    const recorder = wx.getRecorderManager();
    const handleRecorderStart = () => {
      recordingTimelineRef.current = startRecordingTimeline(Date.now());
      setRecordingElapsedMs(0);
      setRecordingState("recording");
    };
    const handleRecorderPause = () => {
      pendingRecorderActionRef.current = null;
      recordingTimelineRef.current = pauseRecordingTimeline(
        recordingTimelineRef.current,
        Date.now()
      );
      setRecordingElapsedMs(recordingTimelineRef.current.accumulatedMs);
      setRecordingState("paused");
    };
    const handleRecorderResume = () => {
      pendingRecorderActionRef.current = null;
      recordingTimelineRef.current = resumeRecordingTimeline(
        recordingTimelineRef.current,
        Date.now()
      );
      setRecordingState("recording");
    };
    const handleRecorderStop = (result: WechatMiniprogram.OnStopCallbackResult) => {
      pendingRecorderActionRef.current = null;
      if (discardNextRecordingRef.current) {
        discardNextRecordingRef.current = false;
        return;
      }

      const duration =
        result.duration ||
        getRecordingElapsedMs(recordingTimelineRef.current, Date.now());
      if (!result.tempFilePath || duration < 500) {
        setRecordingState("idle");
        Taro.showToast({ title: "录音时间太短，请重新录制", icon: "none" });
        return;
      }

      setTempRecordingPath(result.tempFilePath);
      setRecordingDurationMs(duration);
      setRecordingElapsedMs(duration);
      setRecordingState("recorded");
    };
    const handleRecorderError = () => {
      const pendingAction = pendingRecorderActionRef.current;
      pendingRecorderActionRef.current = null;
      if (pendingAction === "pause") {
        Taro.showToast({ title: "暂停录音失败，请重试", icon: "none" });
        return;
      }
      if (pendingAction === "resume") {
        Taro.showToast({ title: "继续录音失败，请重试", icon: "none" });
        return;
      }
      setRecordingState("idle");
      Taro.showToast({ title: "录音失败，请检查麦克风权限", icon: "none" });
    };

    recorder.onStart(handleRecorderStart);
    recorder.onPause(handleRecorderPause);
    recorder.onResume(handleRecorderResume);
    recorder.onStop(handleRecorderStop);
    recorder.onError(handleRecorderError);
    recorderRef.current = recorder;

    return () => {
      discardNextRecordingRef.current = true;
      recorder.stop();
      // 部分基础库提供移除监听接口，旧基础库没有时使用可选调用兼容。
      const recorderWithCleanup = recorder as typeof recorder & {
        offStart?: (callback: typeof handleRecorderStart) => void;
        offPause?: (callback: typeof handleRecorderPause) => void;
        offResume?: (callback: typeof handleRecorderResume) => void;
        offStop?: (callback: typeof handleRecorderStop) => void;
        offError?: (callback: typeof handleRecorderError) => void;
      };
      recorderWithCleanup.offStart?.(handleRecorderStart);
      recorderWithCleanup.offPause?.(handleRecorderPause);
      recorderWithCleanup.offResume?.(handleRecorderResume);
      recorderWithCleanup.offStop?.(handleRecorderStop);
      recorderWithCleanup.offError?.(handleRecorderError);
      modelAudio.destroy();
      recordingAudio.destroy();
      modelAudioControllerRef.current = null;
      recordingAudioRef.current = null;
      recorderRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (recordingState !== "recording") return undefined;

    const timer = setInterval(() => {
      setRecordingElapsedMs(
        getRecordingElapsedMs(recordingTimelineRef.current, Date.now())
      );
    }, 250);
    return () => clearInterval(timer);
  }, [recordingState]);

  useDidHide(() => {
    // navigateTo 只会隐藏当前页；在这里停止，避免音频跨页面继续播放。
    stopPracticePlayback(
      modelAudioControllerRef.current,
      recordingAudioRef.current,
    );
    setPlayingTrackId(null);
    setIsPlayingRecording(false);
  });

  const playModelAudio = (trackId: string, url: string) => {
    const controller = modelAudioControllerRef.current;
    if (!controller || recordingState === "uploading") return;

    stopAudioIfLoaded(recordingAudioRef.current);
    // 示范音频由用户手动控制，录音中和暂停时也允许播放或切换。
    controller.toggle(trackId, url);
  };

  const resetRecording = () => {
    if (recordingState === "recording" || recordingState === "paused") {
      discardNextRecordingRef.current = true;
      recorderRef.current?.stop();
    }
    pendingRecorderActionRef.current = null;
    recordingTimelineRef.current = {
      accumulatedMs: 0,
      activeSinceMs: null,
    };
    stopAudioIfLoaded(recordingAudioRef.current);
    setTempRecordingPath("");
    setRecordingDurationMs(0);
    setRecordingElapsedMs(0);
    setRecordingState("idle");
  };

  const performPracticeSwitch = (nextIndex: number) => {
    modelAudioControllerRef.current?.stop();
    setPlayingTrackId(null);
    resetRecording();
    setPracticeIndex(nextIndex);
    Taro.pageScrollTo({ scrollTop: 0, duration: 200 });
  };

  const requestPracticeSwitch = async (nextIndex: number) => {
    if (nextIndex === practiceIndex) {
      setIsDirectoryOpen(false);
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
    performPracticeSwitch(nextIndex);
  };

  const openPracticeDirectory = () => {
    if (recordingState === "uploading") {
      Taro.showToast({ title: "打卡上传中，请稍候", icon: "none" });
      return;
    }
    setIsDirectoryOpen(true);
  };

  const startRecording = async () => {
    if (!recorderRef.current || recordingState === "uploading") return;

    stopAudioIfLoaded(recordingAudioRef.current);
    setTempRecordingPath("");
    setRecordingDurationMs(0);

    try {
      await Taro.authorize({ scope: "scope.record" });
    } catch (_error) {
      const result = await Taro.showModal({
        title: "需要麦克风权限",
        content: "跟读录音只会在你确认打卡后上传。请在设置中允许使用麦克风。",
        confirmText: "去设置",
      });
      if (result.confirm) await Taro.openSetting();
      return;
    }

    recorderRef.current.start({
      duration: 300000,
      sampleRate: 44100,
      numberOfChannels: 1,
      encodeBitRate: 128000,
      format: "mp3",
      frameSize: 50,
    });
  };

  const pauseRecording = () => {
    if (recordingState !== "recording" || !recorderRef.current) return;

    pendingRecorderActionRef.current = "pause";
    try {
      recorderRef.current.pause();
    } catch (_error) {
      pendingRecorderActionRef.current = null;
      Taro.showToast({ title: "暂停录音失败，请重试", icon: "none" });
    }
  };

  const resumeRecording = () => {
    if (recordingState !== "paused" || !recorderRef.current) return;

    pendingRecorderActionRef.current = "resume";
    try {
      recorderRef.current.resume();
    } catch (_error) {
      pendingRecorderActionRef.current = null;
      Taro.showToast({ title: "继续录音失败，请重试", icon: "none" });
    }
  };

  const stopRecording = () => {
    if (recordingState === "recording" || recordingState === "paused") {
      pendingRecorderActionRef.current = null;
      recorderRef.current?.stop();
    }
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
    if (!practice || !tempRecordingPath || submittingRef.current) return;

    submittingRef.current = true;
    setRecordingState("uploading");
    Taro.showLoading({ title: "正在完成打卡", mask: true });
    let uploadedFileId = "";

    try {
      uploadedFileId = await uploadCheckInRecording(tempRecordingPath, practice.id);
      const created = await createCheckIn({
        recordingFileId: uploadedFileId,
        durationMs: recordingDurationMs,
        bookId: SAMPLE_BOOK_ID,
        bookTitle: SAMPLE_BOOK_TITLE,
        practiceId: practice.id,
        practiceIndex,
        pageNumber: practice.pageNumber,
        sectionTitle: practice.sectionTitle,
        imageUrl: practice.imageUrl,
      });
      // 数据库记录创建成功后，录音文件改由该记录管理，后续页面跳转失败也不能误删。
      uploadedFileId = "";
      Taro.hideLoading();
      Taro.showToast({ title: "打卡成功", icon: "success" });
      submittingRef.current = false;
      setRecordingState("recorded");
      try {
        await Taro.navigateTo({
          url: `/pages/CheckInDetail/CheckInDetail?id=${encodeURIComponent(
            created.id,
          )}&token=${encodeURIComponent(created.shareToken)}`,
        });
      } catch (_navigationError) {
        Taro.showToast({ title: "请到我的打卡中查看", icon: "none" });
      }
    } catch (error) {
      Taro.hideLoading();
      if (uploadedFileId) await removeUploadedRecording(uploadedFileId);
      submittingRef.current = false;
      setRecordingState("recorded");
      Taro.showModal({
        title: "打卡未完成",
        content: getReadableCloudError(error),
        showCancel: false,
      });
    }
  };

  if (!practice) {
    return (
      <View className='practice-empty'>
        <Text>暂时没有可用的跟读训练</Text>
      </View>
    );
  }

  const shownDuration =
    recordingState === "recording" || recordingState === "paused"
      ? recordingElapsedMs
      : recordingDurationMs;

  return (
    <View className='practice-page'>
      <View className='practice-header'>
        <Text className='practice-header__course'>{SAMPLE_BOOK_TITLE}</Text>
        <Text className='practice-header__section'>{practice.sectionTitle}</Text>
        <View className='practice-header__progress-row'>
          <Text className='practice-header__progress'>
            跟读训练 {practiceIndex + 1} / {SAMPLE_BOOK_PRACTICES.length}
          </Text>
          <Text
            className='practice-header__directory'
            onClick={openPracticeDirectory}
          >
            目录
          </Text>
        </View>
      </View>

      <View className='practice-book-page'>
        <Image
          className='practice-book-page__image'
          src={practice.imageUrl}
          mode='widthFix'
          webp
          lazyLoad
        />
        {practice.tracks.map((track, index) => (
          <View
            key={track.id}
            className={`audio-hotspot ${
              playingTrackId === track.id ? "audio-hotspot--playing" : ""
            }`}
            style={{ left: track.left, top: track.top }}
            onClick={() => playModelAudio(track.id, track.url)}
          >
            <Text className='audio-hotspot__icon'>
              {playingTrackId === track.id ? "◼" : "▶"}
            </Text>
            <Text className='audio-hotspot__number'>{index + 1}</Text>
          </View>
        ))}
      </View>

      <View className='practice-recorder'>
        <View className='practice-recorder__heading'>
          <Text className='practice-recorder__title'>我的跟读</Text>
          <Text className='practice-recorder__time'>
            {shownDuration > 0 ? formatDuration(shownDuration) : "最长 5:00"}
          </Text>
        </View>

        {recordingState === "idle" && (
          <Button className='record-button' onClick={startRecording}>
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
            <View className='recording-controls'>
              <Button
                className='record-button record-button--pause'
                onClick={pauseRecording}
              >
                暂停录音
              </Button>
              <Button
                className='record-button record-button--stop'
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
              <Text>录音已暂停，可播放示范音频后继续</Text>
            </View>
            <View className='recording-controls'>
              <Button
                className='record-button record-button--resume'
                onClick={resumeRecording}
              >
                继续录音
              </Button>
              <Button
                className='record-button record-button--stop'
                onClick={stopRecording}
              >
                结束录音
              </Button>
            </View>
          </>
        )}

        {(recordingState === "recorded" || recordingState === "uploading") && (
          <>
            <Text className='practice-recorder__tip'>
              已录制 {formatDuration(recordingDurationMs)}，请先回听确认。
            </Text>
            <View className='record-actions'>
              <Button
                className='record-actions__secondary'
                disabled={recordingState === "uploading"}
                onClick={playRecording}
              >
                {isPlayingRecording ? "停止回听" : "回听录音"}
              </Button>
              <Button
                className='record-actions__secondary'
                disabled={recordingState === "uploading"}
                onClick={startRecording}
              >
                重新录制
              </Button>
            </View>
            <Button
              className='check-in-button'
              loading={recordingState === "uploading"}
              disabled={recordingState === "uploading"}
              onClick={submitCheckIn}
            >
              {recordingState === "uploading" ? "正在上传" : "完成本次打卡"}
            </Button>
          </>
        )}
      </View>

      <View className='practice-navigation'>
        <View
          className={`practice-navigation__button ${
            practiceIndex === 0 ? "practice-navigation__button--disabled" : ""
          }`}
          onClick={() =>
            practiceIndex > 0 && requestPracticeSwitch(practiceIndex - 1)
          }
        >
          <Text>上一个训练</Text>
        </View>
        <View
          className={`practice-navigation__button practice-navigation__button--primary ${
            practiceIndex === SAMPLE_BOOK_PRACTICES.length - 1
              ? "practice-navigation__button--disabled"
              : ""
          }`}
          onClick={() =>
            practiceIndex < SAMPLE_BOOK_PRACTICES.length - 1 &&
            requestPracticeSwitch(practiceIndex + 1)
          }
        >
          <Text>下一个训练</Text>
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
