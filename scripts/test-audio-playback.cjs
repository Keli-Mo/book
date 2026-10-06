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

const createFakeTrackAudio = ({ eventsOnDestroy = [] } = {}) => {
  let source = "";
  const events = [];
  const listeners = {
    canplay: [],
    ended: [],
    error: [],
    pause: [],
    play: [],
    stop: [],
    timeUpdate: [],
    waiting: [],
  };

  const audio = {
    loop: true,
    currentTime: 0,
    duration: 0,
    paused: true,
    playbackRate: 1,
    get src() { return source; },
    set src(value) {
      source = value;
      events.push(`src:${value}`);
    },
    play: () => {
      audio.paused = false;
      events.push("play");
    },
    pause: () => {
      audio.paused = true;
      events.push("pause");
    },
    seek: (seconds) => {
      audio.currentTime = seconds;
      events.push(`seek:${seconds}`);
    },
    destroy: () => {
      events.push("destroy");
      for (const event of eventsOnDestroy) {
        const callbacks = listeners[event];
        callbacks.forEach((listener) => listener(event === "error" ? { errCode: 2, errMsg: "destroy" } : undefined));
      }
    },
    onCanplay: (listener) => listeners.canplay.push(listener),
    onEnded: (listener) => listeners.ended.push(listener),
    onError: (listener) => listeners.error.push(listener),
    onPause: (listener) => listeners.pause.push(listener),
    onPlay: (listener) => listeners.play.push(listener),
    onStop: (listener) => listeners.stop.push(listener),
    onTimeUpdate: (listener) => listeners.timeUpdate.push(listener),
    onWaiting: (listener) => listeners.waiting.push(listener),
    emitCanplay: () => listeners.canplay.forEach((listener) => listener()),
    emitEnded: () => listeners.ended.forEach((listener) => listener()),
    emitError: () => listeners.error.forEach((listener) => listener({ errCode: 1, errMsg: "old" })),
    emitPause: () => listeners.pause.forEach((listener) => listener()),
    emitPlay: () => listeners.play.forEach((listener) => listener()),
    emitStop: () => listeners.stop.forEach((listener) => listener()),
    emitTimeUpdate: () => listeners.timeUpdate.forEach((listener) => listener()),
    emitWaiting: () => listeners.waiting.forEach((listener) => listener()),
    events,
  };
  return audio;
};

const trackAudios = [];
const shownTrackIds = [];
const playbackErrors = [];
const playbackStarts = [];
const playbackPauses = [];
const playbackTimes = [];
const playbackBufferingEvents = [];
const trackController = createTrackAudioController(
  () => {
    const audio = createFakeTrackAudio();
    trackAudios.push(audio);
    return audio;
  },
  (trackId) => shownTrackIds.push(trackId),
  (error) => playbackErrors.push(error),
  {
    onPlay: () => playbackStarts.push("play"),
    onPause: () => playbackPauses.push("pause"),
    onTimeUpdate: (currentTime, duration) => playbackTimes.push([currentTime, duration]),
    onWaiting: () => playbackBufferingEvents.push("waiting"),
    onCanplay: () => playbackBufferingEvents.push("canplay"),
  },
  { sameTrackAction: "pause" },
);

trackController.toggle("track-a", "audio-a.mp3");
assert.deepEqual(
  trackAudios[0].events,
  ["src:audio-a.mp3", "play"],
  "首次播放必须先设置 src 再播放，不能提前 stop",
);
assert.deepEqual(shownTrackIds, ["track-a"]);
trackAudios[0].currentTime = 1.25;
trackAudios[0].duration = 8.75;
trackAudios[0].emitPlay();
trackAudios[0].emitTimeUpdate();
assert.deepEqual(playbackStarts, ["play"], "当前会话的 onPlay 应转发给页面 hook");
assert.deepEqual(
  playbackTimes,
  [[1.25, 8.75]],
  "当前会话的 onTimeUpdate 应同时转发 currentTime 与 duration",
);

trackController.toggle("track-a", "audio-a.mp3");
assert.equal(trackAudios.length, 1, "同一音轨暂停时必须保留原音频实例");
assert.deepEqual(
  trackAudios[0].events,
  ["src:audio-a.mp3", "play", "pause"],
  "同一音轨播放中再次点击应 pause，不能 destroy 或回到开头",
);
trackAudios[0].emitPause();
assert.deepEqual(playbackPauses, ["pause"], "当前会话的 onPause 应转发给页面 hook");
assert.equal(shownTrackIds.at(-1), "track-a", "暂停期间应保留当前音轨，供原实例续播");

trackController.toggle("track-a", "audio-a.mp3");
assert.equal(trackAudios.length, 1, "暂停后继续不得新建音频实例");
assert.deepEqual(
  trackAudios[0].events,
  ["src:audio-a.mp3", "play", "pause", "play"],
  "暂停后再次点击应在原实例调用 play 继续",
);
const pauseCountBeforeLateNativePause = playbackPauses.length;
trackAudios[0].emitPause();
assert.equal(
  playbackPauses.length,
  pauseCountBeforeLateNativePause,
  "恢复播放后迟到的原生 Pause 不能覆盖当前播放态",
);
trackAudios[0].paused = true;
trackAudios[0].emitPause();
assert.equal(
  playbackPauses.length,
  pauseCountBeforeLateNativePause + 1,
  "原生实例确实停止时必须同步真实暂停态",
);
const playCountBeforeRecoveringNativePause = trackAudios[0].events.filter((event) => event === "play").length;
trackController.toggle("track-a", "audio-a.mp3");
assert.equal(
  trackAudios[0].events.filter((event) => event === "play").length,
  playCountBeforeRecoveringNativePause + 1,
  "真实原生暂停后再次点击应恢复原会话",
);

assert.equal(typeof trackController.seek, "function", "示范音频控制器应提供可拖动进度条使用的 seek");
trackController.seek(4.5);
assert.equal(trackAudios[0].currentTime, 4.5, "seek 应把当前实例定位到指定秒数");
assert.equal(trackAudios[0].events.at(-1), "seek:4.5", "seek 必须调用原生音频定位能力");

assert.equal(typeof trackController.setPlaybackRate, "function", "示范音频控制器应支持设置倍速");
trackController.setPlaybackRate(1.25);
assert.equal(trackAudios[0].playbackRate, 1.25, "1.25× 应立即应用到正在播放的实例");

