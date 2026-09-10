import { Button, Image, Text, View } from "@tarojs/components";
import Taro, {
  useDidHide,
  useRouter,
  useShareAppMessage,
} from "@tarojs/taro";
import { useEffect, useMemo, useRef, useState } from "react";
import { sharedImage } from "@/constant";
import { buildBookPracticeBundle } from "@/features/listeningPractice/bookPractice";
import {
  getPlaybackPositionMs,
  stopAudioIfLoaded,
} from "@/features/listeningPractice/audioPlayback";
import {
  CheckInDetail as CheckInDetailData,
  getCheckInDetail,
  getReadableCloudError,
} from "@/services/cloudCheckIn";
import {
  formatCheckInTime,
  formatPlaybackDurationLabel,
} from "@/utils/checkInFormat";

import "./CheckInDetail.scss";

export default function CheckInDetail() {
  const router = useRouter();
  const recordId = router.params?.id || "";
  const routeToken = router.params?.token || "";
  const [detail, setDetail] = useState<CheckInDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackPositionMs, setPlaybackPositionMs] = useState(0);
  const audioRef = useRef<Taro.InnerAudioContext | null>(null);
  const recordingDurationMsRef = useRef(0);
  const practiceUrl = useMemo(() => {
    // 历史记录字段可能缺失或来自旧版本；先核对教材及训练范围，再允许回跳。
    if (!detail || typeof detail.bookId !== "string" || !Number.isInteger(detail.practiceIndex)) return null;
    try {
      const bundle = buildBookPracticeBundle(detail.bookId);
      if (!bundle || detail.practiceIndex < 0 || detail.practiceIndex >= bundle.practices.length) return null;
      return `/pages/Practice/Practice?bookId=${encodeURIComponent(detail.bookId)}&practice=${detail.practiceIndex}`;
    } catch (_error) {
      return null;
    }
  }, [detail]);

  useShareAppMessage(() => {
    if (!detail) {
      return { title: "海沙牛娃英语跟读训练", path: "/pages/Home/Home", imageUrl: sharedImage };
    }

    return {
      title: `我完成了《${detail.bookTitle}》${detail.sectionTitle}跟读打卡`,
      // 分享口令只授予这一条录音的访问权，不能用于查询其他人的打卡。
      path: `/pages/CheckInDetail/CheckInDetail?id=${encodeURIComponent(
        detail.id,
      )}&token=${encodeURIComponent(detail.shareToken)}`,
      imageUrl: detail.imageUrl || sharedImage,
    };
  });

  useEffect(() => {
    const audio = Taro.createInnerAudioContext();
    audio.loop = false;
    audio.onPlay(() => setIsPlaying(true));
    audio.onTimeUpdate(() => {
      setPlaybackPositionMs(
        getPlaybackPositionMs(audio.currentTime, recordingDurationMsRef.current),
      );
    });
    audio.onEnded(() => {
      setIsPlaying(false);
      setPlaybackPositionMs(0);
    });
    audio.onStop(() => {
      setIsPlaying(false);
      setPlaybackPositionMs(0);
    });
    audio.onError(() => {
      setIsPlaying(false);
      setPlaybackPositionMs(0);
      Taro.showToast({ title: "录音播放失败", icon: "none" });
    });
    audioRef.current = audio;

    return () => {
      audio.destroy();
      audioRef.current = null;
    };
  }, []);

  useDidHide(() => {
    // 页面进入后台或跳转到别页时，立即停止录音回听并复位显示。
    stopAudioIfLoaded(audioRef.current);
    setIsPlaying(false);
    setPlaybackPositionMs(0);
  });

  useEffect(() => {
    let active = true;
    const load = async () => {
      if (!recordId) {
        setErrorMessage("分享链接缺少打卡编号");
        setLoading(false);
        return;
      }

      try {
        const result = await getCheckInDetail(recordId, routeToken);
        if (active) {
          recordingDurationMsRef.current = result.durationMs;
          setDetail(result);
        }
      } catch (error) {
        if (active) setErrorMessage(getReadableCloudError(error));
      } finally {
        if (active) setLoading(false);
      }
    };
    load();
    return () => {
      active = false;
    };
  }, [recordId, routeToken]);

  const toggleRecording = () => {
    const audio = audioRef.current;
    if (!audio || !detail?.recordingUrl) return;
    if (isPlaying) {
      stopAudioIfLoaded(audio);
      setIsPlaying(false);
      setPlaybackPositionMs(0);
      return;
    }
    setPlaybackPositionMs(0);
    audio.src = detail.recordingUrl;
    audio.play();
  };

  const startThisPractice = () => {
    if (!detail) return;
    Taro.navigateTo({
      url: practiceUrl || "/pages/BookLibrary/BookLibrary",
    });
  };

  if (loading) {
    return <View className='check-in-state'>正在读取打卡录音…</View>;
  }

  if (!detail) {
    return (
      <View className='check-in-state'>
        <Text className='check-in-state__title'>暂时无法打开这条打卡</Text>
        <Text className='check-in-state__message'>{errorMessage}</Text>
        <Button className='check-in-state__button' onClick={() => Taro.reLaunch({ url: "/pages/Home/Home" })}>
          返回首页
        </Button>
      </View>
    );
  }

  return (
    <View className='check-in-detail'>
      <View className='check-in-detail__success'>
        <Text className='check-in-detail__check'>✓</Text>
        <Text className='check-in-detail__eyebrow'>FOLLOW-READING CHECK-IN</Text>
        <Text className='check-in-detail__title'>完成一次英语跟读</Text>
        <Text className='check-in-detail__time'>{formatCheckInTime(detail.createdAt)}</Text>
      </View>

      <View className='check-in-course-card'>
        <Image className='check-in-course-card__image' src={detail.imageUrl} mode='aspectFill' webp />
        <View className='check-in-course-card__content'>
          <Text className='check-in-course-card__book'>{detail.bookTitle}</Text>
          <Text className='check-in-course-card__section'>{detail.sectionTitle}</Text>
          <Text className='check-in-course-card__meta'>
            第 {detail.practiceIndex + 1} 个训练 · 教材页 {detail.pageNumber}
          </Text>
        </View>
      </View>

      <View className='shared-recording'>
        <Text className='shared-recording__label'>本次跟读录音</Text>
        <Text className='shared-recording__duration'>
          {formatPlaybackDurationLabel(
            isPlaying,
            playbackPositionMs,
            detail.durationMs,
          )}
        </Text>
        <Button className='shared-recording__play' onClick={toggleRecording}>
          <Text className='shared-recording__play-icon'>{isPlaying ? "■" : "▶"}</Text>
          {isPlaying ? "停止播放" : "播放本次跟读"}
        </Button>
        <Text className='shared-recording__privacy'>
          分享的是本次用户录音和打卡记录，不包含题目、答案或教材原音。
        </Text>
      </View>

      <View className='check-in-actions'>
        <Button className='check-in-actions__share' openType='share'>分享这次打卡</Button>
        <Button className='check-in-actions__practice' onClick={startThisPractice}>
          {practiceUrl ? "我也来跟读" : "选择教材"}
        </Button>
      </View>
    </View>
  );
}
