export type EdgeTurn = -1 | 1;
export type GesturePoint = { x: number; y: number };
export type BookHorizontalEdges = { previous: boolean; next: boolean };
export type EdgeDrag = GesturePoint & { direction: EdgeTurn };

const EDGE_TOLERANCE_PX = 2;
const EDGE_TURN_DISTANCE_PX = 64;
const HORIZONTAL_DOMINANCE = 1.5;

export function getBookHorizontalEdges(
  viewportWidth: number,
  contentWidth: number,
  scale: number,
  x: number,
): BookHorizontalEdges {
  if (![viewportWidth, contentWidth, scale, x].every(Number.isFinite) ||
    viewportWidth <= 0 || contentWidth <= 0 || scale <= 0) {
    return { previous: false, next: false };
  }
  const remainingWidth = viewportWidth - contentWidth * scale;
  const minX = Math.min(0, remainingWidth);
  const maxX = Math.max(0, remainingWidth);
  return {
    previous: Math.abs(x - maxX) <= EDGE_TOLERANCE_PX,
    next: Math.abs(x - minX) <= EDGE_TOLERANCE_PX,
  };
}

/** Only distance dragged beyond a reached edge can request a page turn. */
export function advanceBookEdgeDrag({
  anchor,
  point,
  previousPoint,
  startPoint,
  startEdges,
  edges,
}: {
  anchor: EdgeDrag | null;
  point: GesturePoint;
  previousPoint: GesturePoint;
  startPoint: GesturePoint;
  startEdges: BookHorizontalEdges;
  edges: BookHorizontalEdges;
}): { anchor: EdgeDrag | null; turn: EdgeTurn | null } {
  const dx = point.x - startPoint.x;
  const dy = point.y - startPoint.y;
  const stepX = point.x - previousPoint.x;
  if (Math.abs(dx) < HORIZONTAL_DOMINANCE * Math.abs(dy) ||
    (anchor && stepX * -anchor.direction < 0)) {
    return { anchor: null, turn: null };
  }
  const direction = anchor?.direction ?? (stepX < 0 ? 1 : stepX > 0 ? -1 : null);
  if (direction === null || !(direction === 1 ? edges.next : edges.previous)) {
    return { anchor: null, turn: null };
  }
  const startedAtEdge = direction === 1 ? startEdges.next : startEdges.previous;
  const nextAnchor = anchor ?? { direction, ...(startedAtEdge ? startPoint : point) };
  const edgeDx = (point.x - nextAnchor.x) * -direction;
  const edgeDy = Math.abs(point.y - nextAnchor.y);
  return {
    anchor: nextAnchor,
    turn: edgeDx >= EDGE_TURN_DISTANCE_PX && edgeDx >= HORIZONTAL_DOMINANCE * edgeDy
      ? direction
      : null,
  };
}
