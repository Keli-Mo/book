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
    onStart(listener) { listenerCounts.start += 1; listeners.start = listener; },
    onPause(listener) { listenerCounts.pause += 1; listeners.pause = listener; },
    onResume(listener) { listenerCounts.resume += 1; listeners.resume = listener; },
    onStop(listener) { listenerCounts.stop += 1; listeners.stop = listener; },
    onError(listener) { listenerCounts.error += 1; listeners.error = listener; },
    onInterruptionBegin(listener) {
      listenerCounts.interruptionBegin += 1;
      listeners.interruptionBegin = listener;
    },
    onInterruptionEnd(listener) {
      listenerCounts.interruptionEnd += 1;
      listeners.interruptionEnd = listener;
    },
    start(options) {
      calls.start.push(options);
      if (overrides.start) return overrides.start(options);
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
const plain = (value) => JSON.parse(JSON.stringify(value));

const native = createNativeRecorder();
const { createRecorderCoordinator, getRecorderCoordinator } = loadCoordinator();
assert.equal(typeof createRecorderCoordinator, "function");
assert.equal(typeof getRecorderCoordinator, "function");

const coordinator = createRecorderCoordinator({ getRecorderManager: () => native.manager });
const first = coordinator.acquire();
assert.equal(first.ok, true);
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
const seen = { interruptionBegin: 0, interruptionEnd: 0, error: null, stops: [] };
const subscription = eventOwner.owner.subscribe({
  onInterruptionBegin() { seen.interruptionBegin += 1; },
  onInterruptionEnd() { seen.interruptionEnd += 1; },
  onError(error) { seen.error = error; },
  onStop(result) { seen.stops.push(result); },
});
assert.equal(subscription.ok, true);
eventOwner.owner.start(options);
eventNative.emit("start");
eventNative.emit("interruptionBegin");
eventNative.emit("interruptionEnd");
assert.equal(eventNative.calls.pause, 0, "中断开始只能通知，不能伪造 pause");
assert.equal(eventNative.calls.resume, 0, "中断结束只能通知，不能自动 resume");
const nativeError = { errMsg: "native error", errno: 9 };
eventNative.emit("error", nativeError);
assert.equal(seen.error, nativeError, "必须保留底层 error 原对象");
assert.equal(eventOwner.owner.start(options).ok, true, "错误后应可由当前 owner 重新开始");
eventNative.emit("start");
eventOwner.owner.stop();
const rawStop = { duration: 99.9, fileSize: 2, tempFilePath: "/tmp/raw.mp3" };
eventNative.emit("stop", rawStop);
assert.deepEqual(seen.stops, [rawStop], "onStop 必须原样转发原生结果");
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
missingOwner.owner.start(options);
missingNative.emit("start");
assert.deepEqual(plain(missingOwner.owner.pause()), { ok: false, reason: "unsupported", capability: "pause" });
assert.deepEqual(plain(missingOwner.owner.resume()), { ok: false, reason: "unsupported", capability: "resume" });

const unavailable = createRecorderCoordinator({ getRecorderManager: () => undefined });
assert.deepEqual(plain(unavailable.acquire()), { ok: false, reason: "unavailable" });

const thrown = new Error("native start exploded");
const throwingNative = createNativeRecorder({ start() { throw thrown; } });
const throwingCoordinator = createRecorderCoordinator({ getRecorderManager: () => throwingNative.manager });
const throwingOwner = throwingCoordinator.acquire();
const thrownResult = throwingOwner.owner.start(options);
assert.equal(thrownResult.ok, false);
assert.equal(thrownResult.reason, "native-error");
assert.equal(thrownResult.error, thrown, "同步 throw 必须以原对象结构化返回");
assert.equal(throwingCoordinator.getPhase(), "idle");

const lazyRuntime = {};
const lazyExports = loadCoordinator(lazyRuntime);
assert.equal(Object.keys(lazyRuntime).length, 0, "模块导入时不得读取或创建 wx");
const singleton = lazyExports.getRecorderCoordinator();
assert.deepEqual(plain(singleton.acquire()), { ok: false, reason: "unavailable" }, "H5/测试环境必须安全降级");

console.log("录音协调器测试通过：全局事件、所有权、draining 与安全降级契约正确。");
