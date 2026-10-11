/* eslint-disable import/no-commonjs */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");

const sourcePath = path.resolve(__dirname, "../src/features/listeningPractice/recorderCoordinator.ts");
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});
const moduleContainer = { exports: {} };
vm.runInNewContext(compiled.outputText, {
  module: moduleContainer,
  exports: moduleContainer.exports,
  Promise,
  Set,
  Map,
  Object,
  Array,
  Number,
  String,
  RegExp,
  globalThis: {},
});
const { createRecorderCoordinator } = moduleContainer.exports;
assert.equal(typeof createRecorderCoordinator, "function");

const createNativeRecorder = (overrides = {}) => {
  const listeners = {};
  const registered = {};
  const calls = { start: 0, stop: 0 };
  const manager = {
    onStart(fn) { registered.start = (registered.start || 0) + 1; listeners.start = fn; },
    onStop(fn) { registered.stop = (registered.stop || 0) + 1; listeners.stop = fn; },
    onError(fn) { registered.error = (registered.error || 0) + 1; listeners.error = fn; },
    onPause(fn) { registered.pause = (registered.pause || 0) + 1; listeners.pause = fn; },
    onResume(fn) { registered.resume = (registered.resume || 0) + 1; listeners.resume = fn; },
    onInterruptionBegin(fn) { registered.interruptionBegin = (registered.interruptionBegin || 0) + 1; listeners.interruptionBegin = fn; },
    onInterruptionEnd(fn) { registered.interruptionEnd = (registered.interruptionEnd || 0) + 1; listeners.interruptionEnd = fn; },
    start() { calls.start += 1; overrides.start?.(); },
    stop() { calls.stop += 1; overrides.stop?.(); },
  };
  return { manager, calls, registered, emit(name, value) { assert.equal(typeof listeners[name], "function"); listeners[name](value); } };
};

const createFakeScheduler = () => {
  let now = 0;
  let nextId = 1;
  const tasks = new Map();
  return {
    setTimeout(callback, delay) { const id = nextId++; tasks.set(id, { at: now + delay, callback }); return id; },
    clearTimeout(id) { tasks.delete(id); },
    advance(ms) {
      now += ms;
      [...tasks.entries()].filter(([, task]) => task.at <= now).sort((a, b) => a[1].at - b[1].at)
        .forEach(([id, task]) => { tasks.delete(id); task.callback(); });
    },
  };
};

const flushPromises = async () => { for (let index = 0; index < 6; index += 1) await Promise.resolve(); };
const options = { sampleRate: 16000, format: "mp3" };

const testEntryRecovery = async () => {
  const native = createNativeRecorder();
  const scheduler = createFakeScheduler();
  const coordinator = createRecorderCoordinator({ getRecorderManager: () => native.manager, scheduler, quietWindowMs: 10 });
  let finishSave;
  const saved = [];
  const recovery = {
    recover(result) {
      saved.push(result);
      return new Promise((resolve) => { finishSave = resolve; });
    },
  };
  assert.equal(coordinator.beginEntryRecovery(recovery), true, "入口检查应先取得全局恢复锁");
  assert.equal(coordinator.getEntryRecoveryStatus(), "waiting");
  assert.equal(coordinator.acquire().reason, "busy", "页面取得 owner 前就必须被入口锁拦住");
  assert.equal(native.calls.stop, 0, "冷启动只登记锁，不应未经用户选择就 stop 旧录音");
  assert.equal(saved.length, 0, "冷启动不应自动保存旧录音");
  assert.equal(coordinator.beginEntryRecovery(recovery), false, "恢复任务不能重复启动");
  assert.equal(await coordinator.retryEntryRecovery(), false, "明确选择继续等待后，尚无 onStop 不能假称完成");
  assert.equal(native.calls.stop, 1, "用户选择继续等待后才发出一次 stop");
  assert.equal(await coordinator.retryEntryRecovery(), false);
  assert.equal(native.calls.stop, 1, "重复等待不应重复发送 stop 干扰原生状态");
  scheduler.advance(120000);
  assert.equal(coordinator.getEntryRecoveryStatus(), "waiting", "超时不能替代真实 onStop");
  assert.equal(coordinator.acquire().reason, "busy");

  const oldResult = { duration: 2000, fileSize: 20, tempFilePath: "/tmp/page-a.mp3" };
  native.emit("stop", oldResult);
  await flushPromises();
  assert.equal(coordinator.getEntryRecoveryStatus(), "saving", "保存旧录音期间继续锁住新录音");
  assert.equal(coordinator.acquire().reason, "busy");
  assert.equal(saved.length, 1);
  assert.equal(saved[0], oldResult, "旧录音只能传给入口恢复回调");
  native.emit("stop", oldResult);
  assert.equal(saved.length, 1, "重复 onStop 不能二次保存");
  finishSave(true);
  await flushPromises();
  assert.equal(coordinator.getEntryRecoveryStatus(), "none");
  assert.equal(coordinator.acquire().reason, "busy", "恢复保存完成后还须等待静默窗口");
  scheduler.advance(9);
  assert.equal(coordinator.acquire().reason, "busy");
  scheduler.advance(1);
  assert.equal(coordinator.acquire().ok, true, "旧结果落盘并静默后允许新页录音");
  assert.equal(native.calls.stop, 1);
  assert.deepEqual(registeredCounts(native), { start: 1, stop: 1, error: 1, pause: 1, resume: 1, interruptionBegin: 1, interruptionEnd: 1 }, "入口恢复和新页获取 owner 共用一组原生监听");
};

