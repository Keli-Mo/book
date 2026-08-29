/* eslint-disable import/no-commonjs */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");

const sourcePath = path.resolve(
  __dirname,
  "../src/features/listeningPractice/recordingInteraction.ts"
);

assert.equal(fs.existsSync(sourcePath), true, "录音交互模型文件应存在");

const compiled = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
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
  getPracticeSwitchPolicy,
  getRecordingElapsedMs,
  pauseRecordingTimeline,
  resumeRecordingTimeline,
  startRecordingTimeline,
} = moduleContainer.exports;

const started = startRecordingTimeline(1000);
assert.equal(getRecordingElapsedMs(started, 2500), 1500);

const paused = pauseRecordingTimeline(started, 2500);
assert.equal(getRecordingElapsedMs(paused, 9000), 1500);

const resumed = resumeRecordingTimeline(paused, 9000);
assert.equal(getRecordingElapsedMs(resumed, 10000), 2500);

assert.equal(getPracticeSwitchPolicy("idle"), "allow");
assert.equal(getPracticeSwitchPolicy("recording"), "confirm-discard");
assert.equal(getPracticeSwitchPolicy("paused"), "confirm-discard");
assert.equal(getPracticeSwitchPolicy("recorded"), "confirm-discard");
assert.equal(getPracticeSwitchPolicy("uploading"), "block-uploading");

console.log("录音交互测试通过：暂停不计时，恢复后继续累计，切页策略正确。");
