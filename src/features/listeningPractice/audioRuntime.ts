/** Mate 80 鸿蒙微信的原生播放器接受倍速属性却仍以 1× 播放；所有报告 ohos 的设备（含 Pad）使用 WebAudio。 */
export const shouldUseOhOsWebAudio = () => {
  if (typeof wx === "undefined") return false;
  try {
    const native = wx as typeof wx & { getDeviceInfo?: () => { platform?: string } };
    let platform: string | undefined;
    try { platform = native.getDeviceInfo?.().platform; } catch (_error) { /* use legacy API */ }
    return (platform || wx.getSystemInfoSync().platform) === "ohos";
  } catch (_error) {
    return false;
  }
};
