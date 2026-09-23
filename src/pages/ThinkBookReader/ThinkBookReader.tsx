import { Button, Text, View } from "@tarojs/components";
import Taro, { useRouter, useShareAppMessage } from "@tarojs/taro";
import { useMemo, useState } from "react";
import {
  buildThinkBookReader,
  buildThinkPracticeBundle,
  resolveThinkReaderPage,
  type ThinkBookReader as ThinkBookReaderData,
} from "@/features/bookLibrary/thinkBookReader";
import { buildDeviceLayoutClassName } from "@/features/layout/deviceLayout";
import { useAppEntryIntroGuard } from "@/hooks/useAppEntryIntroGuard";
import { useDeviceLayout, type DeviceLayoutState } from "@/hooks/useDeviceLayout";
import CheckInNavigation from "../CheckInDetail/CheckInNavigation";
import { PracticeSession } from "../Practice/Practice";
import "../Practice/Practice.scss";

export default function ThinkBookReader() {
  useAppEntryIntroGuard();
  const layout = useDeviceLayout();
  const layoutClassName = buildDeviceLayoutClassName(layout);
  const router = useRouter();
  const bookId = router.params?.bookId;
  const rawPage = router.params?.page;
  const route = useMemo(() => {
    const reader = buildThinkBookReader(bookId || "");
    const initialPage = reader ? resolveThinkReaderPage(rawPage, reader) : null;
    return { reader, initialPage };
  }, [bookId, rawPage]);

  const goBack = () => {
    const pages = Taro.getCurrentPages?.() ?? [];
    return pages.length > 1
      ? Taro.navigateBack({ delta: 1 })
      : Taro.reLaunch({ url: "/pages/Home/Home" });
  };

  return (
    <View className={`practice-screen ${layoutClassName}`}>
      <CheckInNavigation title='听力跟读训练' onBack={goBack} />
      {route.reader && route.initialPage !== null ? (
        <ThinkPracticeSession
          key={`${route.reader.book.id}:${route.initialPage}`}
          reader={route.reader}
          initialPage={route.initialPage}
          layout={layout}
          layoutClassName={layoutClassName}
        />
      ) : (
        <View className={`practice-empty device-layout__content ${layoutClassName}`}>
          <Text>暂时无法打开训练</Text>
          <Button
            className='practice-empty__button device-touch-target'
            onClick={() => Taro.redirectTo({ url: "/pages/BookLibrary/BookLibrary" })}
          >
            选择教材
          </Button>
        </View>
      )}
    </View>
  );
}

function ThinkPracticeSession({
  reader,
  initialPage,
  layout,
  layoutClassName,
}: {
  reader: ThinkBookReaderData;
  initialPage: number;
  layout: DeviceLayoutState;
  layoutClassName: string;
}) {
  const bundle = useMemo(() => buildThinkPracticeBundle(reader), [reader]);
  const [pageIndex, setPageIndex] = useState(initialPage);
  const page = reader.pages[pageIndex];

  useShareAppMessage(() => ({
    title: `${reader.book.title} · ${page.pageLabel}`,
    path: `/pages/ThinkBookReader/ThinkBookReader?bookId=${encodeURIComponent(reader.book.id)}&page=${page.imageIndex}`,
    imageUrl: reader.book.cover,
  }));

  return (
    <PracticeSession
      bundle={bundle}
      initialPracticeIndex={initialPage}
      initialPractice={bundle.practices[initialPage]}
      layout={layout}
      layoutClassName={layoutClassName}
      keepModelAudioOnTurn
      persistReadingProgress={false}
      onPracticeChange={setPageIndex}
    />
  );
}
