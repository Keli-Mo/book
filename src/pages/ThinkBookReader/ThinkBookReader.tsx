import { Button, Image, ScrollView, Text, View } from "@tarojs/components";
import Taro, { useDidHide, useRouter, useShareAppMessage } from "@tarojs/taro";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildThinkBookReader,
  parseThinkReaderPage,
  type ThinkBookReader as ThinkBookReaderData,
} from "@/features/bookLibrary/thinkBookReader";
import { buildDeviceLayoutClassName } from "@/features/layout/deviceLayout";
import { createTrackAudioController } from "@/features/listeningPractice/audioPlayback";
import { clampHotspotCenter } from "@/features/listeningPractice/hotspotLayout";
import { useAppEntryIntroGuard } from "@/hooks/useAppEntryIntroGuard";
import { useDeviceLayout } from "@/hooks/useDeviceLayout";
import CheckInNavigation from "../CheckInDetail/CheckInNavigation";
import "./ThinkBookReader.scss";

export default function ThinkBookReader() {
  useAppEntryIntroGuard();
  const layout = useDeviceLayout();
  const router = useRouter();
  const bookId = router.params?.bookId;
  const rawPage = router.params?.page;
  const route = useMemo(() => {
    const reader = buildThinkBookReader(bookId || "");
    const initialPage = reader ? parseThinkReaderPage(rawPage, reader.pages.length) : null;
    return { reader, initialPage };
  }, [bookId, rawPage]);

  const goBack = () => {
    const pages = Taro.getCurrentPages?.() ?? [];
    return pages.length > 1
      ? Taro.navigateBack({ delta: 1 })
      : Taro.reLaunch({ url: "/pages/Home/Home" });
  };

  return (
    <View className={`think-reader ${buildDeviceLayoutClassName(layout)}`}>
      <CheckInNavigation title='Think 1 教材阅读' onBack={goBack} />
      {route.reader && route.initialPage !== null ? (
        <ReaderSession
          key={`${route.reader.book.id}:${route.initialPage}`}
          reader={route.reader}
          initialPage={route.initialPage}
          windowWidth={layout.windowWidth}
          windowHeight={layout.windowHeight}
        />
      ) : (
        <View className='think-reader__empty'>
          <Text>无法打开这本教材或指定页面</Text>
          <Button onClick={() => Taro.redirectTo({ url: "/pages/BookLibrary/BookLibrary" })}>
            返回书架
          </Button>
        </View>
      )}
    </View>
  );
}

