/* eslint-disable import/no-commonjs */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");

const sourceRoot = path.resolve(__dirname, "../src");
const sourcePath = path.join(sourceRoot, "features/layout/deviceLayout.ts");
const moduleCache = new Map();

const isInsideSourceRoot = (candidate) =>
  candidate === sourceRoot || candidate.startsWith(`${sourceRoot}${path.sep}`);
const resolveTypeScriptDependency = (request, importerPath) => {
  assert.equal(
    request.startsWith("."),
    true,
    `测试加载器只允许 src 内相对依赖：${request}`,
  );
  const basePath = path.resolve(path.dirname(importerPath), request);
  assert.equal(
    isInsideSourceRoot(basePath),
    true,
    `测试加载器禁止依赖离开 src：${request}`,
  );
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    path.join(basePath, "index.ts"),
    path.join(basePath, "index.tsx"),
  ];
  const dependencyPath = candidates.find(
    (candidate) =>
      isInsideSourceRoot(candidate) &&
      [".ts", ".tsx"].includes(path.extname(candidate)) &&
      fs.existsSync(candidate) &&
      fs.statSync(candidate).isFile(),
  );
  assert.ok(dependencyPath, `TypeScript 相对依赖必须存在：${request}`);
  return dependencyPath;
};
const loadTypeScriptModule = (modulePath) => {
  const absolutePath = path.resolve(modulePath);
  assert.equal(
    isInsideSourceRoot(absolutePath),
    true,
    `测试加载器禁止模块离开 src：${absolutePath}`,
  );
  assert.equal(fs.existsSync(absolutePath), true, "设备布局模型文件应存在");
  if (moduleCache.has(absolutePath)) return moduleCache.get(absolutePath).exports;

  const compiled = ts.transpileModule(fs.readFileSync(absolutePath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2017,
    },
    fileName: absolutePath,
  });
  const moduleContainer = { exports: {} };
  moduleCache.set(absolutePath, moduleContainer);
  const localRequire = (request) =>
    loadTypeScriptModule(resolveTypeScriptDependency(request, absolutePath));

  vm.runInNewContext(
    compiled.outputText,
    {
      module: moduleContainer,
      exports: moduleContainer.exports,
      require: localRequire,
    },
    { filename: absolutePath },
  );
  return moduleContainer.exports;
};

const { calculateDeviceLayout } = loadTypeScriptModule(sourcePath);
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
  assert.ok(
    actual.safeAreaBottom >= 0,
    `${scenario}：safeAreaBottom 必须是非负数`,
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
  [
    "960×600 Pad 在精确阈值进入双栏",
    { windowWidth: 960, windowHeight: 600, screenWidth: 1024, screenHeight: 768 },
    {
      isPad: true,
      orientation: "landscape",
      isSplit: true,
      contentMaxWidth: 1280,
      ...defaultInsets,
    },
  ],
  [
    "959×600 Pad 宽度低于精确阈值时保持单栏",
    { windowWidth: 959, windowHeight: 600, screenWidth: 1024, screenHeight: 768 },
    {
      isPad: true,
      orientation: "landscape",
      isSplit: false,
      contentMaxWidth: 820,
      ...defaultInsets,
    },
  ],
  [
    "窗口短边达到 600 不能把小屏幕设备误判为 Pad",
    { windowWidth: 960, windowHeight: 600, screenWidth: 844, screenHeight: 390 },
    {
      isPad: false,
      orientation: "landscape",
      isSplit: false,
      contentMaxWidth: null,
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
  "分屏窗口的底部安全区只按 screenHeight 计算",
  {
    windowWidth: 960,
    windowHeight: 600,
    screenWidth: 1024,
    screenHeight: 768,
    statusBarHeight: 24,
    safeArea: { top: 24, bottom: 734 },
  },
  {
    isPad: true,
    orientation: "landscape",
    isSplit: true,
    contentMaxWidth: 1280,
    statusBarHeight: 24,
    safeAreaBottom: 34,
  },
);

const phoneInput = {
  windowWidth: 430,
  windowHeight: 932,
  screenWidth: 430,
  screenHeight: 932,
};
const phoneProfile = {
  isPad: false,
  orientation: "portrait",
  isSplit: false,
  contentMaxWidth: null,
};
const invalidStatusBarCases = [
  ["负数", -1],
  ["NaN", Number.NaN],
  ["正 Infinity", Number.POSITIVE_INFINITY],
  ["负 Infinity", Number.NEGATIVE_INFINITY],
  ["零", 0],
];

for (const [scenario, statusBarHeight] of invalidStatusBarCases) {
  assertProfile(
    `非法状态栏：${scenario}`,
    { ...phoneInput, statusBarHeight },
    { ...phoneProfile, ...defaultInsets },
  );
}

const invalidSafeAreaCases = [
  ["缺失 safeArea", undefined],
  ["top 为负数", { top: -1, bottom: 898 }],
  ["bottom 为负数", { top: 0, bottom: -1 }],
  ["top 为 NaN", { top: Number.NaN, bottom: 898 }],
  ["bottom 为 NaN", { top: 59, bottom: Number.NaN }],
  ["top 为正 Infinity", { top: Number.POSITIVE_INFINITY, bottom: 898 }],
  ["top 为负 Infinity", { top: Number.NEGATIVE_INFINITY, bottom: 898 }],
  ["bottom 为正 Infinity", { top: 59, bottom: Number.POSITIVE_INFINITY }],
  ["bottom 为负 Infinity", { top: 59, bottom: Number.NEGATIVE_INFINITY }],
  ["bottom 超过 screenHeight", { top: 59, bottom: 960 }],
  ["top 大于 bottom", { top: 900, bottom: 898 }],
];

for (const [scenario, safeArea] of invalidSafeAreaCases) {
  assertProfile(
    `非法安全区：${scenario}`,
    { ...phoneInput, statusBarHeight: 47, safeArea },
    { ...phoneProfile, statusBarHeight: 47, safeAreaBottom: 0 },
  );
}

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
