/* eslint-disable import/no-commonjs */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");

const sourceRoot = path.resolve(__dirname, "../src");
const sourcePath = path.join(
  sourceRoot,
  "features/listeningPractice/practiceSwipe.ts",
);

const loadTypeScriptModule = (modulePath) => {
  const compiled = ts.transpileModule(fs.readFileSync(modulePath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2017,
    },
    fileName: modulePath,
  });
  const moduleContainer = { exports: {} };
  vm.runInNewContext(
    compiled.outputText,
    {
      module: moduleContainer,
      exports: moduleContainer.exports,
      require: () => {
        throw new Error("practiceSwipe 不得再依赖其他模块");
      },
    },
    { filename: modulePath },
  );
  return moduleContainer.exports;
};

const {
  PAGE_TURN_DURATION_MS,
  PRACTICE_SLIDE_PREFETCH_RADIUS,
  shouldRenderPracticeSlideImage,
  isPracticeSwiperTouchChange,
} = loadTypeScriptModule(sourcePath);

assert.equal(PAGE_TURN_DURATION_MS, 300);
assert.equal(PRACTICE_SLIDE_PREFETCH_RADIUS, 2);
assert.equal(shouldRenderPracticeSlideImage(11, 11), true);
assert.equal(shouldRenderPracticeSlideImage(13, 11), true);
assert.equal(shouldRenderPracticeSlideImage(14, 11), false);
assert.equal(shouldRenderPracticeSlideImage(1.5, 1), false);
assert.equal(isPracticeSwiperTouchChange({ current: 4, source: "touch" }), true);
assert.equal(isPracticeSwiperTouchChange({ current: 4, source: "" }), false);
assert.equal(isPracticeSwiperTouchChange({ current: 4.2, source: "touch" }), false);

console.log("跟读翻页测试通过：原生 Swiper 手指滑动才切训练，邻页预加载避免空白。");
