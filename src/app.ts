import { PropsWithChildren } from "react";
import { useLaunch } from "@tarojs/taro";
import { CLOUD_ENV_ID, initCloudHosting } from "@/cloud";

import "taro-ui/dist/style/index.scss"; // 全局引入一次即可
import "@taroify/icons/index.scss";
import "@taroify/core/index.scss";
import "./app.scss";

export { CLOUD_ENV_ID };

function App({ children }: PropsWithChildren<any>) {
  useLaunch(() => {
    // 闸门页会立刻请求云托管，启动时先固定云环境，避免打到开发者工具当前环境。
    initCloudHosting();
  });

  // children 是将要会渲染的页面
  return children;
}

export default App;
