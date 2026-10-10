import { MovableArea, MovableView } from "@tarojs/components";
import { useRef, useState, type ReactNode } from "react";

export type BookZoomSize = { width: number; height: number };

type PracticeBookZoomProps = {
  viewportSize: BookZoomSize;
  contentSize: BookZoomSize;
  landscape: boolean;
  renderContent: (scale: number) => ReactNode;
  onZoomActiveChange: (active: boolean) => void;
  onVerticalMove?: () => void;
  onHotspotGestureBlockChange?: (blocked: boolean) => void;
};

const ZOOMED_THRESHOLD = 1.01;
const DRAG_THRESHOLD_PX = 6;

export function PracticeBookZoom({
  viewportSize,
  contentSize,
  landscape,
  renderContent,
  onZoomActiveChange,
  onVerticalMove,
  onHotspotGestureBlockChange,
}: PracticeBookZoomProps): JSX.Element {
  const [scaleValue, setScaleValue] = useState(1);
  const scaleRef = useRef(1);
  const pinchingRef = useRef(false);
  const zoomActiveRef = useRef(false);
  const hotspotBlockedRef = useRef(false);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const verticalMoveNotifiedRef = useRef(false);

  const notifyZoomActive = (active: boolean) => {
    if (zoomActiveRef.current === active) return;
    zoomActiveRef.current = active;
    onZoomActiveChange(active);
  };

  const blockHotspotClick = (blocked: boolean) => {
    if (hotspotBlockedRef.current === blocked) return;
    hotspotBlockedRef.current = blocked;
    onHotspotGestureBlockChange?.(blocked);
  };

  return (
    <MovableArea
      className='practice-book-zoom-area'
      scaleArea
      style={{ width: `${viewportSize.width}px`, height: `${viewportSize.height}px` }}
      onTouchStart={(event) => {
        if (event.touches.length >= 2) {
          // 捏合结束后的原生 tap 仍可能到达热点，直到下一次单指起触才解除拦截。
          pinchingRef.current = true;
          touchStartRef.current = null;
          blockHotspotClick(true);
          notifyZoomActive(true);
          return;
        }
        if (pinchingRef.current || event.touches.length !== 1) return;
        blockHotspotClick(false);
        touchStartRef.current = {
          x: event.touches[0].pageX,
          y: event.touches[0].pageY,
        };
      }}
      onTouchMove={(event) => {
        if (event.touches.length >= 2) {
          pinchingRef.current = true;
          touchStartRef.current = null;
          blockHotspotClick(true);
          notifyZoomActive(true);
          return;
        }
        if (event.touches.length !== 1 || !touchStartRef.current) return;
        const dx = event.touches[0].pageX - touchStartRef.current.x;
        const dy = event.touches[0].pageY - touchStartRef.current.y;
        if (Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) blockHotspotClick(true);
      }}
      onTouchEnd={(event) => {
        if (event.touches.length === 0) {
          pinchingRef.current = false;
          touchStartRef.current = null;
        }
        notifyZoomActive(pinchingRef.current || scaleRef.current > ZOOMED_THRESHOLD);
      }}
      onTouchCancel={() => {
        pinchingRef.current = false;
        touchStartRef.current = null;
        notifyZoomActive(scaleRef.current > ZOOMED_THRESHOLD);
      }}
    >
      <MovableView
        className='practice-book-zoom-view'
        style={{ width: `${contentSize.width}px`, height: `${contentSize.height}px` }}
        direction={scaleValue > ZOOMED_THRESHOLD ? "all" : landscape ? "vertical" : "none"}
        scale
        scaleMin={1}
        scaleMax={4}
        scaleValue={scaleValue}
        inertia={false}
        outOfBounds={false}
        onScale={(event) => {
          const nextScale = Number(event.detail.scale);
          if (!Number.isFinite(nextScale)) return;
          const boundedScale = Math.min(4, Math.max(1, nextScale));
          if (pinchingRef.current || Math.abs(boundedScale - scaleRef.current) > 0.001) {
            blockHotspotClick(true);
          }
          if (Math.abs(boundedScale - scaleRef.current) > 0.001) {
            scaleRef.current = boundedScale;
            setScaleValue(boundedScale);
          }
          // 父级只接收状态转换，缩放每帧仅更新此组件及热点视觉尺寸。
          notifyZoomActive(pinchingRef.current || boundedScale > ZOOMED_THRESHOLD);
        }}
        onChange={(event) => {
          const { y } = event.detail;
          if (y < 0 && !verticalMoveNotifiedRef.current) {
            verticalMoveNotifiedRef.current = true;
            onVerticalMove?.();
          }
        }}
      >
        {renderContent(scaleValue)}
      </MovableView>
    </MovableArea>
  );
}
