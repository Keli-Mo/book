import Taro from "@tarojs/taro";
import { useEffect, useState } from "react";

import {
  calculateDeviceLayout,
  DeviceLayoutInput,
  DeviceLayoutProfile,
} from "../features/layout/deviceLayout";

type RuntimeWindowInfo = Taro.getWindowInfo.Result & {
  deviceType?: unknown;
};

type ResizeSize = {
  windowWidth: number;
  windowHeight: number;
};

type WindowResizeEvent =
  | Taro.onWindowResize.CallbackResult
  | TaroGeneral.CallbackResult;

export type DeviceLayoutState = Readonly<
  DeviceLayoutProfile & {
    windowWidth: number;
    windowHeight: number;
  }
>;

const toFiniteWindowSize = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

const buildDeviceLayout = (
  windowInfo: Partial<RuntimeWindowInfo>,
  resizeSize?: ResizeSize,
): DeviceLayoutState => {
  const windowWidth = toFiniteWindowSize(
    resizeSize?.windowWidth ?? windowInfo.windowWidth,
  );
  const windowHeight = toFiniteWindowSize(
    resizeSize?.windowHeight ?? windowInfo.windowHeight,
  );
  const input: DeviceLayoutInput = {
    windowWidth,
    windowHeight,
    screenWidth: windowInfo.screenWidth as number,
    screenHeight: windowInfo.screenHeight as number,
    statusBarHeight: windowInfo.statusBarHeight,
    safeArea: windowInfo.safeArea,
    deviceType: windowInfo.deviceType === "pad" ? "pad" : undefined,
  };

  return {
    ...calculateDeviceLayout(input),
    windowWidth,
    windowHeight,
  };
};

const readDeviceLayout = (resizeSize?: ResizeSize): DeviceLayoutState => {
  try {
    return buildDeviceLayout(Taro.getWindowInfo() as RuntimeWindowInfo, resizeSize);
  } catch (_error) {
    // 运行时 API 异常时保守降级，避免布局读取导致页面白屏。
    return buildDeviceLayout({}, resizeSize);
  }
};

export const useDeviceLayout = (): DeviceLayoutState => {
  const [layout, setLayout] = useState<DeviceLayoutState>(() => readDeviceLayout());

  useEffect(() => {
    const handleResize = (event: WindowResizeEvent) => {
      const size = "size" in event ? event.size : undefined;
      setLayout(readDeviceLayout(size));
    };

    // 非微信测试壳或旧运行时可能没有窗口订阅 API，保留初始化布局即可。
    if (typeof Taro.onWindowResize !== "function") return undefined;
    Taro.onWindowResize(handleResize);
    return () => {
      if (typeof Taro.offWindowResize === "function") {
        Taro.offWindowResize(handleResize);
      }
    };
  }, []);

  return layout;
};
