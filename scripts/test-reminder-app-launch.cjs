/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

test("小程序启动恢复服务器提醒开关，不在启动时申请微信订阅", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/app.ts"), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  } }).outputText;
  const calls = [];
  let launch;
  const exports = {};
  const taro = {
    requestSubscribeMessage() { throw new Error("启动时不得调用微信订阅接口"); },
    setInnerAudioOption() { throw new Error("本测试不应配置音频"); },
  };
  const sandbox = { exports, require(name) {
    if (name === "@tarojs/taro") return {
      __esModule: true, default: taro,
      useLaunch(callback) { launch = callback; },
    };
    if (name === "@/cloud") return {
      CLOUD_ENV_ID: "test-env",
      initCloudHosting() { calls.push("init-cloud"); },
    };
    if (name === "@/features/dailyReminder/reminderSettings") return {
      getReminderSettings() { calls.push("get-server-settings"); return Promise.resolve({ ok: true }); },
    };
    if (name === "@/features/listeningPractice/recordingSessionRecovery") return {
      resumeUnfinishedRecordingOnLaunch() { calls.push("resume-recording"); },
    };
    if (name === "@/features/listeningPractice/audioRuntime") return {
      shouldUseOhOsWebAudio() { return true; },
    };
    if (name.endsWith(".scss")) return {};
    throw new Error(`Unexpected import ${name}`);
  } };
  vm.runInNewContext(compiled, sandbox, { filename: "src/app.ts" });
  assert.equal(sandbox.exports.default({ children: "home" }), "home");
  assert.equal(typeof launch, "function");
  launch();
  assert.deepEqual(calls, ["resume-recording", "init-cloud", "get-server-settings"]);
});
