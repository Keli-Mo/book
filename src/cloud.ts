export const CLOUD_ENV_ID = "cloud1-6geu18jg425a604e";
/** 微信云托管控制台环境 prod 的环境 ID。 */
export const CLOUD_RUN_ENV_ID = "prod-d0gxpzolg8a06fa69";

type CloudClient = {
  init?: (options?: { env?: string; traceUser?: boolean }) => void;
  callContainer?: (options: {
    config: { env: string };
    path: string;
    method: string;
    header: Record<string, string>;
  }) => Promise<unknown>;
};

export const initCloudHosting = () => {
  if (typeof wx === "undefined" || !wx.cloud) return undefined;
  const cloud = wx.cloud as WxCloud & CloudClient;
  // 与官方云托管示例一致：init 不钉死云开发 ID，callContainer.config.env 才指向托管环境。
  cloud.init?.({ traceUser: true });
  return cloud;
};
