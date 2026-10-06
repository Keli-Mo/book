type ImageIndexedPage = { imageIndex: number };

// 只收录逐张核验为无内容空白页、且没有音频或练习内容的图片索引。
const HIDDEN_PAGE_INDEXES: Readonly<Record<string, readonly number[]>> = {
  "9": [2, 188],
  "10": [76],
  "11": [168, 170, 172, 174, 176, 180, 182, 188, 190, 192],
  "12": [118, 120, 122, 124, 126],
  "13": [2, 106, 108, 110],
  "14": [58, 60, 62, 64],
};

export const isBookPageVisible = (
  bookId: string,
  imageIndex: number,
): boolean => !HIDDEN_PAGE_INDEXES[bookId]?.includes(imageIndex);

/**
 * 旧链接或阅读进度若指向已移除的空白页，优先落到下一张内容页；
 * 末尾空白页则回到上一张内容页。其他无效索引仍返回 -1。
 */
export const findVisibleBookPageIndex = <T extends ImageIndexedPage>(
  bookId: string,
  practices: readonly T[],
  requestedImageIndex: number,
): number => {
  const exactIndex = practices.findIndex(
    (practice) => practice.imageIndex === requestedImageIndex,
  );
  if (exactIndex >= 0) return exactIndex;
  if (isBookPageVisible(bookId, requestedImageIndex)) return -1;

  const nextIndex = practices.findIndex(
    (practice) => practice.imageIndex > requestedImageIndex,
  );
  return nextIndex >= 0 ? nextIndex : practices.length - 1;
};
