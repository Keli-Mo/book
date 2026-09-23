import { Button, Text, View } from "@tarojs/components";
import Taro, { useRouter } from "@tarojs/taro";
import { useMemo } from "react";
import { buildDeviceLayoutClassName } from "@/features/layout/deviceLayout";
import { buildBookPracticeBundle } from "@/features/listeningPractice/bookPractice";
import { useAppEntryIntroGuard } from "@/hooks/useAppEntryIntroGuard";
import { useDeviceLayout } from "@/hooks/useDeviceLayout";
import CheckInNavigation from "../CheckInDetail/CheckInNavigation";
import { PracticeSession } from "./PracticeSession";
import "./Practice.scss";

export default function Practice() {
  useAppEntryIntroGuard();
  const layout = useDeviceLayout();
  const layoutClassName = buildDeviceLayoutClassName(layout);
  const router = useRouter();
  const bookId = router.params?.bookId;
  const rawPracticeIndex = router.params?.practice;
  const route = useMemo(() => {
    try {
      if (typeof bookId !== "string" || !bookId) {
        throw new Error("训练链接缺少教材，请重新选择教材");
      }
      // 只接受明确的十进制整数；缺失、负数或越界都不能悄悄落到首尾页。
      if (typeof rawPracticeIndex !== "string" || !/^(?:0|[1-9]\d*)$/.test(rawPracticeIndex)) {
        throw new Error("训练编号无效，请重新选择教材");
      }
      const practiceIndex = Number(rawPracticeIndex);
      const bundle = buildBookPracticeBundle(bookId);
      if (!bundle) throw new Error("找不到这本教材，请重新选择教材");
      if (!Number.isSafeInteger(practiceIndex) || practiceIndex >= bundle.practices.length) {
        throw new Error("训练编号超出本书范围，请重新选择教材");
      }
      return { bundle, practiceIndex, practice: bundle.practices[practiceIndex] };
    } catch (error) {
      return {
        bundle: null,
        errorMessage: error instanceof Error ? error.message : "教材暂时无法读取，请重新选择教材",
      };
    }
  }, [bookId, rawPracticeIndex]);

  const goBack = () => {
    const pages = Taro.getCurrentPages?.() ?? [];
    return pages.length > 1
      ? Taro.navigateBack({ delta: 1 })
      : Taro.reLaunch({ url: "/pages/Home/Home" });
  };

  return (
    <View className={`practice-screen ${layoutClassName}`}>
      <CheckInNavigation title='听力跟读训练' onBack={goBack} />
      {route.bundle ? (
        // 验证通过才挂载会话；换书或外部训练路由时先清理旧会话，保持 Hook 顺序稳定。
        <PracticeSession
          key={`${route.bundle.book.id}:${route.practiceIndex}`}
          bundle={route.bundle}
          initialPracticeIndex={route.practiceIndex}
          initialPractice={route.practice}
          layout={layout}
          layoutClassName={layoutClassName}
        />
      ) : (
        <View className={`practice-empty device-layout__content ${layoutClassName}`}>
          <Text>暂时无法打开训练</Text>
          <Text>{route.errorMessage}</Text>
          <Button
            className='practice-empty__button device-touch-target'
            onClick={() => Taro.redirectTo({ url: "/pages/BookLibrary/BookLibrary" })}
          >
            选择教材
          </Button>
        </View>
      )}
    </View>
  );
}
