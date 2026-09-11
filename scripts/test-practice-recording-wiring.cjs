/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const practicePath = path.resolve(__dirname, "../src/pages/Practice/Practice.tsx");
const source = fs.readFileSync(practicePath, "utf8");

for (const required of [
  "getRecorderCoordinator",
  "createRecordingMachine",
  "requestRecorderAction",
  "requestRecorderTeardown",
  "resolveRecorderCallback",
  "handleInterruptionBegin",
  "handleInterruptionEnd",
  "getPendingCheckInStore",
  "getCheckInSubmissionCoordinator",
  "parseNativeRecordingResult",
  "useDidHide",
  "useUnload",
]) {
  assert.match(source, new RegExp(`\\b${required}\\b`), `训练页必须接入 ${required}`);
}

for (const legacy of [
  "wx.getRecorderManager(",
  "uploadCheckInRecording(",
  "createCheckIn(",
  "removeUploadedRecording(",
]) {
  assert.equal(source.includes(legacy), false, `训练页不得再调用旧链路：${legacy}`);
}

assert.match(source, /sampleRate:\s*16000/);
assert.match(source, /numberOfChannels:\s*1/);
assert.match(source, /encodeBitRate:\s*48000/);
assert.match(source, /format:\s*["']mp3["']/);
assert.equal(/frameSize\s*:/.test(source), false, "录音参数不得携带会触发帧回调兼容问题的 frameSize");

assert.match(
  source,
  /parseNativeRecordingResult\s*\(\s*result\s*\)/,
  "原生停止结果必须由统一解析器验证时长、大小和临时路径",
);
assert.match(source, /Taro\.getSetting\s*\(/, "授权前必须读取当前录音权限");
assert.match(source, /authSetting\s*\[\s*["']scope\.record["']\s*\]/);
assert.match(source, /Taro\.authorize\s*\(\s*\{\s*scope:\s*["']scope\.record["']/s);
assert.match(source, /Taro\.openSetting\s*\(/, "永久拒绝后只从用户确认弹窗进入设置");
assert.match(source, /\.release\s*\(\s*\{[\s\S]*?terminalSink\s*:/, "页面卸载必须把迟到 terminal 托管给全局协调器");
assert.match(source, /\.cancel\s*\(\s*\)/, "页面隐藏或用户取消时必须中止尚未完成的上传");
assert.match(
  source,
  /useUnload\(\(\) => \{[\s\S]*?requestRecorderTeardown\([\s\S]*?terminalSink/,
  "页面卸载时必须先更新录音状态，再把 stop 结果交给持久化 sink",
);
assert.doesNotMatch(source, /RECORDER_TEARDOWN_TIMEOUT_MS|teardownReleaseTimerRef/, "页面不得用固定 8 秒截止丢弃迟到录音");

console.log("训练页录音接线测试通过：状态机、全局协调器、本地保存与幂等提交已进入生产路径。");
