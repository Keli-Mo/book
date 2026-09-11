/* eslint-disable import/no-commonjs */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");

const sourcePath = path.resolve(
  __dirname,
  "../src/features/listeningPractice/hotspotLayout.ts",
);

assert.equal(fs.existsSync(sourcePath), true, "教材热点布局模型文件应存在");

const compiled = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2017,
  },
});
const moduleContainer = { exports: {} };

vm.runInNewContext(compiled.outputText, {
  module: moduleContainer,
  exports: moduleContainer.exports,
});

const { clampHotspotCenter } = moduleContainer.exports;
assert.equal(
  typeof clampHotspotCenter,
  "function",
  "教材热点布局模型应导出 clampHotspotCenter",
);

const normalize = (value) => JSON.parse(JSON.stringify(value));
const assertHotspot = (scenario, point, imageSize, expected, hitRadiusPx) => {
  const actual = normalize(clampHotspotCenter(point, imageSize, hitRadiusPx));
  assert.deepEqual(actual, expected, `${scenario}：热点中心收敛结果不符合契约`);
  assert.ok(Number.isFinite(actual.left), `${scenario}：left 必须是有限数`);
  assert.ok(Number.isFinite(actual.top), `${scenario}：top 必须是有限数`);
};

const defaultBounds = {
  left: 6.875,
  right: 93.125,
  top: 4.583333333333333,
  bottom: 95.41666666666667,
};

assertHotspot(
  "默认 22px 半径收敛左下边缘热点",
  { left: 0, top: 100 },
  { width: 320, height: 480 },
  { left: defaultBounds.left, top: defaultBounds.bottom },
);
assertHotspot(
  "图片中间热点保持不变",
  { left: 50, top: 40 },
  { width: 320, height: 480 },
  { left: 50, top: 40 },
);

const edgeCases = [
  ["左上边界", { left: 0, top: 0 }, { left: defaultBounds.left, top: defaultBounds.top }],
  [
    "右下边界",
    { left: 100, top: 100 },
    { left: defaultBounds.right, top: defaultBounds.bottom },
  ],
  [
    "远超左上界",
    { left: -1000, top: -1000 },
    { left: defaultBounds.left, top: defaultBounds.top },
  ],
  [
    "远超右下界",
    { left: 1000, top: 1000 },
    { left: defaultBounds.right, top: defaultBounds.bottom },
  ],
];

for (const [scenario, point, expected] of edgeCases) {
  assertHotspot(scenario, point, { width: 320, height: 480 }, expected);
}

assertHotspot(
  "自定义 10px 半径按图片尺寸换算百分比边界",
  { left: 0, top: 100 },
  { width: 200, height: 100 },
  { left: 5, top: 90 },
  10,
);
assertHotspot(
  "默认半径同时大于图片宽高一半时稳定居中",
  { left: 0, top: 100 },
  { width: 40, height: 30 },
  { left: 50, top: 50 },
);
assertHotspot(
  "自定义半径仅大于图片高度一半时只居中纵轴",
  { left: 0, top: 100 },
  { width: 200, height: 20 },
  { left: 15, top: 50 },
  30,
);

const invalidInputCases = [
  [
    "图片宽度为零时横轴安全回到 50%",
    { left: 25, top: 25 },
    { width: 0, height: 480 },
    { left: 50, top: 25 },
  ],
  [
    "图片高度为负数时纵轴安全回到 50%",
    { left: 25, top: 25 },
    { width: 320, height: -480 },
    { left: 25, top: 50 },
  ],
  [
    "图片尺寸为 NaN 与 Infinity 时双轴安全回到 50%",
    { left: 25, top: 25 },
    { width: Number.NaN, height: Number.POSITIVE_INFINITY },
    { left: 50, top: 50 },
  ],
  [
    "热点横坐标为 NaN 时横轴安全回到 50%",
    { left: Number.NaN, top: 100 },
    { width: 320, height: 480 },
    { left: 50, top: defaultBounds.bottom },
  ],
  [
    "热点纵坐标为 Infinity 时纵轴安全回到 50%",
    { left: 0, top: Number.POSITIVE_INFINITY },
    { width: 320, height: 480 },
    { left: defaultBounds.left, top: 50 },
  ],
];

for (const [scenario, point, imageSize, expected] of invalidInputCases) {
  assertHotspot(scenario, point, imageSize, expected);
}

const originalPoint = { left: -10, top: 110 };
const originalImageSize = { width: 320, height: 480 };
const pointSnapshot = { ...originalPoint };
const imageSizeSnapshot = { ...originalImageSize };
clampHotspotCenter(originalPoint, originalImageSize);
assert.deepEqual(originalPoint, pointSnapshot, "输入不可变：不得修改热点坐标对象");
assert.deepEqual(originalImageSize, imageSizeSnapshot, "输入不可变：不得修改图片尺寸对象");

console.log(
  "教材热点布局测试通过：默认与自定义半径、四边收敛、非法输入及不可变契约均正确。",
);
