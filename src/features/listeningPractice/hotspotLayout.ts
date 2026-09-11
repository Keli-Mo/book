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
): HotspotCenter => {
  const safeRadius =
    Number.isFinite(hitRadiusPx) && hitRadiusPx >= 0
      ? hitRadiusPx
      : DEFAULT_HIT_RADIUS_PX;

  // 两个轴独立收敛，单轴尺寸异常不影响另一轴的合法百分比。
  return {
    left: clampAxis(point.left, imageSize.width, safeRadius),
    top: clampAxis(point.top, imageSize.height, safeRadius),
  };
};
