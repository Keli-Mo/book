import AtIcon from "taro-ui/lib/components/icon";

type AppIconProps = {
  value: string;
  color?: string;
  size: number | string;
  className?: string;
};

/** 保留 Taro UI 图标字体，只覆盖会被 pxTransform 放大的字号。 */
export default function AppIcon({ size, ...props }: AppIconProps) {
  return <AtIcon {...props} size={size} customStyle={{ fontSize: `${size}px` }} />;
}
