import { Button, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import AppIcon from "@/components/AppIcon/AppIcon";
import { calculateHomeNavigationMetrics } from "@/features/bookLibrary/homeNavigation";
import { useDeviceLayout } from "@/hooks/useDeviceLayout";
import "./CheckInNavigation.scss";

type CheckInNavigationProps = {
  onBack: () => void;
};

export default function CheckInNavigation({ onBack }: CheckInNavigationProps) {
  const layout = useDeviceLayout();
  const metrics = calculateHomeNavigationMetrics(
    layout.windowWidth,
    layout.statusBarHeight,
    Taro.getMenuButtonBoundingClientRect(),
  );

  return (
    <View
      className='check-in-navigation'
      style={{ paddingTop: `${metrics.statusBarHeight}px` }}
    >
      <View
        className='check-in-navigation__main'
        style={{
          height: `${metrics.navigationHeight}px`,
          paddingRight: `${metrics.capsuleReserve}px`,
        }}
      >
        <Button
          className='check-in-navigation__back device-touch-target'
          aria-label='返回上一页'
          onClick={onBack}
        >
          <AppIcon value='chevron-left' size={24} color='#173f34' />
        </Button>
        <Text className='check-in-navigation__title'>跟读打卡</Text>
        <Button
          className='check-in-detail__home check-in-navigation__home device-touch-target'
          aria-label='返回首页'
          onClick={() => Taro.reLaunch({ url: "/pages/Home/Home" })}
        >
          <AppIcon value='home' size={22} color='#173f34' />
        </Button>
      </View>
    </View>
  );
}
