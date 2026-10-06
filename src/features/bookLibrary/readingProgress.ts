import Taro from "@tarojs/taro";
import {
  buildBookPracticeBundle,
  buildFullBookPracticeBundle,
  type ListeningPractice,
} from "@/features/listeningPractice/bookPractice";

export type LegacyReadingProgress = {
  version: 1;
  bookId: string;
  practiceIndex: number;
};

export type FullReadingProgress = {
  version: 2;
  bookId: string;
  imageIndex: number;
};

export type ReadingProgress = LegacyReadingProgress | FullReadingProgress;

// 沿用存储键，按 payload.version 区分；读取旧进度不改写历史位置。
export const READING_PROGRESS_KEY = "haisha:reading-progress:v1";

const resolveProgress = (value: unknown) => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    (candidate.version !== 1 && candidate.version !== 2) ||
    typeof candidate.bookId !== "string"
  ) return null;

  try {
    const index = candidate.version === 1 ? candidate.practiceIndex : candidate.imageIndex;
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) return null;
    const bundle = candidate.version === 1
      ? buildBookPracticeBundle(candidate.bookId)
      : buildFullBookPracticeBundle(candidate.bookId);
    if (!bundle) return null;
    const indexedPractice = candidate.version === 1
      ? bundle.practices[index]
      : bundle.practices.find((item) => item.imageIndex === index);
    if (!indexedPractice) return null;
    const practice = candidate.version === 1
      ? buildFullBookPracticeBundle(candidate.bookId)?.practices.find((item) => item.id === indexedPractice.id)
      : indexedPractice;
    if (!practice) return null;
    const progress: ReadingProgress = candidate.version === 1
      ? { version: 1, bookId: candidate.bookId, practiceIndex: index }
      : { version: 2, bookId: candidate.bookId, imageIndex: index };
    return { progress, practice, isThink: bundle.book.seriesId === "think" };
  } catch (_error) {
    return null;
  }
};

export function readReadingProgress(): ReadingProgress | null {
  try {
    return resolveProgress(Taro.getStorageSync(READING_PROGRESS_KEY))?.progress ?? null;
  } catch (_error) {
    return null;
  }
}

const saveProgress = (value: ReadingProgress): boolean => {
  const progress = resolveProgress(value)?.progress;
  if (!progress) return false;
  try {
    Taro.setStorageSync(READING_PROGRESS_KEY, progress);
    return true;
  } catch (_error) {
    return false;
  }
};

/** 保留旧调用语义：practiceIndex 始终指向原音频训练列表。 */
export function saveReadingProgress(bookId: string, practiceIndex: number): boolean {
  return saveProgress({ version: 1, bookId, practiceIndex });
}

export function saveFullReadingProgress(bookId: string, imageIndex: number): boolean {
  return saveProgress({ version: 2, bookId, imageIndex });
}

export function resolveReadingProgressPractice(progress: ReadingProgress): ListeningPractice | null {
  return resolveProgress(progress)?.practice ?? null;
}

/** 旧进度保留音频索引含义；全页进度及 Think 路由使用原图片索引。 */
export function resolveReadingProgressUrl(progress: ReadingProgress): string | null {
  const resolved = resolveProgress(progress);
  if (!resolved) return null;
  const bookId = encodeURIComponent(resolved.progress.bookId);
  if (resolved.isThink) {
    return `/pages/ThinkBookReader/ThinkBookReader?bookId=${bookId}&page=${resolved.practice.imageIndex}`;
  }
  return resolved.progress.version === 1
    ? `/pages/Practice/Practice?bookId=${bookId}&practice=${resolved.progress.practiceIndex}`
    : `/pages/Practice/Practice?bookId=${bookId}&page=${resolved.practice.imageIndex}`;
}
