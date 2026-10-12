/* eslint-disable import/no-commonjs */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");

const source = fs.readFileSync(
  path.resolve(__dirname, "../src/features/listeningPractice/audioRuntime.ts"),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 },
});

const shouldUseOhOsWebAudio = (platform, { legacy = false, deviceType = "phone" } = {}) => {
  const module = { exports: {} };
  const deviceCalls = { getDeviceInfo: () => ({ platform, deviceType }) };
  const wx = legacy
    ? { getSystemInfoSync: () => ({ platform }) }
    : deviceCalls;
  vm.runInNewContext(compiled.outputText, { module, exports: module.exports, wx });
  assert.equal(typeof module.exports.shouldUseOhOsWebAudio, "function");
  return module.exports.shouldUseOhOsWebAudio();
};

assert.equal(shouldUseOhOsWebAudio("ohos"), true, "鸿蒙体验版和正式版均应使用已在真机验证的驱动");
assert.equal(shouldUseOhOsWebAudio("ohos", { deviceType: "pad" }), true, "鸿蒙平板应使用同一驱动");
assert.equal(shouldUseOhOsWebAudio("ohos", { legacy: true }), true, "旧设备信息接口应能识别鸿蒙");
assert.equal(shouldUseOhOsWebAudio("android"), false, "安卓继续使用原生音频驱动");
assert.equal(shouldUseOhOsWebAudio("ios"), false, "iOS 继续使用原生音频驱动及静音开关设置");

console.log("鸿蒙示范音频驱动选择测试通过。");
