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
  getRecordingPermissionStep,
  parseNativeRecordingResult,
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
  requestRecorderTeardown,
  resetRecordingMachine,
  restoreRecordedMachine,
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
assert.equal(getRecordingPermissionStep(true), "granted");
assert.equal(getRecordingPermissionStep(false), "open-settings");
assert.equal(getRecordingPermissionStep(undefined), "request");
assert.equal(getRecordingPermissionStep(null), "request");

assert.deepEqual(
  JSON.parse(JSON.stringify(parseNativeRecordingResult({
    tempFilePath: "wxfile://tmp/record.mp3",
    duration: 1234.5,
    fileSize: 4096,
  }))),
  {
    ok: true,
    tempFilePath: "wxfile://tmp/record.mp3",
    durationMs: 1234.5,
    fileSizeBytes: 4096,
  },
  "录音只使用原生返回的路径、时长和大小",
);
for (const [result, reason] of [
  [{ duration: 1000, fileSize: 10 }, "missing-path"],
  [{ tempFilePath: "x", duration: 0, fileSize: 10 }, "invalid-duration"],
  [{ tempFilePath: "x", duration: 499.9, fileSize: 10 }, "too-short"],
  [{ tempFilePath: "x", duration: 1000, fileSize: 0 }, "invalid-size"],
  [{ tempFilePath: "x", duration: 1000, fileSize: 1.5 }, "invalid-size"],
]) {
  assert.equal(parseNativeRecordingResult(result).reason, reason);
}

