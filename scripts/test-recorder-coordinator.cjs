/* eslint-disable import/no-commonjs */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");

const sourcePath = path.resolve(
  __dirname,
  "../src/features/listeningPractice/recorderCoordinator.ts",
);
assert.equal(fs.existsSync(sourcePath), true, "全局录音协调器模块应存在");

const loadCoordinator = (runtimeGlobal = {}) => {
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
    globalThis: runtimeGlobal,
  });
  return moduleContainer.exports;
};

const createNativeRecorder = (overrides = {}) => {
  const listenerCounts = {
    start: 0,
    pause: 0,
    resume: 0,
    stop: 0,
    error: 0,
    interruptionBegin: 0,
    interruptionEnd: 0,
  };
  const listeners = {};
  const calls = { start: [], pause: 0, resume: 0, stop: 0 };
  const manager = {
    onStart(listener) { listenerCounts.start += 1; if (overrides.onRegister) overrides.onRegister("start", listenerCounts.start); listeners.start = listener; },
    onPause(listener) { listenerCounts.pause += 1; if (overrides.onRegister) overrides.onRegister("pause", listenerCounts.pause); listeners.pause = listener; },
    onResume(listener) { listenerCounts.resume += 1; if (overrides.onRegister) overrides.onRegister("resume", listenerCounts.resume); listeners.resume = listener; },
    onStop(listener) { listenerCounts.stop += 1; if (overrides.onRegister) overrides.onRegister("stop", listenerCounts.stop); listeners.stop = listener; },
    onError(listener) { listenerCounts.error += 1; if (overrides.onRegister) overrides.onRegister("error", listenerCounts.error); listeners.error = listener; },
    onInterruptionBegin(listener) {
      listenerCounts.interruptionBegin += 1;
      if (overrides.onRegister) overrides.onRegister("interruptionBegin", listenerCounts.interruptionBegin); listeners.interruptionBegin = listener;
    },
    onInterruptionEnd(listener) {
      listenerCounts.interruptionEnd += 1;
      if (overrides.onRegister) overrides.onRegister("interruptionEnd", listenerCounts.interruptionEnd); listeners.interruptionEnd = listener;
    },
    start(options) {
      calls.start.push(options);
      if (overrides.start) return overrides.start(options, listeners);
    },
    pause() { calls.pause += 1; if (overrides.pause) return overrides.pause(); },
    resume() { calls.resume += 1; if (overrides.resume) return overrides.resume(); },
    stop() { calls.stop += 1; if (overrides.stop) return overrides.stop(); },
  };
  for (const name of overrides.missing || []) delete manager[name];
  return {
    manager,
    calls,
    listenerCounts,
    emit(name, payload) { listeners[name](payload); },
  };
};

const options = { sampleRate: 16000, numberOfChannels: 1, encodeBitRate: 48000, format: "mp3" };
const plain = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
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

const native = createNativeRecorder();
const { createRecorderCoordinator, getRecorderCoordinator } = loadCoordinator();
assert.equal(typeof createRecorderCoordinator, "function");
assert.equal(typeof getRecorderCoordinator, "function");

const stablePauseNative = createNativeRecorder();
const stablePauseScheduler = createFakeScheduler();
const stablePauseCoordinator = createRecorderCoordinator({
  getRecorderManager: () => stablePauseNative.manager,
  scheduler: stablePauseScheduler,
  operationTimeoutMs: 25,
});
const stablePauseOwner = stablePauseCoordinator.acquire().owner;
stablePauseOwner.start(options);
stablePauseNative.emit("start");
stablePauseOwner.pause();
stablePauseNative.emit("pause");
stablePauseNative.emit("interruptionBegin");
stablePauseNative.emit("interruptionBegin");
stablePauseScheduler.advance(100);
assert.equal(stablePauseNative.calls.stop, 0, "已确认暂停后重复系统打断不应强制结束");
assert.equal(stablePauseCoordinator.getPhase(), "paused");
stablePauseNative.emit("interruptionEnd");
assert.equal(stablePauseNative.calls.resume, 0, "中断结束不能自动继续");
assert.equal(stablePauseOwner.resume().ok, true);
stablePauseNative.emit("resume");
assert.equal(stablePauseCoordinator.getPhase(), "recording");

const pendingPauseNative = createNativeRecorder();
const pendingPauseScheduler = createFakeScheduler();
const pendingPauseCoordinator = createRecorderCoordinator({
  getRecorderManager: () => pendingPauseNative.manager,
  scheduler: pendingPauseScheduler,
  operationTimeoutMs: 25,
});
const pendingPauseOwner = pendingPauseCoordinator.acquire().owner;
pendingPauseOwner.start(options);
pendingPauseNative.emit("start");
pendingPauseOwner.pause();
pendingPauseScheduler.advance(24);
assert.equal(pendingPauseNative.calls.stop, 0, "pending pause 确认窗口内不得提前 stop");
pendingPauseScheduler.advance(1);
assert.equal(pendingPauseNative.calls.stop, 1, "pending pause 未收到确认必须触发安全 stop");
assert.equal(pendingPauseCoordinator.getPhase(), "stopping");

