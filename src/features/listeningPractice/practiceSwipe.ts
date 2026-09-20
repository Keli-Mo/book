export const PAGE_TURN_DURATION_MS = 300;
export const PRACTICE_SLIDE_PREFETCH_RADIUS = 2;

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

type SwiperChangeDetail = {
  current?: number;
  source?: string;
};

/** 手指翻页才会提交训练；程序改 current（目录/按钮）走另一条路径。 */
export const isPracticeSwiperTouchChange = (detail: SwiperChangeDetail | null | undefined): boolean =>
  Boolean(detail && Number.isInteger(detail.current) && detail.source === "touch");
