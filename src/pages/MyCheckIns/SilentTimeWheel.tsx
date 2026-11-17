import { Button, ScrollView, View } from "@tarojs/components";
import { useEffect, useRef, useState } from "react";

const ROW_HEIGHT = 40;
const SETTLE_DELAY_MS = 140;

interface SilentTimeWheelProps {
  field: "hour" | "minute";
  label: string;
  options: readonly string[];
  value: string;
  disabled?: boolean;
  isOptionDisabled?: (value: string) => boolean;
  onChange: (value: string) => void;
  onMovingChange: (moving: boolean) => void;
}

/** A plain scroll list keeps time selection free of native picker sounds. */
export default function SilentTimeWheel({
  field, label, options, value, disabled = false, isOptionDisabled, onChange, onMovingChange,
}: SilentTimeWheelProps) {
  const initialTop = Math.max(0, options.indexOf(value)) * ROW_HEIGHT;
  const [scrollTop, setScrollTop] = useState(initialTop);
  const positionRef = useRef(initialTop);
  const touchingRef = useRef(false);
  const activeRef = useRef(false);
  const movedRef = useRef(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout>>();
  const snapTimer = useRef<ReturnType<typeof setTimeout>>();
  const latestProps = useRef({ value, isOptionDisabled, onChange, onMovingChange });
  latestProps.current = { value, isOptionDisabled, onChange, onMovingChange };

  const clearTimers = () => {
    clearTimeout(settleTimer.current);
    clearTimeout(snapTimer.current);
  };

  useEffect(() => () => clearTimers(), []);

  useEffect(() => {
    const index = options.indexOf(value);
    if (index < 0) return;
    clearTimers();
    activeRef.current = false;
    touchingRef.current = false;
    movedRef.current = false;
    positionRef.current = index * ROW_HEIGHT;
    setScrollTop(positionRef.current);
    latestProps.current.onMovingChange(false);
  }, [value, options]);

  const snapTo = (index: number) => {
    activeRef.current = false;
    clearTimers();
    const target = index * ROW_HEIGHT;
    // First mirror the native offset so snapping also works when the target is
    // identical to the previous scrollTop prop after a short drag and release.
    setScrollTop(positionRef.current);
    snapTimer.current = setTimeout(() => {
      positionRef.current = target;
      setScrollTop(target);
      movedRef.current = false;
      latestProps.current.onMovingChange(false);
    }, 32);
  };

  const settle = () => {
    if (touchingRef.current || !activeRef.current) return;
    const position = positionRef.current / ROW_HEIGHT;
    const candidates = options.map((option, index) => ({ option, index }))
      .filter(item => !latestProps.current.isOptionDisabled?.(item.option));
    const nearest = candidates.reduce<typeof candidates[number] | undefined>((best, item) =>
      !best || Math.abs(item.index - position) < Math.abs(best.index - position) ? item : best, undefined);
    if (!nearest) {
      activeRef.current = false;
      latestProps.current.onMovingChange(false);
      return;
    }
    const index = nearest.index;
    if (movedRef.current) latestProps.current.onChange(options[index]);
    snapTo(index);
  };

  const waitForRest = () => {
    clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(settle, SETTLE_DELAY_MS);
  };

  const begin = () => {
    if (disabled || touchingRef.current) return;
    clearTimers();
    touchingRef.current = true;
    activeRef.current = true;
    movedRef.current = false;
    onMovingChange(true);
  };

  const end = () => {
    touchingRef.current = false;
    if (activeRef.current) waitForRest();
  };

  return (
    <View
      className={`silent-time-wheel silent-time-wheel--${field}`}
      onTouchStart={begin}
      onTouchEnd={end}
      onTouchCancel={end}
    >
      <View className='silent-time-wheel__selection' />
      <ScrollView
        className={`silent-time-wheel__scroll silent-time-wheel__scroll--${field}`}
        scrollY={!disabled}
        scrollTop={scrollTop}
        scrollWithAnimation={false}
        enhanced
        bounces={false}
        fastDeceleration
        showScrollbar={false}
        onDragStart={begin}
        onDragEnd={end}
        onScroll={event => {
          const top = event.detail.scrollTop;
          if (!Number.isFinite(top)) return;
          const changed = top !== positionRef.current;
          positionRef.current = top;
          // Initial positioning and programmatic snapping cannot select a new
          // minute for an existing appointment such as 09:07.
          if (!activeRef.current || disabled) return;
          movedRef.current = movedRef.current || changed;
          onMovingChange(true);
          if (!touchingRef.current) waitForRest();
        }}
      >
        <View className='silent-time-wheel__spacer' />
        {options.map((option, index) => (
          <Button
            key={option}
            className={`silent-time-wheel__item daily-reminder-card__${field}${value === option ? " silent-time-wheel__item--selected" : ""}${isOptionDisabled?.(option) ? " silent-time-wheel__item--disabled" : ""}`}
            ariaLabel={`${option} ${label}${isOptionDisabled?.(option) ? "，不可选" : value === option ? "，已选" : ""}`}
            hoverClass='none'
            disabled={disabled || isOptionDisabled?.(option)}
            onClick={() => {
              if (disabled || movedRef.current || latestProps.current.isOptionDisabled?.(option)) return;
              touchingRef.current = false;
              onChange(option);
              snapTo(index);
            }}
          >{option}</Button>
        ))}
        <View className='silent-time-wheel__spacer' />
      </ScrollView>
      <View className='silent-time-wheel__fade silent-time-wheel__fade--top' />
      <View className='silent-time-wheel__fade silent-time-wheel__fade--bottom' />
    </View>
  );
}
