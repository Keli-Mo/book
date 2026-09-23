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
};

export type ThinkReaderPage = {
  imageIndex: number;
  imageUrl: string;
  pageLabel: string;
  sectionTitle: string;
  tracks: PracticeTrack[];
  /** 该页在已有音频训练列表中的位置；无音频页为 null。 */
  practiceIndex: number | null;
};

export type ThinkBookReader = {
  book: BookCatalogItem;
  pages: ThinkReaderPage[];
  chapters: ThinkReaderChapter[];
};

const isThinkBookId = (bookId: string): bookId is ThinkBookId =>
  bookId === "26" || bookId === "27";

/** 仅为 Think 1 两册构建完整 PDF 页序，并复用训练模型里的音频热点。 */
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
  const pages = imageUrls.map((imageUrl, imageIndex) => {
    while (sectionIndex < catalog.length && catalog[sectionIndex].page <= imageIndex) {
      sectionTitle = catalog[sectionIndex].name;
      sectionIndex += 1;
    }
    const indexedPractice = practiceByPage.get(imageIndex);
    const printedPage = bookId === "27" ? imageIndex + 3 : imageIndex;
    const pageLabel = imageIndex === 0
      ? "封面"
      : bookId === "26" && imageIndex < 4
        ? `前置页 ${imageIndex}`
        : `第 ${printedPage} 页`;
    return {
      imageIndex,
      imageUrl,
      pageLabel,
      sectionTitle,
      tracks: indexedPractice?.practice.tracks ?? [],
      practiceIndex: indexedPractice?.index ?? null,
    };
  });

  return {
    book: bundle.book,
    pages,
    chapters: catalog.map(({ name, page }) => ({ name, imageIndex: page })),
  };
};

/** 路由参数采用从 0 开始的图片索引；非法或越界参数交给页面显示错误。 */
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