const primaryScheduler = createFakeScheduler();
const coordinator = createRecorderCoordinator({ getRecorderManager: () => native.manager, scheduler: primaryScheduler, quietWindowMs: 10 });
const first = coordinator.acquire();
assert.equal(first.ok, true);
assert.deepEqual(plain(first.capabilities), { canRecord: true, canPause: true, canResume: true, canInterrupt: true });
assert.deepEqual(native.listenerCounts, {
  start: 1, pause: 1, resume: 1, stop: 1, error: 1, interruptionBegin: 1, interruptionEnd: 1,
}, "每种原生事件只能注册一次");
assert.deepEqual(plain(first.owner.start(options)), { ok: true });
assert.deepEqual(native.calls.start, [options], "调用方录音参数必须透明传递");
assert.equal(first.owner.start(options).ok, false, "快速重复 start 必须无效");
assert.equal(native.calls.start.length, 1);
native.emit("start");
assert.equal(coordinator.getPhase(), "recording");
assert.deepEqual(plain(first.owner.pause()), { ok: true });
assert.equal(native.calls.pause, 1);
assert.equal(first.owner.pause().ok, false, "快速重复 pause 必须无效");
native.emit("pause");
assert.deepEqual(plain(first.owner.resume()), { ok: true });
assert.equal(native.calls.resume, 1);
assert.equal(first.owner.resume().ok, false, "快速重复 resume 必须无效");
native.emit("resume");
assert.deepEqual(plain(first.owner.stop()), { ok: true });
assert.equal(first.owner.stop().ok, false, "快速重复 stop 必须无效");
assert.equal(native.calls.stop, 1);
const firstStop = { duration: 1234.5, fileSize: 4567, tempFilePath: "/tmp/first.mp3" };
native.emit("stop", firstStop);
assert.equal(coordinator.getPhase(), "draining");
primaryScheduler.advance(10);
assert.equal(coordinator.getPhase(), "idle");

const startTimeoutNative = createNativeRecorder();
const startTimeoutScheduler = createFakeScheduler();
const startTimeoutCoordinator = createRecorderCoordinator({
  getRecorderManager: () => startTimeoutNative.manager,
  scheduler: startTimeoutScheduler,
  quietWindowMs: 10,
  drainTimeoutMs: 40,
});
const startTimeoutOwner = startTimeoutCoordinator.acquire();
const startTimeoutEvents = { errors: [], stops: [] };
startTimeoutOwner.owner.subscribe({
  onError(error) { startTimeoutEvents.errors.push(error); },
  onStop(result) { startTimeoutEvents.stops.push(result); },
});
assert.equal(startTimeoutOwner.owner.start(options).ok, true);
startTimeoutScheduler.advance(9999);
assert.equal(startTimeoutNative.calls.stop, 0, "start 确认窗口内不得提前 stop");
startTimeoutScheduler.advance(1);
assert.equal(startTimeoutNative.calls.stop, 1, "start 无 onStart/onError 时必须主动安全 stop");
assert.equal(startTimeoutCoordinator.getPhase(), "draining", "start 回调缺失后必须进入旧会话隔离态");
assert.match(String(startTimeoutEvents.errors[0]?.errMsg), /启动.*超时/, "页面必须收到可恢复的启动超时错误");
assert.equal(startTimeoutOwner.owner.start(options).reason, "busy", "旧 start 未收口前不能开启新会话");
startTimeoutNative.emit("stop", { tempFilePath: "/tmp/late-start.mp3" });
assert.deepEqual(startTimeoutEvents.stops, [], "start 超时后的迟到 terminal 不得冒充成功录音");
startTimeoutScheduler.advance(10);
assert.equal(startTimeoutOwner.owner.start(options).ok, true, "迟到 terminal 静默收口后应允许新会话");

const stopTimeoutNative = createNativeRecorder();
const stopTimeoutScheduler = createFakeScheduler();
const stopTimeoutCoordinator = createRecorderCoordinator({
  getRecorderManager: () => stopTimeoutNative.manager,
  scheduler: stopTimeoutScheduler,
  quietWindowMs: 10,
  drainTimeoutMs: 40,
});
const stopTimeoutOwner = stopTimeoutCoordinator.acquire();
const stopTimeoutEvents = { errors: [], stops: [] };
stopTimeoutOwner.owner.subscribe({
  onError(error) { stopTimeoutEvents.errors.push(error); },
  onStop(result) { stopTimeoutEvents.stops.push(result); },
});
stopTimeoutOwner.owner.start(options);
stopTimeoutNative.emit("start");
assert.equal(stopTimeoutOwner.owner.stop().ok, true);
stopTimeoutScheduler.advance(29999);
assert.equal(stopTimeoutCoordinator.getPhase(), "stopping", "stop 确认窗口内必须继续等待原生 terminal");
stopTimeoutScheduler.advance(1);
assert.equal(stopTimeoutCoordinator.getPhase(), "draining", "stop 无 onStop/onError 时必须进入有限隔离态");
assert.match(String(stopTimeoutEvents.errors[0]?.errMsg), /停止.*超时/, "页面必须收到可恢复的停止超时错误");
assert.equal(stopTimeoutOwner.owner.start(options).reason, "busy", "旧 stop 未收口前不能开启新会话");
const lateTimedOutStop = { tempFilePath: "/tmp/late-stop.mp3" };
stopTimeoutNative.emit("stop", lateTimedOutStop);
assert.deepEqual(stopTimeoutEvents.stops, [lateTimedOutStop], "stop 超时后的迟到结果仍必须交给原会话保存");
stopTimeoutScheduler.advance(10);
assert.equal(stopTimeoutOwner.owner.start(options).ok, true, "迟到 stop 静默收口后应允许新会话");

