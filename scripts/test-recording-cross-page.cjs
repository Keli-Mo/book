/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
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
  globalThis: {},
});
const { createRecorderCoordinator } = moduleContainer.exports;

function createScheduler() {
  let now = 0;
  let nextId = 1;
  const tasks = new Map();
  return {
    setTimeout(callback, delay) {
      const id = nextId++;
      tasks.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout(id) { tasks.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, task] of [...tasks].sort((a, b) => a[1].at - b[1].at)) {
        if (task.at <= now && tasks.has(id)) {
          tasks.delete(id);
          task.callback();
        }
      }
    },
  };
}

function createNativeRecorder({ start, stop } = {}) {
  const listeners = {};
  const calls = { start: [], stop: 0 };
  const manager = {
    onStart(callback) { listeners.start = callback; },
    onStop(callback) { listeners.stop = callback; },
    onError(callback) { listeners.error = callback; },
    start(options) {
      calls.start.push(options);
      start?.();
    },
    stop() {
      calls.stop += 1;
      stop?.();
    },
  };
  return { manager, calls, emit(name, payload) { listeners[name]?.(payload); } };
}

const recordingOptions = { format: "mp3", sampleRate: 16000 };

test("A 页面退出后，B 须等 A 的 onStop、异步保存和静默期完成", async () => {
  const scheduler = createScheduler();
  const native = createNativeRecorder();
  const coordinator = createRecorderCoordinator({
    getRecorderManager: () => native.manager,
    scheduler,
    quietWindowMs: 10,
    drainTimeoutMs: 1000,
  });
  const a = coordinator.acquire();
  assert.equal(a.ok, true);
  assert.equal(a.owner.start(recordingOptions).ok, true);
  native.emit("start");

  assert.equal(a.owner.stop().ok, true);
  let finishSave;
  const saved = [];
  assert.equal(a.owner.release({
    terminalSink: (event) => new Promise((resolve) => {
      assert.equal(event.type, "stop");
      finishSave = () => {
        saved.push({ practiceId: "A", path: event.result.tempFilePath });
        resolve();
      };
    }),
  }).ok, true);
  assert.equal(native.calls.stop, 1, "release 不应重复请求原生 stop");
  assert.equal(coordinator.acquire().reason, "busy", "A 尚未收到 onStop，B 不得取得录音器");

  native.emit("stop", { tempFilePath: "/tmp/A.mp3" });
  assert.equal(coordinator.acquire().reason, "busy", "A 正在异步保存，B 仍须等待");
  assert.equal(native.calls.start.length, 1, "等待期间不得向原生发送 B 的 start");
  finishSave();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(saved, [{ practiceId: "A", path: "/tmp/A.mp3" }]);
  assert.equal(coordinator.acquire().reason, "busy", "A 保存完成后仍须经过静默期");
  scheduler.advance(9);
  assert.equal(coordinator.acquire().reason, "busy");
  scheduler.advance(1);
  const b = coordinator.acquire();
  assert.equal(b.ok, true, "A 完成后 B 应自动获得可用录音器");
  assert.equal(b.owner.start(recordingOptions).ok, true);
  assert.equal(native.calls.start.length, 2);
});

test("新的 JS 协调器遇原生旧录音占用，不得把旧 onStop 归给 B", () => {
  let nativeBusy = true;
  const scheduler = createScheduler();
  const native = createNativeRecorder({
    start() {
      if (nativeBusy) throw { errMsg: "operateRecorder:fail is recording or paused" };
    },
  });
  const coordinator = createRecorderCoordinator({
    getRecorderManager: () => native.manager,
    scheduler,
    quietWindowMs: 10,
    drainTimeoutMs: 1000,
  });
  const b = coordinator.acquire();
  const bFiles = [];
  assert.equal(b.ok, true);
  assert.equal(b.owner.subscribe({ onStop(result) { bFiles.push(result.tempFilePath); } }).ok, true);

  const firstStart = b.owner.start(recordingOptions);
  assert.equal(firstStart.reason, "native-error");
  assert.equal(coordinator.getPhase(), "uncertain", "原生占用时应进入状态未知锁");
  assert.equal(native.calls.stop, 1, "应请求一次原生 stop 来收口旧录音");
  assert.equal(b.owner.start(recordingOptions).reason, "busy");
  assert.equal(coordinator.acquire().reason, "busy");
  assert.equal(native.calls.start.length, 1, "旧录音未结束时不可重复 start");

  nativeBusy = false;
  native.emit("stop", { tempFilePath: "/tmp/old-A.mp3" });
  assert.deepEqual(bFiles, [], "旧 A 文件不可进入 B 的保存回调");
  assert.equal(coordinator.acquire().reason, "busy", "旧 onStop 后仍须静默隔离");
  scheduler.advance(10);
  assert.equal(b.owner.start(recordingOptions).ok, true, "旧会话收口后 B 可重新开始");
  native.emit("start");
  native.emit("stop", { tempFilePath: "/tmp/new-B.mp3" });
  assert.deepEqual(bFiles, ["/tmp/new-B.mp3"]);
});
