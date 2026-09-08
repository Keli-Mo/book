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

const {
  createTrackAudioController,
  getPlaybackPositionMs,
  stopAudioIfLoaded,
  stopPracticePlayback,
} = moduleContainer.exports;

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

const playbackEvents = [];
let playbackSource = "";
const fakeTrackAudio = {
  get src() { return playbackSource; },
  set src(value) {
    playbackSource = value;
    playbackEvents.push(`src:${value}`);
  },
  stop: () => playbackEvents.push("stop"),
  play: () => playbackEvents.push("play"),
};
const shownTrackIds = [];
const trackController = createTrackAudioController(
  fakeTrackAudio,
  (trackId) => shownTrackIds.push(trackId),
);

trackController.toggle("track-a", "audio-a.mp3");
assert.deepEqual(
  playbackEvents,
  ["src:audio-a.mp3", "play"],
  "首次播放必须先设置 src 再播放，不能提前 stop",
);
assert.deepEqual(shownTrackIds, ["track-a"]);

trackController.toggle("track-b", "audio-b.mp3");
assert.deepEqual(
  playbackEvents,
  ["src:audio-a.mp3", "play", "stop"],
  "切换音轨时应先等待旧音轨停止",
);
assert.equal(playbackSource, "audio-a.mp3", "onStop 前不能抢先替换音源");

trackController.handleStop();
assert.deepEqual(
  playbackEvents,
  ["src:audio-a.mp3", "play", "stop", "src:audio-b.mp3", "play"],
  "收到旧音轨 onStop 后再启动新音轨",
);
assert.equal(shownTrackIds.at(-1), "track-b", "旧 onStop 不能清空新音轨状态");

const synchronousEvents = [];
let synchronousSource = "";
let synchronousController;
const synchronousAudio = {
  get src() { return synchronousSource; },
  set src(value) {
    synchronousSource = value;
    synchronousEvents.push(`src:${value}`);
  },
  play: () => synchronousEvents.push("play"),
  stop: () => {
    synchronousEvents.push("stop");
    synchronousController.handleStop();
  },
};
synchronousController = createTrackAudioController(synchronousAudio, () => {});
synchronousController.toggle("track-a", "audio-a.mp3");
synchronousController.toggle("track-b", "audio-b.mp3");
synchronousController.toggle("track-b", "audio-b.mp3");
assert.equal(
  synchronousEvents.filter((event) => event === "stop").length,
  2,
  "即使 onStop 同步到达，第二次点击当前音轨也必须真正停止",
);

let modelStopCount = 0;
let recordingStopCount = 0;
stopPracticePlayback(
  { stop: () => { modelStopCount += 1; } },
  { src: "recording.mp3", stop: () => { recordingStopCount += 1; } },
);
assert.equal(modelStopCount, 1, "页面隐藏时应停止示范音频");
assert.equal(recordingStopCount, 1, "页面隐藏时应停止录音回听");

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
const practiceHideBody = practice.match(
  /useDidHide\(\(\) => \{([\s\S]*?)\n  \}\);/,
)?.[1] || "";
assert.match(
  practiceHideBody,
  /stopPracticePlayback\(\s*modelAudioControllerRef\.current,\s*recordingAudioRef\.current,?\s*\)/,
  "训练页隐藏回调本身应停止示范音频和录音回听",
);
assert.doesNotMatch(
  practiceHideBody,
  /recorderRef|resetRecording|recorder\.stop/,
  "训练页隐藏时不能停止或丢弃正在进行的录音",
);
assert.doesNotMatch(
  practice,
  /modelAudioRef\.current\?\.stop\(\)|recordingAudioRef\.current\?\.stop\(\)/,
  "训练页不能再对可能为空源的音频直接 stop",
);
const playModelAudioBody = practice.match(
  /const playModelAudio = \(trackId: string, url: string\) => \{([\s\S]*?)\n  \};/,
)?.[1] || "";
assert.match(
  playModelAudioBody,
  /controller\.toggle\(trackId, url\)/,
  "训练页点击示范音频应交给经过时序测试的控制器",
);
assert.doesNotMatch(
  playModelAudioBody,
  /audio\.stop\(\)|audio\.src\s*=/,
  "训练页不能绕过控制器重新引入 stop 与 src 的竞态",
);

assert.match(checkInDetail, /useDidHide/, "分享页应监听页面隐藏");
assert.match(
  checkInDetail,
  /audio\.onTimeUpdate\(\(\) =>[\s\S]*?audio\.currentTime/,
  "分享页应从音频上下文读取实时播放进度",
);
const detailHideBody = checkInDetail.match(
  /useDidHide\(\(\) => \{([\s\S]*?)\n  \}\);/,
)?.[1] || "";
assert.match(
  detailHideBody,
  /stopAudioIfLoaded\(audioRef\.current\)/,
  "分享页隐藏回调本身应停止音频",
);
assert.match(
  detailHideBody,
  /setPlaybackPositionMs\(0\)/,
  "分享页隐藏回调本身应清零播放进度",
);
assert.match(
  checkInDetail,
  /formatRecordingDuration\(playbackPositionMs\)[\s\S]*?formatRecordingDuration\(detail\.durationMs\)/,
  "分享页播放时应同时显示当前时间和总时长",
);

console.log("音频播放测试通过：首次停止保护、离页停止与分享进度均正确。");
