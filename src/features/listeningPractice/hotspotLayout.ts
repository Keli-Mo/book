export type HotspotCenter = {
  left: number;
  top: number;
};

export type HotspotImageSize = {
  width: number;
  height: number;
};

const DEFAULT_HIT_RADIUS_PX = 22;

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
  leftShiftPx = 0,
): HotspotCenter => {
  const safeRadius =
    Number.isFinite(hitRadiusPx) && hitRadiusPx >= 0
      ? hitRadiusPx
      : DEFAULT_HIT_RADIUS_PX;
  const leftShiftPercent = Number.isFinite(leftShiftPx) && imageSize.width > 0
    ? (Math.max(0, leftShiftPx) * 100) / imageSize.width
    : 0;

  // 两个轴独立收敛，单轴尺寸异常不影响另一轴的合法百分比。
  return {
    left: clampAxis(point.left - leftShiftPercent, imageSize.width, safeRadius),
    top: clampAxis(point.top, imageSize.height, safeRadius),
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
