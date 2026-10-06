export type HotspotCenter = {
  left: number;
  top: number;
};

export type HotspotImageSize = {
  width: number;
  height: number;
};

const DEFAULT_HIT_RADIUS_PX = 22;
const HOTSPOT_VISUAL_RADIUS_PX = 13;
const DEFAULT_THINK_HOTSPOT_LEFT_SHIFT_PX = 8;
const THINK_HOTSPOT_LEFT_SHIFT_PX_BY_BOOK_ID: Readonly<Record<string, number>> = {
  "26": 22,
};
const CENTER_ANCHORED_HOTSPOT_IDS = new Set([
  "3-84-0",
  "4-140-0",
  "4-164-0",
  "5-134-0",
]);

/**
 * 将各批教材的历史录点语义统一为当前圆钮中心，再叠加已确认的题目避让。
 */
export const resolveHotspotAnchorOffset = (
  bookId: string,
  seriesId: string,
  trackId: string,
) => {
  if (CENTER_ANCHORED_HOTSPOT_IDS.has(trackId)) {
    return { offsetXPx: 0, offsetYPx: 0 };
  }
  const numericBookId = Number.parseInt(bookId, 10);
  if (numericBookId >= 3 && numericBookId <= 25) {
    return { offsetXPx: HOTSPOT_VISUAL_RADIUS_PX, offsetYPx: HOTSPOT_VISUAL_RADIUS_PX };
  }
  if (seriesId === "think") {
    return {
      offsetXPx: -(THINK_HOTSPOT_LEFT_SHIFT_PX_BY_BOOK_ID[bookId] ?? DEFAULT_THINK_HOTSPOT_LEFT_SHIFT_PX),
      offsetYPx: 0,
    };
  }
  return { offsetXPx: 0, offsetYPx: 0 };
};

const clampAxis = (
  value: number,
  imageLength: number,
  hitRadiusPx: number,
): number => {
  if (
    !Number.isFinite(value) ||
    !Number.isFinite(imageLength) ||
    imageLength <= 0
  ) {
    return 50;
  }
  if (hitRadiusPx >= imageLength / 2) return 50;

  const boundary = (hitRadiusPx * 100) / imageLength;
  return Math.min(Math.max(value, boundary), 100 - boundary);
};

export const clampHotspotCenter = (
  point: HotspotCenter,
  imageSize: HotspotImageSize,
  hitRadiusPx = DEFAULT_HIT_RADIUS_PX,
  offsetXPx = 0,
  offsetYPx = 0,
): HotspotCenter => {
  const safeRadius =
    Number.isFinite(hitRadiusPx) && hitRadiusPx >= 0
      ? hitRadiusPx
      : DEFAULT_HIT_RADIUS_PX;
  const offsetXPercent = Number.isFinite(offsetXPx) && imageSize.width > 0
    ? (offsetXPx * 100) / imageSize.width
    : 0;
  const offsetYPercent = Number.isFinite(offsetYPx) && imageSize.height > 0
    ? (offsetYPx * 100) / imageSize.height
    : 0;

  // 两个轴独立收敛，单轴尺寸异常不影响另一轴的合法百分比。
  return {
    left: clampAxis(point.left + offsetXPercent, imageSize.width, safeRadius),
    top: clampAxis(point.top + offsetYPercent, imageSize.height, safeRadius),
  };
};

/** 手机竖屏课文区固定比例，不随单张图片改高度。 */
export const PHONE_BOOK_ASPECT = 3 / 2;

export const fixedPhoneBookSlot = (width: number): HotspotImageSize | null => {
  if (!Number.isFinite(width) || width <= 0) return null;
  return { width, height: Math.round(width * PHONE_BOOK_ASPECT) };
};

export type ContainedImageFrame = HotspotImageSize & {
  left: number;
  top: number;
};

/** 在固定框内完整放下图片并居中，框本身不随图片比例变化。 */
export const containImageInSlot = (
  slot: HotspotImageSize,
  natural: HotspotImageSize,
): ContainedImageFrame | null => {
  const fitted = fitImageToBounds(slot, natural);
  if (!fitted) return null;
  return {
    left: Math.round((slot.width - fitted.width) / 2),
    top: Math.round((slot.height - fitted.height) / 2),
    width: fitted.width,
    height: fitted.height,
  };
};

/** 只按列宽保持教材比例；录音区变高时由页面滚动承接，不再挤小教材。 */
export const fitImageToWidth = (
  width: number,
  natural: HotspotImageSize,
): HotspotImageSize | null => {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(natural.width) ||
    !Number.isFinite(natural.height) ||
    width <= 0 ||
    natural.width <= 0 ||
    natural.height <= 0
  ) {
    return null;
  }

  return {
    width,
    height: Math.round(width * natural.height / natural.width),
  };
};

/** 横屏和 iPad 使用独立的阅读区边界，录音内容不参与边界计算。 */
export const fitImageToBounds = (
  bounds: HotspotImageSize,
  natural: HotspotImageSize,
): HotspotImageSize | null => {
  if ([bounds.width, bounds.height, natural.width, natural.height]
    .some((length) => !Number.isFinite(length) || length <= 0)) return null;

  const scale = Math.min(bounds.width / natural.width, bounds.height / natural.height);
  return {
    width: Math.min(bounds.width, natural.width * scale),
    height: Math.min(bounds.height, natural.height * scale),
  };
};
