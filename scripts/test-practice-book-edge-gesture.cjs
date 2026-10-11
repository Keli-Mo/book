/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

const sourcePath = path.resolve(__dirname, "../src/pages/Practice/bookEdgeGesture.ts");
assert.ok(fs.existsSync(sourcePath), "边缘翻页算法文件 bookEdgeGesture.ts 应存在");
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 },
  fileName: sourcePath,
});
const moduleContainer = { exports: {} };
vm.runInNewContext(compiled.outputText, {
  module: moduleContainer,
  exports: moduleContainer.exports,
  require: () => { throw new Error("边缘翻页纯函数不应依赖平台模块"); },
}, { filename: sourcePath });
const { getBookHorizontalEdges, advanceBookEdgeDrag } = moduleContainer.exports;
assert.equal(typeof getBookHorizontalEdges, "function");
assert.equal(typeof advanceBookEdgeDrag, "function");
const normalize = (value) => JSON.parse(JSON.stringify(value));
const nowhere = { previous: false, next: false };
const both = { previous: true, next: true };
const edgeFor = (direction) => ({ previous: direction === -1, next: direction === 1 });
const advance = (input) => normalize(advanceBookEdgeDrag(input));
const sample = (overrides = {}) => ({
  anchor: null,
  point: { x: 120, y: 140 },
  previousPoint: { x: 120, y: 140 },
  startPoint: { x: 120, y: 140 },
  startEdges: nowhere,
  edges: nowhere,
  ...overrides,
});

test("2 倍书页横向边界区分左端、右端和中间，容差为 2 px", () => {
  assert.deepEqual(normalize(getBookHorizontalEdges(374, 374, 2, 0)), edgeFor(-1));
  assert.deepEqual(normalize(getBookHorizontalEdges(374, 374, 2, -374)), edgeFor(1));
  assert.deepEqual(normalize(getBookHorizontalEdges(374, 374, 2, -187)), nowhere);
  assert.deepEqual(normalize(getBookHorizontalEdges(374, 374, 2, -2)), edgeFor(-1));
  assert.deepEqual(normalize(getBookHorizontalEdges(374, 374, 2, -3)), nowhere);
  assert.deepEqual(normalize(getBookHorizontalEdges(374, 374, 2, -372)), edgeFor(1));
  assert.deepEqual(normalize(getBookHorizontalEdges(374, 374, 2, -371)), nowhere);
});

test("1 倍等宽书页同时位于左右端，未知原生坐标不能算边缘", () => {
  assert.deepEqual(normalize(getBookHorizontalEdges(374, 374, 1, 0)), both);
  assert.deepEqual(normalize(getBookHorizontalEdges(374, 374, 2, Number.NaN)), nowhere);
});

for (const direction of [-1, 1]) {
  const label = direction === 1 ? "下一页" : "上一页";
  const outward = -direction;
  const edge = edgeFor(direction);

  test(`${label}：中部一次大幅拖到边缘只建立新锚点，后续外拖 64 px 才候选翻页`, () => {
    const start = { x: 120, y: 140 };
    const arrival = { x: start.x + outward * 400, y: 140 };
    const arrived = advance(sample({
      point: arrival,
      previousPoint: start,
      startPoint: start,
      startEdges: nowhere,
      edges: edge,
    }));
    assert.deepEqual(arrived, { anchor: { direction, ...arrival }, turn: null });
    const continued = advance(sample({
      anchor: arrived.anchor,
      point: { x: arrival.x + outward * 64, y: 140 },
      previousPoint: arrival,
      startPoint: start,
      edges: edge,
    }));
    assert.equal(continued.turn, direction);
  });

  test(`${label}：起触已在边缘，外拖 63 px 不翻，64 px 刚好满足`, () => {
    const start = { x: 120, y: 140 };
    const before = advance(sample({
      point: { x: start.x + outward * 63, y: 140 },
      startEdges: edge,
      edges: edge,
    }));
    assert.equal(before.turn, null);
    assert.deepEqual(before.anchor, { direction, ...start });
    const enough = advance(sample({
      anchor: before.anchor,
      point: { x: start.x + outward * 64, y: 140 },
      previousPoint: { x: start.x + outward * 63, y: 140 },
      startEdges: edge,
      edges: edge,
    }));
    assert.equal(enough.turn, direction);
  });

  test(`${label}：竖拖和斜拖不会建立边缘翻页候选`, () => {
    for (const point of [
      { x: 120 + outward * 2, y: 220 },
      { x: 120 + outward * 64, y: 190 },
    ]) {
      const result = advance(sample({ point, startEdges: edge, edges: edge }));
      assert.deepEqual(result, { anchor: null, turn: null });
    }
  });

  test(`${label}：已有候选向内回拉、离开边缘和改为竖拖都会取消锚点`, () => {
    const anchor = { direction, x: 120, y: 140 };
    const previousPoint = { x: 120 + outward * 60, y: 140 };
    const reversed = advance(sample({
      anchor,
      point: { x: previousPoint.x - outward * 10, y: 140 },
      previousPoint,
      startEdges: edge,
      edges: edge,
    }));
    assert.deepEqual(reversed, { anchor: null, turn: null });
    const away = advance(sample({
      anchor,
      point: { x: 120 + outward * 80, y: 140 },
      previousPoint,
      startEdges: edge,
      edges: nowhere,
    }));
    assert.deepEqual(away, { anchor: null, turn: null });
    const vertical = advance(sample({
      anchor,
      point: { x: 120 + outward * 65, y: 220 },
      previousPoint,
      startEdges: edge,
      edges: edge,
    }));
    assert.deepEqual(vertical, { anchor: null, turn: null });
  });
}

test("1 倍书页反向拖动清除旧候选，不能沿用原方向已累计的位移", () => {
  const result = advance(sample({
    anchor: { direction: 1, x: 120, y: 140 },
    previousPoint: { x: 60, y: 140 },
    point: { x: 70, y: 140 },
    startEdges: both,
    edges: both,
  }));
  assert.deepEqual(result, { anchor: null, turn: null });
});
