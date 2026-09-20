import { PropsWithChildren } from "react";
import Taro, { useLaunch } from "@tarojs/taro";
import { CLOUD_ENV_ID, initCloudHosting } from "@/cloud";

import "taro-ui/dist/style/index.scss"; // 全局引入一次即可
import "@taroify/icons/index.scss";
import "@taroify/core/index.scss";
import "./app.scss";

export { CLOUD_ENV_ID };

function App({ children }: PropsWithChildren<any>) {
  useLaunch(() => {
    // 全局配置覆盖示范听音和录音回听，避免 iOS 静音模式下播放无声。
    void Taro.setInnerAudioOption({ obeyMuteSwitch: false }).catch((error) => {
      console.warn("全局音频配置失败", error);
    });
    // 闸门页会立刻请求云托管，启动时先固定云环境，避免打到开发者工具当前环境。
    initCloudHosting();
  });

  // children 是将要会渲染的页面
  return children;
}

export default App;