const pauseWatchdogNative = createNativeRecorder();
const pauseWatchdogScheduler = createFakeScheduler();
const pauseWatchdogCoordinator = createRecorderCoordinator({
  getRecorderManager: () => pauseWatchdogNative.manager,
  scheduler: pauseWatchdogScheduler,
  quietWindowMs: 10,
});
const pauseWatchdogOwner = pauseWatchdogCoordinator.acquire();
const pauseWatchdogStops = [];
pauseWatchdogOwner.owner.subscribe({ onStop(result) { pauseWatchdogStops.push(result); } });
pauseWatchdogOwner.owner.start(options);
pauseWatchdogNative.emit("start");
pauseWatchdogOwner.owner.pause();
pauseWatchdogScheduler.advance(999);
assert.equal(pauseWatchdogNative.calls.stop, 0, "pause 确认等待未满 1000ms 时不得提前 stop");
pauseWatchdogScheduler.advance(1);
assert.equal(pauseWatchdogNative.calls.stop, 1, "pause 确认超过 1000ms 未到必须触发安全 stop");
assert.equal(pauseWatchdogCoordinator.getPhase(), "stopping");
const pauseTimeoutStop = { duration: 1000, fileSize: 10, tempFilePath: "/tmp/pause-timeout.mp3" };
pauseWatchdogNative.emit("stop", pauseTimeoutStop);
assert.deepEqual(pauseWatchdogStops, [pauseTimeoutStop], "watchdog stop 的原生结果仍须交给当前 owner 保存");
pauseWatchdogScheduler.advance(10);

const resumeWatchdogNative = createNativeRecorder();
const resumeWatchdogScheduler = createFakeScheduler();
const resumeWatchdogCoordinator = createRecorderCoordinator({
  getRecorderManager: () => resumeWatchdogNative.manager,
  scheduler: resumeWatchdogScheduler,
  operationTimeoutMs: 25,
  quietWindowMs: 10,
});
const resumeWatchdogOwner = resumeWatchdogCoordinator.acquire();
resumeWatchdogOwner.owner.start(options);
resumeWatchdogNative.emit("start");
resumeWatchdogOwner.owner.pause();
resumeWatchdogNative.emit("pause");
resumeWatchdogOwner.owner.resume();
resumeWatchdogScheduler.advance(24);
assert.equal(resumeWatchdogNative.calls.stop, 0, "自定义 resume 确认窗口内不得提前 stop");
resumeWatchdogScheduler.advance(1);
assert.equal(resumeWatchdogNative.calls.stop, 1, "resume 确认超时必须触发安全 stop");
assert.equal(resumeWatchdogCoordinator.getPhase(), "stopping");

const confirmedNative = createNativeRecorder();
const confirmedScheduler = createFakeScheduler();
const confirmedCoordinator = createRecorderCoordinator({
  getRecorderManager: () => confirmedNative.manager,
  scheduler: confirmedScheduler,
  operationTimeoutMs: 25,
});
const confirmedOwner = confirmedCoordinator.acquire();
confirmedOwner.owner.start(options);
confirmedNative.emit("start");
confirmedOwner.owner.pause();
confirmedScheduler.advance(24);
confirmedNative.emit("pause");
confirmedScheduler.advance(100);
assert.equal(confirmedNative.calls.stop, 0, "及时 onPause 必须取消 watchdog");
confirmedOwner.owner.resume();
confirmedScheduler.advance(24);
confirmedNative.emit("resume");
confirmedScheduler.advance(100);
assert.equal(confirmedNative.calls.stop, 0, "及时 onResume 必须取消 watchdog");
confirmedOwner.owner.stop();
assert.equal(confirmedNative.calls.stop, 1, "确认成功后只允许用户 stop 一次");

const interruptionWatchdogNative = createNativeRecorder();
const interruptionWatchdogScheduler = createFakeScheduler();
const interruptionWatchdogCoordinator = createRecorderCoordinator({
  getRecorderManager: () => interruptionWatchdogNative.manager,
  scheduler: interruptionWatchdogScheduler,
  operationTimeoutMs: 25,
});
const interruptionWatchdogOwner = interruptionWatchdogCoordinator.acquire();
interruptionWatchdogOwner.owner.start(options);
interruptionWatchdogNative.emit("start");
interruptionWatchdogNative.emit("interruptionBegin");
interruptionWatchdogScheduler.advance(24);
assert.equal(interruptionWatchdogNative.calls.stop, 0, "系统中断确认窗口内不得提前 stop");
interruptionWatchdogScheduler.advance(1);
assert.equal(interruptionWatchdogNative.calls.stop, 1, "系统中断未返回 pause/stop/error 时必须安全 stop");
assert.equal(interruptionWatchdogCoordinator.getPhase(), "stopping");

const interruptionConfirmedNative = createNativeRecorder();
const interruptionConfirmedScheduler = createFakeScheduler();
const interruptionConfirmedCoordinator = createRecorderCoordinator({
  getRecorderManager: () => interruptionConfirmedNative.manager,
  scheduler: interruptionConfirmedScheduler,
  operationTimeoutMs: 25,
});
const interruptionConfirmedOwner = interruptionConfirmedCoordinator.acquire();
interruptionConfirmedOwner.owner.start(options);
interruptionConfirmedNative.emit("start");
interruptionConfirmedNative.emit("interruptionBegin");
interruptionConfirmedScheduler.advance(24);
interruptionConfirmedNative.emit("pause");
interruptionConfirmedScheduler.advance(100);
assert.equal(interruptionConfirmedNative.calls.stop, 0, "系统中断及时 onPause 必须取消 watchdog");

