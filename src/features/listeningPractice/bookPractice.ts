import {
  BOOKS,
  type BookCatalogItem,
} from "@/features/bookLibrary/bookCatalog";
import { allAudioList } from "@/pages/BookDetail/Components/BookPreview/constants/audioList";
import { catalogLists } from "@/pages/BookDetail/Components/BookPreview/constants/catalogList";
import { concatImages } from "@/pages/BookDetail/Components/BookPreview/constants/images";

export const DEFAULT_BOOK_ID = "3";

export type OriginalAudioTrack = {
  offset?: Array<number | string>;
  url: string;
  flag?: "Cambridge" | "Percentage" | string;
};

type CatalogItem = {
  name: string;
  page: number;
};

export type PracticeTrack = {
  id: string;
  url: string;
  label: string;
  left: string;
  top: string;
  positionAdjusted: boolean;
};

export type ListeningPractice = {
  id: string;
  // Task 4 替换旧页面前，目录组件仍需兼容 book3Practice 的训练项。
  bookId?: string;
  imageIndex: number;
  pageNumber: number;
  imageUrl: string;
  sectionTitle: string;
  tracks: PracticeTrack[];
};

export type BookPracticeBundle = {
  book: BookCatalogItem;
  coverUrl: string;
  practices: ListeningPractice[];
};

