import { PropsWithChildren } from "react";
import Taro, { useLaunch } from "@tarojs/taro";
import { CLOUD_ENV_ID, initCloudHosting } from "@/cloud";
import { resumeUnfinishedRecordingOnLaunch } from "@/features/listeningPractice/recordingSessionRecovery";
import { shouldUseOhOsWebAudio } from "@/features/listeningPractice/audioRuntime";

import "taro-ui/dist/style/index.scss"; // 全局引入一次即可
import "@taroify/icons/index.scss";
import "@taroify/core/index.scss";
import "./app.scss";

export { CLOUD_ENV_ID };

function App({ children }: PropsWithChildren<any>) {
  useLaunch(() => {
    resumeUnfinishedRecordingOnLaunch();
    // 此设置用于 iOS 静音开关；微信的 WebAudio 驱动与 setInnerAudioOption 不兼容。
    if (!shouldUseOhOsWebAudio()) {
      void Taro.setInnerAudioOption({ obeyMuteSwitch: false }).catch((error) => {
        const errMsg = typeof error === "object" && error !== null && "errMsg" in error
          ? String((error as { errMsg?: unknown }).errMsg ?? "")
          : "";
        if (errMsg.includes("开发者工具暂不支持此 API")) return;
        console.warn("全局音频配置失败", error);
      });
    }
    // 闸门页会立刻请求云托管，启动时先固定云环境，避免打到开发者工具当前环境。
    initCloudHosting();
  });

  // children 是将要会渲染的页面
  return children;
}

export default App;