const resumeInterruptedNative = createNativeRecorder();
const resumeInterruptedScheduler = createFakeScheduler();
const resumeInterruptedCoordinator = createRecorderCoordinator({
  getRecorderManager: () => resumeInterruptedNative.manager,
  scheduler: resumeInterruptedScheduler,
  operationTimeoutMs: 25,
});
const resumeInterruptedOwner = resumeInterruptedCoordinator.acquire();
let resumeInterruptedEvents = 0;
resumeInterruptedOwner.owner.subscribe({ onResume() { resumeInterruptedEvents += 1; } });
resumeInterruptedOwner.owner.start(options);
resumeInterruptedNative.emit("start");
resumeInterruptedOwner.owner.pause();
resumeInterruptedNative.emit("pause");
resumeInterruptedOwner.owner.resume();
resumeInterruptedNative.emit("interruptionBegin");
resumeInterruptedScheduler.advance(24);
resumeInterruptedNative.emit("resume");
resumeInterruptedScheduler.advance(1);
assert.equal(resumeInterruptedNative.calls.stop, 1, "系统中断期间迟到 onResume 不得清除 watchdog");
assert.equal(resumeInterruptedCoordinator.getPhase(), "stopping");
assert.equal(resumeInterruptedEvents, 0, "系统中断期间不得把迟到 onResume 报告成恢复成功");

const resumeInterruptedPausedNative = createNativeRecorder();
const resumeInterruptedPausedScheduler = createFakeScheduler();
const resumeInterruptedPausedCoordinator = createRecorderCoordinator({
  getRecorderManager: () => resumeInterruptedPausedNative.manager,
  scheduler: resumeInterruptedPausedScheduler,
  operationTimeoutMs: 25,
});
const resumeInterruptedPausedOwner = resumeInterruptedPausedCoordinator.acquire();
resumeInterruptedPausedOwner.owner.start(options);
resumeInterruptedPausedNative.emit("start");
resumeInterruptedPausedOwner.owner.pause();
resumeInterruptedPausedNative.emit("pause");
resumeInterruptedPausedOwner.owner.resume();
resumeInterruptedPausedNative.emit("interruptionBegin");
resumeInterruptedPausedScheduler.advance(24);
resumeInterruptedPausedNative.emit("resume");
resumeInterruptedPausedNative.emit("pause");
resumeInterruptedPausedScheduler.advance(100);
assert.equal(resumeInterruptedPausedNative.calls.stop, 0, "迟到 onResume 后及时 onPause 必须正常取消中断 watchdog");
assert.equal(resumeInterruptedPausedCoordinator.getPhase(), "paused");

const releasedWatchdogNative = createNativeRecorder();
const releasedWatchdogScheduler = createFakeScheduler();
const releasedWatchdogCoordinator = createRecorderCoordinator({
  getRecorderManager: () => releasedWatchdogNative.manager,
  scheduler: releasedWatchdogScheduler,
  operationTimeoutMs: 25,
});
const releasedWatchdogOwner = releasedWatchdogCoordinator.acquire();
releasedWatchdogOwner.owner.start(options);
releasedWatchdogNative.emit("start");
releasedWatchdogOwner.owner.pause();
releasedWatchdogOwner.owner.release();
assert.equal(releasedWatchdogNative.calls.stop, 1, "release 应立即安全 stop");
releasedWatchdogScheduler.advance(25);
assert.equal(releasedWatchdogNative.calls.stop, 1, "release 必须清理 watchdog，不能重复 stop");

const terminalWatchdogNative = createNativeRecorder();
const terminalWatchdogScheduler = createFakeScheduler();
const terminalWatchdogCoordinator = createRecorderCoordinator({
  getRecorderManager: () => terminalWatchdogNative.manager,
  scheduler: terminalWatchdogScheduler,
  operationTimeoutMs: 25,
  quietWindowMs: 10,
});
const terminalWatchdogOwner = terminalWatchdogCoordinator.acquire();
terminalWatchdogOwner.owner.start(options);
terminalWatchdogNative.emit("start");
terminalWatchdogOwner.owner.pause();
terminalWatchdogNative.emit("stop", { tempFilePath: "/tmp/native-stop.mp3" });
terminalWatchdogScheduler.advance(25);
assert.equal(terminalWatchdogNative.calls.stop, 0, "原生 terminal 必须清理 watchdog，不能补发 stop");

const errorWatchdogNative = createNativeRecorder();
const errorWatchdogScheduler = createFakeScheduler();
const errorWatchdogCoordinator = createRecorderCoordinator({
  getRecorderManager: () => errorWatchdogNative.manager,
  scheduler: errorWatchdogScheduler,
  operationTimeoutMs: 25,
});
const errorWatchdogOwner = errorWatchdogCoordinator.acquire();
errorWatchdogOwner.owner.start(options);
errorWatchdogNative.emit("start");
errorWatchdogOwner.owner.pause();
errorWatchdogNative.emit("pause");
errorWatchdogOwner.owner.resume();
errorWatchdogNative.emit("error", { errMsg: "resume failed" });
errorWatchdogScheduler.advance(25);
assert.equal(errorWatchdogNative.calls.stop, 0, "原生 error 必须清理 watchdog，不能补发 stop");

