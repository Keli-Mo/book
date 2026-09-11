export type RecordingState =
  | "checking"
  | "unsupported"
  | "idle"
  | "starting"
  | "recording"
  | "paused"
  | "stopping"
  | "recorded"
  | "uploading"
  | "error";

export type PauseReason = "user" | "background" | "interruption" | null;

export interface RecordingCapabilities {
  canRecord: boolean;
  canPause: boolean;
  canResume: boolean;
  canInterrupt: boolean;
}

export interface RecordingCapabilityInput {
  hasRecorderManager: boolean;
  hasPause: boolean;
  hasResume: boolean;
  hasInterruptionListener: boolean;
}

export type RecorderAction = "start" | "pause" | "resume" | "stop";

export interface RecorderCommand {
  type: RecorderAction;
  sessionId: number;
  operationSeq: number;
}

export interface RecorderCallback {
  type: RecorderAction | "error";
  sessionId: number;
  operationSeq: number;
  error?: unknown;
}

export interface RecordingMachine {
  state: RecordingState;
  capabilities: RecordingCapabilities | null;
  sessionId: number;
  operationSeq: number;
  pendingAction: RecorderAction | null;
  pauseReason: PauseReason;
  needsManualResume: boolean;
  clockFrozen: boolean;
  mounted: boolean;
  lastError: unknown;
}

export interface RecordingActionResult {
  machine: RecordingMachine;
  command: RecorderCommand | null;
}

export type RecordingUploadResult =
  | { ok: true }
  | { ok: false; error: unknown };

const noCommand = (machine: RecordingMachine): RecordingActionResult => ({
  machine,
  command: null,
});

/** 将底层能力探测结果收敛为页面可直接消费的稳定布尔值。 */
export const detectRecordingCapabilities = (
  input: RecordingCapabilityInput,
): RecordingCapabilities => ({
  canRecord: input.hasRecorderManager,
  canPause: input.hasRecorderManager && input.hasPause,
  canResume: input.hasRecorderManager && input.hasResume,
  canInterrupt: input.hasRecorderManager && input.hasInterruptionListener,
});

/** 初始状态必须先完成能力检测，不能假定所有微信环境都支持录音。 */
export const createRecordingMachine = (): RecordingMachine => ({
  state: "checking",
  capabilities: null,
  sessionId: 0,
  operationSeq: 0,
  pendingAction: null,
  pauseReason: null,
  needsManualResume: false,
  clockFrozen: false,
  mounted: true,
  lastError: null,
});

/** unsupported 仅可通过重新检测能力后离开。 */
export const resolveRecordingCapabilities = (
  machine: RecordingMachine,
  capabilities: RecordingCapabilities,
): RecordingMachine => {
  if (!machine.mounted || (machine.state !== "checking" && machine.state !== "unsupported")) {
    return machine;
  }

  return {
    ...machine,
    capabilities,
    state: capabilities.canRecord ? "idle" : "unsupported",
    pendingAction: null,
    pauseReason: null,
    needsManualResume: false,
    clockFrozen: false,
    lastError: null,
  };
};

const issueCommand = (
  machine: RecordingMachine,
  type: RecorderAction,
  nextState: RecordingState,
  options: Pick<RecordingMachine, "pauseReason" | "needsManualResume" | "clockFrozen">,
  sessionId = machine.sessionId,
): RecordingActionResult => {
  const operationSeq = machine.operationSeq + 1;
  const nextMachine: RecordingMachine = {
    ...machine,
    ...options,
    state: nextState,
    sessionId,
    operationSeq,
    pendingAction: type,
    lastError: null,
  };

  return {
    machine: nextMachine,
    command: { type, sessionId, operationSeq },
  };
};

/**
 * 页面只执行返回的 command；状态只会在 resolveRecorderCallback 收到原生确认后稳定。
 * 快速重复点击会因 pendingAction 或当前状态不匹配而返回 null command。
 */
export const requestRecorderAction = (
  machine: RecordingMachine,
  action: RecorderAction,
  pauseReason: Exclude<PauseReason, null> = "user",
): RecordingActionResult => {
  if (!machine.mounted || machine.pendingAction) return noCommand(machine);

  if (action === "start" && (machine.state === "idle" || machine.state === "recorded" || machine.state === "error")) {
    return issueCommand(
      machine,
      "start",
      "starting",
      { pauseReason: null, needsManualResume: false, clockFrozen: false },
      machine.sessionId + 1,
    );
  }

  if (action === "pause" && machine.state === "recording" && machine.capabilities?.canPause) {
    return issueCommand(machine, "pause", "recording", {
      pauseReason,
      needsManualResume: pauseReason !== "user",
      clockFrozen: true,
    });
  }

  if (action === "resume" && machine.state === "paused" && machine.capabilities?.canResume) {
    return issueCommand(machine, "resume", "paused", {
      pauseReason: machine.pauseReason,
      needsManualResume: false,
      clockFrozen: true,
    });
  }

  if (action === "stop" && (machine.state === "recording" || machine.state === "paused")) {
    return issueCommand(machine, "stop", "stopping", {
      pauseReason,
      needsManualResume: false,
      clockFrozen: true,
    });
  }

  return noCommand(machine);
};

const callbackMatchesPendingAction = (
  machine: RecordingMachine,
  callback: RecorderCallback,
) =>
  machine.mounted &&
  callback.sessionId === machine.sessionId &&
  callback.operationSeq === machine.operationSeq &&
  callback.type === machine.pendingAction;

const canAcceptSystemStop = (
  machine: RecordingMachine,
  callback: RecorderCallback,
) =>
  callback.type === "stop" &&
  callback.operationSeq === machine.operationSeq &&
  (machine.state === "recording" ||
    machine.state === "paused" ||
    (machine.state === "starting" &&
      machine.pendingAction === "pause" &&
      machine.pauseReason === "interruption"));

