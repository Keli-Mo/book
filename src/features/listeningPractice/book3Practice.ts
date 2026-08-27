import { allAudioList } from "@/pages/BookDetail/Components/BookPreview/constants/audioList";
import { catalogLists } from "@/pages/BookDetail/Components/BookPreview/constants/catalogList";
import { concatImages } from "@/pages/BookDetail/Components/BookPreview/constants/images";

export const SAMPLE_BOOK_ID = "3";
export const SAMPLE_BOOK_TITLE = "CASA阅读启蒙&自然拼读 1";

interface OriginalAudioTrack {
  offset?: Array<number | string>;
  url: string;
  flag?: "Cambridge" | "Percentage" | string;
}

interface CatalogItem {
  name: string;
  page: number;
}

export interface PracticeTrack {
  id: string;
  url: string;
  label: string;
  left: string;
  top: string;
  positionAdjusted: boolean;
}

export interface ListeningPractice {
  id: string;
  imageIndex: number;
  pageNumber: number;
  imageUrl: string;
  sectionTitle: string;
  tracks: PracticeTrack[];
}

const imageUrls = concatImages[SAMPLE_BOOK_ID] || [];
const audioByPage = (allAudioList[SAMPLE_BOOK_ID] || {}) as Record<
  number,
  OriginalAudioTrack[]
>;
const catalog = (catalogLists[SAMPLE_BOOK_ID] || []) as CatalogItem[];

export const SAMPLE_BOOK_COVER = imageUrls[0] || "";

/**
 * 从云存储文件名解析教材真实页号。
 * 旧实现用“图片索引 + 2”猜测音频页号，插页或删页后会整体错位；
 * 真实页号匹配可以保证页面、音频与热点坐标始终绑定在同一页。
 */
export const parseBookPageNumber = (imageUrl: string): number | null => {
  try {
    const cleanUrl = decodeURIComponent(imageUrl.split("?")[0]);
    const match = cleanUrl.match(/_(\d+)\.(?:png|jpe?g|webp)$/i);
    return match ? Number(match[1]) : null;
  } catch (_error) {
    return null;
  }
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/**
 * 将历史采集坐标换算为图片容器百分比坐标。
 * 百分比坐标不依赖手机和平板实际宽度，图片等比缩放后热点仍会落在原音频标记附近。
 */
export const convertTrackPosition = (track: OriginalAudioTrack) => {
  const [rawX = 0, rawY = 0] = track.offset || [];
  let left: number;
  let top: number;

  if (track.flag === "Cambridge") {
    left = ((Number(rawX) - 3576) / 825) * 100;
    top = ((Number(rawY) - 202) / 1061) * 100;
  } else if (track.flag === "Percentage") {
    left = Number.parseFloat(String(rawX));
    top = Number.parseFloat(String(rawY));
  } else {
    left = ((Number(rawX) - 653) / 469) * 100;
    top = ((Number(rawY) - 167) / 606) * 100;
  }

  const safeLeft = clamp(Number.isFinite(left) ? left : 50, 1, 96);
  const safeTop = clamp(Number.isFinite(top) ? top : 50, 1, 96);

  return {
    left: `${safeLeft.toFixed(2)}%`,
    top: `${safeTop.toFixed(2)}%`,
    positionAdjusted: safeLeft !== left || safeTop !== top,
  };
};

const getTrackLabel = (url: string, index: number) => {
  try {
    const filename = decodeURIComponent(url.split("/").pop() || "")
      .replace(/\.mp3(?:\?.*)?$/i, "")
      .trim();
    return filename || `示范音频 ${index + 1}`;
  } catch (_error) {
    return `示范音频 ${index + 1}`;
  }
};

const getSectionTitle = (imageIndex: number) => {
  const currentSection = catalog
    .filter((item) => item.page <= imageIndex)
    .sort((a, b) => b.page - a.page)[0];
  return currentSection?.name || "课程导入";
};

/** 只生成含示范音频的训练页，不再提供整本教材连续翻阅。 */
export const SAMPLE_BOOK_PRACTICES: ListeningPractice[] = imageUrls
  .map((imageUrl, imageIndex) => {
    const pageNumber = parseBookPageNumber(imageUrl);
    if (pageNumber === null) return null;

    const tracks = audioByPage[pageNumber] || [];
    if (!Array.isArray(tracks) || tracks.length === 0) return null;

    return {
      id: `${SAMPLE_BOOK_ID}-page-${pageNumber}`,
      imageIndex,
      pageNumber,
      imageUrl,
      sectionTitle: getSectionTitle(imageIndex),
      tracks: tracks.map((track, index) => ({
        id: `${SAMPLE_BOOK_ID}-${pageNumber}-${index}`,
        url: track.url,
        label: getTrackLabel(track.url, index),
        ...convertTrackPosition(track),
      })),
    } satisfies ListeningPractice;
  })
  .filter((practice): practice is ListeningPractice => practice !== null);
