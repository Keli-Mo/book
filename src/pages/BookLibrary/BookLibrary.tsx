import { Image, Input, ScrollView, Text, View } from "@tarojs/components";
import Taro, { useRouter, useShareAppMessage } from "@tarojs/taro";
import { useMemo, useState } from "react";
import AppIcon from "@/components/AppIcon/AppIcon";
import {
  BOOKS,
  BOOK_SERIES,
  filterBooks,
  resolveBookAction,
  type BookCatalogItem,
  type BookSeriesId,
} from "@/features/bookLibrary/bookCatalog";
import { buildDeviceLayoutClassName } from "@/features/layout/deviceLayout";
import { useAppEntryIntroGuard } from "@/hooks/useAppEntryIntroGuard";
import { useDeviceLayout } from "@/hooks/useDeviceLayout";
import { sharedImage, sharedTitle } from "@/constant";

import "./BookLibrary.scss";

const isSeriesId = (value: string): value is BookSeriesId =>
  BOOK_SERIES.some((series) => series.id === value);

export default function BookLibrary() {
  useAppEntryIntroGuard();
  const layout = useDeviceLayout();
  const layoutClassName = buildDeviceLayoutClassName(layout);
  const router = useRouter();
  const requestedSeries = router.params?.series || "all";
  const [seriesId, setSeriesId] = useState<BookSeriesId | "all">(
    isSeriesId(requestedSeries) ? requestedSeries : "all",
  );
  const [query, setQuery] = useState("");

  const visibleBooks = useMemo(
    () => filterBooks(BOOKS, seriesId, query),
    [query, seriesId],
  );
  const currentSeries = BOOK_SERIES.find((series) => series.id === seriesId);

  useShareAppMessage(() => ({
    title: sharedTitle,
    path: "pages/Home/Home",
    imageUrl: sharedImage,
  }));

  const openBook = (book: BookCatalogItem) => {
    const action = resolveBookAction(book);

    // Think 两册进入完整阅读页；既有教材继续进入已验证的跟读训练页。
    Taro.navigateTo({ url: action.url });
  };

  return (
    <View className={`book-library device-layout__content ${layoutClassName}`}>
      <View className='book-library__toolbar'>
        <View className='book-library__heading'>
          <Text className='book-library__title'>
            {currentSeries?.title || "全部教材"}
          </Text>
          <Text className='book-library__count'>{visibleBooks.length} 册教材</Text>
        </View>

        <View className='book-search'>
          <AppIcon value='search' size='20' color='#73857d' />
          <Input
            className='book-search__input'
            value={query}
            type='text'
            confirmType='search'
            placeholder='搜索书名、级别或册别'
            placeholderClass='book-search__placeholder'
            onInput={(event) => setQuery(event.detail.value)}
          />
          {query ? (
            <View
              className='book-search__clear device-touch-target'
              hoverClass='is-pressed'
              onClick={() => setQuery("")}
            >
              <AppIcon value='close-circle' size='18' color='#7a8a84' />
            </View>
          ) : null}
        </View>

        <ScrollView className='series-filters' scrollX enhanced showScrollbar={false}>
          <View className='series-filters__track'>
            <View
              className={`series-filter device-touch-target ${
                seriesId === "all" ? "is-selected" : ""
              }`}
              hoverClass='is-pressed'
              onClick={() => setSeriesId("all")}
            >
              <Text>全部</Text>
            </View>
            {BOOK_SERIES.map((series) => (
              <View
                className={`series-filter device-touch-target ${
                  seriesId === series.id ? "is-selected" : ""
                }`}
                key={series.id}
                hoverClass='is-pressed'
                onClick={() => setSeriesId(series.id)}
              >
                <Text>{series.shortTitle}</Text>
              </View>
            ))}
          </View>
        </ScrollView>
      </View>

      <ScrollView
        className='book-library__scroller'
        scrollY
        enhanced
        showScrollbar={false}
      >
        {visibleBooks.length ? (
          <View className='book-list'>
            {visibleBooks.map((book) => (
              <View
                className='book-row'
                key={book.id}
                hoverClass='is-pressed'
                onClick={() => openBook(book)}
              >
                <Image
                  className='book-row__cover'
                  src={book.cover}
                  mode='aspectFit'
                  lazyLoad
                />
                <View className='book-row__text'>
                  <Text className='book-row__title'>
                    {seriesId === "casa" ? book.level : book.title}
                  </Text>
                  <Text className='book-row__meta'>
                    {seriesId === "casa" ? book.title : `${book.level} · ${book.kind}`}
                  </Text>
                </View>
                <AppIcon value='chevron-right' size='18' color='#9aa6a2' />
              </View>
            ))}
          </View>
        ) : (
          <View className='book-empty'>
            <AppIcon value='search' size='38' color='#2f856a' />
            <Text className='book-empty__title'>没有找到这本教材</Text>
            <Text className='book-empty__tip'>换一个书名或级别试试</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}