trackController.toggle("track-b", "audio-b.mp3");
assert.deepEqual(
  trackAudios[0].events,
  ["src:audio-a.mp3", "play", "pause", "play", "play", "seek:4.5", "destroy"],
  "切换音轨时应先销毁旧播放会话",
);
assert.deepEqual(
  trackAudios[1].events,
  ["src:audio-b.mp3", "play"],
  "新音轨应使用独立播放会话",
);
assert.equal(trackAudios[1].playbackRate, 1.25, "用户选择的 1.25× 应沿用到随后播放的音轨");
assert.equal(shownTrackIds.at(-1), "track-b");

trackAudios[0].emitStop();
trackAudios[0].emitEnded();
trackAudios[0].emitError();
trackAudios[0].currentTime = 9;
trackAudios[0].emitPlay();
trackAudios[0].emitTimeUpdate();
assert.equal(
  shownTrackIds.at(-1),
  "track-b",
  "旧会话迟到的 stop/end/error 都不能清空新音轨状态",
);
assert.equal(playbackErrors.length, 0, "旧会话的错误不能误报到新播放");
assert.deepEqual(playbackStarts, ["play"], "旧会话迟到的 play 不能复活页面播放态");
assert.deepEqual(playbackTimes, [[1.25, 8.75]], "旧会话迟到的 timeUpdate 不能覆盖新会话进度");

trackAudios[1].currentTime = 2.5;
trackAudios[1].duration = 12;
trackAudios[1].emitPlay();
trackAudios[1].emitTimeUpdate();
assert.deepEqual(playbackStarts, ["play", "play"]);
assert.deepEqual(playbackTimes, [[1.25, 8.75], [2.5, 12]]);

trackAudios[1].emitWaiting();
assert.deepEqual(
  playbackBufferingEvents,
  ["waiting"],
  "当前音轨数据不足时应通知页面进入缓冲态",
);
trackAudios[1].emitCanplay();
assert.deepEqual(
  playbackBufferingEvents,
  ["waiting", "canplay"],
  "缓冲恢复后应通知页面退出缓冲态",
);
assert.equal(
  trackAudios[1].events.at(-1),
  "play",
  "仍有播放意图时，音频恢复可播后应主动续播",
);
trackAudios[1].emitWaiting();
trackController.toggle("track-b", "audio-b.mp3");
const playCountAfterUserPause = trackAudios[1].events.filter((event) => event === "play").length;
trackAudios[1].emitCanplay();
assert.equal(
  trackAudios[1].events.filter((event) => event === "play").length,
  playCountAfterUserPause,
  "用户在缓冲期间主动暂停后，迟到的 Canplay 不能擅自恢复播放",
);
const playbackStartCountAfterUserPause = playbackStarts.length;
trackAudios[1].paused = false;
trackAudios[1].emitPlay();
assert.equal(
  playbackStarts.length,
  playbackStartCountAfterUserPause,
  "用户取消播放后迟到的原生 Play 事件不能把页面重新切回播放态",
);
assert.equal(trackAudios[1].events.at(-1), "pause", "迟到的原生 Play 应立即被当前暂停意图纠正");

trackAudios[1].emitEnded();
assert.equal(shownTrackIds.at(-1), null, "当前音轨结束后应恢复未播放状态");
assert.equal(trackAudios[1].events.at(-1), "destroy", "结束后应释放音频实例");

const loopingAudios = [];
const loopingTrackIds = [];
const loopingController = createTrackAudioController(
  () => {
    const audio = createFakeTrackAudio();
    loopingAudios.push(audio);
    return audio;
  },
  (trackId) => loopingTrackIds.push(trackId),
  undefined,
  {},
  { sameTrackAction: "pause", loop: true },
);
loopingController.toggle("looping-track", "looping.mp3");
loopingAudios[0].emitEnded();
assert.equal(
  loopingTrackIds.at(-1),
  "looping-track",
  "原生循环音轨发出 Ended 时不能清空当前播放会话",
);
assert.equal(
  loopingAudios[0].events.includes("destroy"),
  false,
  "原生循环音轨发出 Ended 时不能销毁仍需循环的实例",
);
loopingController.dispose();

const interruptedAudios = [];
const interruptedController = createTrackAudioController(
  () => {
    const audio = createFakeTrackAudio();
    interruptedAudios.push(audio);
    return audio;
  },
  () => {},
  undefined,
  {},
  { sameTrackAction: "pause" },
);
interruptedController.toggle("interrupted-track", "interrupted.mp3");
assert.equal(
  typeof interruptedController.handleInterruptionBegin,
  "function",
  "音频控制器应能记录系统音频中断开始",
);
assert.equal(
  typeof interruptedController.handleInterruptionEnd,
  "function",
  "音频控制器应能在系统音频中断结束后恢复播放",
);
interruptedController.handleInterruptionBegin();
interruptedAudios[0].paused = true;
interruptedAudios[0].emitPause();
interruptedController.handleInterruptionEnd();
assert.equal(
  interruptedAudios[0].events.at(-1),
  "play",
  "系统音频中断结束后应恢复中断前仍有播放意图的会话",
);
interruptedController.toggle("interrupted-track", "interrupted.mp3");
const playCountBeforePausedInterruption = interruptedAudios[0].events.filter((event) => event === "play").length;
interruptedController.handleInterruptionBegin();
interruptedController.toggle("interrupted-track", "interrupted.mp3");
assert.equal(
  interruptedAudios[0].events.filter((event) => event === "play").length,
  playCountBeforePausedInterruption,
  "系统中断尚未结束时，用户请求继续只能记录播放意图，不能提前调用 play",
);
interruptedController.handleInterruptionEnd();
assert.equal(
  interruptedAudios[0].events.filter((event) => event === "play").length,
  playCountBeforePausedInterruption + 1,
  "暂停会话在系统中断期间请求继续后，应等中断结束再播放",
);
interruptedController.handleInterruptionBegin();
interruptedController.toggle("interrupted-track", "interrupted.mp3");
const playCountAfterCancellation = interruptedAudios[0].events.filter((event) => event === "play").length;
interruptedController.handleInterruptionEnd();
assert.equal(
  interruptedAudios[0].events.filter((event) => event === "play").length,
  playCountAfterCancellation,
  "用户在系统中断期间主动取消播放后，中断结束不能再次复活音频",
);
interruptedController.dispose();

