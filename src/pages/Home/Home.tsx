import { Image, Text, View } from "@tarojs/components";
import Taro, { useDidShow, useShareAppMessage } from "@tarojs/taro";
import { useState } from "react";
import AppIcon from "@/components/AppIcon/AppIcon";
import {
  BOOK_SERIES,
  type BookSeriesId,
} from "@/features/bookLibrary/bookCatalog";
import { calculateHomeNavigationMetrics } from "@/features/bookLibrary/homeNavigation";
import { readReadingProgress, type ReadingProgress } from "@/features/bookLibrary/readingProgress";
import { buildDeviceLayoutClassName } from "@/features/layout/deviceLayout";
import { buildBookPracticeBundle } from "@/features/listeningPractice/bookPractice";
import { useAppEntryIntroGuard } from "@/hooks/useAppEntryIntroGuard";
import { useDeviceLayout } from "@/hooks/useDeviceLayout";
import { sharedImage, sharedTitle } from "@/constant";

import "./Home.scss";

export default function Home() {
  useAppEntryIntroGuard();
  const [readingProgress, setReadingProgress] = useState<ReadingProgress | null>(
    () => readReadingProgress(),
  );
  const layout = useDeviceLayout();
  // 首页采用用户确认的单栏方案，宽 Pad 也只增加留白，不改成信息双列。
  const layoutClassName = buildDeviceLayoutClassName({
    ...layout,
    isSplit: false,
  });
  const navigationMetrics = calculateHomeNavigationMetrics(
    layout.windowWidth,
    layout.statusBarHeight,
    Taro.getMenuButtonBoundingClientRect(),
  );
  const progressBundle = readingProgress
    ? buildBookPracticeBundle(readingProgress.bookId)
    : null;
  const progressPractice = progressBundle && readingProgress
    ? progressBundle.practices[readingProgress.practiceIndex]
    : null;

  useShareAppMessage(() => ({
    title: sharedTitle,
    path: "pages/Home/Home",
    imageUrl: sharedImage,
  }));

  useDidShow(() => {
    setReadingProgress(readReadingProgress());
  });

  const openLibrary = (seriesId: BookSeriesId | "all" = "all") => {
    Taro.navigateTo({
      url: `/pages/BookLibrary/BookLibrary?series=${seriesId}`,
    });
  };

  const startPractice = () => {
    if (!readingProgress || !progressBundle || !progressPractice) {
      openLibrary("all");
      return;
    }
    Taro.navigateTo({
      url: `/pages/Practice/Practice?bookId=${encodeURIComponent(readingProgress.bookId)}&practice=${readingProgress.practiceIndex}`,
    });
  };

  const openMyCheckIns = () => {
    Taro.navigateTo({ url: "/pages/MyCheckIns/MyCheckIns" });
  };

  return (
    <View className={`library-home ${layoutClassName}`}>
      <View
        className='library-home__navigation'
        style={{ paddingTop: `${navigationMetrics.statusBarHeight}px` }}
      >
        <View
          className='library-home__navigation-main'
          style={{
            height: `${navigationMetrics.navigationHeight}px`,
            paddingRight: `${navigationMetrics.capsuleReserve}px`,
          }}
        >
          <View className='library-home__brand'>
            <AppIcon value='bookmark' size='27' color='#278465' />
            <Text>海沙牛娃</Text>
          </View>
          <View
            className='library-home__search device-touch-target'
            hoverClass='is-pressed'
            onClick={() => openLibrary("all")}
          >
            <AppIcon value='search' size='25' color='#173f34' />
          </View>
        </View>
      </View>

      <View className='library-home__content device-layout__content'>
        <View className={`continue-card ${progressBundle ? "" : "continue-card--empty"}`}>
          {progressBundle && progressPractice ? (
            <Image
              className='continue-card__cover'
              src={progressBundle.book.cover}
              mode='aspectFit'
              lazyLoad
            />
          ) : null}
          <View className='continue-card__body'>
            <Text className='continue-card__title'>
              {progressBundle?.book.title || "开始跟读练习"}
            </Text>
            <Text className='continue-card__progress'>
              {progressPractice
                ? `${progressPractice.sectionTitle} · 教材第 ${progressPractice.pageNumber} 页`
                : "还没有跟读记录，先去书库选择教材"}
            </Text>
            <View
              className='continue-card__button device-touch-target'
              hoverClass='is-pressed'
              onClick={startPractice}
            >
              <Text>{progressBundle ? "继续跟读" : "选择教材"}</Text>
            </View>
          </View>
        </View>

        <View className='series-section'>
          <View className='series-section__heading'>
            <View>
              <Text className='series-section__title'>按系列找书</Text>
              <Text className='series-section__summary'>5 个系列 · 23 册</Text>
            </View>
            <View
              className='series-section__all device-touch-target'
              hoverClass='is-pressed'
              onClick={() => openLibrary("all")}
            >
              <Text>全部教材</Text>
              <AppIcon value='chevron-right' size='16' color='#2f856a' />
            </View>
          </View>

          <View className='series-list'>
            {BOOK_SERIES.map((series) => (
              <View
                className='series-row'
                key={series.id}
                hoverClass='is-pressed'
                onClick={() => openLibrary(series.id)}
              >
                <Image
                  className='series-row__cover'
                  src={series.cover}
                  mode='aspectFit'
                  lazyLoad
                />
                <View className='series-row__text'>
                  <Text className='series-row__title'>{series.title}</Text>
                  <Text className='series-row__range'>{series.rangeLabel}</Text>
                </View>
                <AppIcon value='chevron-right' size='18' color='#9aa6a2' />
              </View>
            ))}
          </View>
        </View>
      </View>

      <View className='home-tabs'>
        <View className='home-tabs__item device-touch-target is-active'>
          <AppIcon value='folder' size='24' color='#2f856a' />
          <Text>学习</Text>
        </View>
        <View
          className='home-tabs__item device-touch-target'
          hoverClass='is-pressed'
          onClick={openMyCheckIns}
        >
          <AppIcon value='user' size='24' color='#7b827f' />
          <Text>我的</Text>
        </View>
      </View>
    </View>
  );
}
