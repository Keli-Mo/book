import type { RecordingState } from "./recordingStateMachine";

export type { PauseReason, RecordingState } from "./recordingStateMachine";

export interface RecordingTimeline {
  accumulatedMs: number;
  activeSinceMs: number | null;
}

/** 区分首次询问与已明确拒绝，只有后者才引导用户进入设置页。 */
export const getRecordingPermissionStep = (
  authorized: unknown,
): "granted" | "request" | "open-settings" =>
  authorized === true
    ? "granted"
    : authorized === false
      ? "open-settings"
      : "request";

export type ParsedNativeRecordingResult =
  | {
      ok: true;
      tempFilePath: string;
      durationMs: number;
      fileSizeBytes: number;
    }
  | {
      ok: false;
      reason: "missing-path" | "invalid-duration" | "too-short" | "invalid-size";
      message: string;
    };

/** 不用页面计时器猜测文件元数据，打卡仅接受 RecorderManager 的原生停止结果。 */
export const parseNativeRecordingResult = (
  result: unknown,
): ParsedNativeRecordingResult => {
  const native = result as {
    tempFilePath?: unknown;
    duration?: unknown;
    fileSize?: unknown;
  };
  if (typeof native?.tempFilePath !== "string" || !native.tempFilePath.trim()) {
    return { ok: false, reason: "missing-path", message: "录音文件未生成，请重新录制" };
  }
  if (typeof native.duration !== "number" || !Number.isFinite(native.duration) || native.duration <= 0) {
    return { ok: false, reason: "invalid-duration", message: "微信未返回有效录音时长，请重新录制" };
  }
  if (native.duration < 500) {
    return { ok: false, reason: "too-short", message: "录音时间太短，请重新录制" };
  }
  if (
    typeof native.fileSize !== "number" ||
    !Number.isSafeInteger(native.fileSize) ||
    native.fileSize <= 0
  ) {
    return { ok: false, reason: "invalid-size", message: "录音文件为空，请重新录制" };
  }
  return {
    ok: true,
    tempFilePath: native.tempFilePath,
    durationMs: native.duration,
    fileSizeBytes: native.fileSize,
  };
};

/** 仅生成界面文案；原始错误仍保留在录音状态中供诊断。 */
export const RECORDER_OCCUPIED_GUIDANCE =
  "微信录音设备仍被占用。请先结束微信通话或其他录音，返回本页重试；若仍无法恢复，再关闭并重新打开微信。";

export const getRecordingErrorMessage = (error: unknown): string => {
  const details = error && typeof error === "object"
    ? error as { errMsg?: unknown; message?: unknown; errCode?: unknown; errno?: unknown; code?: unknown }
    : undefined;
  const description = [typeof error === "string" ? error : "", details?.errMsg, details?.message,
    details?.errCode, details?.errno, details?.code]
    .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
    .join(" ");
  if (/is recording or paused|audio is recording/i.test(description)) {
    return RECORDER_OCCUPIED_GUIDANCE;
  }
  if (/\bENOSPC\b|no space left on device|device storage full|设备存储空间不足/i.test(description)) {
    return "设备存储空间不足，请清理手机存储空间后重试";
  }
  if (/本地录音空间不足|quota|storage[\s_-]?full/i.test(description)) {
    return "本地录音空间不足，请到“我的录音”删除不需要的本地录音后重试";
  }
  return "录音操作失败，请稍后重试";
};

/** 从零开始记录本轮实际录音时长。 */
export const startRecordingTimeline = (nowMs: number): RecordingTimeline => ({
  accumulatedMs: 0,
  activeSinceMs: nowMs,
});

/** 暂停期间不累加时长，只计算真正处于录音状态的时间。 */
export const getRecordingElapsedMs = (
  timeline: RecordingTimeline,
  nowMs: number
): number =>
  timeline.accumulatedMs +
  (timeline.activeSinceMs === null
    ? 0
    : Math.max(0, nowMs - timeline.activeSinceMs));

export const pauseRecordingTimeline = (
  timeline: RecordingTimeline,
  nowMs: number
): RecordingTimeline => ({
  accumulatedMs: getRecordingElapsedMs(timeline, nowMs),
  activeSinceMs: null,
});

export const resumeRecordingTimeline = (
  timeline: RecordingTimeline,
  nowMs: number
): RecordingTimeline => ({
  accumulatedMs: timeline.accumulatedMs,
  activeSinceMs: nowMs,
});

/** 切页前统一判断是否可以直接切换、需要确认或必须等待上传结束。 */
export const getPracticeSwitchPolicy = (
  state: RecordingState
): "allow" | "confirm-discard" | "block-uploading" => {
  if (state === "uploading") {
    return "block-uploading";
  }

  return state === "idle" || state === "unsupported" || state === "checking"
    ? "allow"
    : "confirm-discard";
};
