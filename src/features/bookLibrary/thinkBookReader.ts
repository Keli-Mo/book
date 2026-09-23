import type { BookCatalogItem } from "@/features/bookLibrary/bookCatalog";
import {
  buildBookPracticeBundle,
  type ListeningPractice,
  type PracticeTrack,
} from "@/features/listeningPractice/bookPractice";
import { catalogLists } from "@/pages/BookDetail/Components/BookPreview/constants/catalogList";
import { concatImages } from "@/pages/BookDetail/Components/BookPreview/constants/images";

export type ThinkBookId = "26" | "27";

export type ThinkReaderChapter = {
  name: string;
  imageIndex: number;
  pageIndex: number;
};

export type ThinkReaderPage = {
  imageIndex: number;
  imageUrl: string;
  pageLabel: string;
  sectionTitle: string;
  tracks: PracticeTrack[];
  /** 当前音频题，或本页承接的上一页音频题，在跟读列表中的位置。 */
  practiceIndex: number;
};

export type ThinkBookReader = {
  book: BookCatalogItem;
  sourcePageCount: number;
  pages: ThinkReaderPage[];
  chapters: ThinkReaderChapter[];
};

const isThinkBookId = (bookId: string): bookId is ThinkBookId =>
  bookId === "26" || bookId === "27";

/** 这些学生书页面承接前一页的听读正文或理解题，本页没有独立音轨标记。 */
const STUDENT_CONTINUATION_PAGES = new Set([
  13, 21, 27, 31, 39, 45, 49, 57, 63,
  67, 75, 81, 85, 93, 99, 103, 111, 117,
]);

/** Think 1 阅读器仅展示音频题及其跨页内容。 */
export const buildThinkBookReader = (bookId: string): ThinkBookReader | null => {
  if (!isThinkBookId(bookId)) return null;

  const bundle = buildBookPracticeBundle(bookId);
  if (!bundle) return null;

  const imageUrls = concatImages[bookId];
  const catalog = catalogLists[bookId];
  const practiceByPage = new Map<number, {
    practice: ListeningPractice;
    index: number;
  }>();
  bundle.practices.forEach((practice, index) => {
    practiceByPage.set(practice.imageIndex, { practice, index });
  });

  let sectionIndex = 0;
  let sectionTitle = "课程导入";
  const pages: ThinkReaderPage[] = [];
  imageUrls.forEach((imageUrl, imageIndex) => {
    while (sectionIndex < catalog.length && catalog[sectionIndex].page <= imageIndex) {
      sectionTitle = catalog[sectionIndex].name;
      sectionIndex += 1;
    }
    const indexedPractice = practiceByPage.get(imageIndex);
    const isContinuation = bookId === "26" && STUDENT_CONTINUATION_PAGES.has(imageIndex);
    if (!indexedPractice && !isContinuation) return;
    const relatedPractice = indexedPractice ?? practiceByPage.get(imageIndex - 1);
    if (!relatedPractice) throw new Error(`Think 1 跨页内容 ${imageIndex} 找不到前页音频题`);
    const printedPage = bookId === "27" ? imageIndex + 3 : imageIndex;
    pages.push({
      imageIndex,
      imageUrl,
      pageLabel: `第 ${printedPage} 页`,
      sectionTitle,
      tracks: indexedPractice?.practice.tracks ?? [],
      practiceIndex: relatedPractice.index,
    });
  });

  const chapters: ThinkReaderChapter[] = [];
  catalog.forEach(({ name, page }, catalogIndex) => {
    const nextSection = catalog[catalogIndex + 1]?.page ?? imageUrls.length;
    const pageIndex = pages.findIndex((readerPage) =>
      readerPage.imageIndex >= page && readerPage.imageIndex < nextSection,
    );
    if (pageIndex >= 0) {
      chapters.push({ name, imageIndex: pages[pageIndex].imageIndex, pageIndex });
    }
  });

  return {
    book: bundle.book,
    sourcePageCount: imageUrls.length,
    pages,
    chapters,
  };
};

/** 路由参数采用筛选后从 0 开始的阅读页索引。 */
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

/** 旧分享链接使用原 PDF 图片索引；被筛掉的页面跳到下一张保留页。 */
export const resolveThinkReaderPage = (raw: unknown, reader: ThinkBookReader): number | null => {
  const imageIndex = parseThinkReaderPage(raw, reader.sourcePageCount);
  if (imageIndex === null || reader.pages.length === 0) return null;
  const nextPage = reader.pages.findIndex((page) => page.imageIndex >= imageIndex);
  return nextPage >= 0 ? nextPage : reader.pages.length - 1;
};
