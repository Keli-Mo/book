/* eslint-disable import/no-commonjs */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");

const projectRoot = path.resolve(__dirname, "..");
const helperPath = path.join(
  projectRoot,
  "src/features/listeningPractice/audioPlayback.ts",
);

assert.equal(fs.existsSync(helperPath), true, "音频安全停止与进度工具应存在");

const compiled = ts.transpileModule(fs.readFileSync(helperPath, "utf8"), {
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

const { getPlaybackPositionMs, stopAudioIfLoaded } = moduleContainer.exports;

let stopCount = 0;
assert.equal(stopAudioIfLoaded(null), false, "没有音频实例时不应停止");
assert.equal(
  stopAudioIfLoaded({ src: "", stop: () => { stopCount += 1; } }),
  false,
  "首次播放前没有 src 时不应调用 stop",
);
assert.equal(stopCount, 0, "空 src 不能触发底层 stop");
assert.equal(
  stopAudioIfLoaded({
    src: "https://example.com/recording.mp3",
    stop: () => { stopCount += 1; },
  }),
  true,
  "已有 src 时应停止播放",
);
assert.equal(stopCount, 1, "已有 src 时只停止一次");

assert.equal(getPlaybackPositionMs(0.99, 5000), 0, "未满一秒时显示 0 秒");
assert.equal(getPlaybackPositionMs(2.99, 5000), 2000, "当前秒数应向下取整");
assert.equal(getPlaybackPositionMs(8, 5000), 5000, "进度不能超过总时长");
assert.equal(getPlaybackPositionMs(-2, 5000), 0, "负数进度应归零");
assert.equal(getPlaybackPositionMs(Number.NaN, 5000), 0, "无效进度应归零");

const practice = fs.readFileSync(
  path.join(projectRoot, "src/pages/Practice/Practice.tsx"),
  "utf8",
);
const checkInDetail = fs.readFileSync(
  path.join(projectRoot, "src/pages/CheckInDetail/CheckInDetail.tsx"),
  "utf8",
);

assert.match(practice, /useDidHide/, "训练页应监听页面隐藏");
assert.match(
  practice,
  /useDidHide\(\(\) => \{[\s\S]*?stopAudioIfLoaded\(modelAudioRef\.current\)[\s\S]*?stopAudioIfLoaded\(recordingAudioRef\.current\)/,
  "训练页隐藏时应停止示范音频和录音回听",
);
assert.doesNotMatch(
  practice,
  /modelAudioRef\.current\?\.stop\(\)|recordingAudioRef\.current\?\.stop\(\)/,
  "训练页不能再对可能为空源的音频直接 stop",
);

assert.match(checkInDetail, /useDidHide/, "分享页应监听页面隐藏");
assert.match(
  checkInDetail,
  /audio\.onTimeUpdate\(\(\) =>[\s\S]*?audio\.currentTime/,
  "分享页应从音频上下文读取实时播放进度",
);
assert.match(
  checkInDetail,
  /useDidHide\(\(\) => \{[\s\S]*?stopAudioIfLoaded\(audioRef\.current\)[\s\S]*?setPlaybackPositionMs\(0\)/,
  "分享页隐藏时应停止音频并清零播放进度",
);
assert.match(
  checkInDetail,
  /formatRecordingDuration\(playbackPositionMs\)[\s\S]*?formatRecordingDuration\(detail\.durationMs\)/,
  "分享页播放时应同时显示当前时间和总时长",
);

console.log("音频播放测试通过：首次停止保护、离页停止与分享进度均正确。");