const registeredCounts = (native) => ({ ...native.registered });

const testSpontaneousStopWaitsForChoice = async () => {
  const native = createNativeRecorder();
  const scheduler = createFakeScheduler();
  const coordinator = createRecorderCoordinator({ getRecorderManager: () => native.manager, scheduler, quietWindowMs: 10 });
  const oldResult = { duration: 1200, fileSize: 100, tempFilePath: "/tmp/spontaneous-old.mp3" };
  const saved = [];
  assert.equal(coordinator.beginEntryRecovery({ recover(result) { saved.push(result); return true; } }), true);
  native.emit("stop", oldResult);
  await flushPromises();
  assert.equal(saved.length, 0, "旧 onStop 自行到达时也不能绕过用户选择自动保存");
  assert.equal(coordinator.acquire().reason, "busy");
  assert.equal(await coordinator.retryEntryRecovery(), true, "明确继续等待后可保存已收到的旧文件");
  assert.deepEqual(saved, [oldResult]);
  scheduler.advance(10);
  assert.equal(coordinator.acquire().ok, true);
};

const testTerminalResultWaitsForChoice = async () => {
  const native = createNativeRecorder();
  const scheduler = createFakeScheduler();
  const coordinator = createRecorderCoordinator({ getRecorderManager: () => native.manager, scheduler, quietWindowMs: 10 });
  const oldResult = { duration: 1200, fileSize: 100, tempFilePath: "/tmp/previous-terminal.mp3" };
  const saved = [];
  assert.equal(coordinator.beginEntryRecovery({
    terminalResult: oldResult,
    recover(result) { saved.push(result); return true; },
  }), true);
  await flushPromises();
  assert.equal(coordinator.getEntryRecoveryStatus(), "waiting", "冷启动已有旧文件也应等用户选择");
  assert.equal(saved.length, 0, "已有旧文件不能在冷启动时自动保存");
  assert.equal(native.calls.stop, 0, "已有终止文件无需自动 stop");
  assert.equal(coordinator.acquire().reason, "busy", "等待用户选择时仍保护新录音入口");
  assert.equal(await coordinator.retryEntryRecovery(), true, "用户选择继续等待后才保存旧文件");
  assert.deepEqual(saved, [oldResult]);
  scheduler.advance(10);
  assert.equal(coordinator.acquire().ok, true);
};

const testFailedSaveRetry = async () => {
  const native = createNativeRecorder();
  const scheduler = createFakeScheduler();
  const coordinator = createRecorderCoordinator({ getRecorderManager: () => native.manager, scheduler, quietWindowMs: 10 });
  const oldResult = { tempFilePath: "/tmp/needs-retry.mp3" };
  let attempts = 0;
  assert.equal(coordinator.beginEntryRecovery({ recover(result) { assert.equal(result, oldResult); attempts += 1; return attempts > 1; } }), true);
  assert.equal(native.calls.stop, 0);
  assert.equal(await coordinator.retryEntryRecovery(), false);
  assert.equal(native.calls.stop, 1);
  native.emit("stop", oldResult);
  await flushPromises();
  assert.equal(coordinator.getEntryRecoveryStatus(), "failed", "旧录音保存失败时保留入口锁");
  assert.equal(coordinator.acquire().reason, "busy");
  scheduler.advance(120000);
  assert.equal(coordinator.acquire().reason, "busy", "保存失败不可通过等待自动解锁");
  assert.equal(await coordinator.retryEntryRecovery(), true, "用户重试应使用先前的原生结果继续保存");
  assert.equal(attempts, 2);
  assert.equal(native.calls.stop, 1, "重试保存不应再调用原生 stop");
  assert.equal(coordinator.getEntryRecoveryStatus(), "none");
  scheduler.advance(10);
  assert.equal(coordinator.acquire().ok, true);
};

