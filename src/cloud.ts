export const CLOUD_ENV_ID = "cloud1-6geu18jg425a604e";

type CloudClient = {
  init?: (options: { env: string; traceUser?: boolean }) => void;
};

export const initCloudHosting = () => {
  if (typeof wx === "undefined" || !wx.cloud) return undefined;
  const cloud = wx.cloud as WxCloud & CloudClient;
  cloud.init?.({ env: CLOUD_ENV_ID, traceUser: true });
  return cloud;
};
