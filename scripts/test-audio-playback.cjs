/* eslint-disable import/no-commonjs */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");

const projectRoot = path.resolve(__dirname, "..");
const checkInFormatPath = path.join(
  projectRoot,
  "src/utils/checkInFormat.ts",
);
const formatCompiled = ts.transpileModule(
  fs.readFileSync(checkInFormatPath, "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2017,
    },
  },
);
const formatModule = { exports: {} };
vm.runInNewContext(formatCompiled.outputText, {
  module: formatModule,
  exports: formatModule.exports,
});
const { formatPlaybackDurationLabel } = formatModule.exports;

assert.equal(
  formatPlaybackDurationLabel(false, 3000, 8000),
  "0:08",
  "未播放时只显示总时长",
);
assert.equal(
  formatPlaybackDurationLabel(true, 3000, 8000),
  "0:03 / 0:08",
  "播放中应显示当前进度和总时长",
);

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

const createFakeTrackAudio = ({ stopOnDestroy = false } = {}) => {
  let source = "";
  const events = [];
  const listeners = {
    ended: [],
    error: [],
    stop: [],
  };

  const audio = {
    loop: true,
    get src() { return source; },
    set src(value) {
      source = value;
      events.push(`src:${value}`);
    },
    play: () => events.push("play"),
    destroy: () => {
      events.push("destroy");
      if (stopOnDestroy) listeners.stop.forEach((listener) => listener());
    },
    onEnded: (listener) => listeners.ended.push(listener),
    onError: (listener) => listeners.error.push(listener),
    onStop: (listener) => listeners.stop.push(listener),
    emitEnded: () => listeners.ended.forEach((listener) => listener()),
    emitError: () => listeners.error.forEach((listener) => listener({ errCode: 1, errMsg: "old" })),
    emitStop: () => listeners.stop.forEach((listener) => listener()),
    events,
  };
  return audio;
};

const trackAudios = [];
const shownTrackIds = [];
const playbackErrors = [];
const trackController = createTrackAudioController(
  () => {
    const audio = createFakeTrackAudio();
    trackAudios.push(audio);
    return audio;
  },
  (trackId) => shownTrackIds.push(trackId),
  (error) => playbackErrors.push(error),
);

trackController.toggle("track-a", "audio-a.mp3");
assert.deepEqual(
  trackAudios[0].events,
  ["src:audio-a.mp3", "play"],
  "首次播放必须先设置 src 再播放，不能提前 stop",
);
assert.deepEqual(shownTrackIds, ["track-a"]);

trackController.toggle("track-b", "audio-b.mp3");
assert.deepEqual(
  trackAudios[0].events,
  ["src:audio-a.mp3", "play", "destroy"],
  "切换音轨时应先销毁旧播放会话",
);
assert.deepEqual(
  trackAudios[1].events,
  ["src:audio-b.mp3", "play"],
  "新音轨应使用独立播放会话",
);
assert.equal(shownTrackIds.at(-1), "track-b");

trackAudios[0].emitStop();
trackAudios[0].emitEnded();
trackAudios[0].emitError();
assert.equal(
  shownTrackIds.at(-1),
  "track-b",
  "旧会话迟到的 stop/end/error 都不能清空新音轨状态",
);
assert.equal(playbackErrors.length, 0, "旧会话的错误不能误报到新播放");

trackAudios[1].emitEnded();
assert.equal(shownTrackIds.at(-1), null, "当前音轨结束后应恢复未播放状态");
assert.equal(trackAudios[1].events.at(-1), "destroy", "结束后应释放音频实例");

const synchronousAudios = [];
const synchronousTrackIds = [];
const synchronousController = createTrackAudioController(
  () => {
    const audio = createFakeTrackAudio({ stopOnDestroy: true });
    synchronousAudios.push(audio);
    return audio;
  },
  (trackId) => synchronousTrackIds.push(trackId),
);
synchronousController.toggle("track-a", "audio-a.mp3");
synchronousController.toggle("track-b", "audio-b.mp3");
assert.equal(
  synchronousTrackIds.at(-1),
  "track-b",
  "销毁时同步到达的旧 onStop 不能覆盖新音轨状态",
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
const checkInDetailConfig = fs.readFileSync(
  path.join(
    projectRoot,
    "src/pages/CheckInDetail/CheckInDetail.config.ts",
  ),
  "utf8",
);

assert.match(
  checkInDetailConfig,
  /homeButton:\s*true/,
  "分享详情页应在系统导航栏显示原生首页按钮",
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
  /formatPlaybackDurationLabel\(\s*isPlaying,\s*playbackPositionMs,\s*detail\.durationMs,?\s*\)/,
  "分享页应使用经过行为测试的播放时长标签函数",
);

console.log("音频播放测试通过：首次停止保护、离页停止与分享进度均正确。");

const { createPage, elements, textOf, byClass } = require("./test-practice-book-route.cjs");

async function testBookPlaybackLifecycle() {
  const page = createPage("src/pages/Practice/Practice.tsx", { bookId: "22", practice: "0" });
  let tree = page.render();
  byClass(tree, "audio-hotspot").props.onClick();
  const firstModelAudio = page.audios.at(-1);
  byClass(tree, "practice-header__directory").props.onClick();
  tree = page.render();
  assert.equal(firstModelAudio.events.includes("destroy"), false, "打开目录只是布局变化，不能停止示范音频");
  const directory = elements(tree).find((node) => node.type?.name === "PracticeDirectory");
  await directory.props.onSelect(1);
  assert.ok(firstModelAudio.events.includes("destroy"), "换训练应通过现有控制器销毁旧示范音频");
  tree = page.render();
  page.recorderHandlers.Stop({ tempFilePath: "/tmp/recording.mp3", duration: 1200 });
  tree = page.render();
  elements(tree).find((node) => node.type === "Button" && textOf(node) === "回听录音").props.onClick();
  const recording = page.audios.find((audio) => audio.src === "/tmp/recording.mp3");
  const previousStops = recording.events.filter((event) => event === "stop").length;
  byClass(tree, "practice-header__directory").props.onClick();
  tree = page.render();
  assert.equal(recording.events.filter((event) => event === "stop").length, previousStops, "打开目录不能停止录音回听");
  await elements(tree).find((node) => node.type?.name === "PracticeDirectory").props.onSelect(2);
  assert.ok(recording.events.includes("stop"), "换训练应停止旧录音回听");
  for (const route of [{ bookId: "25", practice: "0" }, { bookId: "25", practice: "23" }]) {
    tree = page.render();
    byClass(tree, "audio-hotspot").props.onClick();
    const oldModel = page.audios.at(-1);
    // 为回听上下文保留已加载源，验证路由卸载也清理这一路音频。
    const oldRecording = page.audios.findLast((audio) => !audio.events.includes("destroy") && audio !== oldModel);
    oldRecording.src = "/tmp/old-recording.mp3";
    tree = page.setRoute(route);
    assert.ok(oldModel.events.includes("destroy"), "换书/路由训练应通过现有控制器销毁旧示范音频");
    assert.ok(oldRecording.events.includes("stop"), "换书/路由训练应停止旧录音回听");
    assert.ok(oldRecording.events.includes("destroy"), "旧会话的回听上下文应释放");
    assert.equal(textOf(byClass(tree, "practice-header__course")), "Reading Explorer 5");
  }
  console.log("音频教材回归通过：换书、换训练停止两路音频，目录布局变化保持播放。");
}
testBookPlaybackLifecycle().catch((error) => { console.error(error); process.exitCode = 1; });