const readyForRestore = resolveRecordingCapabilities(
  createRecordingMachine(),
  { canRecord: true, canPause: true, canResume: true, canInterrupt: true },
);
const restored = restoreRecordedMachine(readyForRestore);
assert.equal(restored.state, "recorded", "重启后可恢复已保存的待上传录音");
assert.equal(
  restoreRecordedMachine(requestRecorderAction(readyForRestore, "start").machine).state,
  "starting",
  "活动录音不得被恢复记录覆盖",
);
assert.equal(resetRecordingMachine(restored).state, "idle", "放弃已保存录音后回到 idle");
assert.equal(
  resetRecordingMachine(beginRecordingUpload(restored)).state,
  "uploading",
  "上传中不得被普通重置绕过",
);

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
assert.equal(
  getRecordingErrorMessage({ message: "device disconnected", code: "EIO" }),
  "device disconnected\n错误码：EIO",
  "通用 code 也必须显示给用户，便于真机诊断"
);
assert.equal(
  getRecordingErrorMessage({ message: "recorder failed", errCode: 0, errno: 1, code: "EIO" }),
  "recorder failed\n错误码：0",
  "errCode、errno、code 的优先级必须稳定且保留 0"
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
assert.equal(interrupted.command, null, "系统中断会原生暂停，不能再次调用 recorder.pause");
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

assert.strictEqual(
  resolveRecorderCallback(machine, {
    type: "error",
    sessionId: 1,
    operationSeq: 5,
    error: { errMsg: "late stop error" },
  }),
  machine,
  "已确认 stop 后的同序号迟到 error 不得覆盖有效录音"
);

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
assert.equal(forcedStop.command, null, "没有手动 pause 能力时也应等待原生 onPause");
assert.equal(forcedStop.machine.pauseReason, "interruption");
assert.equal(forcedStop.machine.clockFrozen, true);

const uploading = beginRecordingUpload(machine);
assert.equal(uploading.state, "uploading");
assert.strictEqual(
  resolveRecorderCallback(uploading, {
    type: "error",
    sessionId: 1,
    operationSeq: 5,
    error: { errMsg: "late upload error" },
  }),
  uploading,
  "上传中的迟到录音 error 不得破坏上传路径"
);
machine = finishRecordingUpload(uploading, { ok: true });
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

let automaticStopMachine = resolveRecordingCapabilities(
  createRecordingMachine(),
  completeCapabilities
);
const automaticStopStart = requestRecorderAction(automaticStopMachine, "start");
automaticStopMachine = resolveRecorderCallback(automaticStopStart.machine, {
  type: "start",
  sessionId: 1,
  operationSeq: 1,
});
automaticStopMachine = resolveRecorderCallback(automaticStopMachine, {
  type: "stop",
  sessionId: 1,
  operationSeq: 1,
});
assert.equal(
  automaticStopMachine.state,
  "recorded",
  "录音中的五分钟自动 onStop 必须保留本轮录音"
);

let pausedAutomaticStopMachine = resolveRecordingCapabilities(
  createRecordingMachine(),
  completeCapabilities
);
const pausedAutomaticStopStart = requestRecorderAction(pausedAutomaticStopMachine, "start");
pausedAutomaticStopMachine = resolveRecorderCallback(pausedAutomaticStopStart.machine, {
  type: "start",
  sessionId: 1,
  operationSeq: 1,
});
const pausedAutomaticStopPause = requestRecorderAction(pausedAutomaticStopMachine, "pause");
pausedAutomaticStopMachine = resolveRecorderCallback(pausedAutomaticStopPause.machine, {
  type: "pause",
  sessionId: 1,
  operationSeq: 2,
});
pausedAutomaticStopMachine = resolveRecorderCallback(pausedAutomaticStopMachine, {
  type: "stop",
  sessionId: 1,
  operationSeq: 2,
});
assert.equal(pausedAutomaticStopMachine.state, "recorded", "暂停后的系统 onStop 也必须可接收");

let pendingPauseStopMachine = resolveRecordingCapabilities(
  createRecordingMachine(),
  completeCapabilities
);
const pendingPauseStopStart = requestRecorderAction(pendingPauseStopMachine, "start");
pendingPauseStopMachine = resolveRecorderCallback(pendingPauseStopStart.machine, {
  type: "start",
  sessionId: 1,
  operationSeq: 1,
});
const pendingPauseStop = requestRecorderAction(pendingPauseStopMachine, "pause");
pendingPauseStopMachine = resolveRecorderCallback(pendingPauseStop.machine, {
  type: "stop",
  sessionId: 1,
  operationSeq: 2,
});
assert.equal(pendingPauseStopMachine.state, "recorded", "pending pause 期间的系统 onStop 必须完成录音");

let pendingResumeStopMachine = resolveRecordingCapabilities(
  createRecordingMachine(),
  completeCapabilities
);
const pendingResumeStopStart = requestRecorderAction(pendingResumeStopMachine, "start");
pendingResumeStopMachine = resolveRecorderCallback(pendingResumeStopStart.machine, {
  type: "start",
  sessionId: 1,
  operationSeq: 1,
});
const pendingResumeStopPause = requestRecorderAction(pendingResumeStopMachine, "pause");
pendingResumeStopMachine = resolveRecorderCallback(pendingResumeStopPause.machine, {
  type: "pause",
  sessionId: 1,
  operationSeq: 2,
});
const pendingResumeStop = requestRecorderAction(pendingResumeStopMachine, "resume");
pendingResumeStopMachine = resolveRecorderCallback(pendingResumeStop.machine, {
  type: "stop",
  sessionId: 1,
  operationSeq: 3,
});
assert.equal(pendingResumeStopMachine.state, "recorded", "pending resume 期间的系统 onStop 必须完成录音");

const startingStop = requestRecorderAction(
  resolveRecordingCapabilities(createRecordingMachine(), completeCapabilities),
  "start"
);
assert.equal(
  resolveRecorderCallback(startingStop.machine, {
    type: "stop",
    sessionId: 1,
    operationSeq: 1,
  }).state,
  "starting",
  "starting 阶段的意外 onStop 不能伪造有效录音"
);

const startingTeardown = requestRecorderTeardown(startingStop.machine);
assert.equal(startingTeardown.machine.state, "stopping", "页面卸载必须能终止尚未确认 start 的录音");
assert.equal(startingTeardown.command.type, "stop");
assert.equal(
  resolveRecorderCallback(startingTeardown.machine, {
    type: "stop",
    sessionId: startingTeardown.command.sessionId,
    operationSeq: startingTeardown.command.operationSeq,
  }).state,
  "recorded",
  "页面卸载主动发出的 stop 回调必须能保存录音",
);
assert.equal(
  requestRecorderTeardown(
    resolveRecordingCapabilities(createRecordingMachine(), completeCapabilities),
  ).command,
  null,
  "空闲状态卸载不能凭空调用 recorder.stop",
);

let activeNativeErrorMachine = resolveRecordingCapabilities(
  createRecordingMachine(),
  completeCapabilities
);
const activeNativeErrorStart = requestRecorderAction(activeNativeErrorMachine, "start");
activeNativeErrorMachine = resolveRecorderCallback(activeNativeErrorStart.machine, {
  type: "start",
  sessionId: 1,
  operationSeq: 1,
});
activeNativeErrorMachine = resolveRecorderCallback(activeNativeErrorMachine, {
  type: "error",
  sessionId: 1,
  operationSeq: 1,
  error: { message: "system recorder failure", code: "EIO" },
});
assert.equal(activeNativeErrorMachine.state, "error", "活动录音无 pending 的原生错误仍必须进入 error");
assert.deepEqual(JSON.parse(JSON.stringify(activeNativeErrorMachine.lastError)), {
  message: "system recorder failure",
  code: "EIO",
});

let resumeInterruptedMachine = resolveRecordingCapabilities(
  createRecordingMachine(),
  completeCapabilities
);
const resumeInterruptedStart = requestRecorderAction(resumeInterruptedMachine, "start");
resumeInterruptedMachine = resolveRecorderCallback(resumeInterruptedStart.machine, {
  type: "start",
  sessionId: 1,
  operationSeq: 1,
});
const resumeInterruptedPause = requestRecorderAction(resumeInterruptedMachine, "pause");
resumeInterruptedMachine = resolveRecorderCallback(resumeInterruptedPause.machine, {
  type: "pause",
  sessionId: 1,
  operationSeq: 2,
});
const pendingResume = requestRecorderAction(resumeInterruptedMachine, "resume");
const interruptionDuringResume = handleInterruptionBegin(pendingResume.machine);
assert.equal(
  interruptionDuringResume.command,
  null,
  "系统中断已原生暂停，pending resume 期间不得重复执行 recorder.pause"
);
assert.equal(interruptionDuringResume.machine.operationSeq, 4);
assert.equal(interruptionDuringResume.machine.pendingAction, "pause");
assert.equal(interruptionDuringResume.machine.pauseReason, "interruption");
assert.equal(interruptionDuringResume.machine.needsManualResume, true);
assert.equal(interruptionDuringResume.machine.clockFrozen, true);
const lateResume = resolveRecorderCallback(interruptionDuringResume.machine, {
  type: "resume",
  sessionId: 1,
  operationSeq: 3,
});
assert.equal(lateResume.state, "paused", "已失效的 resume 确认不得恢复录音");
assert.equal(lateResume.clockFrozen, true, "已失效的 resume 确认不得解冻计时");
resumeInterruptedMachine = resolveRecorderCallback(lateResume, {
  type: "pause",
  sessionId: 1,
  operationSeq: 4,
});
assert.equal(resumeInterruptedMachine.state, "paused");
assert.equal(resumeInterruptedMachine.needsManualResume, true);
assert.equal(handleInterruptionEnd(resumeInterruptedMachine).command, null);
const manualResumeAfterInterruption = requestRecorderAction(resumeInterruptedMachine, "resume");
assert.equal(manualResumeAfterInterruption.command.type, "resume");
assert.equal(
  resolveRecorderCallback(manualResumeAfterInterruption.machine, {
    type: "resume",
    sessionId: 1,
    operationSeq: 5,
  }).state,
  "recording",
  "只有用户新的 resume 才能恢复录音"
);

const pendingStartInterruption = handleInterruptionBegin(startingStop.machine);
assert.equal(pendingStartInterruption.command, null);
assert.equal(pendingStartInterruption.machine.pendingAction, "pause");
assert.equal(pendingStartInterruption.machine.operationSeq, 2);
assert.equal(
  resolveRecorderCallback(pendingStartInterruption.machine, {
    type: "start",
    sessionId: 1,
    operationSeq: 1,
  }).state,
  "starting",
  "中断已作废 start 后的迟到 onStart 不得进入 recording"
);
assert.equal(
  resolveRecorderCallback(pendingStartInterruption.machine, {
    type: "stop",
    sessionId: 1,
    operationSeq: 2,
  }).state,
  "recorded",
  "中断后原生直接 onStop 必须被接收"
);

let pendingPauseInterruptionMachine = resolveRecordingCapabilities(
  createRecordingMachine(),
  completeCapabilities
);
const pendingPauseInterruptionStart = requestRecorderAction(pendingPauseInterruptionMachine, "start");
pendingPauseInterruptionMachine = resolveRecorderCallback(pendingPauseInterruptionStart.machine, {
  type: "start",
  sessionId: 1,
  operationSeq: 1,
});
const pendingUserPause = requestRecorderAction(pendingPauseInterruptionMachine, "pause");
const interruptionDuringPause = handleInterruptionBegin(pendingUserPause.machine);
assert.equal(interruptionDuringPause.command, null, "已发出的用户 pause 不得在中断时重复调用");
assert.equal(interruptionDuringPause.machine.operationSeq, 2);
assert.equal(interruptionDuringPause.machine.pauseReason, "interruption");
assert.equal(
  resolveRecorderCallback(interruptionDuringPause.machine, {
    type: "pause",
    sessionId: 1,
    operationSeq: 2,
  }).needsManualResume,
  true,
  "pending pause 收到中断后也必须保留手动恢复标记"
);

let uploadRetryMachine = machine;
uploadRetryMachine = beginRecordingUpload(uploadRetryMachine);
const uploadFailure = { errMsg: "uploadFile:fail timeout", code: "ETIMEDOUT" };
uploadRetryMachine = finishRecordingUpload(uploadRetryMachine, {
  ok: false,
  error: uploadFailure,
});
assert.equal(uploadRetryMachine.state, "recorded", "上传失败应保留录音供重试");
assert.deepEqual(JSON.parse(JSON.stringify(uploadRetryMachine.lastError)), uploadFailure);
const uploadRetrying = beginRecordingUpload(uploadRetryMachine);
assert.equal(uploadRetrying.state, "uploading", "上传失败后必须可再次 beginUpload");
assert.equal(uploadRetrying.sessionId, uploadRetryMachine.sessionId, "重试上传不能新建录音 session");
uploadRetryMachine = finishRecordingUpload(uploadRetrying, { ok: true });
assert.equal(uploadRetryMachine.state, "recorded");
assert.equal(uploadRetryMachine.lastError, null, "上传成功必须清理上次失败原因");
const disposedUploading = disposeRecordingMachine(uploadRetrying);
assert.strictEqual(
  finishRecordingUpload(disposedUploading, { ok: false, error: uploadFailure }),
  disposedUploading,
  "卸载后上传完成不得更新状态"
);

console.log("录音交互测试通过：时间线、错误、能力检测与状态机契约正确。");