const testNoTerminalKeepsLock = async () => {
  const native = createNativeRecorder({ stop() { throw new Error("native stop failed"); } });
  const scheduler = createFakeScheduler();
  const coordinator = createRecorderCoordinator({ getRecorderManager: () => native.manager, scheduler });
  let recovered = 0;
  assert.equal(coordinator.beginEntryRecovery({ recover() { recovered += 1; return true; } }), true);
  assert.equal(native.calls.stop, 0, "冷启动时不得自动操作原生录音器");
  assert.equal(await coordinator.retryEntryRecovery(), false);
  assert.equal(native.calls.stop, 1);
  scheduler.advance(86400000);
  assert.equal(coordinator.getEntryRecoveryStatus(), "waiting");
  assert.equal(coordinator.acquire().reason, "busy", "stop 抛错或无 onStop 都不能证明原生已空闲");
  assert.equal(await coordinator.retryEntryRecovery(), false);
  assert.equal(recovered, 0);
};

const testExplicitAbandonUnlocksWithoutRestart = () => {
  const native = createNativeRecorder({ stop() { throw new Error("native stop failed"); } });
  const scheduler = createFakeScheduler();
  const coordinator = createRecorderCoordinator({ getRecorderManager: () => native.manager, scheduler, abandonQuietWindowMs: 100 });
  let recovered = 0;
  assert.equal(coordinator.beginEntryRecovery({ recover() { recovered += 1; return true; } }), true);
  assert.equal(native.calls.stop, 0, "用户尚未选择时不能自动 stop");
  assert.equal(coordinator.abandonUnconfirmedRecording(), true, "用户明确放弃后应能在当前小程序中收口旧会话");
  assert.equal(native.calls.stop, 1, "用户选择放弃后才请求原生停止旧录音");
  assert.equal(coordinator.getEntryRecoveryStatus(), "none");
  assert.equal(coordinator.acquire().reason, "busy", "短暂隔离期内不能立即开始新录音");
  native.emit("stop", { tempFilePath: "/tmp/abandoned-a.mp3" });
  assert.equal(recovered, 0, "放弃后迟到的旧文件不能保存到任何页面");
  scheduler.advance(99);
  assert.equal(coordinator.acquire().reason, "busy");
  scheduler.advance(1);
  const next = coordinator.acquire();
  assert.equal(next.ok, true, "隔离期结束后无需重启微信即可尝试新录音");
  assert.equal(next.owner.start(options).ok, true);
};

const testStopTimeoutOffersEarlyAbandon = () => {
  const native = createNativeRecorder();
  const scheduler = createFakeScheduler();
  const coordinator = createRecorderCoordinator({ getRecorderManager: () => native.manager, scheduler, abandonQuietWindowMs: 100 });
  const acquired = coordinator.acquire();
  const errors = [];
  acquired.owner.subscribe({ onError(error) { errors.push(error); } });
  assert.equal(acquired.owner.start(options).ok, true);
  native.emit("start");
  assert.equal(acquired.owner.stop().ok, true);
  scheduler.advance(4999);
  assert.equal(errors.length, 0);
  scheduler.advance(1);
  assert.equal(errors[0]?.code, "RECORDER_OPERATION_TIMEOUT", "停止超过五秒应允许用户尽快处理");
  assert.equal(coordinator.abandonUnconfirmedRecording(), true);
  assert.equal(acquired.owner.start(options).reason, "released", "旧 owner 不能在放弃后重新开麦");
  scheduler.advance(100);
  assert.equal(coordinator.acquire().ok, true);
};

