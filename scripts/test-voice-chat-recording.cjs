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
console.log("voice chat recording checks passed");