/** 只有当前会话、当前操作的原生确认才能转换到稳定状态。 */
export const resolveRecorderCallback = (
  machine: RecordingMachine,
  callback: RecorderCallback,
): RecordingMachine => {
  if (!machine.mounted || callback.sessionId !== machine.sessionId) return machine;

  if (callback.type === "error") {
    if (callback.operationSeq !== machine.operationSeq) return machine;
    // 已获得有效录音或正在上传时，迟到的原生诊断不能毁掉可用数据。
    if (!machine.pendingAction && machine.state !== "recording" && machine.state !== "paused") {
      return machine;
    }
    return {
      ...machine,
      state: "error",
      pendingAction: null,
      clockFrozen: true,
      lastError: callback.error,
    };
  }

  // 五分钟上限、系统打断等会直接触发 onStop，并不总有页面 stop 意图。
  if (canAcceptSystemStop(machine, callback)) {
    return {
      ...machine,
      state: "recorded",
      pendingAction: null,
      needsManualResume: false,
      clockFrozen: false,
    };
  }

  if (!callbackMatchesPendingAction(machine, callback)) return machine;

  if (callback.type === "start") {
    return {
      ...machine,
      state: "recording",
      pendingAction: null,
      pauseReason: null,
      needsManualResume: false,
      clockFrozen: false,
    };
  }

  if (callback.type === "pause") {
    return {
      ...machine,
      state: "paused",
      pendingAction: null,
      clockFrozen: true,
    };
  }

  if (callback.type === "resume") {
    return {
      ...machine,
      state: "recording",
      pendingAction: null,
      pauseReason: null,
      needsManualResume: false,
      clockFrozen: false,
    };
  }

  return {
    ...machine,
    state: "recorded",
    pendingAction: null,
    needsManualResume: false,
    clockFrozen: false,
  };
};

/** 中断后微信会原生暂停；这里只建立回调屏障，不能重复调用 recorder.pause。 */
export const handleInterruptionBegin = (
  machine: RecordingMachine,
): RecordingActionResult => {
  if (!machine.mounted || !machine.capabilities?.canInterrupt) {
    return noCommand(machine);
  }

  const waitForNativePause = (current: RecordingMachine): RecordingActionResult => ({
    machine: {
      ...current,
      operationSeq: current.operationSeq + 1,
      pendingAction: "pause",
      pauseReason: "interruption",
      needsManualResume: true,
      clockFrozen: true,
    },
    command: null,
  });

  if (machine.state === "starting" && machine.pendingAction === "start") {
    return waitForNativePause(machine);
  }

  if (machine.state === "recording") {
    // 已发出的用户 pause 本身就是可等待的原生 pause，不必重复设置屏障。
    if (machine.pendingAction === "pause") {
      return {
        machine: {
          ...machine,
          pauseReason: "interruption",
          needsManualResume: true,
          clockFrozen: true,
        },
        command: null,
      };
    }
    return machine.pendingAction ? noCommand(machine) : waitForNativePause(machine);
  }

  if (machine.state === "paused") {
    if (machine.pendingAction === "resume") return waitForNativePause(machine);
    if (machine.pendingAction) return noCommand(machine);
    return {
      machine: {
        ...machine,
        pauseReason: "interruption",
        needsManualResume: true,
        clockFrozen: true,
      },
      command: null,
    };
  }

  return noCommand(machine);
};

/** 中断结束绝不自动恢复，用户必须明确点击继续。 */
export const handleInterruptionEnd = (
  machine: RecordingMachine,
): RecordingActionResult => {
  if (!machine.mounted || machine.pauseReason !== "interruption") {
    return noCommand(machine);
  }

  return {
    machine: { ...machine, needsManualResume: true },
    command: null,
  };
};

export const beginRecordingUpload = (machine: RecordingMachine): RecordingMachine =>
  machine.mounted && machine.state === "recorded"
    ? { ...machine, state: "uploading" }
    : machine;

export const finishRecordingUpload = (
  machine: RecordingMachine,
  result: RecordingUploadResult,
): RecordingMachine =>
  machine.mounted && machine.state === "uploading"
    ? {
        ...machine,
        // 上传失败仍保留这一份录音，用户可直接再次 beginRecordingUpload。
        state: "recorded",
        lastError: result.ok ? null : result.error,
      }
    : machine;

/** 启动时发现同一训练已有本地录音，可恢复回听与手动提交，不会自动联网。 */
export const restoreRecordedMachine = (
  machine: RecordingMachine,
): RecordingMachine =>
  machine.mounted &&
  !machine.pendingAction &&
  (machine.state === "idle" ||
    machine.state === "unsupported" ||
    machine.state === "recorded" ||
    machine.state === "error")
    ? {
        ...machine,
        state: "recorded",
        pauseReason: null,
        needsManualResume: false,
        clockFrozen: false,
        lastError: null,
      }
    : machine;

/** 只重置稳定的本地录音；上传中和原生操作进行中必须由各自回调收敛。 */
export const resetRecordingMachine = (
  machine: RecordingMachine,
): RecordingMachine =>
  machine.mounted &&
  !machine.pendingAction &&
  (machine.state === "recorded" || machine.state === "error")
    ? {
        ...machine,
        state: machine.capabilities?.canRecord ? "idle" : "unsupported",
        pauseReason: null,
        needsManualResume: false,
        clockFrozen: false,
        lastError: null,
      }
    : machine;

/** 卸载后不再接受任何原生回调，避免旧页面覆盖新会话。 */
export const disposeRecordingMachine = (
  machine: RecordingMachine,
): RecordingMachine => ({
  ...machine,
  mounted: false,
  pendingAction: null,
  clockFrozen: true,
});
