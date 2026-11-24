const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const file = path.join(__dirname, "../src/features/voiceChat/recording.ts");
const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const moduleRef = { exports: {} };
const removed = [];
const errorModule = { exports: {} };
const errorSource = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/services/voiceChatErrors.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
new Function("module", "exports", errorSource)(errorModule, errorModule.exports);
new Function("module", "exports", "require", compiled)(moduleRef, moduleRef.exports, (name) => {
  if (name === "@/features/listeningPractice/recorderCoordinator") return { getRecorderCoordinator: () => null };
  if (name === "@/features/voiceChat/playback") return { removeRecordedTempFile: (path) => { removed.push(path); return Promise.resolve(); } };
  if (name === "@/services/voiceChatErrors") return errorModule.exports;
  throw new Error(`Unexpected import ${name}`);
});
const { createVoiceRecorder } = moduleRef.exports;

let listener, released = 0, stopped = 0, releaseOptions;
const owner = {
  subscribe(value) { listener = value; return { ok: true, unsubscribe() {} }; },
  start() { return { ok: true }; },
  stop() { stopped++; return { ok: true }; },
  release(options) { released++; releaseOptions = options; return { ok: true, phase: "idle" }; },
};
const coordinator = { acquire() { return { ok: true, owner }; } };
let completed = [];
let recorder = createVoiceRecorder(coordinator);
recorder.start((path, duration) => completed.push([path, duration]), () => { throw new Error("unexpected error"); });
assert.equal(recorder.isActive(), true);
recorder.stop();
assert.equal(stopped, 1);
listener.onStop({ tempFilePath: "recording.mp3", duration: 1200 });
assert.deepEqual(completed, [["recording.mp3", 1200]]);
assert.equal(recorder.isActive(), false);
assert.equal(released, 1);

recorder = createVoiceRecorder(coordinator);
recorder.start((path) => completed.push(path), () => { throw new Error("unexpected error"); });
recorder.cancel();
listener.onStop({ tempFilePath: "late.mp3", duration: 1000 });
assert.equal(completed.length, 1, "取消后迟到录音不能进入聊天");
releaseOptions.terminalSink({ type: "stop", result: { tempFilePath: "late.mp3" } });
assert.deepEqual(removed, ["late.mp3"], "取消后迟到录音文件应删除");
let errorMessage;
recorder = createVoiceRecorder(coordinator);
recorder.start(() => { throw new Error("unexpected completion"); }, message => { errorMessage = message; });
listener.onError({ errMsg: "operateRecorder:fail auth deny private-data" });
assert.match(errorMessage, /麦克风权限未开启/);
assert.ok(!errorMessage.includes("private-data"));
assert.equal(recorder.isActive(), false);
owner.start = () => ({ ok: false, reason: "native-error", error: new Error("privacy authorization denied private-data") });
assert.throws(() => recorder.start(() => {}, () => {}), error => error.code === "MIC_PRIVACY" && !error.message.includes("private-data"));

// The native callback arrives after the user can tap the orb/inline stop again.
{
  let nativeListener, nativePhase = "idle", stopCalls = 0, synchronousStop = false;
  const finished = [], errors = [];
  const delayedOwner = {
    subscribe(value) { nativeListener = value; return { ok: true, unsubscribe() {} }; },
    start() { nativePhase = "recording"; return { ok: true }; },
    stop() {
      stopCalls++;
      if (nativePhase === "stopping") return { ok: false, reason: "invalid-phase" };
      nativePhase = "stopping";
      if (synchronousStop) nativeListener.onStop({ tempFilePath: "sync.mp3", duration: 1500 });
      return { ok: true };
    },
    release() { nativePhase = "idle"; return { ok: true, phase: "idle" }; },
  };
  const delayed = createVoiceRecorder({ acquire: () => ({ ok: true, owner: delayedOwner }) });
  const start = () => delayed.start((path, duration) => finished.push([path, duration]), message => errors.push(message));
  start();
  delayed.stop(); delayed.stop();
  assert.equal(stopCalls, 1, "异步 onStop 前重复点结束只能向原生发送一次 stop");
  assert.equal(delayed.isActive(), true, "等待原生确认期间应保留当前录音");
  nativeListener.onStop({ tempFilePath: "delayed.mp3", duration: 1250 });
  assert.deepEqual(finished, [["delayed.mp3", 1250]], "重复停止不能丢失有效录音");
  assert.deepEqual(errors, []);
  assert.equal(delayed.isActive(), false);

  start();
  delayed.stop(); delayed.stop();
  assert.equal(stopCalls, 2, "下一段录音拥有独立的停止状态");
  nativeListener.onStop({ tempFilePath: "next.mp3", duration: 1800 });
  assert.deepEqual(finished[1], ["next.mp3", 1800]);

  synchronousStop = true;
  start(); delayed.stop(); delayed.stop();
  assert.equal(stopCalls, 3, "同步 onStop 也只完成一次，不再触碰已结束的录音");
  assert.deepEqual(finished[2], ["sync.mp3", 1500]);
  assert.equal(delayed.isActive(), false);
  assert.deepEqual(errors, []);
}
console.log("voice chat recording checks passed");
