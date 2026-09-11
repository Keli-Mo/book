/* eslint-disable import/no-commonjs */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");

const sourcePath = path.resolve(
  __dirname,
  "../src/features/layout/deviceLayout.ts",
);

assert.equal(fs.existsSync(sourcePath), true, "设备布局模型文件应存在");

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

const { calculateDeviceLayout } = moduleContainer.exports;
assert.equal(
  typeof calculateDeviceLayout,
  "function",
  "设备布局模型应导出 calculateDeviceLayout",
);

const normalize = (value) => JSON.parse(JSON.stringify(value));
const assertProfile = (scenario, input, expected) => {
  const actual = normalize(calculateDeviceLayout(input));
  assert.deepEqual(actual, expected, `${scenario}：设备布局结果不符合契约`);
  assert.ok(
    Number.isFinite(actual.statusBarHeight),
    `${scenario}：statusBarHeight 必须是有限数`,
  );
  assert.ok(
    Number.isFinite(actual.safeAreaBottom),
    `${scenario}：safeAreaBottom 必须是有限数`,
  );
};

const defaultInsets = { statusBarHeight: 20, safeAreaBottom: 0 };
const deviceMatrix = [
  [
    "320×568 小屏手机竖屏",
    { windowWidth: 320, windowHeight: 568, screenWidth: 320, screenHeight: 568 },
    {
      isPad: false,
      orientation: "portrait",
      isSplit: false,
      contentMaxWidth: null,
      ...defaultInsets,
    },
  ],
  [
    "430×932 刘海手机竖屏及合法安全区",
    {
      windowWidth: 430,
      windowHeight: 932,
      screenWidth: 430,
      screenHeight: 932,
      statusBarHeight: 59,
      safeArea: { top: 59, bottom: 898 },
    },
    {
      isPad: false,
      orientation: "portrait",
      isSplit: false,
      contentMaxWidth: null,
      statusBarHeight: 59,
      safeAreaBottom: 34,
    },
  ],
  [
    "844×390 手机横屏仍保持单栏",
    { windowWidth: 844, windowHeight: 390, screenWidth: 844, screenHeight: 390 },
    {
      isPad: false,
      orientation: "landscape",
      isSplit: false,
      contentMaxWidth: null,
      ...defaultInsets,
    },
  ],
  [
    "768×1024 iPad 竖屏",
    { windowWidth: 768, windowHeight: 1024, screenWidth: 768, screenHeight: 1024 },
    {
      isPad: true,
      orientation: "portrait",
      isSplit: false,
      contentMaxWidth: 820,
      ...defaultInsets,
    },
  ],
  [
    "1024×768 iPad 横屏双栏",
    { windowWidth: 1024, windowHeight: 768, screenWidth: 1024, screenHeight: 768 },
    {
      isPad: true,
      orientation: "landscape",
      isSplit: true,
      contentMaxWidth: 1280,
      ...defaultInsets,
    },
  ],
  [
    "800×1280 Android Pad 竖屏",
    { windowWidth: 800, windowHeight: 1280, screenWidth: 800, screenHeight: 1280 },
    {
      isPad: true,
      orientation: "portrait",
      isSplit: false,
      contentMaxWidth: 820,
      ...defaultInsets,
    },
  ],
  [
    "1280×800 Android Pad 横屏双栏",
    { windowWidth: 1280, windowHeight: 800, screenWidth: 1280, screenHeight: 800 },
    {
      isPad: true,
      orientation: "landscape",
      isSplit: true,
      contentMaxWidth: 1280,
      ...defaultInsets,
    },
  ],
  [
    "960×599 Pad 横屏高度不足时退回单栏",
    { windowWidth: 960, windowHeight: 599, screenWidth: 960, screenHeight: 600 },
    {
      isPad: true,
      orientation: "landscape",
      isSplit: false,
      contentMaxWidth: 820,
      ...defaultInsets,
    },
  ],
];

for (const [scenario, input, expected] of deviceMatrix) {
  assertProfile(scenario, input, expected);
}

assertProfile(
  'deviceType="pad" 覆盖短边不足 600 的屏幕回退判定',
  {
    windowWidth: 844,
    windowHeight: 390,
    screenWidth: 844,
    screenHeight: 390,
    deviceType: "pad",
  },
  {
    isPad: true,
    orientation: "landscape",
    isSplit: false,
    contentMaxWidth: 820,
    ...defaultInsets,
  },
);

assertProfile(
  "Pad 分屏窗口必须按固定屏幕短边识别设备",
  {
    windowWidth: 500,
    windowHeight: 700,
    screenWidth: 1024,
    screenHeight: 768,
  },
  {
    isPad: true,
    orientation: "portrait",
    isSplit: false,
    contentMaxWidth: 820,
    ...defaultInsets,
  },
);

assertProfile(
  "安全区底部超出屏幕时收敛为 0",
  {
    windowWidth: 430,
    windowHeight: 932,
    screenWidth: 430,
    screenHeight: 932,
    statusBarHeight: 47,
    safeArea: { top: 47, bottom: 960 },
  },
  {
    isPad: false,
    orientation: "portrait",
    isSplit: false,
    contentMaxWidth: null,
    statusBarHeight: 47,
    safeAreaBottom: 0,
  },
);

assertProfile(
  "非法状态栏与安全区使用默认值",
  {
    windowWidth: 430,
    windowHeight: 932,
    screenWidth: 430,
    screenHeight: 932,
    statusBarHeight: Number.POSITIVE_INFINITY,
    safeArea: { top: Number.NaN, bottom: 898 },
  },
  {
    isPad: false,
    orientation: "portrait",
    isSplit: false,
    contentMaxWidth: null,
    ...defaultInsets,
  },
);

const invalidDimensionCases = [
  [
    "窗口宽度为 NaN",
    {
      windowWidth: Number.NaN,
      windowHeight: 568,
      screenWidth: 320,
      screenHeight: 568,
    },
    {
      isPad: false,
      orientation: "portrait",
      isSplit: false,
      contentMaxWidth: null,
      ...defaultInsets,
    },
  ],
  [
    "屏幕宽度为 Infinity",
    {
      windowWidth: 430,
      windowHeight: 932,
      screenWidth: Number.POSITIVE_INFINITY,
      screenHeight: 932,
    },
    {
      isPad: false,
      orientation: "portrait",
      isSplit: false,
      contentMaxWidth: null,
      ...defaultInsets,
    },
  ],
  [
    "窗口与屏幕尺寸为零或负数",
    { windowWidth: 0, windowHeight: -1, screenWidth: 0, screenHeight: -1 },
    {
      isPad: false,
      orientation: "portrait",
      isSplit: false,
      contentMaxWidth: null,
      ...defaultInsets,
    },
  ],
  [
    'deviceType="pad" 且尺寸非法时保守保持 Pad 单栏',
    {
      windowWidth: Number.NEGATIVE_INFINITY,
      windowHeight: 0,
      screenWidth: Number.NaN,
      screenHeight: -800,
      deviceType: "pad",
    },
    {
      isPad: true,
      orientation: "portrait",
      isSplit: false,
      contentMaxWidth: 820,
      ...defaultInsets,
    },
  ],
];

for (const [scenario, input, expected] of invalidDimensionCases) {
  assertProfile(scenario, input, expected);
}

console.log(
  "设备布局测试通过：手机、iPad、Android Pad、分屏、安全区与非法尺寸契约均正确。",
);
