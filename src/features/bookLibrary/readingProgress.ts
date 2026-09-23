import Taro from "@tarojs/taro";
import { buildBookPracticeBundle } from "@/features/listeningPractice/bookPractice";

export type ReadingProgress = {
  version: 1;
  bookId: string;
  practiceIndex: number;
};

export const READING_PROGRESS_KEY = "haisha:reading-progress:v1";

const validateReadingProgress = (value: unknown): ReadingProgress | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ReadingProgress>;
  if (
    candidate.version !== 1 ||
    typeof candidate.bookId !== "string" ||
    !Number.isSafeInteger(candidate.practiceIndex) ||
    (candidate.practiceIndex as number) < 0
  ) return null;

  try {
    const bundle = buildBookPracticeBundle(candidate.bookId);
    if (!bundle || (candidate.practiceIndex as number) >= bundle.practices.length) return null;
  } catch (_error) {
    return null;
  }

  return {
    version: 1,
    bookId: candidate.bookId,
    practiceIndex: candidate.practiceIndex as number,
  };
};

export function readReadingProgress(): ReadingProgress | null {
  try {
    return validateReadingProgress(Taro.getStorageSync(READING_PROGRESS_KEY));
  } catch (_error) {
    return null;
  }
}

export function saveReadingProgress(bookId: string, practiceIndex: number): boolean {
  const progress = validateReadingProgress({ version: 1, bookId, practiceIndex });
  if (!progress) return false;
  try {
    Taro.setStorageSync(READING_PROGRESS_KEY, progress);
    return true;
  } catch (_error) {
    return false;
  }
}

/** 历史进度始终使用原音频训练索引；Think 阅读器入口使用对应的 PDF 图片索引。 */
export function resolveReadingProgressUrl(progress: ReadingProgress): string | null {
  const valid = validateReadingProgress(progress);
  if (!valid) return null;

  try {
    const bundle = buildBookPracticeBundle(valid.bookId);
    const practice = bundle?.practices[valid.practiceIndex];
    if (!bundle || !practice) return null;
    const bookId = encodeURIComponent(valid.bookId);
    return bundle.book.seriesId === "think"
      ? `/pages/ThinkBookReader/ThinkBookReader?bookId=${bookId}&page=${practice.imageIndex}`
      : `/pages/Practice/Practice?bookId=${bookId}&practice=${valid.practiceIndex}`;
  } catch (_error) {
    return null;
  }
}
