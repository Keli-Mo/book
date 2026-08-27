import { Image, Text, View } from "@tarojs/components";
import Taro, { useRouter } from "@tarojs/taro";
import { useEffect, useRef, useState } from "react";
import {
  SAMPLE_BOOK_PRACTICES,
  SAMPLE_BOOK_TITLE,
} from "@/features/listeningPractice/book3Practice";

import "./Practice.scss";

const normalizePracticeIndex = (rawIndex?: string) => {
  const parsed = Number(rawIndex || 0);
  if (!Number.isInteger(parsed)) return 0;
  return Math.min(SAMPLE_BOOK_PRACTICES.length - 1, Math.max(0, parsed));
};

export default function Practice() {
  const router = useRouter();
  const [practiceIndex, setPracticeIndex] = useState(() =>
    normalizePracticeIndex(router.params?.practice),
  );
  const [playingTrackId, setPlayingTrackId] = useState<string | null>(null);
  const modelAudioRef = useRef<Taro.InnerAudioContext | null>(null);

  const practice = SAMPLE_BOOK_PRACTICES[practiceIndex];

  useEffect(() => {
    const audio = Taro.createInnerAudioContext();
    audio.loop = false;
    audio.onEnded(() => setPlayingTrackId(null));
    audio.onStop(() => setPlayingTrackId(null));
    audio.onError(() => {
      setPlayingTrackId(null);
      Taro.showToast({ title: "示范音频播放失败", icon: "none" });
    });
    modelAudioRef.current = audio;

    return () => {
      audio.destroy();
      modelAudioRef.current = null;
    };
  }, []);

  const playModelAudio = (trackId: string, url: string) => {
    const audio = modelAudioRef.current;
    if (!audio) return;

    // 每次只播放用户主动点击的当前音频，不自动循环或连续播放下一段。
    audio.stop();
    audio.src = url;
    audio.play();
    setPlayingTrackId(trackId);
  };

  const switchPractice = (nextIndex: number) => {
    modelAudioRef.current?.stop();
    setPlayingTrackId(null);
    setPracticeIndex(nextIndex);
    Taro.pageScrollTo({ scrollTop: 0, duration: 200 });
  };

  if (!practice) {
    return (
      <View className="practice-empty">
        <Text>暂时没有可用的跟读训练</Text>
      </View>
    );
  }

  return (
    <View className="practice-page">
      <View className="practice-header">
        <Text className="practice-header__course">{SAMPLE_BOOK_TITLE}</Text>
        <Text className="practice-header__section">{practice.sectionTitle}</Text>
        <Text className="practice-header__progress">
          跟读训练 {practiceIndex + 1} / {SAMPLE_BOOK_PRACTICES.length}
        </Text>
      </View>

      <View className="practice-guide">
        <Text className="practice-guide__title">先听示范，再完成自己的跟读</Text>
        <Text className="practice-guide__text">
          点击教材页上的播放标记收听当前位置对应的示范音频。
        </Text>
      </View>

      <View className="practice-book-page">
        <Image
          className="practice-book-page__image"
          src={practice.imageUrl}
          mode="widthFix"
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
            <Text className="audio-hotspot__icon">
              {playingTrackId === track.id ? "◼" : "▶"}
            </Text>
            <Text className="audio-hotspot__number">{index + 1}</Text>
          </View>
        ))}
      </View>

      <View className="practice-audio-status">
        <Text className="practice-audio-status__title">本页示范听力</Text>
        <Text className="practice-audio-status__value">
          {practice.tracks.length} 段 · 点击图片中的播放标记
        </Text>
      </View>

      <View className="practice-record-placeholder">
        <Text className="practice-record-placeholder__title">我的跟读</Text>
        <Text className="practice-record-placeholder__text">
          录音、回听和云端打卡将在下一阶段接入。
        </Text>
      </View>

      <View className="practice-navigation">
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
    </View>
  );
}
