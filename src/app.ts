import { PropsWithChildren } from "react";
import { useLaunch } from "@tarojs/taro";

import "taro-ui/dist/style/index.scss"; // 全局引入一次即可
import "@taroify/icons/index.scss";
import "@taroify/core/index.scss";
import "./app.scss";

export const CLOUD_ENV_ID = "cloud1-6geu18jg425a604e";

function App({ children }: PropsWithChildren<any>) {
  useLaunch(() => {
    // 固定到用户提供的云环境，避免开发者工具当前环境不同导致录音上传到错误项目。
    if (wx.cloud) {
      wx.cloud.init({ env: CLOUD_ENV_ID, traceUser: true });
    }
  });

  // children 是将要会渲染的页面
  return children;
}

export default App;
