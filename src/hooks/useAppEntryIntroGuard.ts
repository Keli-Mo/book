import Taro, { useDidShow } from "@tarojs/taro";
import { redirectToIntroIfNeeded } from "@/services/appEntry";

/** 热启动停在子页时补一次入口校验；intro 才跳走，否则保持当前页。 */
export function useAppEntryIntroGuard() {
  useDidShow(() => {
    void redirectToIntroIfNeeded((url) => Taro.reLaunch({ url }));
  });
}
