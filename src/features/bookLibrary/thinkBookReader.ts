import type { BookCatalogItem } from "@/features/bookLibrary/bookCatalog";
import {
  buildFullBookPracticeBundle,
  type BookPracticeBundle,
  type ListeningPractice,
  type PracticeTrack,
} from "@/features/listeningPractice/bookPractice";
import { catalogLists } from "@/pages/BookDetail/Components/BookPreview/constants/catalogList";

export type ThinkBookId = "26" | "27" | "28" | "29";

export type ThinkReaderChapter = {
  name: string;
  imageIndex: number;
  pageIndex: number;
};

export type ThinkReaderPage = {
  imageIndex: number;
  imageUrl: string;
  pageNumber: number;
  pageLabel: string;
  sectionTitle: string;
  tracks: PracticeTrack[];
  /** 旧音频列表的索引，既有续页沿用前页；其余无音频页为 null。 */
  practiceIndex: number | null;
};

export type ThinkBookReader = {
  book: BookCatalogItem;
  sourcePageCount: number;
  pages: ThinkReaderPage[];
  chapters: ThinkReaderChapter[];
};

/** 无独立音轨标记、但承接前页听读或理解题的原 PDF 图片索引。 */
const THINK_1_STUDENT_CONTINUATION_PAGES = new Set([
  13, 21, 27, 31, 39, 45, 49, 57, 63,
  67, 75, 81, 85, 93, 99, 103, 111, 117,
]);
const THINK_2_STUDENT_CONTINUATION_PAGES = new Set([
  13, 21, 27, 31, 39, 45, 49, 57, 63, 67,
  75, 81, 85, 93, 99, 103, 111, 117,
]);

const THINK_BOOK_CONFIG: Record<ThinkBookId, {
  continuationPages: ReadonlySet<number>;
}> = {
  "26": { continuationPages: THINK_1_STUDENT_CONTINUATION_PAGES },
  "27": { continuationPages: new Set() },
  "28": { continuationPages: THINK_2_STUDENT_CONTINUATION_PAGES },
  "29": { continuationPages: new Set() },
};

const isThinkBookId = (bookId: string): bookId is ThinkBookId =>
  bookId === "26" || bookId === "27" || bookId === "28" || bookId === "29";

/** Think 阅读器展示全部登记图片，并保留旧音频题与跨页关联。 */
export const buildThinkBookReader = (bookId: string): ThinkBookReader | null => {
  if (!isThinkBookId(bookId)) return null;

  const bundle = buildFullBookPracticeBundle(bookId);
  if (!bundle) return null;

  const catalog = catalogLists[bookId];
  const config = THINK_BOOK_CONFIG[bookId];
  const practiceByPage = new Map<number, {
    practice: ListeningPractice;
    index: number;
  }>();
  bundle.practices.filter((practice) => practice.tracks.length > 0).forEach((practice, index) => {
    practiceByPage.set(practice.imageIndex, { practice, index });
  });

  const pages: ThinkReaderPage[] = bundle.practices.map((practice) => {
    const { imageIndex, imageUrl, pageNumber, sectionTitle, tracks } = practice;
    const indexedPractice = practiceByPage.get(imageIndex);
    const isContinuation = config.continuationPages.has(imageIndex);
    const relatedPractice = indexedPractice ?? (isContinuation ? practiceByPage.get(imageIndex - 1) : undefined);
    if (isContinuation && !relatedPractice) throw new Error(`Think 跨页内容 ${imageIndex} 找不到前页音频题`);
    return {
      imageIndex,
      imageUrl,
      pageNumber,
      pageLabel: practice.pageLabel ?? `第 ${pageNumber} 页`,
      sectionTitle,
      tracks,
      practiceIndex: relatedPractice?.index ?? null,
    };
  });

  const chapters: ThinkReaderChapter[] = catalog.map(({ name, page }) => ({
    name, imageIndex: page, pageIndex: page,
  }));

  return {
    book: bundle.book,
    sourcePageCount: bundle.practices.length,
    pages,
    chapters,
  };
};

/** Think 和普通教材共用全页训练模型，避免两套页号与封面规则。 */
export const buildThinkPracticeBundle = (reader: ThinkBookReader): BookPracticeBundle => {
  const bundle = buildFullBookPracticeBundle(reader.book.id);
  if (!bundle) throw new Error(`Think 教材 ${reader.book.id} 找不到全页训练数据`);
  return bundle;
};

/** 路由参数采用从 0 开始的源图片索引。 */
export const parseThinkReaderPage = (raw: unknown, pageCount: number): number | null => {
  if (!Number.isSafeInteger(pageCount) || pageCount <= 0) return null;
  const index = typeof raw === "string" && /^(?:0|[1-9]\d*)$/.test(raw)
    ? Number(raw)
    : raw;
  return typeof index === "number" && Number.isSafeInteger(index) &&
    index >= 0 && index < pageCount
    ? index
    : null;
};

/** 新旧分享链接均按原图片索引打开同一页。 */
export const resolveThinkReaderPage = (raw: unknown, reader: ThinkBookReader): number | null => {
  const imageIndex = parseThinkReaderPage(raw, reader.sourcePageCount);
  if (imageIndex === null || reader.pages.length === 0) return null;
  const nextPage = reader.pages.findIndex((page) => page.imageIndex >= imageIndex);
  return nextPage >= 0 ? nextPage : reader.pages.length - 1;
};
