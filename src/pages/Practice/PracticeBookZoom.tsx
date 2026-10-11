import { MovableArea, MovableView, type ITouchEvent } from "@tarojs/components";
import { useRef, type ReactNode } from "react";
import {
  advanceBookEdgeDrag,
  getBookHorizontalEdges,
  type BookHorizontalEdges,
  type EdgeDrag,
  type EdgeTurn,
  type GesturePoint,
} from "./bookEdgeGesture";

export type BookZoomSize = { width: number; height: number };

type PracticeBookZoomProps = {
  viewportSize: BookZoomSize;
  contentSize: BookZoomSize;
  renderContent: () => ReactNode;
  onZoomActiveChange: (active: boolean) => void;
  onVerticalMove?: () => void;
  onHotspotGestureBlockChange?: (blocked: boolean) => void;
  onEdgeTurn?: (direction: EdgeTurn) => void;
};

const ZOOMED_THRESHOLD = 1.01;
const DRAG_THRESHOLD_PX = 6;

export function PracticeBookZoom({
  viewportSize,
  contentSize,
  renderContent,
  onZoomActiveChange,
  onVerticalMove,
  onHotspotGestureBlockChange,
  onEdgeTurn,
}: PracticeBookZoomProps): JSX.Element {
  const scaleRef = useRef(1);
  const pinchingRef = useRef(false);
  const zoomActiveRef = useRef(false);
  const hotspotBlockedRef = useRef(false);
  const verticalMoveNotifiedRef = useRef(false);
  const nativeXRef = useRef(0);
  const singleGestureRef = useRef<{
    identifier: number;
    start: GesturePoint;
    last: GesturePoint;
    startEdges: BookHorizontalEdges;
  } | null>(null);
  const edgeDragRef = useRef<EdgeDrag | null>(null);
  const edgeTurnRef = useRef<EdgeTurn | null>(null);

  const readEdges = () => getBookHorizontalEdges(
    viewportSize.width, contentSize.width, scaleRef.current, nativeXRef.current,
  );

  const clearEdgeDrag = () => {
    singleGestureRef.current = null;
    edgeDragRef.current = null;
    edgeTurnRef.current = null;
  };

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

  const trackSingleTouch = (point: GesturePoint) => {
    const gesture = singleGestureRef.current;
    if (pinchingRef.current || !gesture) return;
    const dx = point.x - gesture.start.x;
    const dy = point.y - gesture.start.y;
    if (Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
      blockHotspotClick(true);
      const next = advanceBookEdgeDrag({
        anchor: edgeDragRef.current,
        point,
        previousPoint: gesture.last,
        startPoint: gesture.start,
        startEdges: gesture.startEdges,
        edges: readEdges(),
      });
      edgeDragRef.current = next.anchor;
      edgeTurnRef.current = next.turn;
      if (!next.anchor) gesture.startEdges = { previous: false, next: false };
    } else {
      edgeDragRef.current = null;
      edgeTurnRef.current = null;
    }
    gesture.last = point;
  };

  return (
    <MovableArea
      className='practice-book-zoom-area'
      scaleArea
      style={{ width: `${viewportSize.width}px`, height: `${viewportSize.height}px` }}
    >
      <MovableView
        className='practice-book-zoom-view'
        style={{ width: `${contentSize.width}px`, height: `${contentSize.height}px` }}
        // 原生移动方向需在首次挂载时确定；1x 时由组件边界限制位移。
        direction='all'
        scale
        scaleMin={1}
        scaleMax={4}
        // 倍率使用微信原生默认值；绑定固定 scale-value 会在重绘时覆盖捏合结果。
        animation={false}
        inertia={false}
        outOfBounds={false}
        // 微信模板只在 movable-view 输出触摸绑定，不能依赖 movable-area 回调。
        onTouchStart={(event) => {
          const { touches } = event as ITouchEvent;
          clearEdgeDrag();
          if (touches.length >= 2) {
            // 捏合结束后的原生 tap 仍可能到达热点，直到下一次单指起触才解除拦截。
            pinchingRef.current = true;
            blockHotspotClick(true);
            notifyZoomActive(true);
            return;
          }
          if (pinchingRef.current || touches.length !== 1) return;
          blockHotspotClick(false);
          const point = { x: touches[0].pageX, y: touches[0].pageY };
          singleGestureRef.current = {
            identifier: touches[0].identifier,
            start: point,
            last: point,
            startEdges: readEdges(),
          };
        }}
        onTouchMove={(event) => {
          const { touches } = event as ITouchEvent;
          if (touches.length >= 2) {
            pinchingRef.current = true;
            clearEdgeDrag();
            blockHotspotClick(true);
            notifyZoomActive(true);
            return;
          }
          if (touches.length === 1) trackSingleTouch({ x: touches[0].pageX, y: touches[0].pageY });
        }}
        onTouchEnd={(event) => {
          if (event.touches.length === 0) {
            // touchmove 可能合并最后一帧，松手时重新检查最终位置，避免回拉后误翻。
            const finalTouch = event.changedTouches?.find((touch) =>
              touch.identifier === singleGestureRef.current?.identifier);
            if (finalTouch) trackSingleTouch({ x: finalTouch.pageX, y: finalTouch.pageY });
            const turn = pinchingRef.current ? null : edgeTurnRef.current;
            const edges = readEdges();
            pinchingRef.current = false;
            clearEdgeDrag();
            if (turn && (turn === 1 ? edges.next : edges.previous)) onEdgeTurn?.(turn);
          }
          notifyZoomActive(pinchingRef.current || scaleRef.current > ZOOMED_THRESHOLD);
        }}
        onTouchCancel={() => {
          pinchingRef.current = false;
          clearEdgeDrag();
          blockHotspotClick(true);
          notifyZoomActive(scaleRef.current > ZOOMED_THRESHOLD);
        }}
        onScale={(event) => {
          const nextScale = Number(event.detail.scale);
          if (!Number.isFinite(nextScale)) return;
          const boundedScale = Math.min(4, Math.max(1, nextScale));
          if (pinchingRef.current) blockHotspotClick(true);
          scaleRef.current = boundedScale;
          if (Number.isFinite(event.detail.x)) nativeXRef.current = event.detail.x;
          notifyZoomActive(pinchingRef.current || boundedScale > ZOOMED_THRESHOLD);
        }}
        onChange={(event) => {
          const { x, y } = event.detail;
          if (Number.isFinite(x)) nativeXRef.current = x;
          const edges = readEdges();
          if (edgeTurnRef.current && !(edgeTurnRef.current === 1 ? edges.next : edges.previous)) {
            edgeDragRef.current = null;
            edgeTurnRef.current = null;
          }
          if (y < 0 && !verticalMoveNotifiedRef.current) {
            verticalMoveNotifiedRef.current = true;
            onVerticalMove?.();
          }
        }}
      >
        {renderContent()}
      </MovableView>
    </MovableArea>
  );
}