const testHiddenPageOffersEarlyAbandon = () => {
  const native = createNativeRecorder();
  const scheduler = createFakeScheduler();
  const coordinator = createRecorderCoordinator({ getRecorderManager: () => native.manager, scheduler, abandonQuietWindowMs: 100 });
  const acquired = coordinator.acquire();
  assert.equal(acquired.owner.start(options).ok, true);
  native.emit("start");
  assert.equal(acquired.owner.release().ok, true, "页面退出时应尝试结束录音");
  scheduler.advance(4999);
  assert.equal(coordinator.getPhase(), "draining");
  scheduler.advance(1);
  assert.equal(coordinator.getPhase(), "uncertain", "隐藏页五秒仍无结束回调时应开放放弃入口");
  assert.equal(coordinator.abandonUnconfirmedRecording(), true);
  scheduler.advance(100);
  assert.equal(coordinator.acquire().ok, true);
};

const testUnconfirmedStartQuarantine = () => {
  const native = createNativeRecorder();
  const scheduler = createFakeScheduler();
  const coordinator = createRecorderCoordinator({ getRecorderManager: () => native.manager, scheduler, quietWindowMs: 10 });
  const acquired = coordinator.acquire();
  assert.equal(acquired.ok, true);
  const stops = [];
  acquired.owner.subscribe({ onStop(result) { stops.push(result); } });
  assert.equal(acquired.owner.start(options).ok, true);
  assert.equal(coordinator.getPhase(), "starting");
  native.emit("stop", { tempFilePath: "/tmp/old-page-a.mp3" });
  assert.equal(stops.length, 0, "新录音未收到 onStart 时，迟到的旧 onStop 不得归给新 owner");
  assert.equal(coordinator.getPhase(), "starting", "旧停止回调不能结束已经发出的新 start");
  native.emit("start");
  assert.equal(coordinator.getPhase(), "recording", "新 onStart 仍须确认本次录音");
  assert.equal(acquired.owner.stop().ok, true);
  const newResult = { tempFilePath: "/tmp/new-page-b.mp3" };
  native.emit("stop", newResult);
  assert.deepEqual(stops, [newResult], "随后新录音的结束结果只能保存一次");
};

const testAbandonedOldStopAfterNewStart = () => {
  const native = createNativeRecorder();
  const scheduler = createFakeScheduler();
  const coordinator = createRecorderCoordinator({ getRecorderManager: () => native.manager, scheduler, abandonQuietWindowMs: 100 });
  let oldSaved = 0;
  assert.equal(coordinator.beginEntryRecovery({ recover() { oldSaved += 1; return true; } }), true);
  assert.equal(coordinator.abandonUnconfirmedRecording(), true);
  scheduler.advance(100);

  const next = coordinator.acquire();
  assert.equal(next.ok, true);
  const newStops = [];
  next.owner.subscribe({ onStop(result) { newStops.push(result); } });
  assert.equal(next.owner.start(options).ok, true);
  assert.equal(coordinator.getPhase(), "starting");
  native.emit("stop", { tempFilePath: "/tmp/abandoned-old.mp3" });
  assert.equal(oldSaved, 0, "放弃的旧录音不得再保存");
  assert.deepEqual(newStops, [], "迟到旧 onStop 不得归给新 owner");
  assert.equal(coordinator.getPhase(), "starting", "迟到旧 onStop 不得结束新录音的启动确认");

  native.emit("start");
  assert.equal(coordinator.getPhase(), "recording");
  assert.equal(next.owner.stop().ok, true);
  const newResult = { duration: 1200, fileSize: 100, tempFilePath: "/tmp/new-after-abandon.mp3" };
  native.emit("stop", newResult);
  assert.deepEqual(newStops, [newResult], "新录音停止结果只交付一次");
  assert.equal(oldSaved, 0);
};

Promise.resolve()
  .then(testAbandonedOldStopAfterNewStart)
  .then(testEntryRecovery)
  .then(testSpontaneousStopWaitsForChoice)
  .then(testTerminalResultWaitsForChoice)
  .then(testFailedSaveRetry)
  .then(testNoTerminalKeepsLock)
  .then(testExplicitAbandonUnlocksWithoutRestart)
  .then(testStopTimeoutOffersEarlyAbandon)
  .then(testHiddenPageOffersEarlyAbandon)
  .then(testUnconfirmedStartQuarantine)
  .then(() => console.log("入口录音恢复测试通过：冷启动锁、旧文件保存、失败重试、无回调隔离及监听唯一性。"))
  .catch((error) => { console.error(error); process.exitCode = 1; });