const COVER_WHITELIST: Record<string, string> = {
  "11": "OW_2E_L1_Studentbook.png",
  "12": "OW_L1_Workbook.png",
  "13": "OW_Starter_Studentbook.png",
  "14": "OW_Starter_Workbook-1.png",
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const toFiniteCoordinate = (value: unknown, coordinateType: string) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${coordinateType}坐标必须为有限数值`);
  }
  return value;
};

const toPercentageCoordinate = (value: unknown) => {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("百分比坐标必须为有限数值");
    return value;
  }

  if (
    typeof value !== "string" ||
    !/^-?(?:\d+|\d*\.\d+)%$/.test(value)
  ) {
    throw new Error("百分比坐标必须是有限数值或严格的数值百分号字符串");
  }

  const parsed = Number(value.slice(0, -1));
  if (!Number.isFinite(parsed)) throw new Error("百分比坐标必须为有限数值");
  return parsed;
};

/**
 * 将三套历史热点坐标统一成图片容器百分比。非法坐标直接报错，避免热点悄悄漂到默认位置。
 */
export const parseTrackCoordinate = (track: OriginalAudioTrack) => {
  if (!Array.isArray(track.offset) || track.offset.length !== 2) {
    throw new Error("热点坐标必须包含两个值");
  }

  const [rawX, rawY] = track.offset;
  let leftPercent: number;
  let topPercent: number;

  if (track.flag === "Cambridge") {
    leftPercent = ((toFiniteCoordinate(rawX, "Cambridge") - 3576) / 825) * 100;
    topPercent = ((toFiniteCoordinate(rawY, "Cambridge") - 202) / 1061) * 100;
  } else if (track.flag === "Percentage") {
    leftPercent = toPercentageCoordinate(rawX);
    topPercent = toPercentageCoordinate(rawY);
  } else if (track.flag === undefined) {
    leftPercent = ((toFiniteCoordinate(rawX, "像素") - 653) / 469) * 100;
    topPercent = ((toFiniteCoordinate(rawY, "像素") - 167) / 606) * 100;
  } else {
    throw new Error(`不支持的热点坐标类型：${track.flag}`);
  }

  const safeLeft = clamp(leftPercent, 1, 96);
  const safeTop = clamp(topPercent, 1, 96);
  return {
    leftPercent: safeLeft,
    topPercent: safeTop,
    positionAdjusted: safeLeft !== leftPercent || safeTop !== topPercent,
  };
};

const parseImagePageNumber = (imageUrl: string): number | null => {
  try {
    const cleanUrl = decodeURIComponent(imageUrl.split("?")[0]);
    const match = cleanUrl.match(/_(\d+)\.(?:png|jpe?g|webp)$/i);
    return match ? Number(match[1]) : null;
  } catch (_error) {
    return null;
  }
};

const getDecodedFilename = (url: string) => {
  try {
    return decodeURIComponent(url.split("?")[0]).split("/").pop() || "";
  } catch (_error) {
    return "";
  }
};

const isAllowedCover = (bookId: string, imageIndex: number, imageUrl: string) =>
  imageIndex === 0 && COVER_WHITELIST[bookId] === getDecodedFilename(imageUrl);

const getTrackLabel = (url: string, index: number) => {
  try {
    const filename = getDecodedFilename(url).replace(/\.mp3$/i, "").trim();
    return filename || `示范音频 ${index + 1}`;
  } catch (_error) {
    return `示范音频 ${index + 1}`;
  }
};

const bookDataError = (bookId: string, context: string, message: string) =>
  new Error(`教材 ${bookId} ${context}${message}`);

const getSectionTitle = (catalog: readonly CatalogItem[], imageIndex: number) => {
  let currentSection: CatalogItem | undefined;
  for (const item of catalog) {
    if (item.page > imageIndex) break;
    currentSection = item;
  }
  return currentSection?.name || "课程导入";
};

const freezeBundle = (book: BookCatalogItem, practices: ListeningPractice[]) => {
  const frozenPractices = practices.map((practice) =>
    Object.freeze({
      ...practice,
      tracks: Object.freeze(
        practice.tracks.map((track) => Object.freeze({ ...track })),
      ) as unknown as PracticeTrack[],
    }) as ListeningPractice,
  );

  return Object.freeze({
    book: Object.freeze({ ...book }) as BookCatalogItem,
    coverUrl: book.cover,
    practices: Object.freeze(frozenPractices) as unknown as ListeningPractice[],
  }) as BookPracticeBundle;
};

/** 由教材单一数据源生成仅含示范音频页的训练模型。 */
export const buildBookPracticeBundle = (
  bookId: string,
): BookPracticeBundle | null => {
  const book = BOOKS.find((item) => item.id === bookId);
  if (!book) return null;

  const imageUrls = (concatImages as Record<string, unknown>)[bookId];
  const rawAudioByPage = (allAudioList as Record<string, unknown>)[bookId];
  const rawCatalog = (catalogLists as Record<string, unknown>)[bookId];
  if (!Array.isArray(imageUrls)) {
    throw bookDataError(bookId, "图片数据：", "应为图片数组");
  }
  if (!rawAudioByPage || typeof rawAudioByPage !== "object") {
    throw bookDataError(bookId, "音频数据：", "应为页码映射");
  }
  if (!Array.isArray(rawCatalog)) {
    throw bookDataError(bookId, "目录数据：", "应为目录数组");
  }

  const catalog = rawCatalog as CatalogItem[];
  catalog.forEach((item, index) => {
    if (
      !item ||
      typeof item.name !== "string" ||
      !Number.isInteger(item.page) ||
      item.page < 0 ||
      item.page >= imageUrls.length ||
      (index > 0 && item.page <= catalog[index - 1].page)
    ) {
      throw bookDataError(bookId, `目录 ${index}：`, "page 或名称不合法");
    }
  });

  const imageByPage = new Map<number, { imageIndex: number; imageUrl: string }>();
  imageUrls.forEach((imageUrl, imageIndex) => {
    if (typeof imageUrl !== "string") {
      throw bookDataError(bookId, `图片索引 ${imageIndex}：`, "图片地址不合法");
    }
    const pageNumber = parseImagePageNumber(imageUrl);
    if (pageNumber === null) {
      if (isAllowedCover(bookId, imageIndex, imageUrl)) return;
      throw bookDataError(bookId, `图片索引 ${imageIndex}：`, "无法解析真实页号");
    }
    if (imageByPage.has(pageNumber)) {
      throw bookDataError(bookId, `第 ${pageNumber} 页：`, "图片真实页号重复");
    }
    imageByPage.set(pageNumber, { imageIndex, imageUrl });
  });

  const audioByPage = rawAudioByPage as Record<string, unknown>;
  const tracksByPage = new Map<number, OriginalAudioTrack[]>();
  Object.entries(audioByPage).forEach(([rawPageNumber, rawTracks]) => {
    const pageNumber = Number(rawPageNumber);
    if (!Number.isInteger(pageNumber)) {
      throw bookDataError(bookId, `音频页 ${rawPageNumber}：`, "页号不合法");
    }
    if (!Array.isArray(rawTracks)) {
      throw bookDataError(bookId, `第 ${pageNumber} 页：`, "音频段应为数组");
    }
    if (rawTracks.length > 0 && !imageByPage.has(pageNumber)) {
      throw bookDataError(bookId, `第 ${pageNumber} 页：`, "找不到对应图片");
    }
    tracksByPage.set(pageNumber, rawTracks as OriginalAudioTrack[]);
  });

  const practices: ListeningPractice[] = [];
  for (const [pageNumber, image] of imageByPage) {
    const tracks = tracksByPage.get(pageNumber) || [];
    if (tracks.length === 0) continue;

    practices.push({
      id: `${bookId}-page-${pageNumber}`,
      bookId,
      imageIndex: image.imageIndex,
      pageNumber,
      imageUrl: image.imageUrl,
      sectionTitle: getSectionTitle(catalog, image.imageIndex),
      tracks: tracks.map((track, trackIndex) => {
        const context = `第 ${pageNumber} 页第 ${trackIndex + 1} 段：`;
        if (!track || typeof track.url !== "string" || !track.url.trim()) {
          throw bookDataError(bookId, context, "音频地址不合法");
        }
        try {
          const coordinate = parseTrackCoordinate(track);
          return {
            id: `${bookId}-${pageNumber}-${trackIndex}`,
            url: track.url,
            label: getTrackLabel(track.url, trackIndex),
            left: `${coordinate.leftPercent.toFixed(2)}%`,
            top: `${coordinate.topPercent.toFixed(2)}%`,
            positionAdjusted: coordinate.positionAdjusted,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : "热点坐标不合法";
          throw bookDataError(bookId, context, message);
        }
      }),
    });
  }

  return freezeBundle(book, practices);
};