const eventNative = createNativeRecorder();
const eventScheduler = createFakeScheduler();
const eventCoordinator = createRecorderCoordinator({ getRecorderManager: () => eventNative.manager, scheduler: eventScheduler, quietWindowMs: 10 });
const eventOwner = eventCoordinator.acquire();
const seen = { interruptionBegin: 0, interruptionEnd: 0, pause: 0, error: null, stops: [] };
const subscription = eventOwner.owner.subscribe({
  onInterruptionBegin() { seen.interruptionBegin += 1; },
  onInterruptionEnd() { seen.interruptionEnd += 1; },
  onPause() { seen.pause += 1; },
  onError(error) { seen.error = error; },
  onStop(result) { seen.stops.push(result); },
});
assert.equal(subscription.ok, true);
eventOwner.owner.start(options);
eventNative.emit("start");
eventNative.emit("interruptionBegin");
eventNative.emit("pause");
eventNative.emit("interruptionEnd");
assert.equal(eventNative.calls.pause, 0, "中断开始只能通知，不能伪造 pause");
assert.equal(eventNative.calls.resume, 0, "中断结束只能通知，不能自动 resume");
assert.equal(seen.pause, 1, "系统 interruption pause 必须转发");
assert.equal(eventCoordinator.getPhase(), "paused");
const nativeError = { errMsg: "native error", errno: 9 };
eventNative.emit("error", nativeError);
assert.equal(seen.error, nativeError, "必须保留底层 error 原对象");
eventScheduler.advance(10);
assert.equal(eventOwner.owner.start(options).ok, true, "错误后应可由当前 owner 重新开始");
eventNative.emit("start");
eventOwner.owner.stop();
const rawStop = { duration: 99.9, fileSize: 2, tempFilePath: "/tmp/raw.mp3" };
eventNative.emit("stop", rawStop);
assert.deepEqual(seen.stops, [rawStop], "onStop 必须原样转发原生结果");
assert.equal(seen.stops[0], rawStop, "onStop result 必须保持同一对象引用");
assert.equal(seen.interruptionBegin, 1);
assert.equal(seen.interruptionEnd, 1);
eventScheduler.advance(10);

const drainingNative = createNativeRecorder();
const drainingScheduler = createFakeScheduler();
const drainingCoordinator = createRecorderCoordinator({ getRecorderManager: () => drainingNative.manager, scheduler: drainingScheduler, quietWindowMs: 10 });
const oldOwner = drainingCoordinator.acquire();
const oldStops = [];
oldOwner.owner.subscribe({ onStop(result) { oldStops.push(result); } });
oldOwner.owner.start(options);
drainingNative.emit("start");
assert.deepEqual(plain(oldOwner.owner.release()), { ok: true, phase: "draining" });
assert.equal(drainingNative.calls.stop, 1, "释放活动 owner 只能 stop 一次");
assert.equal(oldOwner.owner.release().ok, false, "重复 release 必须无效");
assert.deepEqual(
  plain(drainingCoordinator.acquire()),
  { ok: false, reason: "busy", phase: "draining" },
  "draining 时 acquire 必须直接返回 busy，页面才能按同一契约自动重试",
);
const staleStop = { duration: 12.5, fileSize: 1, tempFilePath: "/tmp/stale.mp3" };
drainingNative.emit("stop", staleStop);
assert.deepEqual(oldStops, [], "release 后旧 owner 不得接收回调");
drainingScheduler.advance(10);
const newOwner = drainingCoordinator.acquire();
assert.equal(newOwner.ok, true);
const newStops = [];
newOwner.owner.subscribe({ onStop(result) { newStops.push(result); } });
assert.deepEqual(plain(newOwner.owner.start(options)), { ok: true });
drainingNative.emit("start");
newOwner.owner.stop();
const newStop = { duration: 22.5, fileSize: 3, tempFilePath: "/tmp/new.mp3" };
drainingNative.emit("stop", newStop);
assert.deepEqual(newStops, [newStop]);
drainingScheduler.advance(10);
assert.equal(newOwner.owner.subscribe({}).ok, true, "当前 owner 应可订阅");
assert.equal(oldOwner.owner.subscribe({}).ok, false, "release 后不可重新订阅旧 owner");

const drainErrorNative = createNativeRecorder();
const drainErrorScheduler = createFakeScheduler();
const drainErrorCoordinator = createRecorderCoordinator({ getRecorderManager: () => drainErrorNative.manager, scheduler: drainErrorScheduler, quietWindowMs: 10 });
const drainErrorOld = drainErrorCoordinator.acquire();
drainErrorOld.owner.start(options);
drainErrorNative.emit("start");
drainErrorOld.owner.release();
assert.equal(drainErrorCoordinator.acquire().reason, "busy");
const staleError = { errMsg: "old session stopped" };
drainErrorNative.emit("error", staleError);
drainErrorScheduler.advance(10);
const drainErrorNew = drainErrorCoordinator.acquire();
assert.equal(drainErrorNew.owner.start(options).ok, true, "旧 error 消费后应允许新 session 启动");

const missingNative = createNativeRecorder({ missing: ["pause", "resume", "onInterruptionBegin", "onInterruptionEnd"] });
const missingCoordinator = createRecorderCoordinator({ getRecorderManager: () => missingNative.manager });
const missingOwner = missingCoordinator.acquire();
assert.equal(missingOwner.ok, true, "缺少可选能力不能崩溃");
assert.deepEqual(plain(missingOwner.capabilities), { canRecord: true, canPause: false, canResume: false, canInterrupt: false });
missingOwner.owner.start(options);
missingNative.emit("start");
assert.deepEqual(plain(missingOwner.owner.pause()), { ok: false, reason: "unsupported", capability: "pause" });
assert.deepEqual(plain(missingOwner.owner.resume()), { ok: false, reason: "unsupported", capability: "resume" });

const unavailable = createRecorderCoordinator({ getRecorderManager: () => undefined });
assert.deepEqual(plain(unavailable.acquire()), { ok: false, reason: "unavailable" });

