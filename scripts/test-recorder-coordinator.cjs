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

const coordinator = createRecorderCoordinator({ getRecorderManager: () => native.manager });
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
assert.equal(coordinator.getPhase(), "idle");

const eventNative = createNativeRecorder();
const eventCoordinator = createRecorderCoordinator({ getRecorderManager: () => eventNative.manager });
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
assert.equal(eventOwner.owner.start(options).ok, true, "错误后应可由当前 owner 重新开始");
eventNative.emit("start");
eventOwner.owner.stop();
const rawStop = { duration: 99.9, fileSize: 2, tempFilePath: "/tmp/raw.mp3" };
eventNative.emit("stop", rawStop);
assert.deepEqual(seen.stops, [rawStop], "onStop 必须原样转发原生结果");
assert.equal(seen.stops[0], rawStop, "onStop result 必须保持同一对象引用");
assert.equal(seen.interruptionBegin, 1);
assert.equal(seen.interruptionEnd, 1);

const drainingNative = createNativeRecorder();
const drainingCoordinator = createRecorderCoordinator({ getRecorderManager: () => drainingNative.manager });
const oldOwner = drainingCoordinator.acquire();
const oldStops = [];
oldOwner.owner.subscribe({ onStop(result) { oldStops.push(result); } });
oldOwner.owner.start(options);
drainingNative.emit("start");
assert.deepEqual(plain(oldOwner.owner.release()), { ok: true, phase: "draining" });
assert.equal(drainingNative.calls.stop, 1, "释放活动 owner 只能 stop 一次");
assert.equal(oldOwner.owner.release().ok, false, "重复 release 必须无效");
const newOwner = drainingCoordinator.acquire();
assert.equal(newOwner.ok, true);
assert.deepEqual(plain(newOwner.owner.start(options)), { ok: false, reason: "busy", phase: "draining" });
const newStops = [];
newOwner.owner.subscribe({ onStop(result) { newStops.push(result); } });
const staleStop = { duration: 12.5, fileSize: 1, tempFilePath: "/tmp/stale.mp3" };
drainingNative.emit("stop", staleStop);
assert.deepEqual(oldStops, [], "release 后旧 owner 不得接收回调");
assert.deepEqual(newStops, [], "旧 session stop 不得发给新页面");
assert.deepEqual(plain(newOwner.owner.start(options)), { ok: true });
drainingNative.emit("start");
newOwner.owner.stop();
const newStop = { duration: 22.5, fileSize: 3, tempFilePath: "/tmp/new.mp3" };
drainingNative.emit("stop", newStop);
assert.deepEqual(newStops, [newStop]);
assert.equal(newOwner.owner.subscribe({}).ok, true, "当前 owner 应可订阅");
assert.equal(oldOwner.owner.subscribe({}).ok, false, "release 后不可重新订阅旧 owner");

const drainErrorNative = createNativeRecorder();
const drainErrorCoordinator = createRecorderCoordinator({ getRecorderManager: () => drainErrorNative.manager });
const drainErrorOld = drainErrorCoordinator.acquire();
drainErrorOld.owner.start(options);
drainErrorNative.emit("start");
drainErrorOld.owner.release();
const drainErrorNew = drainErrorCoordinator.acquire();
const drainErrors = [];
drainErrorNew.owner.subscribe({ onError(error) { drainErrors.push(error); } });
assert.equal(drainErrorNew.owner.start(options).reason, "busy");
const staleError = { errMsg: "old session stopped" };
drainErrorNative.emit("error", staleError);
assert.deepEqual(drainErrors, [], "draining 的旧 error 不得发给新 owner");
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
const waitingOwner = quietCoordinator.acquire();
waitingOwner.owner.release();
assert.equal(quietNative.calls.stop, 1, "等待 drain 的 owner release 不得重复 stop");
const quietNew = quietCoordinator.acquire();
const quietEvents = [];
quietNew.owner.subscribe({ onStop(value) { quietEvents.push(value); }, onError(value) { quietEvents.push(value); } });
quietNative.emit("stop", { id: "old-stop" });
assert.equal(quietNew.owner.start(options).reason, "busy", "旧 terminal 后静默窗口内不得启动");
quietScheduler.advance(5);
quietNative.emit("error", { id: "old-late-error" });
quietScheduler.advance(9);
assert.equal(quietNew.owner.start(options).reason, "busy", "迟到 terminal 必须重置静默窗口");
quietScheduler.advance(1);
assert.equal(quietNew.owner.start(options).ok, true);
assert.deepEqual(quietEvents, [], "quiet 窗口内旧 terminal 不得通知或改变等待 owner");

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
const boundaryWaiting = boundary.acquire();
boundaryNative.emit("pause");
assert.equal(boundary.getPhase(), "draining", "旧 pause 确认不能突破 draining");
assert.deepEqual(boundaryEvents, [], "release 后旧确认不能再通知");
boundaryNative.emit("stop", { id: "old" });
assert.equal(boundaryWaiting.owner.start(options).reason, "busy");
boundaryScheduler.advance(10);
assert.equal(boundaryWaiting.owner.start(options).ok, true);
boundaryNative.emit("start"); boundaryWaiting.owner.stop();
const normalStop = { id: "normal" }; boundaryNative.emit("stop", normalStop);
assert.equal(boundary.getPhase(), "draining", "普通 onStop 也必须进入 quiet settle");
assert.equal(boundaryWaiting.owner.start(options).reason, "busy");
boundaryScheduler.advance(10); assert.equal(boundaryWaiting.owner.start(options).ok, true);

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

console.log("录音协调器测试通过：全局事件、所有权、draining 与安全降级契约正确。");