const deferredInterruptionAudios = [];
const deferredInterruptionController = createTrackAudioController(
  () => {
    const audio = createFakeTrackAudio();
    deferredInterruptionAudios.push(audio);
    return audio;
  },
  () => {},
  undefined,
  {},
  { sameTrackAction: "pause" },
);
deferredInterruptionController.handleInterruptionBegin();
deferredInterruptionController.toggle("started-during-interruption", "deferred.mp3");
assert.deepEqual(
  deferredInterruptionAudios[0].events,
  ["src:deferred.mp3"],
  "系统音频中断期间新建的会话只能装载音源，不能提前调用必然失败的 play",
);
deferredInterruptionController.toggle("switched-during-interruption", "switched.mp3");
assert.deepEqual(
  deferredInterruptionAudios[0].events,
  ["src:deferred.mp3", "destroy"],
  "系统中断期间切换音轨应释放旧会话",
);
assert.deepEqual(
  deferredInterruptionAudios[1].events,
  ["src:switched.mp3"],
  "系统中断期间切换到的新音轨仍应等待中断结束",
);
deferredInterruptionController.handleInterruptionEnd();
assert.equal(
  deferredInterruptionAudios[1].events.at(-1),
  "play",
  "系统音频中断结束后应只播放中断期间最后选中的会话",
);
deferredInterruptionController.dispose();

const hooklessAudios = [];
const hooklessTrackIds = [];
const hooklessController = createTrackAudioController(
  () => {
    const audio = createFakeTrackAudio();
    hooklessAudios.push(audio);
    return audio;
  },
  (trackId) => hooklessTrackIds.push(trackId),
  undefined,
  {},
  { sameTrackAction: "pause" },
);
hooklessController.toggle("model", "model.mp3");
hooklessAudios[0].emitPlay();
hooklessAudios[0].emitTimeUpdate();
hooklessController.toggle("model", "model.mp3");
assert.deepEqual(hooklessTrackIds, ["model"], "未提供 hooks 时暂停也应保留当前音轨");
assert.equal(hooklessAudios[0].events.at(-1), "pause", "未提供 hooks 时同轨第二次点击仍应暂停而非释放");
hooklessController.toggle("model", "model.mp3");
assert.equal(hooklessAudios.length, 1, "未提供 hooks 时续播仍应复用原实例");
assert.equal(hooklessAudios[0].events.at(-1), "play", "未提供 hooks 时第三次点击应从暂停位置续播");

const synchronousAudios = [];
const synchronousTrackIds = [];
const synchronousHooks = [];
const synchronousController = createTrackAudioController(
  () => {
    const audio = createFakeTrackAudio({ eventsOnDestroy: ["play", "timeUpdate", "stop", "ended", "error"] });
    synchronousAudios.push(audio);
    return audio;
  },
  (trackId) => synchronousTrackIds.push(trackId),
  () => synchronousHooks.push("error"),
  {
    onPlay: () => synchronousHooks.push("play"),
    onTimeUpdate: () => synchronousHooks.push("time"),
  },
);
synchronousController.toggle("track-a", "audio-a.mp3");
synchronousController.toggle("track-b", "audio-b.mp3");
assert.equal(
  synchronousTrackIds.at(-1),
  "track-b",
  "销毁时同步到达的旧 onStop 不能覆盖新音轨状态",
);
assert.deepEqual(synchronousHooks, [], "destroy 同步触发的全部旧事件必须在销毁前失效");
synchronousController.dispose();
synchronousAudios[1].emitPlay();
synchronousAudios[1].emitTimeUpdate();
synchronousAudios[1].emitStop();
synchronousAudios[1].emitEnded();
synchronousAudios[1].emitError();
assert.deepEqual(synchronousHooks, [], "dispose 后到达的全部事件必须保持失效");
assert.equal(synchronousTrackIds.at(-1), "track-b", "dispose 不应额外通知页面状态");

let modelStopCount = 0;
let recordingStopCount = 0;
stopPracticePlayback(
  { stop: () => { modelStopCount += 1; } },
  { stop: () => { recordingStopCount += 1; } },
);
assert.equal(modelStopCount, 1, "页面隐藏时应停止示范音频");
assert.equal(recordingStopCount, 1, "页面隐藏时应停止录音回听");

assert.equal(getPlaybackPositionMs(0.99, 5000), 0, "未满一秒时显示 0 秒");
assert.equal(getPlaybackPositionMs(2.99, 5000), 2000, "当前秒数应向下取整");
assert.equal(getPlaybackPositionMs(8, 5000), 5000, "进度不能超过总时长");
assert.equal(getPlaybackPositionMs(-2, 5000), 0, "负数进度应归零");
assert.equal(getPlaybackPositionMs(Number.NaN, 5000), 0, "无效进度应归零");
assert.equal(getPlaybackPositionMs(Number.POSITIVE_INFINITY, 5000), 0, "无限进度应归零");

