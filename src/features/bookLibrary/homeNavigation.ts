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
  menuButton: MenuButtonRect,
): HomeNavigationMetrics => {
  const safeStatusBarHeight = Math.max(statusBarHeight || 0, 0);
  const menuHeight = Math.max(menuButton.height || 32, 32);
  const verticalGap = Math.max(menuButton.top - safeStatusBarHeight, 4);

  return {
    statusBarHeight: safeStatusBarHeight,
    navigationHeight: menuHeight + verticalGap * 2,
    capsuleReserve: Math.max(windowWidth - menuButton.left + 8, 96),
  };
};
