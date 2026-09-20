import { Text, View } from "@tarojs/components";
import Taro, { useLoad } from "@tarojs/taro";
import { useRef } from "react";
import { buildDeviceLayoutClassName } from "@/features/layout/deviceLayout";
import { useDeviceLayout } from "@/hooks/useDeviceLayout";
import {
  fetchAppEntryMode,
  HOME_FALLBACK_URL,
  resolveLaunchUrl,
} from "@/services/appEntry";

import "./Launch.scss";

export default function Launch() {
  const layoutClassName = buildDeviceLayoutClassName({
    ...useDeviceLayout(),
    isSplit: false,
  });
  const startedRef = useRef(false);

  useLoad(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    void (async () => {
      try {
        const response = await fetchAppEntryMode();
        const url = resolveLaunchUrl(response.mode);
        console.log("[app-entry] launch", JSON.stringify({ mode: response.mode, url }));
        await Taro.reLaunch({ url });
      } catch (error) {
        console.log(
          "[app-entry] error",
          error instanceof Error ? error.message : String(error),
        );
        await Taro.reLaunch({ url: HOME_FALLBACK_URL });
      }
    })();
  });

  return (
    <View className={`launch-screen ${layoutClassName}`}>
      <Text className='launch-screen__status'>正在进入…</Text>
    </View>
  );
}
