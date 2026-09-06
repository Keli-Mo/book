import { Image, Text, View } from "@tarojs/components";
import Taro, { useShareAppMessage } from "@tarojs/taro";
import AtIcon from "taro-ui/lib/components/icon";
import {
  BOOKS,
  BOOK_SERIES,
  type BookSeriesId,
} from "@/features/bookLibrary/bookCatalog";
import { calculateHomeNavigationMetrics } from "@/features/bookLibrary/homeNavigation";
import { sharedImage } from "@/constant";

import "./Home.scss";

const PRIMARY_BOOK = BOOKS.find((book) => book.id === "3") || BOOKS[0];

export default function Home() {
  const windowInfo = Taro.getSystemInfoSync();
  const navigationMetrics = calculateHomeNavigationMetrics(
    windowInfo.windowWidth,
    windowInfo.statusBarHeight || 20,
    Taro.getMenuButtonBoundingClientRect(),
  );

  useShareAppMessage(() => ({
    title: "海沙牛娃英语听力与跟读训练",
    path: "pages/Home/Home",
    imageUrl: sharedImage,
  }));

  const openLibrary = (seriesId: BookSeriesId | "all" = "all") => {
    Taro.navigateTo({
      url: `/pages/BookLibrary/BookLibrary?series=${seriesId}`,
    });
  };

  const startPractice = () => {
    // 当前只有 CASA 第 1 册完成了教材页、音频和热点位置核对。
    Taro.navigateTo({ url: "/pages/Practice/Practice?practice=0" });
  };

  const openMyCheckIns = () => {
    Taro.navigateTo({ url: "/pages/MyCheckIns/MyCheckIns" });
  };

  const showClassPreview = () => {
    Taro.showToast({ title: "班级功能稍后开放", icon: "none" });
  };

  return (
    <View className='library-home'>
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
            <AtIcon value='bookmark' size='27' color='#278465' />
            <Text>海沙牛娃</Text>
          </View>
          <View
            className='library-home__search'
            hoverClass='is-pressed'
            onClick={() => openLibrary("all")}
          >
            <AtIcon value='search' size='25' color='#173f34' />
          </View>
        </View>
      </View>

      <View className='library-home__content'>
        <Text className='library-home__heading'>接着上次，读一页</Text>

        <View className='continue-card'>
          <Image
            className='continue-card__cover'
            src={PRIMARY_BOOK.cover}
            mode='aspectFit'
            lazyLoad
          />
          <View className='continue-card__body'>
            <Text className='continue-card__title'>{PRIMARY_BOOK.title}</Text>
            <Text className='continue-card__progress'>上次练到 Unit 1 · 课文</Text>
            <View className='continue-card__available'>
              <AtIcon value='check-circle' size='16' color='#2f856a' />
              <Text>可跟读</Text>
            </View>
            <View
              className='continue-card__button'
              hoverClass='is-pressed'
              onClick={startPractice}
            >
              <Text>继续跟读</Text>
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
              className='series-section__all'
              hoverClass='is-pressed'
              onClick={() => openLibrary("all")}
            >
              <Text>全部教材</Text>
              <AtIcon value='chevron-right' size='16' color='#2f856a' />
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
                <Text
                  className={`series-row__state ${
                    series.availableCount ? "is-available" : ""
                  }`}
                >
                  {series.availableCount
                    ? `${series.availableCount} 册可练`
                    : "待上线"}
                </Text>
                <AtIcon value='chevron-right' size='18' color='#9aa6a2' />
              </View>
            ))}
          </View>
        </View>
      </View>

      <View className='home-tabs'>
        <View className='home-tabs__item is-active'>
          <AtIcon value='folder' size='24' color='#2f856a' />
          <Text>学习</Text>
        </View>
        <View
          className='home-tabs__item'
          hoverClass='is-pressed'
          onClick={showClassPreview}
        >
          <AtIcon value='home' size='24' color='#7b827f' />
          <Text>班级</Text>
        </View>
        <View
          className='home-tabs__item'
          hoverClass='is-pressed'
          onClick={openMyCheckIns}
        >
          <AtIcon value='user' size='24' color='#7b827f' />
          <Text>我的</Text>
        </View>
      </View>
    </View>
  );
}
