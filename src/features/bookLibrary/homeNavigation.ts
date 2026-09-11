export type MenuButtonRect = {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
};

export type HomeNavigationMetrics = {
  statusBarHeight: number;
  navigationHeight: number;
  capsuleReserve: number;
};

/**
 * 微信胶囊在 iOS、Android 和不同模拟器上的位置并不固定，导航栏必须按实时尺寸留位。
 */
export const calculateHomeNavigationMetrics = (
  windowWidth: number,
  statusBarHeight: number,
  menuButton?: MenuButtonRect,
): HomeNavigationMetrics => {
  const safeStatusBarHeight =
    Number.isFinite(statusBarHeight) && statusBarHeight > 0
      ? statusBarHeight
      : 20;
  const hasValidWindow = Number.isFinite(windowWidth) && windowWidth > 0;
  const hasValidMenu =
    menuButton !== undefined &&
    [
      menuButton.top,
      menuButton.bottom,
      menuButton.left,
      menuButton.right,
      menuButton.width,
      menuButton.height,
    ].every((value) => Number.isFinite(value) && value > 0) &&
    menuButton.top >= safeStatusBarHeight &&
    menuButton.top < menuButton.bottom &&
    menuButton.left < menuButton.right &&
    menuButton.right <= windowWidth;

  // 任一关键几何值失真时统一回退，避免 NaN 继续污染页面样式。
  if (!hasValidWindow || !hasValidMenu || safeStatusBarHeight !== statusBarHeight) {
    return {
      statusBarHeight: safeStatusBarHeight,
      navigationHeight: 44,
      capsuleReserve: 96,
    };
  }

  const menuHeight = Math.max(menuButton.height, 32);
  const verticalGap = Math.max(menuButton.top - safeStatusBarHeight, 4);

  return {
    statusBarHeight: safeStatusBarHeight,
    navigationHeight: menuHeight + verticalGap * 2,
    capsuleReserve: Math.max(windowWidth - menuButton.left + 8, 96),
  };
};
