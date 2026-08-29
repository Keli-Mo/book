import { Button, Image, Text, View } from "@tarojs/components";
import Taro, { useRouter } from "@tarojs/taro";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  SAMPLE_BOOK_ID,
  SAMPLE_BOOK_PRACTICES,
  SAMPLE_BOOK_TITLE,
} from "@/features/listeningPractice/book3Practice";
import { buildPracticeDirectoryGroups } from "@/features/listeningPractice/practiceDirectory";
import {
  createCheckIn,
  getReadableCloudError,
  removeUploadedRecording,
  uploadCheckInRecording,
} from "@/services/cloudCheckIn";
import PracticeDirectory from "./PracticeDirectory";

import "./Practice.scss";

type RecordingState = "idle" | "recording" | "recorded" | "uploading";

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
  const modelAudioRef = useRef<Taro.InnerAudioContext | null>(null);
  const recordingAudioRef = useRef<Taro.InnerAudioContext | null>(null);
  const recorderRef = useRef<WechatMiniprogram.RecorderManager | null>(null);
  const recordingStartedAtRef = useRef(0);
  const discardNextRecordingRef = useRef(false);
  const submittingRef = useRef(false);

  const practice = SAMPLE_BOOK_PRACTICES[practiceIndex];

  useEffect(() => {
    const modelAudio = Taro.createInnerAudioContext();
    modelAudio.loop = false;
    modelAudio.onEnded(() => setPlayingTrackId(null));
    modelAudio.onStop(() => setPlayingTrackId(null));
    modelAudio.onError(() => {
      setPlayingTrackId(null);
      Taro.showToast({ title: "示范音频播放失败", icon: "none" });
    });
    modelAudioRef.current = modelAudio;

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
      recordingStartedAtRef.current = Date.now();
      setRecordingElapsedMs(0);
      setRecordingState("recording");
    };
    const handleRecorderStop = (result: WechatMiniprogram.OnStopCallbackResult) => {
      if (discardNextRecordingRef.current) {
        discardNextRecordingRef.current = false;
        return;
      }

      const duration = result.duration || Date.now() - recordingStartedAtRef.current;
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
      setRecordingState("idle");
      Taro.showToast({ title: "录音失败，请检查麦克风权限", icon: "none" });
    };

    recorder.onStart(handleRecorderStart);
    recorder.onStop(handleRecorderStop);
    recorder.onError(handleRecorderError);
    recorderRef.current = recorder;

    return () => {
      discardNextRecordingRef.current = true;
      recorder.stop();
      recorder.offStart(handleRecorderStart);
      recorder.offStop(handleRecorderStop);
      recorder.offError(handleRecorderError);
      modelAudio.destroy();
      recordingAudio.destroy();
      modelAudioRef.current = null;
      recordingAudioRef.current = null;
      recorderRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (recordingState !== "recording") return undefined;

    const timer = setInterval(() => {
      setRecordingElapsedMs(Date.now() - recordingStartedAtRef.current);
    }, 250);
    return () => clearInterval(timer);
  }, [recordingState]);

  const playModelAudio = (trackId: string, url: string) => {
    const audio = modelAudioRef.current;
    if (!audio || recordingState === "recording") return;

    recordingAudioRef.current?.stop();
    // 每次只播放用户主动点击的当前音频，不自动循环或连续播放下一段。
    audio.stop();
    audio.src = url;
    audio.play();
    setPlayingTrackId(trackId);
  };

  const resetRecording = () => {
    if (recordingState === "recording") {
      discardNextRecordingRef.current = true;
      recorderRef.current?.stop();
    }
    recordingAudioRef.current?.stop();
    setTempRecordingPath("");
    setRecordingDurationMs(0);
    setRecordingElapsedMs(0);
    setRecordingState("idle");
  };

  const switchPractice = (nextIndex: number) => {
    if (recordingState === "uploading") {
      Taro.showToast({ title: "打卡上传中，请稍候", icon: "none" });
      return;
    }
    modelAudioRef.current?.stop();
    setPlayingTrackId(null);
    resetRecording();
    setPracticeIndex(nextIndex);
    Taro.pageScrollTo({ scrollTop: 0, duration: 200 });
  };

  const startRecording = async () => {
    if (!recorderRef.current || recordingState === "uploading") return;

    modelAudioRef.current?.stop();
    recordingAudioRef.current?.stop();
    setPlayingTrackId(null);
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

  const stopRecording = () => {
    if (recordingState === "recording") recorderRef.current?.stop();
  };

  const playRecording = () => {
    const audio = recordingAudioRef.current;
    if (!audio || !tempRecordingPath) return;

    modelAudioRef.current?.stop();
    setPlayingTrackId(null);
    if (isPlayingRecording) {
      audio.stop();
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
    recordingState === "recording" ? recordingElapsedMs : recordingDurationMs;

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
            onClick={() => setIsDirectoryOpen(true)}
          >
            目录
          </Text>
        </View>
      </View>

      <View className='practice-guide'>
        <Text className='practice-guide__title'>先听示范，再完成自己的跟读</Text>
        <Text className='practice-guide__text'>
          点击教材页上的播放标记收听当前位置对应的示范音频。
        </Text>
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
          <>
            <Text className='practice-recorder__tip'>
              录音先保存在本机，回听满意后再完成打卡。
            </Text>
            <Button className='record-button' onClick={startRecording}>
              <Text className='record-button__dot' />
              开始跟读录音
            </Button>
          </>
        )}

        {recordingState === "recording" && (
          <>
            <View className='recording-indicator'>
              <Text className='recording-indicator__pulse' />
              <Text>正在录音，请完成本页跟读</Text>
            </View>
            <Button className='record-button record-button--stop' onClick={stopRecording}>
              结束录音
            </Button>
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
          onClick={() => practiceIndex > 0 && switchPractice(practiceIndex - 1)}
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
            switchPractice(practiceIndex + 1)
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
        onSelect={(nextIndex) => {
          setIsDirectoryOpen(false);
          switchPractice(nextIndex);
        }}
      />
    </View>
  );
}
