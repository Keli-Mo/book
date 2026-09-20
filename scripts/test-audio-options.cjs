/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");

const compiled = ts.transpileModule(
  fs.readFileSync(path.join(__dirname, "../src/app.ts"), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 } },
).outputText;

const launchApp = (audioError) => {
  let onLaunch;
  let cloudInitializations = 0;
  const audioOptions = [];
  const warnings = [];
  const taro = {
    useLaunch: (callback) => { onLaunch = callback; },
    setInnerAudioOption: (options) => {
      audioOptions.push(options);
      return audioError ? Promise.reject(audioError) : Promise.resolve({});
    },
  };
  const loaded = { exports: {} };
  vm.runInNewContext(compiled, {
    module: loaded,
    exports: loaded.exports,
    console: { warn: (...args) => warnings.push(args) },
    require: (request) => {
      if (request === "@tarojs/taro") return { __esModule: true, default: taro, ...taro };
      if (request === "@/cloud") return { initCloudHosting: () => { cloudInitializations += 1; } };
      if (request.endsWith(".scss")) return {};
      throw new Error(`Unexpected dependency: ${request}`);
    },
  });
  const children = {};
  assert.equal(loaded.exports.default({ children }), children, "启动配置不能阻断页面渲染");
  onLaunch();
  return { audioOptions, warnings, cloudInitializations };
};

test("冷启动统一允许静音模式下播放，无需先打开旧教材页", async () => {
  const app = launchApp();
  assert.equal(app.audioOptions.length, 1, "应用启动时必须设置全局音频选项");
  assert.equal(app.audioOptions[0].obeyMuteSwitch, false, "用户主动播放不应被 iOS 静音模式静默屏蔽");
  assert.equal(app.cloudInitializations, 1, "保留云环境初始化");
  await Promise.resolve();
  assert.equal(app.warnings.length, 0);
});

test("音频配置失败被记录且不阻断启动", async () => {
  const error = { errMsg: "setInnerAudioOption:fail" };
  const app = launchApp(error);
  await Promise.resolve();
  assert.equal(app.cloudInitializations, 1);
  assert.equal(app.warnings.length, 1, "配置失败必须有诊断日志，不能成为未处理的 Promise 拒绝");
  assert.equal(app.warnings[0][1], error);
});
