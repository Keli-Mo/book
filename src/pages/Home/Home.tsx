import { Image, Text, View } from "@tarojs/components";
import Taro, { useShareAppMessage } from "@tarojs/taro";
import {
  SAMPLE_BOOK_COVER,
  SAMPLE_BOOK_PRACTICES,
  SAMPLE_BOOK_TITLE,
} from "@/features/listeningPractice/book3Practice";
import { sharedImage } from "@/constant";

import "./Home.scss";

export default function Home() {
  const totalTracks = SAMPLE_BOOK_PRACTICES.reduce(
    (count, practice) => count + practice.tracks.length,
    0,
  );

  useShareAppMessage(() => ({
    title: "海沙牛娃英语听力与跟读训练",
    path: "pages/Home/Home",
    imageUrl: sharedImage,
  }));

  const startPractice = () => {
    Taro.navigateTo({ url: "/pages/Practice/Practice?practice=0" });
  };

  return (
    <View className="practice-home">
      <View className="practice-home__hero">
        <Text className="practice-home__eyebrow">LISTEN · REPEAT · CHECK IN</Text>
        <Text className="practice-home__title">每天听一点，开口读一遍</Text>
        <Text className="practice-home__subtitle">
          原版示范听力与教材练习位置一一对应，完成跟读后生成你的学习打卡。
        </Text>
      </View>

      <View className="practice-home__section-title">
        <Text>本期课程</Text>
        <Text className="practice-home__section-tip">先从一本书开始</Text>
      </View>

      <View className="course-card" onClick={startPractice}>
        <Image
          className="course-card__cover"
          src={SAMPLE_BOOK_COVER}
          mode="aspectFill"
          webp
          lazyLoad
        />
        <View className="course-card__content">
          <Text className="course-card__badge">英语听力跟读</Text>
          <Text className="course-card__title">{SAMPLE_BOOK_TITLE}</Text>
          <Text className="course-card__summary">
            {SAMPLE_BOOK_PRACTICES.length} 个跟读训练 · {totalTracks} 段示范音频
          </Text>
          <View className="course-card__action">
            <Text>开始今天的训练</Text>
            <Text className="course-card__arrow">→</Text>
          </View>
        </View>
      </View>

      <View className="practice-home__notice">
        <Text className="practice-home__notice-title">训练方式</Text>
        <Text className="practice-home__notice-text">
          点击教材页上的播放标记收听对应示范，再完成自己的跟读录音。示范音频不会自动连播或循环。
        </Text>
      </View>
    </View>
  );
}