const practice = fs.readFileSync(
  path.join(projectRoot, "src/pages/Practice/PracticeSession.tsx"),
  "utf8",
);
const practiceStyles = fs.readFileSync(
  path.join(projectRoot, "src/pages/Practice/Practice.scss"),
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
const checkInNavigation = fs.readFileSync(
  path.join(projectRoot, "src/pages/CheckInDetail/CheckInNavigation.tsx"),
  "utf8",
);

assert.match(
  checkInDetailConfig,
  /navigationStyle:\s*["']custom["']/,
  "分享详情页应启用包含真实返回入口的自定义导航",
);
assert.match(checkInNavigation, /aria-label=['"]返回首页['"]/, "自定义导航应提供可访问的首页入口");
assert.match(checkInNavigation, /Taro\.reLaunch\(\{\s*url:\s*["']\/pages\/Home\/Home["']\s*\}\)/, "首页入口应真实返回首页");

assert.match(practice, /useDidHide/, "训练页应监听页面隐藏");
const practiceHiddenBody = practice.match(
  /const handlePracticeHidden = useCallback\(\(\) => \{([\s\S]*?)\n  \}, \[/,
)?.[1] || "";
const practiceHideBody = practice.match(
  /useDidHide\(\(\) => \{([\s\S]*?)\n  \}\);/,
)?.[1] || "";
assert.match(practiceHideBody, /handlePracticeHidden\(\)/, "Page.onHide 应调用统一隐藏清理");
assert.match(
  practiceHiddenBody,
  /stopPracticePlayback\(\s*modelAudioControllerRef\.current,\s*recordingAudioRef\.current,?\s*\)/,
  "训练页统一隐藏清理应停止示范音频和录音回听",
);
assert.doesNotMatch(
  practiceHiddenBody,
  /recorderRef|resetRecording|recorder\.stop/,
  "训练页隐藏时不能停止或丢弃正在进行的录音",
);
assert.doesNotMatch(
  practice,
  /modelAudioRef\.current\?\.stop\(\)|recordingAudioRef\.current\?\.(?:src|play)/,
  "训练页不能绕过控制器直接操作可能为空源的原生音频",
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
  /onTimeUpdate:\s*\(seconds\)\s*=>[\s\S]*?getPlaybackPositionMs\(seconds, durationRef\.current\)/,
  "分享页应通过控制器 hook 读取并裁剪实时播放进度",
);
const detailHideBody = checkInDetail.match(
  /useDidHide\(\(\) => \{([\s\S]*?)\n  \}\);/,
)?.[1] || "";
assert.match(
  detailHideBody,
  /audioControllerRef\.current\?\.stop\(\)/,
  "分享页隐藏回调本身应停止音频",
);
assert.match(
  detailHideBody,
  /setPlaybackPositionMs\(0\)/,
  "分享页隐藏回调本身应清零播放进度",
);
assert.match(
  checkInDetail,
  /formatPlaybackDurationLabel\(isPlaying,\s*playbackPositionMs,\s*values\.durationMs\)/,
  "分享页应使用经过行为测试的播放时长标签函数",
);

console.log("音频播放测试通过：首次停止保护、离页停止与分享进度均正确。");

const { createPage, elements, textOf, byClass, buildBookPracticeBundle } = require("./test-practice-book-route.cjs");

const loadedBookImageFixture = {
  getImageInfo({ success }) {
    success?.({ width: 1588, height: 2245 });
  },
  createSelectorQuery() {
    let callback;
    const query = {
      select() { return query; },
      boundingClientRect(next) { callback = next; return query; },
      exec() { callback?.({ width: 374, height: 560 }); },
    };
    return query;
  },
};
const renderAfterBookImageLoaded = async (page) => {
  page.render();
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
  return page.render();
};
const relativeLuminance = (hexColor) => {
  const channels = String(hexColor).match(/[0-9a-f]{2}/gi)?.map((channel) => parseInt(channel, 16) / 255) || [];
  if (channels.length !== 3) return Number.NaN;
  const linear = channels.map((channel) => channel <= 0.03928
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4);
  return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
};
const contrastRatio = (first, second) => {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05);
};

async function testBookPlaybackLifecycle() {
  const audioPages = buildBookPracticeBundle("22").practices;
  const practiceToasts = [];
  const page = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    {
      showToast: ({ title }) => practiceToasts.push(title),
      taroOverrides: loadedBookImageFixture,
    },
  );
  let tree = await renderAfterBookImageLoaded(page);
  byClass(tree, "audio-hotspot").props.onClick();
  const firstModelAudio = page.audios.at(-1);
  assert.equal(firstModelAudio.loop, true, "教材示范音频应启用原生单段循环，播完继续播放当前音源");
  firstModelAudio.currentTime = 3.5;
  firstModelAudio.duration = 12;
  firstModelAudio.trigger("TimeUpdate");
  tree = page.render();

  const modelPlayer = byClass(tree, "practice-model-player");
  assert.ok(modelPlayer, "示范音频开始后页面应显示常驻播放器");
  const progressRow = byClass(tree, "practice-header__progress-row");
  const bookViewport = byClass(tree, "practice-book-viewport");
  assert.ok(
    elements(progressRow).includes(modelPlayer),
    "示范播放器应放入标题下方现有进度行，避免悬浮遮挡教材页面",
  );
  assert.equal(
    elements(bookViewport).includes(modelPlayer),
    false,
    "示范播放器不能继续覆盖在教材书页 viewport 内",
  );
  let modelProgress = byClass(tree, "practice-model-player__progress");
  assert.equal(modelProgress?.type, "Slider", "示范播放器应使用可拖动的 Slider 进度条");
  assert.equal(modelProgress.props.value, 3.5, "进度条应显示 currentTime");
  assert.equal(modelProgress.props.max, 12, "进度条上限应使用音频 duration");
  assert.ok(
    contrastRatio(modelProgress.props.backgroundColor, "#e7f3ee") >= 3,
    "未播放进度轨道与播放器底色至少应达到 3:1 对比度，真机上不能融进背景",
  );
  assert.ok(modelProgress.props.blockSize >= 18, "进度滑块触点不能继续使用接近最小值的 14PX");

  let modelToggle = byClass(tree, "practice-model-player__toggle");
  assert.doesNotMatch(textOf(modelToggle), /暂停|继续|播放/, "播放控制按钮可见内容应只使用图标");
  assert.match(String(modelToggle.props["aria-label"] || ""), /暂停/, "播放中图标按钮应通过 aria-label 说明暂停操作");
  modelToggle.props.onClick();
  assert.equal(page.audios.length, 1, "暂停示范音频不能创建或销毁原实例");
  assert.equal(firstModelAudio.events.at(-1), "pause", "播放器暂停按钮应调用原生 pause");
  tree = page.render();
  modelToggle = byClass(tree, "practice-model-player__toggle");
  assert.doesNotMatch(textOf(modelToggle), /暂停|继续|播放/, "暂停后的控制按钮也只能显示图标");
  assert.match(String(modelToggle.props["aria-label"] || ""), /继续|播放/, "暂停后图标按钮应通过 aria-label 说明继续操作");
  byClass(tree, "audio-hotspot").props.onClick();
  assert.equal(page.audios.length, 1, "同一热点继续播放必须复用原音频实例");
  assert.equal(firstModelAudio.events.at(-1), "play", "同一热点再次点击应从暂停位置继续");

  modelProgress = byClass(page.render(), "practice-model-player__progress");
  modelProgress.props.onChanging({ detail: { value: 7 } });
  tree = page.render();
  assert.equal(
    elements(tree).find((node) => node.type === "Swiper")?.props.disableTouch,
    true,
    "拖动音频进度时必须锁定教材 Swiper，避免误翻页",
  );
  modelProgress = byClass(tree, "practice-model-player__progress");
  modelProgress.props.onChange({ detail: { value: 7 } });
  assert.equal(firstModelAudio.currentTime, 7, "松开进度条后应 seek 到用户选择的秒数");
  assert.equal(firstModelAudio.events.at(-1), "seek:7", "进度条拖动应调用当前实例的 seek");
  tree = page.render();
  assert.equal(
    elements(tree).find((node) => node.type === "Swiper")?.props.disableTouch,
    false,
    "结束拖动后应恢复教材 Swiper",
  );

  firstModelAudio.duration = 12.2;
  firstModelAudio.trigger("TimeUpdate");
  tree = page.render();
  modelProgress = byClass(tree, "practice-model-player__progress");
  modelProgress.props.onChanging({ detail: { value: 13 } });
  modelProgress = byClass(page.render(), "practice-model-player__progress");
  modelProgress.props.onChange({ detail: { value: 13 } });
  assert.equal(firstModelAudio.currentTime, 12.2, "拖到整数刻度末端时 seek 不能超过真实小数时长");
  tree = page.render();
  assert.equal(
    byClass(tree, "practice-model-player__progress").props.value,
    12.2,
    "拖动结束后的 UI 进度也必须裁剪到真实小数时长",
  );
  assert.equal(
    textOf(byClass(tree, "practice-model-player__time")),
    "0:12 / 0:12",
    "小数时长音频不能显示当前进度超过总时长",
  );

  let rateTrigger = byClass(tree, "practice-model-player__rate");
  assert.match(textOf(rateTrigger), /1(?:\.0)?\s*[x×]/i, "倍速入口默认应显示当前 1× 倍速");
  assert.equal(byClass(tree, "practice-model-player__rate-menu"), undefined, "未点击倍速入口时不应预先展开菜单");
  await rateTrigger.props.onClick();
  tree = page.render();
  assert.equal(page.actionSheetCalls.length, 0, "点击倍速入口不应再打开底部微信 ActionSheet");
  const rateMenu = byClass(tree, "practice-model-player__rate-menu");
  assert.ok(rateMenu, "点击倍速入口应在播放器附近展开内联菜单");
  const modelPlayerWithRateMenu = byClass(tree, "practice-model-player");
  const viewportWithRateMenu = byClass(tree, "practice-book-viewport");
  assert.ok(
    elements(modelPlayerWithRateMenu).includes(rateMenu),
    "倍速菜单必须锚定在 practice-model-player 内",
  );
  assert.equal(
    elements(viewportWithRateMenu).includes(rateMenu),
    false,
    "倍速菜单不能挂载到教材书页 viewport 内",
  );
  const rateOptions = elements(rateMenu).filter((node) =>
    String(node.props?.className || "").split(" ").includes("practice-model-player__rate-option"),
  );
  assert.equal(rateOptions.length, 5, "内联倍速菜单应提供五个选项");
  assert.deepEqual(
    rateOptions.map((option) => textOf(option).trim()),
    ["0.75×", "1.0×", "1.25×", "1.5×", "2.0×"],
    "内联倍速菜单应严格提供 0.75×、1.0×、1.25×、1.5× 和 2.0×",
  );
  await rateOptions[2].props.onClick();
  assert.equal(firstModelAudio.playbackRate, 1.25, "选择 1.25× 后应立即应用到当前音频");
  tree = page.render();
  assert.equal(byClass(tree, "practice-model-player__rate-menu"), undefined, "选择倍速后应立即收起内联菜单");
  rateTrigger = byClass(tree, "practice-model-player__rate");
  assert.match(textOf(rateTrigger), /1\.25\s*[x×]/i, "选择后倍速入口应显示当前 1.25×");

  const progressStyle = practiceStyles.match(
    /\.practice-model-player\s*\{[\s\S]*?&__progress\s*\{([\s\S]*?)\n\s*\}/,
  )?.[1] || "";
  assert.match(
    progressStyle,
    /transform:\s*translateY\(7PX\)\s*;/i,
    "Slider 应按实测偏差下移 7PX，使原生轨道在变薄的播放器内视觉居中",
  );
  const modelPlayerStyle = practiceStyles.match(
    /\.practice-model-player\s*\{([\s\S]*?)\n\s*&__toggle/,
  )?.[1] || "";
  assert.match(modelPlayerStyle, /width:\s*auto\s*;/i, "播放器应恢复横向自适应长度");
  assert.match(modelPlayerStyle, /max-width:\s*520PX\s*;/i, "播放器横向长度应继续沿用宽屏上限");
  assert.match(modelPlayerStyle, /height:\s*38PX\s*;/i, "播放器应缩小上下厚度，而不是缩短横向长度");
  assert.match(modelPlayerStyle, /min-height:\s*38PX\s*;/i, "播放器的最小上下厚度应同步缩小");
  assert.match(modelPlayerStyle, /flex:\s*1\s*;/i, "播放器应继续占用标题行可用的横向空间");
  const modelPlayerControlStyle = practiceStyles.match(
    /&__toggle,\s*\n\s*&__rate\s*\{([\s\S]*?)\n\s*\}/,
  )?.[1] || "";
  assert.match(modelPlayerControlStyle, /width:\s*44PX\s*;/i, "播放与倍速按钮应保留 44PX 横向占位与命中盒");
  assert.match(modelPlayerControlStyle, /height:\s*44PX\s*;/i, "播放与倍速按钮应保留 44PX 纵向命中盒");
  assert.match(modelPlayerControlStyle, /border:\s*3PX\s+solid\s+transparent\s*;/i,
    "按钮应使用透明边框把可见背景压薄至 38PX");
  assert.match(modelPlayerControlStyle, /background-clip:\s*padding-box\s*;/i,
    "按钮背景只能绘制在 38PX 可见区域内");
  const headerActionsStyle = practiceStyles.match(
    /&__actions\s*\{([^}]*)\}/,
  )?.[1] || "";
  assert.match(headerActionsStyle, /display:\s*flex\s*;/i, "放大查看与目录应组成固定操作组");
  assert.match(headerActionsStyle, /flex:\s*none\s*;/i, "右侧操作组不能被播放器压缩");
  assert.match(headerActionsStyle, /margin-left:\s*auto\s*;/i, "右侧操作组应始终锚定在行尾");
  assert.match(headerActionsStyle, /gap:\s*0\s*;/i, "放大查看应紧靠目录");
  assert.doesNotMatch(
    practiceStyles,
    /\.practice-header__progress-row--audio-active\s+\.practice-header__directory\s*\{[^}]*margin-left:\s*auto\s*;/i,
    "音频出现后不能再给目录单独分配自动边距，否则会拆开放大查看与目录",
  );
  const baseProgressRowStyle = practiceStyles.match(
    /\.practice-header\s*\{[\s\S]*?&__progress-row\s*\{([\s\S]*?)&--audio-active/,
  )?.[1] || "";
  assert.match(
    baseProgressRowStyle,
    /min-height:\s*44PX\s*;/i,
    "播放前后的进度行应显式保留同一 44PX 高度，不能依赖目录按钮间接撑高导致书页跳动",
  );
  const rateMenuStyle = practiceStyles.match(
    /(?:&__rate-menu|\.practice-model-player__rate-menu)\s*\{([\s\S]*?)\n\s*\}/,
  )?.[1] || "";
  assert.match(
    practiceStyles,
    /\.practice-model-player\s*\{[\s\S]{0,400}?position:\s*relative\s*;/i,
    "播放器应建立相对定位上下文，让内联倍速菜单锚定在组件边上",
  );
  assert.match(rateMenuStyle, /position:\s*absolute\s*;/i, "倍速菜单应绝对定位，不挤动播放器和书页");
  assert.match(rateMenuStyle, /top:\s*calc\(100%\s*\+\s*[^)]+\)\s*;/i,
    "倍速菜单应紧贴播放器下沿展开，而不是固定在屏幕底部");
  assert.doesNotMatch(rateMenuStyle, /position:\s*fixed\s*;/i,
    "倍速菜单不能退化为覆盖屏幕底部的 fixed 面板");

  const conservativeDevicePage = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    {
      canIUse: (schema) => schema !== "InnerAudioContext.playbackRate",
      taroOverrides: loadedBookImageFixture,
    },
  );
  let conservativeDeviceTree = await renderAfterBookImageLoaded(conservativeDevicePage);
  byClass(conservativeDeviceTree, "audio-hotspot").props.onClick();
  conservativeDeviceTree = conservativeDevicePage.render();
  const conservativeRateTrigger = byClass(conservativeDeviceTree, "practice-model-player__rate");
  assert.ok(
    conservativeRateTrigger,
    "机型能力探测返回 false 时也必须显示倍速入口，避免华为等模拟机误隐藏",
  );
  conservativeRateTrigger.props.onClick();
  conservativeDeviceTree = conservativeDevicePage.render();
  const conservativeRateOptions = elements(
    byClass(conservativeDeviceTree, "practice-model-player__rate-menu"),
  ).filter((node) =>
    String(node.props?.className || "").split(" ").includes("practice-model-player__rate-option"),
  );
  conservativeRateOptions[4].props.onClick();
  assert.equal(
    conservativeDevicePage.audios.at(-1).playbackRate,
    2,
    "能力探测误报时仍应把用户选择的 2× 写入真实音频实例",
  );

  const pausesBeforePageTurn = firstModelAudio.events.filter((event) => event === "pause").length;
  byClass(tree, "practice-header__directory").props.onClick();
  tree = page.render();
  assert.equal(firstModelAudio.events.includes("destroy"), false, "打开目录只是布局变化，不能停止示范音频");
  const directory = elements(tree).find((node) => node.type?.name === "PracticeDirectory");
  await directory.props.onSelect(audioPages[1].imageIndex);
  assert.equal(firstModelAudio.events.includes("destroy"), false, "目录换页后示范音频必须继续播放");
  assert.equal(
    firstModelAudio.events.filter((event) => event === "pause").length,
    pausesBeforePageTurn,
    "目录换页不能暂停示范音频",
  );
  tree = page.render();
  const progressBeforeSwipe = textOf(byClass(tree, "practice-header__progress"));
  await elements(tree).find((node) => node.type === "Swiper").props.onChange({
    detail: { current: 2, source: "touch" },
  });
  tree = page.render();
  assert.equal(textOf(byClass(tree, "practice-header__progress")), progressBeforeSwipe,
    "手势动画完成前不得提前提交当前训练页");
  assert.equal(firstModelAudio.paused, false, "手势动画过程中示范音频应继续播放");
  await elements(tree).find((node) => node.type === "Swiper").props.onAnimationFinish({
    detail: { current: 2, source: "touch" },
  });
  assert.notEqual(textOf(byClass(page.render(), "practice-header__progress")), progressBeforeSwipe,
    "手势动画结束后应真正提交目标训练页");
  assert.equal(firstModelAudio.events.includes("destroy"), false, "手势翻页后示范音频必须继续播放");
  assert.equal(firstModelAudio.paused, false, "手势翻页不能暂停示范音频");
  tree = page.render();
  await page.recorderHandlers.Stop({ tempFilePath: "/tmp/recording.mp3", duration: 1200 });
  tree = page.render();
  elements(tree).find((node) => node.type === "Button" && textOf(node) === "回听录音").props.onClick();
  const recordingA = page.audios.find((audio) => audio.src === "/tmp/recording.mp3");
  assert.equal(recordingA.loop, false, "教材单段循环不能改变录音回听的单次播放行为");
  tree = page.render();
  assert.ok(elements(tree).some((node) => node.type === "Button" && textOf(node) === "停止回听"), "A 原生 onPlay 后应显示停止按钮");
  elements(tree).find((node) => node.type === "Button" && textOf(node) === "停止回听").props.onClick();
  assert.equal(recordingA.events.at(-1), "destroy", "录音回听第二次点击仍应停止并释放，不能改成暂停");
  tree = page.render();
  elements(tree).find((node) => node.type === "Button" && textOf(node) === "回听录音").props.onClick();
  const recordingB = page.audios.findLast((audio) => audio.src === "/tmp/recording.mp3");
  assert.notEqual(recordingB, recordingA, "再次回听必须创建独立 B 会话");
  const toastCountBeforeOldEvents = practiceToasts.length;
  for (const event of ["Play", "TimeUpdate", "Stop", "Ended", "Error"]) {
    recordingA.trigger(event, event === "Error" ? { errCode: 1, errMsg: "old" } : undefined);
  }
  tree = page.render();
  assert.ok(elements(tree).some((node) => node.type === "Button" && textOf(node) === "停止回听"), "A 的全部迟到事件不能清空 B 播放态");
  assert.equal(practiceToasts.length, toastCountBeforeOldEvents, "A 的迟到错误不能额外弹提示");
  recordingB.trigger("Ended");
  tree = page.render();
  assert.ok(elements(tree).some((node) => node.type === "Button" && textOf(node) === "回听录音"), "B 正常结束应复位按钮");
  elements(tree).find((node) => node.type === "Button" && textOf(node) === "回听录音").props.onClick();
  const recordingC = page.audios.findLast((audio) => audio.src === "/tmp/recording.mp3");
  recordingC.trigger("Error", { errCode: 2, errMsg: "current" });
  tree = page.render();
  assert.ok(elements(tree).some((node) => node.type === "Button" && textOf(node) === "回听录音"), "当前会话报错应复位按钮");
  assert.equal(practiceToasts.at(-1), "录音回听失败", "仅当前回听错误应显示固定提示");
  elements(tree).find((node) => node.type === "Button" && textOf(node) === "回听录音").props.onClick();
  const recording = page.audios.findLast((audio) => audio.src === "/tmp/recording.mp3");
  const previousStops = recording.events.filter((event) => event === "stop").length;
  byClass(tree, "practice-header__directory").props.onClick();
  tree = page.render();
  assert.equal(recording.events.filter((event) => event === "stop").length, previousStops, "打开目录不能停止录音回听");
  await elements(tree).find((node) => node.type?.name === "PracticeDirectory").props.onSelect(audioPages[2].imageIndex);
  assert.equal(recording.events.includes("destroy"), false, "教材翻页应保留当前录音回听会话");
  assert.ok(elements(page.render()).some((node) => node.type === "Button" && textOf(node) === "停止回听"), "翻页后应继续显示当前录音的停止回听按钮");

  tree = page.render();
  byClass(tree, "audio-hotspot").props.onClick();
  const oldModel = page.audios.at(-1);
  tree = page.setRoute({ bookId: "25", practice: "0" });
  assert.ok(oldModel.events.includes("destroy"), "换书/路由训练应通过现有控制器销毁旧示范音频");
  assert.equal(textOf(byClass(tree, "practice-header__course")), "Reading Explorer 5");

  await page.recorderHandlers.Stop({ tempFilePath: "/tmp/old-recording.mp3", duration: 1200 });
  tree = page.render();
  elements(tree).find((node) => node.type === "Button" && textOf(node) === "回听录音").props.onClick();
  const oldRecording = page.audios.find((audio) => audio.src === "/tmp/old-recording.mp3");
  tree = page.setRoute({ bookId: "25", practice: "23" });
  assert.ok(oldRecording.events.includes("destroy"), "换书/路由训练应释放旧录音回听会话");
  assert.equal(textOf(byClass(tree, "practice-header__course")), "Reading Explorer 5");
  console.log("音频教材回归通过：示范音频可暂停、拖动、多档倍速和跨页续播，换书仍释放会话。");
}

async function testSameUrlPlaybackAcrossPages() {
  const audioPages = buildBookPracticeBundle("7").practices;
  const firstPage = audioPages.find((entry) => entry.pageNumber === 61);
  const secondPage = audioPages.find((entry) => entry.pageNumber === 62);
  const firstTrack = firstPage?.tracks[0];
  const secondTrack = secondPage?.tracks[0];
  assert.ok(firstPage && secondPage && firstTrack && secondTrack, "教材 7 应保留跨页共用音频的真实回归样本");
  assert.notEqual(firstTrack.id, secondTrack.id, "真实回归样本必须来自不同页面、不同 trackId");
  assert.equal(firstTrack.url, secondTrack.url, "真实回归样本的两个热点必须指向同一音频 URL");

  const page = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "7", page: String(firstPage.imageIndex) },
    { taroOverrides: loadedBookImageFixture },
  );
  try {
    let tree = await renderAfterBookImageLoaded(page);
    byClass(tree, "audio-hotspot").props.onClick();
    const sharedAudio = page.audios.at(-1);
    sharedAudio.currentTime = 6.25;
    sharedAudio.duration = 18;
    sharedAudio.trigger("TimeUpdate");

    tree = await renderAfterBookImageLoaded(page);
    const progressBeforeSwipe = textOf(byClass(tree, "practice-header__progress"));
    await elements(tree).find((node) => node.type === "Swiper").props.onChange({
      detail: { current: secondPage.imageIndex, source: "touch" },
    });
    tree = page.render();
    assert.equal(textOf(byClass(tree, "practice-header__progress")), progressBeforeSwipe,
      "共用音频跨页时也应等待手势动画结束再提交业务页");
    await elements(tree).find((node) => node.type === "Swiper").props.onAnimationFinish({
      detail: { current: secondPage.imageIndex, source: "touch" },
    });
    tree = await renderAfterBookImageLoaded(page);
    assert.notEqual(textOf(byClass(tree, "practice-header__progress")), progressBeforeSwipe,
      "共用音频跨页测试必须真正进入后一页");
    let sharedHotspot = byClass(tree, "audio-hotspot");
    assert.match(
      sharedHotspot.props.className,
      /audio-hotspot--playing/,
      "翻到不同 trackId 但 URL 相同的下一页时，热点仍应代表当前播放实例",
    );
    assert.match(textOf(sharedHotspot), /Ⅱ/, "跨页共用音频的热点应继续显示播放中");

    sharedHotspot.props.onClick();
    assert.equal(page.audios.length, 1, "点击跨页同 URL 热点只能暂停原实例，不能新建并从 0 播放");
    assert.equal(sharedAudio.events.at(-1), "pause", "点击跨页同 URL 热点应暂停原实例");
    assert.equal(sharedAudio.events.includes("destroy"), false, "暂停跨页同 URL 音频不能销毁原实例");
    assert.equal(sharedAudio.currentTime, 6.25, "暂停跨页同 URL 音频必须保留原播放进度");

    tree = page.render();
    sharedHotspot = byClass(tree, "audio-hotspot");
    assert.match(sharedHotspot.props.className, /audio-hotspot--paused/, "暂停后当前页热点应显示可继续状态");
    sharedHotspot.props.onClick();
    assert.equal(page.audios.length, 1, "继续跨页同 URL 音频必须复用原实例");
    assert.equal(sharedAudio.events.at(-1), "play", "暂停后再次点击应在原实例继续播放");
    assert.equal(sharedAudio.currentTime, 6.25, "继续播放不能把跨页共用音频重置到 0");
  } finally {
    page.dispose();
  }
}

async function testPlaybackScreenAwakeLifecycle() {
  const keepScreenOnCalls = [];
  let interruptionBegin;
  let interruptionEnd;
  let removedInterruptionBegin;
  let removedInterruptionEnd;
  let disposed = false;
  const page = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    {
      taroOverrides: {
        ...loadedBookImageFixture,
        setKeepScreenOn: async ({ keepScreenOn }) => {
          keepScreenOnCalls.push(keepScreenOn);
        },
        onAudioInterruptionBegin: (callback) => { interruptionBegin = callback; },
        onAudioInterruptionEnd: (callback) => { interruptionEnd = callback; },
        offAudioInterruptionBegin: (callback) => { removedInterruptionBegin = callback; },
        offAudioInterruptionEnd: (callback) => { removedInterruptionEnd = callback; },
      },
    },
  );
  try {
    let tree = await renderAfterBookImageLoaded(page);
    assert.equal(typeof interruptionBegin, "function", "训练页应监听系统音频中断开始事件");
    assert.equal(typeof interruptionEnd, "function", "训练页应监听系统音频中断结束事件");
    byClass(tree, "audio-hotspot").props.onClick();
    await Promise.resolve();
    assert.equal(
      keepScreenOnCalls.at(-1),
      true,
      "示范音频开始播放时应保持屏幕常亮，避免锁屏触发页面隐藏并销毁音频",
    );

    const modelAudio = page.audios.at(-1);
    modelAudio.trigger("Waiting");
    tree = page.render();
    assert.match(
      String(byClass(tree, "practice-model-player__toggle").props["aria-label"] || ""),
      /缓冲/,
      "远程音频数据不足时播放器应明确显示缓冲态，不能继续假装正在播放",
    );
    assert.match(
      byClass(tree, "practice-model-player__play-icon").props.className,
      /practice-model-player__play-icon--buffering/,
      "缓冲时播放按钮应显示现有控件内的加载图标",
    );
    assert.equal(keepScreenOnCalls.at(-1), true, "短暂缓冲期间仍应保持屏幕常亮");
    modelAudio.trigger("Canplay");
    tree = page.render();
    assert.match(
      String(byClass(tree, "practice-model-player__toggle").props["aria-label"] || ""),
      /暂停/,
      "缓冲恢复并收到原生 Play 后应回到播放态",
    );

    byClass(tree, "practice-model-player__toggle").props.onClick();
    await Promise.resolve();
    assert.equal(keepScreenOnCalls.at(-1), false, "用户暂停示范音频后应释放常亮");

    tree = page.render();
    byClass(tree, "practice-model-player__toggle").props.onClick();
    await Promise.resolve();
    assert.equal(keepScreenOnCalls.at(-1), true, "用户继续播放后应重新保持屏幕常亮");

    const playCountBeforeInterruption = modelAudio.events.filter((event) => event === "play").length;
    interruptionBegin();
    modelAudio.paused = true;
    modelAudio.trigger("Pause");
    await Promise.resolve();
    assert.equal(keepScreenOnCalls.at(-1), false, "系统音频中断开始后应释放屏幕常亮");
    interruptionEnd();
    await Promise.resolve();
    assert.equal(
      modelAudio.events.filter((event) => event === "play").length,
      playCountBeforeInterruption + 1,
      "页面仍可见时，系统音频中断结束后应恢复原播放会话",
    );
    assert.equal(keepScreenOnCalls.at(-1), true, "系统中断恢复后的原生 Play 应重新保持屏幕常亮");
    modelAudio.trigger("Pause");
    await Promise.resolve();
    tree = page.render();
    assert.equal(keepScreenOnCalls.at(-1), true, "恢复后迟到的 Pause 不能再次关闭屏幕常亮");
    assert.match(
      String(byClass(tree, "practice-model-player__toggle").props["aria-label"] || ""),
      /暂停/,
      "恢复后迟到的 Pause 不能把界面覆盖成暂停态",
    );

    interruptionBegin();
    page.hide();
    await Promise.resolve();
    assert.equal(keepScreenOnCalls.at(-1), false, "页面隐藏并停止播放时应释放屏幕常亮");
    const playCountAfterHide = modelAudio.events.filter((event) => event === "play").length;
    interruptionEnd();
    assert.equal(
      modelAudio.events.filter((event) => event === "play").length,
      playCountAfterHide,
      "页面隐藏并释放会话后，迟到的系统中断结束事件不能复活音频",
    );

    page.dispose();
    disposed = true;
    assert.equal(removedInterruptionBegin, interruptionBegin, "卸载时应移除同一个系统中断开始监听函数");
    assert.equal(removedInterruptionEnd, interruptionEnd, "卸载时应移除同一个系统中断结束监听函数");
  } finally {
    if (!disposed) page.dispose();
  }
}

async function testBufferingRecoveryWithoutRepeatedPlayEvent() {
  const page = createPage(
    "src/pages/Practice/Practice.tsx",
    { bookId: "22", practice: "0" },
    {
      deferAudioPlay: true,
      taroOverrides: loadedBookImageFixture,
    },
  );
  try {
    let tree = await renderAfterBookImageLoaded(page);
    byClass(tree, "audio-hotspot").props.onClick();
    tree = page.render();
    assert.match(
      String(byClass(tree, "practice-model-player__toggle").props["aria-label"] || ""),
      /缓冲/,
      "音源已经选中但尚未收到原生 Play 时应显示缓冲态",
    );

    const modelAudio = page.audios.at(-1);
    modelAudio.trigger("Play");
    modelAudio.trigger("Waiting");
    tree = page.render();
    assert.match(
      String(byClass(tree, "practice-model-player__toggle").props["aria-label"] || ""),
      /缓冲/,
      "原生 Waiting 后应进入缓冲态",
    );

    const playCountBeforeCanplay = modelAudio.events.filter((event) => event === "play").length;
    modelAudio.trigger("Canplay");
    tree = page.render();
    assert.equal(
      modelAudio.events.filter((event) => event === "play").length,
      playCountBeforeCanplay + 1,
      "缓冲恢复时控制器应主动请求续播",
    );
    assert.match(
      String(byClass(tree, "practice-model-player__toggle").props["aria-label"] || ""),
      /暂停/,
      "系统未重复派发 Play 时，Canplay 也应让界面退出缓冲态",
    );
  } finally {
    page.dispose();
  }
}

testBookPlaybackLifecycle()
  .then(testSameUrlPlaybackAcrossPages)
  .then(testBufferingRecoveryWithoutRepeatedPlayEvent)
  .then(testPlaybackScreenAwakeLifecycle)
  .catch((error) => { console.error(error); process.exitCode = 1; });