const noTerminal = createNativeRecorder({ missing: ["onStop"] });
assert.deepEqual(
  plain(createRecorderCoordinator({ getRecorderManager: () => noTerminal.manager }).acquire()),
  { ok: false, reason: "unavailable" },
  "缺核心 terminal listener 时不能发布会永久 draining 的 owner",
);

const retryNative = createNativeRecorder({
  onRegister(name, count) {
    if (name === "stop" && count === 1) throw new Error("temporary bind failure");
  },
});
let getterCalls = 0;
const retryCoordinator = createRecorderCoordinator({ getRecorderManager: () => {
  getterCalls += 1;
  if (getterCalls === 1) throw new Error("temporary getter failure");
  return retryNative.manager;
} });
assert.deepEqual(plain(retryCoordinator.acquire()), { ok: false, reason: "unavailable" });
assert.deepEqual(plain(retryCoordinator.acquire()), { ok: false, reason: "unavailable" });
assert.equal(retryCoordinator.acquire().ok, true, "初始化失败后必须可重试");
assert.equal(retryNative.listenerCounts.start, 1, "已成功绑定的 listener 不得重复注册");
assert.equal(retryNative.listenerCounts.stop, 2, "失败 listener 应在重试补绑");

const isolatedNative = createNativeRecorder({
  start(_options, listeners) { listeners.start(); },
});
const isolatedCoordinator = createRecorderCoordinator({ getRecorderManager: () => isolatedNative.manager });
const isolatedOwner = isolatedCoordinator.acquire();
let secondStarts = 0;
isolatedOwner.owner.subscribe({ onStart() { throw new Error("page listener failed"); } });
isolatedOwner.owner.subscribe({ onStart() { secondStarts += 1; } });
assert.equal(isolatedOwner.owner.start(options).ok, true, "listener throw 不能污染同步 native start 结果");
assert.equal(isolatedCoordinator.getPhase(), "recording");
assert.equal(secondStarts, 1, "后续 listener 必须继续收到同一事件");

const quietScheduler = createFakeScheduler();
const quietNative = createNativeRecorder();
const quietCoordinator = createRecorderCoordinator({
  getRecorderManager: () => quietNative.manager,
  scheduler: quietScheduler,
  quietWindowMs: 10,
});
const quietOld = quietCoordinator.acquire();
quietOld.owner.start(options);
quietNative.emit("start");
quietOld.owner.stop();
quietOld.owner.release();
assert.equal(quietCoordinator.getPhase(), "draining", "release while stopping 必须真进入 draining");
assert.equal(quietCoordinator.acquire().reason, "busy", "drain 未完成时不得创建等待 owner");
assert.equal(quietNative.calls.stop, 1, "busy acquire 不得重复 stop");
quietNative.emit("stop", { id: "old-stop" });
assert.equal(quietCoordinator.acquire().reason, "busy", "旧 terminal 后静默窗口内不得取得 owner");
quietScheduler.advance(5);
quietNative.emit("error", { id: "old-late-error" });
quietScheduler.advance(9);
assert.equal(quietCoordinator.acquire().reason, "busy", "迟到 terminal 必须重置静默窗口");
quietScheduler.advance(1);
const quietNew = quietCoordinator.acquire();
assert.equal(quietNew.owner.start(options).ok, true);

const pureThrowScheduler = createFakeScheduler();
const pureThrowNative = createNativeRecorder({ stop() { throw new Error("stop did not enqueue"); } });
const pureThrowCoordinator = createRecorderCoordinator({ getRecorderManager: () => pureThrowNative.manager, scheduler: pureThrowScheduler, quietWindowMs: 10 });
const pureThrowOwner = pureThrowCoordinator.acquire();
pureThrowOwner.owner.start(options); pureThrowNative.emit("start");
assert.equal(pureThrowOwner.owner.release().reason, "native-error");
const afterPureThrow = pureThrowCoordinator.acquire();
assert.equal(afterPureThrow.owner.start(options).ok, true, "纯同步 stop throw 不得留下永久 draining");

const thrown = new Error("native start exploded");
const throwingNative = createNativeRecorder({ start() { throw thrown; } });
const throwingCoordinator = createRecorderCoordinator({ getRecorderManager: () => throwingNative.manager });
const throwingOwner = throwingCoordinator.acquire();
const thrownResult = throwingOwner.owner.start(options);
assert.equal(thrownResult.ok, false);
assert.equal(thrownResult.reason, "native-error");
assert.equal(thrownResult.error, thrown, "同步 throw 必须以原对象结构化返回");
assert.equal(throwingCoordinator.getPhase(), "idle");

const boundaryScheduler = createFakeScheduler();
const boundaryNative = createNativeRecorder();
const boundary = createRecorderCoordinator({ getRecorderManager: () => boundaryNative.manager, scheduler: boundaryScheduler, quietWindowMs: 10 });
const boundaryOwner = boundary.acquire();
const boundaryEvents = [];
boundaryOwner.owner.subscribe({ onPause() { boundaryEvents.push("pause"); }, onStop(value) { boundaryEvents.push(value); } });
boundaryOwner.owner.start(options); boundaryNative.emit("start"); boundaryOwner.owner.pause();
boundaryOwner.owner.release();
assert.equal(boundary.acquire().reason, "busy");
boundaryNative.emit("pause");
assert.equal(boundary.getPhase(), "draining", "旧 pause 确认不能突破 draining");
assert.deepEqual(boundaryEvents, [], "release 后旧确认不能再通知");
boundaryNative.emit("stop", { id: "old" });
assert.equal(boundary.acquire().reason, "busy");
boundaryScheduler.advance(10);
const boundaryWaiting = boundary.acquire();
assert.equal(boundaryWaiting.owner.start(options).ok, true);
boundaryNative.emit("start"); boundaryWaiting.owner.stop();
const normalStop = { id: "normal" }; boundaryNative.emit("stop", normalStop);
assert.equal(boundary.getPhase(), "draining", "普通 onStop 也必须进入 quiet settle");
assert.equal(boundaryWaiting.owner.start(options).reason, "busy");
boundaryScheduler.advance(10); assert.equal(boundaryWaiting.owner.start(options).ok, true);