function ReaderSession({
  reader,
  initialPage,
  windowWidth,
  windowHeight,
}: {
  reader: ThinkBookReaderData;
  initialPage: number;
  windowWidth: number;
  windowHeight: number;
}) {
  const [pageIndex, setPageIndex] = useState(initialPage);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [playingTrackId, setPlayingTrackId] = useState<string | null>(null);
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const audioController = useRef<ReturnType<typeof createTrackAudioController> | null>(null);
  const page = reader.pages[pageIndex];

  useEffect(() => {
    const controller = createTrackAudioController(
      () => Taro.createInnerAudioContext(),
      setPlayingTrackId,
      () => void Taro.showToast({ title: "示范音频播放失败", icon: "none" }),
    );
    audioController.current = controller;
    return () => {
      controller.dispose();
      audioController.current = null;
    };
  }, []);

  useDidHide(() => {
    audioController.current?.stop();
  });

  useShareAppMessage(() => ({
    title: `${reader.book.title} · ${page.pageLabel}`,
    path: `/pages/ThinkBookReader/ThinkBookReader?bookId=${encodeURIComponent(reader.book.id)}&page=${pageIndex}`,
    imageUrl: reader.book.cover,
  }));

  const measureImage = useCallback(() => {
    if (typeof Taro.createSelectorQuery !== "function") return;
    Taro.createSelectorQuery()
      .select(".think-reader__page-image")
      .boundingClientRect((rect) => {
        if (
          rect && !Array.isArray(rect) &&
          Number.isFinite(rect.width) && Number.isFinite(rect.height) &&
          rect.width > 0 && rect.height > 0
        ) {
          setImageSize({ width: rect.width, height: rect.height });
        }
      })
      .exec();
  }, []);

  useEffect(() => {
    measureImage();
  }, [windowWidth, windowHeight, pageIndex, measureImage]);

  const hotspots = useMemo(() => page.tracks.map((track) => {
    if (imageSize.width <= 0 || imageSize.height <= 0) return track;
    const center = clampHotspotCenter(
      { left: Number.parseFloat(track.left), top: Number.parseFloat(track.top) },
      imageSize,
    );
    return { ...track, left: `${center.left}%`, top: `${center.top}%` };
  }), [page.tracks, imageSize]);

  const turnTo = (nextIndex: number) => {
    if (nextIndex < 0 || nextIndex >= reader.pages.length) return;
    if (nextIndex === pageIndex) {
      setDirectoryOpen(false);
      return;
    }
    audioController.current?.stop();
    setImageSize({ width: 0, height: 0 });
    setPageIndex(nextIndex);
    setDirectoryOpen(false);
  };

  const openPractice = () => {
    const practiceIndex = page.practiceIndex ?? 0;
    audioController.current?.stop();
    Taro.navigateTo({
      url: `/pages/Practice/Practice?bookId=${encodeURIComponent(reader.book.id)}&practice=${practiceIndex}`,
    });
  };

  return (
    <View className='think-reader__content device-layout__content'>
      <View className='think-reader__heading'>
        <Text className='think-reader__book-title'>{reader.book.title}</Text>
        <Text className='think-reader__position'>
          {page.sectionTitle} · {page.pageLabel} · {pageIndex + 1}/{reader.pages.length} 张
        </Text>
      </View>

      <View className='think-reader__page'>
        <Image
          key={page.imageUrl}
          className='think-reader__page-image'
          src={page.imageUrl}
          mode='widthFix'
          onLoad={measureImage}
        />
        <View className='think-reader__hotspots'>
          {hotspots.map((track, index) => (
            <View
              key={track.id}
              className={`think-reader__hotspot device-touch-target ${playingTrackId === track.id ? "is-playing" : ""}`}
              style={{ left: track.left, top: track.top }}
              onClick={() => audioController.current?.toggle(track.id, track.url)}
              aria-label={`播放第 ${index + 1} 段示范音频`}
            >
              <Text>{playingTrackId === track.id ? "■" : "▶"}</Text>
            </View>
          ))}
        </View>
      </View>

      <View className='think-reader__actions'>
        <Button className='think-reader__action' onClick={() => setDirectoryOpen(true)}>章节目录</Button>
        <Button className='think-reader__action think-reader__action--primary' onClick={openPractice}>
          {page.practiceIndex === null ? "进入跟读训练" : "跟读本页"}
        </Button>
      </View>
      <View className='think-reader__navigation'>
        <Button disabled={pageIndex === 0} onClick={() => turnTo(pageIndex - 1)}>上一页</Button>
        <Button disabled={pageIndex === reader.pages.length - 1} onClick={() => turnTo(pageIndex + 1)}>下一页</Button>
      </View>

      {directoryOpen && (
        <View className='think-reader__directory-mask' onClick={() => setDirectoryOpen(false)}>
          <View className='think-reader__directory-sheet' onClick={(event) => event.stopPropagation()}>
            <View className='think-reader__directory-head'>
              <Text>章节目录</Text>
              <Text onClick={() => setDirectoryOpen(false)}>关闭</Text>
            </View>
            <ScrollView scrollY className='think-reader__directory-list'>
              <View className='think-reader__directory-item' onClick={() => turnTo(0)}>封面</View>
              {reader.chapters.map((chapter) => (
                <View
                  key={`${chapter.name}:${chapter.imageIndex}`}
                  className='think-reader__directory-item'
                  onClick={() => turnTo(chapter.imageIndex)}
                >
                  {chapter.name}
                </View>
              ))}
            </ScrollView>
          </View>
        </View>
      )}
    </View>
  );
}
