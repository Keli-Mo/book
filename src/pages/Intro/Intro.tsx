import { Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { calculateHomeNavigationMetrics } from "@/features/bookLibrary/homeNavigation";
import { buildDeviceLayoutClassName } from "@/features/layout/deviceLayout";
import { useDeviceLayout } from "@/hooks/useDeviceLayout";

import "./Intro.scss";

const TEACHER_POINTS = [
  "教师团队具有考官资质",
  "小班教学，有单独学习群，助教随时答疑/批改作业",
  "正课以外配套定期线上复习课，减轻家长辅导负担",
  "贴心的口语配对服务，每一对口语伙伴单独的考前辅导",
] as const;

const SYSTEM_POINTS = [
  "教学接轨国际同时也能把握应试技巧，能提高素质的同时也能精准分析及把握各类标化考试考点。",
  "每周集中进行教研讨论，不断提升，教学质量一直稳定优秀。",
  "提供独特「陪读」服务，课后助教跟进，最大程度减轻家长辅导的压力。",
  "机构长期积累各种真题，把握各类考试最新政策。",
] as const;

export default function Intro() {
  const layout = useDeviceLayout();
  const layoutClassName = buildDeviceLayoutClassName({
    ...layout,
    isSplit: false,
  });
  let menuButton;
  try {
    menuButton = Taro.getMenuButtonBoundingClientRect?.();
  } catch (_error) {
    menuButton = undefined;
  }
  const metrics = calculateHomeNavigationMetrics(
    layout.windowWidth,
    layout.statusBarHeight,
    menuButton,
  );

  return (
    <View className={`intro-screen ${layoutClassName}`}>
      <View
        className='intro-screen__navigation'
        style={{ paddingTop: `${metrics.statusBarHeight}px` }}
      >
        <View
          className='intro-screen__navigation-main'
          style={{
            height: `${metrics.navigationHeight}px`,
            paddingRight: `${metrics.capsuleReserve}px`,
          }}
        >
          <Text className='intro-screen__title'>海沙牛娃</Text>
        </View>
      </View>

      <View className='intro-screen__content device-layout__content'>
        <View className='intro-article'>
          <View className='intro-article__header'>
            <View className='intro-article__brand'>
              <View className='intro-article__dot' />
              <Text>CASA海沙</Text>
            </View>
            <Text className='intro-article__label'>Introduction</Text>
            <Text className='intro-article__quote'>“</Text>
          </View>

          <Text className='intro-article__lead'>
            我们专注做英语教培课程，小龄段的启蒙、KPF、小学初中校内英语、MK，以及针对出国留学的托福、雅思、SAT 和入学考均有涵盖。以素质培养为主，同时有很强的应试课程，素质应试双兼顾。
          </Text>

          <Text className='intro-article__heading'>
            一、海沙老师拥有多年教学经验及沉淀，在师资等方面都有优势：
          </Text>
          {TEACHER_POINTS.map((point, index) => (
            <Text className='intro-article__item' key={point}>
              {`(${index + 1}) ${point}`}
            </Text>
          ))}

          <Text className='intro-article__heading'>
            二、教学体系兼顾素质及应试
          </Text>
          {SYSTEM_POINTS.map((point, index) => (
            <Text className='intro-article__item' key={point}>
              {`(${index + 1}) ${point}`}
            </Text>
          ))}
        </View>

        <View className='intro-footer'>
          <Text className='intro-footer__mark'>CASA</Text>
          <Text className='intro-footer__name'>海　沙</Text>
        </View>
      </View>
    </View>
  );
}