const detachedNative = createNativeRecorder();
const detachedScheduler = createFakeScheduler();
const detachedCoordinator = createRecorderCoordinator({
  getRecorderManager: () => detachedNative.manager,
  scheduler: detachedScheduler,
  quietWindowMs: 10,
  drainTimeoutMs: 30000,
});
const detachedOld = detachedCoordinator.acquire();
const detachedEvents = [];
detachedOld.owner.start(options);
detachedNative.emit("start");
detachedOld.owner.stop();
assert.deepEqual(
  plain(detachedOld.owner.release({ terminalSink: (event) => detachedEvents.push(event) })),
  { ok: true, phase: "draining" },
  "stopping owner 卸载后应把唯一 terminal 消费器托管给协调器",
);
assert.equal(detachedNative.calls.stop, 1, "已经 stopping 的 release 不得重复 stop");
assert.equal(detachedCoordinator.acquire().reason, "busy", "旧 terminal 未收口前不能取得新 owner");
detachedScheduler.advance(9000);
const delayedDetachedStop = { duration: 9000, fileSize: 99, tempFilePath: "/tmp/delayed.mp3" };
detachedNative.emit("stop", delayedDetachedStop);
assert.deepEqual(
  plain(detachedEvents),
  [{ type: "stop", result: delayedDetachedStop }],
  "页面卸载超过旧 8 秒窗口后，迟到的有效 stop 仍必须交给托管 sink",
);
assert.equal(detachedCoordinator.acquire().reason, "busy", "terminal 后静默窗口结束前仍不能取得 owner");
detachedScheduler.advance(10);
const detachedWaiting = detachedCoordinator.acquire();
assert.equal(detachedWaiting.owner.start(options).ok, true, "托管 sink 完成后应允许等待页面开始录音");

let synchronousNative;
const synchronousEvents = [];
synchronousNative = createNativeRecorder({
  stop() {
    synchronousNative.emit("stop", { duration: 1, fileSize: 1, tempFilePath: "/tmp/sync.mp3" });
  },
});
const synchronousScheduler = createFakeScheduler();
const synchronousCoordinator = createRecorderCoordinator({
  getRecorderManager: () => synchronousNative.manager,
  scheduler: synchronousScheduler,
  quietWindowMs: 10,
});
const synchronousOwner = synchronousCoordinator.acquire();
synchronousOwner.owner.start(options);
synchronousNative.emit("start");
synchronousOwner.owner.release({ terminalSink: (event) => synchronousEvents.push(event) });
assert.equal(synchronousEvents.length, 1, "release 必须先安装 sink 再调用可能同步回调的原生 stop");
assert.equal(synchronousEvents[0].type, "stop");

const timeoutNative = createNativeRecorder();
const timeoutScheduler = createFakeScheduler();
const timeoutCoordinator = createRecorderCoordinator({
  getRecorderManager: () => timeoutNative.manager,
  scheduler: timeoutScheduler,
  quietWindowMs: 10,
  drainTimeoutMs: 30,
});
const timeoutOld = timeoutCoordinator.acquire();
timeoutOld.owner.start(options);
timeoutNative.emit("start");
timeoutOld.owner.release({ terminalSink: () => { throw new Error("terminal 不应到达"); } });
timeoutScheduler.advance(29);
assert.equal(timeoutCoordinator.acquire().reason, "busy", "drain 总超时前必须继续隔离旧会话");
timeoutScheduler.advance(1);
const timeoutWaiting = timeoutCoordinator.acquire();
assert.equal(timeoutWaiting.owner.start(options).ok, true, "terminal 永不返回时 drain watchdog 必须解除永久 busy");

