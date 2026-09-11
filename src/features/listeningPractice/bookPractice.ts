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
  bookId: string;
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

// 历史数据保留的负索引空占位；只有这些教材/音频键且无音频时可例外。
const EMPTY_AUDIO_KEY_WHITELIST: Record<string, readonly number[]> = {
  "3": [0, 1], "4": [0, 1], "5": [0, 1], "6": [0, 1],
  "7": [0], "8": [0], "9": [0], "10": [0],
  "11": [0, 1], "12": [0, 1], "13": [0, 1], "14": [0, 1],
  "15": [0, 1], "16": [0, 1], "17": [0, 1],
  "18": [1], "19": [1], "20": [1], "21": [1],
  "22": [1], "23": [1], "24": [1], "25": [1],
};

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

  // 模型保留原始百分比；22px 点击半径的边界收敛由实际图片布局负责。
  return {
    leftPercent,
    topPercent,
    positionAdjusted: false,
  };
};

// 教材素材使用域名/IPv4 的 HTTP(S) 地址；不依赖小程序缺少的浏览器 URL 全局。
const isHttpUrl = (value: unknown): value is string => {
  if (typeof value !== "string" || /[\s\\]/.test(value)) return false;
  const match = value.match(/^https?:\/\/([a-z\d.-]+)(?::(\d{1,5}))?(?:[/?#].*)?$/i);
  if (!match) return false;
  const [, hostname, port] = match;
  if (port !== undefined && Number(port) > 65535) return false;
  return hostname.length <= 253 && hostname.split(".").every((label) =>
    /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label),
  ) && (!/^[\d.]+$/.test(hostname) || (
    hostname.split(".").length === 4 && hostname.split(".").every((part) => Number(part) <= 255)
  ));
};

const parseImagePageNumber = (imageUrl: string): number | null => {
  try {
    const cleanUrl = decodeURIComponent(imageUrl.split("?")[0]);
    const match = cleanUrl.match(/_(\d+)\.(?:png|jpe?g|webp)$/i);
    const pageNumber = match ? Number(match[1]) : null;
    return Number.isSafeInteger(pageNumber) ? pageNumber : null;
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
  return currentSection?.name ?? "课程导入";
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
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
    throw bookDataError(bookId, "图片数据：", "应为非空图片数组");
  }
  if (!rawAudioByPage || typeof rawAudioByPage !== "object" || Array.isArray(rawAudioByPage)) {
    throw bookDataError(bookId, "音频数据：", "应为页码映射");
  }
  if (!Array.isArray(rawCatalog) || rawCatalog.length === 0) {
    throw bookDataError(bookId, "目录数据：", "应为非空目录数组");
  }

  const catalog = rawCatalog as CatalogItem[];
  Array.from(catalog).forEach((item, index) => {
    if (
      !item ||
      typeof item.name !== "string" ||
      !item.name.trim() ||
      !Number.isInteger(item.page) ||
      item.page < 0 ||
      item.page >= imageUrls.length ||
      (index > 0 && item.page <= catalog[index - 1].page)
    ) {
      throw bookDataError(bookId, `目录 ${index}：`, "page 或名称不合法");
    }
  });

  const seenImagePages = new Set<number>();
  const validatedImages = Array.from(imageUrls, (imageUrl, imageIndex) => {
    if (!isHttpUrl(imageUrl)) {
      throw bookDataError(bookId, `图片索引 ${imageIndex}：`, "图片地址不合法");
    }
    const pageNumber = parseImagePageNumber(imageUrl);
    if (pageNumber === null) {
      if (isAllowedCover(bookId, imageIndex, imageUrl)) {
        return { imageIndex, imageUrl, pageNumber: null };
      }
      throw bookDataError(bookId, `图片索引 ${imageIndex}：`, "无法解析真实页号");
    }
    if (seenImagePages.has(pageNumber)) {
      throw bookDataError(bookId, `第 ${pageNumber} 页：`, "图片真实页号重复");
    }
    seenImagePages.add(pageNumber);
    return { imageIndex, imageUrl, pageNumber };
  });

  const audioByPage = rawAudioByPage as Record<string, unknown>;
  const mappedAudioPages: Array<{
    audioKey: number;
    imageIndex: number;
    tracks: OriginalAudioTrack[];
  }> = [];
  Object.entries(audioByPage).forEach(([rawPageNumber, rawTracks]) => {
    const audioKey = Number(rawPageNumber);
    // 只接受规范十进制页键，避免 02、2.0、2e0 等键归一化后覆盖同一页。
    if (!/^(?:0|[1-9]\d*)$/.test(rawPageNumber) || !Number.isSafeInteger(audioKey)) {
      throw bookDataError(bookId, `音频页 ${rawPageNumber}：`, "页号不合法");
    }
    if (!Array.isArray(rawTracks)) {
      throw bookDataError(bookId, `第 ${audioKey} 页：`, "音频段应为数组");
    }
    const imageIndex = audioKey - 2;
    if (imageIndex < 0 || imageIndex >= validatedImages.length) {
      if (rawTracks.length === 0 && EMPTY_AUDIO_KEY_WHITELIST[bookId]?.includes(audioKey)) return;
      throw bookDataError(bookId, `第 ${audioKey} 页：`, "找不到对应图片");
    }
    if (rawTracks.length === 0) return;
    if (validatedImages[imageIndex].pageNumber === null) {
      throw bookDataError(bookId, `第 ${audioKey} 页：`, "音频不能映射到教材封面");
    }
    // 历史录点工具以 currentImageIndex + 2 写入键；键不是图片文件名里的印刷页码。
    mappedAudioPages.push({
      audioKey,
      imageIndex,
      tracks: rawTracks as OriginalAudioTrack[],
    });
  });
  if (mappedAudioPages.length === 0) {
    throw bookDataError(bookId, "音频数据：", "应至少包含一个非空音频页");
  }

  const practices: ListeningPractice[] = mappedAudioPages
    .sort((left, right) => left.imageIndex - right.imageIndex)
    .map(({ audioKey, imageIndex, tracks }) => {
      const image = validatedImages[imageIndex];
      const pageNumber = image.pageNumber!;
      return {
        id: `${bookId}-page-${pageNumber}`,
        bookId,
        imageIndex,
        pageNumber,
        imageUrl: image.imageUrl,
        sectionTitle: getSectionTitle(catalog, imageIndex),
        tracks: Array.from(tracks, (track, trackIndex) => {
          const trackContext = `第 ${audioKey} 页第 ${trackIndex + 1} 段：`;
          if (!track || Array.isArray(track) || !isHttpUrl(track.url)) {
            throw bookDataError(bookId, trackContext, "音频地址不合法");
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
            throw bookDataError(bookId, trackContext, message);
          }
        }),
      };
    });

  return freezeBundle(book, practices);
};
