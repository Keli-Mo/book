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
const stateMachinePath = path.resolve(
  __dirname,
  "../src/features/listeningPractice/recordingStateMachine.ts"
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
  getRecordingErrorMessage,
  getPracticeSwitchPolicy,
  getRecordingElapsedMs,
  pauseRecordingTimeline,
  resumeRecordingTimeline,
  startRecordingTimeline,
} = moduleContainer.exports;

assert.equal(
  fs.existsSync(stateMachinePath),
  true,
  "录音状态机模块应存在"
);

const stateMachineCompiled = ts.transpileModule(
  fs.readFileSync(stateMachinePath, "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2017,
    },
  }
);
const stateMachineModule = { exports: {} };
vm.runInNewContext(stateMachineCompiled.outputText, {
  module: stateMachineModule,
  exports: stateMachineModule.exports,
});

const {
  beginRecordingUpload,
  createRecordingMachine,
  detectRecordingCapabilities,
  disposeRecordingMachine,
  finishRecordingUpload,
  handleInterruptionBegin,
  handleInterruptionEnd,
  requestRecorderAction,
  resolveRecordingCapabilities,
  resolveRecorderCallback,
} = stateMachineModule.exports;

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

assert.equal(
  typeof getRecordingErrorMessage,
  "function",
  "录音错误必须保留原始原因，不能全部归因为麦克风权限"
);
assert.equal(
  getRecordingErrorMessage({ errMsg: "operateRecorder:fail audio is recording" }),
  "operateRecorder:fail audio is recording"
);
assert.equal(
  getRecordingErrorMessage({ errMsg: "operateRecorder:fail", errno: 103 }),
  "operateRecorder:fail\n错误码：103"
);
assert.equal(
  getRecordingErrorMessage(new Error("native recorder unavailable")),
  "native recorder unavailable"
);
assert.equal(
  getRecordingErrorMessage({ errCode: 0, message: "recorder failed" }),
  "recorder failed\n错误码：0"
);
for (const error of [undefined, null, {}, { errMsg: "" }]) {
  assert.match(getRecordingErrorMessage(error), /未返回具体原因/);
  assert.doesNotMatch(getRecordingErrorMessage(error), /权限|\[object Object\]/);
}

const completeCapabilities = detectRecordingCapabilities({
  hasRecorderManager: true,
  hasPause: true,
  hasResume: true,
  hasInterruptionListener: true,
});
assert.deepEqual(JSON.parse(JSON.stringify(completeCapabilities)), {
  canRecord: true,
  canPause: true,
  canResume: true,
  canInterrupt: true,
});
assert.equal(
  detectRecordingCapabilities({
    hasRecorderManager: false,
    hasPause: true,
    hasResume: true,
    hasInterruptionListener: true,
  }).canRecord,
  false
);
assert.deepEqual(
  JSON.parse(
    JSON.stringify(
      detectRecordingCapabilities({
        hasRecorderManager: true,
        hasPause: false,
        hasResume: false,
        hasInterruptionListener: false,
      })
    )
  ),
  { canRecord: true, canPause: false, canResume: false, canInterrupt: false }
);

let machine = createRecordingMachine();
assert.equal(machine.state, "checking");
machine = resolveRecordingCapabilities(machine, completeCapabilities);
assert.equal(machine.state, "idle");
assert.equal(machine.pauseReason, null);

const unsupported = resolveRecordingCapabilities(
  createRecordingMachine(),
  detectRecordingCapabilities({
    hasRecorderManager: false,
    hasPause: false,
    hasResume: false,
    hasInterruptionListener: false,
  })
);
assert.equal(unsupported.state, "unsupported");
assert.equal(requestRecorderAction(unsupported, "start").command, null);

const startRequest = requestRecorderAction(machine, "start");
assert.deepEqual(JSON.parse(JSON.stringify(startRequest.command)), {
  type: "start",
  sessionId: 1,
  operationSeq: 1,
});
assert.equal(startRequest.machine.state, "starting");
assert.equal(requestRecorderAction(startRequest.machine, "start").command, null);

machine = resolveRecorderCallback(startRequest.machine, {
  type: "start",
  sessionId: 1,
  operationSeq: 1,
});
assert.equal(machine.state, "recording");

const pauseRequest = requestRecorderAction(machine, "pause", "user");
assert.equal(pauseRequest.machine.state, "recording");
assert.equal(pauseRequest.machine.pauseReason, "user");
assert.equal(pauseRequest.machine.clockFrozen, true);
assert.equal(pauseRequest.command.type, "pause");
assert.equal(requestRecorderAction(pauseRequest.machine, "pause", "user").command, null);