async function testAsyncDetachedSink() {
  const asyncNative = createNativeRecorder();
  const asyncScheduler = createFakeScheduler();
  const asyncCoordinator = createRecorderCoordinator({
    getRecorderManager: () => asyncNative.manager,
    scheduler: asyncScheduler,
    quietWindowMs: 10,
    drainTimeoutMs: 30,
  });
  const asyncOld = asyncCoordinator.acquire();
  let resolveSink;
  asyncOld.owner.start(options);
  asyncNative.emit("start");
  asyncOld.owner.release({
    terminalSink: () => new Promise((resolve) => { resolveSink = resolve; }),
  });
  assert.equal(asyncCoordinator.acquire().reason, "busy");
  asyncNative.emit("stop", { duration: 2, fileSize: 2, tempFilePath: "/tmp/async.mp3" });
  asyncScheduler.advance(29);
  assert.equal(asyncCoordinator.acquire().reason, "busy", "异步持久化完成前必须保持 draining");
  resolveSink();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(asyncCoordinator.acquire().reason, "busy", "异步 sink 完成后仍须经过 quiet window");
  asyncScheduler.advance(10);
  const asyncWaiting = asyncCoordinator.acquire();
  assert.equal(asyncWaiting.owner.start(options).ok, true, "异步 sink 完成并静默后应允许新录音");

  const activeNative = createNativeRecorder();
  const activeScheduler = createFakeScheduler();
  const activeCoordinator = createRecorderCoordinator({
    getRecorderManager: () => activeNative.manager,
    scheduler: activeScheduler,
    quietWindowMs: 10,
    drainTimeoutMs: 30,
  });
  const activeOwner = activeCoordinator.acquire();
  let resolveActiveListener;
  activeOwner.owner.subscribe({
    onStop() { return new Promise((resolve) => { resolveActiveListener = resolve; }); },
  });
  activeOwner.owner.start(options);
  activeNative.emit("start");
  activeOwner.owner.stop();
  activeNative.emit("stop", { duration: 4, fileSize: 4, tempFilePath: "/tmp/active.mp3" });
  activeScheduler.advance(29);
  assert.equal(activeOwner.owner.start(options).reason, "busy", "活跃 owner 的异步 onStop 完成前不得开始下一次录音");
  resolveActiveListener();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(activeOwner.owner.start(options).reason, "busy", "活跃异步 listener 完成后仍须经过静默窗口");
  activeScheduler.advance(10);
  assert.equal(activeOwner.owner.start(options).ok, true, "活跃异步 onStop 完成并静默后应解锁");

  const rejectedNative = createNativeRecorder();
  const rejectedScheduler = createFakeScheduler();
  const rejectedCoordinator = createRecorderCoordinator({
    getRecorderManager: () => rejectedNative.manager,
    scheduler: rejectedScheduler,
    quietWindowMs: 10,
    drainTimeoutMs: 30,
  });
  const rejectedOwner = rejectedCoordinator.acquire();
  let rejectActiveListener;
  rejectedOwner.owner.subscribe({
    onError() { return new Promise((_resolve, reject) => { rejectActiveListener = reject; }); },
  });
  rejectedOwner.owner.start(options);
  rejectedNative.emit("start");
  rejectedNative.emit("error", { errMsg: "native failed" });
  rejectActiveListener(new Error("持久化失败"));
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(rejectedOwner.owner.start(options).reason, "busy", "异步 onError 拒绝后仍须经过静默窗口");
  rejectedScheduler.advance(10);
  assert.equal(rejectedOwner.owner.start(options).ok, true, "异步 onError 拒绝也必须安全收口并解锁");

  const activeStalledNative = createNativeRecorder();
  const activeStalledScheduler = createFakeScheduler();
  const activeStalledCoordinator = createRecorderCoordinator({
    getRecorderManager: () => activeStalledNative.manager,
    scheduler: activeStalledScheduler,
    quietWindowMs: 10,
    drainTimeoutMs: 30,
  });
  const activeStalledOwner = activeStalledCoordinator.acquire();
  activeStalledOwner.owner.subscribe({ onStop() { return new Promise(() => {}); } });
  activeStalledOwner.owner.start(options);
  activeStalledNative.emit("start");
  activeStalledOwner.owner.stop();
  activeStalledNative.emit("stop", { duration: 5, fileSize: 5, tempFilePath: "/tmp/active-stalled.mp3" });
  activeStalledScheduler.advance(29);
  assert.equal(activeStalledOwner.owner.start(options).reason, "busy", "活跃异步 listener 超时前必须保持 draining");
  activeStalledScheduler.advance(1);
  assert.equal(activeStalledOwner.owner.start(options).ok, true, "活跃异步 listener 永不结束时 watchdog 必须解锁");

  const stalledNative = createNativeRecorder();
  const stalledScheduler = createFakeScheduler();
  const stalledCoordinator = createRecorderCoordinator({
    getRecorderManager: () => stalledNative.manager,
    scheduler: stalledScheduler,
    quietWindowMs: 10,
    drainTimeoutMs: 30,
  });
  const stalledOld = stalledCoordinator.acquire();
  stalledOld.owner.start(options);
  stalledNative.emit("start");
  stalledOld.owner.release({ terminalSink: () => new Promise(() => {}) });
  stalledNative.emit("stop", { duration: 3, fileSize: 3, tempFilePath: "/tmp/stalled.mp3" });
  stalledScheduler.advance(29);
  assert.equal(stalledCoordinator.acquire().reason, "busy");
  stalledScheduler.advance(1);
  const stalledWaiting = stalledCoordinator.acquire();
  assert.equal(stalledWaiting.owner.start(options).ok, true, "sink 永不结束时第二段 watchdog 也必须解锁");
}

const optionalNative = createNativeRecorder({ missing: ["pause"] });
const optional = createRecorderCoordinator({ getRecorderManager: () => optionalNative.manager });
assert.equal(optional.acquire().capabilities.canInterrupt, true, "中断不依赖手动 pause 命令");
const noPauseCallback = createNativeRecorder({ missing: ["onPause"] });
assert.equal(createRecorderCoordinator({ getRecorderManager: () => noPauseCallback.manager }).acquire().capabilities.canInterrupt, false);

const fallback = createRecorderCoordinator({ getRecorderManager: () => createNativeRecorder().manager });
assert.equal(fallback.acquire().ok, true, "无注入 timer 时仍安全降级，不得抛错");

const lazyRuntime = {};
const lazyExports = loadCoordinator(lazyRuntime);
assert.equal(Object.keys(lazyRuntime).length, 0, "模块导入时不得读取或创建 wx");
const singleton = lazyExports.getRecorderCoordinator();
assert.deepEqual(plain(singleton.acquire()), { ok: false, reason: "unavailable" }, "H5/测试环境必须安全降级");

testAsyncDetachedSink()
  .then(() => console.log("录音协调器测试通过：全局事件、所有权、托管 terminal、draining 与安全降级契约正确。"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
