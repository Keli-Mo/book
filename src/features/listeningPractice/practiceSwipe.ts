export const PAGE_TURN_DURATION_MS = 300;
export const PRACTICE_SLIDE_PREFETCH_RADIUS = 2;
export const MAX_RETAINED_PRACTICE_SLIDES = 24;

/** 当前页与两侧预加载，避免滑到空白再补图。 */
export const shouldRenderPracticeSlideImage = (
  index: number,
  currentIndex: number,
  radius = PRACTICE_SLIDE_PREFETCH_RADIUS,
): boolean => {
  if (!Number.isInteger(index) || !Number.isInteger(currentIndex)) return false;
  const window = Number.isFinite(radius) && radius >= 0 ? radius : PRACTICE_SLIDE_PREFETCH_RADIUS;
  return Math.abs(index - currentIndex) <= window;
};

/** 已加载过的页保持 Image 节点，避免翻回去再打一次网络。 */
export const retainPracticeSlideIndexes = (
  previous: Iterable<number>,
  currentIndex: number,
  total: number,
  radius = PRACTICE_SLIDE_PREFETCH_RADIUS,
  maxRetained = MAX_RETAINED_PRACTICE_SLIDES,
): number[] => {
  if (!Number.isInteger(currentIndex) || !Number.isInteger(total) || total <= 0) return [];
  const next = new Set<number>();
  const add = (index: number) => {
    if (Number.isInteger(index) && index >= 0 && index < total) next.add(index);
  };
  for (const index of previous) add(index);
  const window = Number.isFinite(radius) && radius >= 0 ? radius : PRACTICE_SLIDE_PREFETCH_RADIUS;
  for (let index = currentIndex - window; index <= currentIndex + window; index += 1) {
    add(index);
  }
  const limit =
    Number.isFinite(maxRetained) && maxRetained > 0 ? maxRetained : MAX_RETAINED_PRACTICE_SLIDES;
  if (next.size <= limit) {
    return [...next].sort((left, right) => left - right);
  }
  return [...next]
    .sort(
      (left, right) =>
        Math.abs(left - currentIndex) - Math.abs(right - currentIndex) || left - right,
    )
    .slice(0, limit)
    .sort((left, right) => left - right);
};

type SwiperChangeDetail = {
  current?: number;
  source?: string;
};

/** 手指翻页才会提交训练；程序改 current（目录/按钮）走另一条路径。 */
export const isPracticeSwiperTouchChange = (detail: SwiperChangeDetail | null | undefined): boolean =>
  Boolean(detail && Number.isInteger(detail.current) && detail.source === "touch");