assert.equal(
  resolveRecorderCallback(pauseRequest.machine, {
    type: "pause",
    sessionId: 1,
    operationSeq: 1,
  }).state,
  "recording",
  "旧 operation 的回调不得改变稳定状态"
);
machine = resolveRecorderCallback(pauseRequest.machine, {
  type: "pause",
  sessionId: 1,
  operationSeq: 2,
});
assert.equal(machine.state, "paused");

const resumeRequest = requestRecorderAction(machine, "resume");
assert.equal(resumeRequest.command.type, "resume");
assert.equal(
  requestRecorderAction(resumeRequest.machine, "resume").command,
  null,
  "快速重复 resume 不得重复发命令"
);
machine = resolveRecorderCallback(resumeRequest.machine, {
  type: "resume",
  sessionId: 1,
  operationSeq: 3,
});
assert.equal(machine.state, "recording");
assert.equal(machine.pauseReason, null);

const interrupted = handleInterruptionBegin(machine);
assert.equal(interrupted.machine.clockFrozen, true);
assert.equal(interrupted.machine.pauseReason, "interruption");
assert.equal(interrupted.command.type, "pause");
assert.equal(handleInterruptionEnd(interrupted.machine).command, null);
assert.equal(handleInterruptionEnd(interrupted.machine).machine.needsManualResume, true);
machine = resolveRecorderCallback(interrupted.machine, {
  type: "pause",
  sessionId: 1,
  operationSeq: 4,
});
assert.equal(machine.state, "paused");
assert.equal(machine.needsManualResume, true);

const stopRequest = requestRecorderAction(machine, "stop");
assert.equal(stopRequest.command.type, "stop");
assert.equal(
  requestRecorderAction(stopRequest.machine, "stop").command,
  null,
  "快速重复 stop 不得重复发命令"
);
machine = resolveRecorderCallback(stopRequest.machine, {
  type: "stop",
  sessionId: 1,
  operationSeq: 5,
});
assert.equal(machine.state, "recorded");

let noPauseMachine = resolveRecordingCapabilities(
  createRecordingMachine(),
  detectRecordingCapabilities({
    hasRecorderManager: true,
    hasPause: false,
    hasResume: false,
    hasInterruptionListener: false,
  })
);
const noPauseStart = requestRecorderAction(noPauseMachine, "start");
noPauseMachine = resolveRecorderCallback(noPauseStart.machine, {
  type: "start",
  sessionId: 1,
  operationSeq: 1,
});
assert.equal(requestRecorderAction(noPauseMachine, "pause").command, null);
assert.equal(
  handleInterruptionBegin(noPauseMachine).command,
  null,
  "没有中断监听能力时，手动调用中断处理也必须安全降级"
);

let interruptWithoutPause = resolveRecordingCapabilities(
  createRecordingMachine(),
  detectRecordingCapabilities({
    hasRecorderManager: true,
    hasPause: false,
    hasResume: false,
    hasInterruptionListener: true,
  })
);
const interruptedStart = requestRecorderAction(interruptWithoutPause, "start");
interruptWithoutPause = resolveRecorderCallback(interruptedStart.machine, {
  type: "start",
  sessionId: 1,
  operationSeq: 1,
});
const forcedStop = handleInterruptionBegin(interruptWithoutPause);
assert.equal(forcedStop.command.type, "stop");
assert.equal(forcedStop.machine.pauseReason, "interruption");
assert.equal(forcedStop.machine.clockFrozen, true);

const uploading = beginRecordingUpload(machine);
assert.equal(uploading.state, "uploading");
machine = finishRecordingUpload(uploading, true);
assert.equal(machine.state, "recorded");

const nextStart = requestRecorderAction(machine, "start");
assert.equal(nextStart.command.sessionId, 2);
assert.equal(
  resolveRecorderCallback(nextStart.machine, {
    type: "error",
    sessionId: 1,
    operationSeq: 5,
    error: { errMsg: "stale error" },
  }).state,
  "starting",
  "旧 session 的回调不得覆盖新 session"
);
const currentError = resolveRecorderCallback(nextStart.machine, {
  type: "error",
  sessionId: 2,
  operationSeq: 6,
  error: { errMsg: "operateRecorder:fail", errCode: 7001 },
});
assert.equal(currentError.state, "error");
assert.deepEqual(JSON.parse(JSON.stringify(currentError.lastError)), {
  errMsg: "operateRecorder:fail",
  errCode: 7001,
});
assert.equal(
  getRecordingErrorMessage(currentError.lastError),
  "operateRecorder:fail\n错误码：7001"
);

const disposed = disposeRecordingMachine(nextStart.machine);
assert.equal(disposed.mounted, false);
assert.equal(
  resolveRecorderCallback(disposed, {
    type: "start",
    sessionId: 2,
    operationSeq: 6,
  }).state,
  "starting",
  "卸载后回调不得变更状态"
);

console.log("录音交互测试通过：时间线、错误、能力检测与状态机契约正确。");
