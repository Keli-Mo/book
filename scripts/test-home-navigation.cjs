/* eslint-disable import/no-commonjs */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");

const sourcePath = path.resolve(
  __dirname,
  "../src/features/bookLibrary/homeNavigation.ts",
);

assert.equal(fs.existsSync(sourcePath), true, "首页导航栏尺寸模型应存在");

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

const { calculateHomeNavigationMetrics } = moduleContainer.exports;

assert.deepEqual(
  JSON.parse(
    JSON.stringify(
      calculateHomeNavigationMetrics(390, 47, {
        top: 51,
        bottom: 83,
        left: 294,
        right: 381,
        width: 87,
        height: 32,
      }),
    ),
  ),
  { statusBarHeight: 47, navigationHeight: 40, capsuleReserve: 104 },
  "应根据 iOS 胶囊位置计算导航高度和右侧留白",
);
assert.deepEqual(
  JSON.parse(
    JSON.stringify(
      calculateHomeNavigationMetrics(412, 24, {
        top: 30,
        bottom: 62,
        left: 316,
        right: 403,
        width: 87,
        height: 32,
      }),
    ),
  ),
  { statusBarHeight: 24, navigationHeight: 44, capsuleReserve: 104 },
  "应适配 Android 不同状态栏高度",
);

console.log("首页导航测试通过：iOS 与 Android 胶囊尺寸均能动态适配。");
