export type DeviceOrientation = "portrait" | "landscape";

export type DeviceSafeArea = {
  top: number;
  bottom: number;
};

export type DeviceLayoutInput = {
  windowWidth: number;
  windowHeight: number;
  screenWidth: number;
  screenHeight: number;
  statusBarHeight?: number;
  safeArea?: DeviceSafeArea;
  deviceType?: "pad";
};

export type DeviceLayoutProfile = {
  isPad: boolean;
  orientation: DeviceOrientation;
  isSplit: boolean;
  contentMaxWidth: 820 | 1280 | null;
  statusBarHeight: number;
  safeAreaBottom: number;
};

type DeviceLayoutClassProfile = Pick<
  DeviceLayoutProfile,
  "isPad" | "orientation" | "isSplit"
>;

/**
 * 页面只消费互斥的设备 class，避免横屏手机误进 Pad 双栏。
 * Home 等需要固定单栏的页面可在调用前把 isSplit 覆盖为 false。
 */
export const buildDeviceLayoutClassName = (
  profile: DeviceLayoutClassProfile,
): string =>
  [
    "device-layout",
    `device-layout--${profile.orientation}`,
    profile.isPad ? "device-layout--pad" : "device-layout--phone",
    profile.isSplit ? "device-layout--split" : "device-layout--single",
  ].join(" ");

const isPositiveFinite = (value: number): boolean =>
  Number.isFinite(value) && value > 0;

const calculateSafeAreaBottom = ({
  safeArea,
  screenHeight,
}: DeviceLayoutInput): number => {
  if (
    !safeArea ||
    !Number.isFinite(screenHeight) ||
    screenHeight < 0 ||
    !Number.isFinite(safeArea.top) ||
    safeArea.top < 0 ||
    !Number.isFinite(safeArea.bottom) ||
    safeArea.bottom < 0 ||
    safeArea.top > safeArea.bottom ||
    safeArea.bottom > screenHeight
  ) {
    return 0;
  }

  return screenHeight - safeArea.bottom;
};

export const calculateDeviceLayout = (
  input: DeviceLayoutInput,
): DeviceLayoutProfile => {
  const hasValidScreen =
    isPositiveFinite(input.screenWidth) && isPositiveFinite(input.screenHeight);
  // Pad 回退只看固定屏幕短边，避免分屏窗口把手机误判成 Pad。
  const isPad =
    input.deviceType === "pad" ||
    (hasValidScreen && Math.min(input.screenWidth, input.screenHeight) >= 600);
  const hasValidWindow =
    isPositiveFinite(input.windowWidth) && isPositiveFinite(input.windowHeight);
  const orientation: DeviceOrientation =
    hasValidWindow && input.windowWidth > input.windowHeight
      ? "landscape"
      : "portrait";
  // 双栏必须同时满足 Pad、横屏和两个窗口阈值。
  const isSplit =
    isPad &&
    orientation === "landscape" &&
    input.windowWidth >= 960 &&
    input.windowHeight >= 600;

  return {
    isPad,
    orientation,
    isSplit,
    contentMaxWidth: isPad ? (isSplit ? 1280 : 820) : null,
    statusBarHeight: isPositiveFinite(input.statusBarHeight ?? 0)
      ? (input.statusBarHeight as number)
      : 20,
    safeAreaBottom: calculateSafeAreaBottom(input),
  };
};
