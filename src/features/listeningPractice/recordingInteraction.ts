import type { RecordingState } from "./recordingStateMachine";

export type { PauseReason, RecordingState } from "./recordingStateMachine";

export interface RecordingTimeline {
  accumulatedMs: number;
  activeSinceMs: number | null;
}

/** 保留微信原始错误；未知录音失败不能一律归因为麦克风权限。 */
export const getRecordingErrorMessage = (error: unknown): string => {
  const details =
    error && typeof error === "object"
      ? (error as {
          errMsg?: string;
          message?: string;
          errCode?: string | number;
          errno?: string | number;
          code?: string | number;
        })
      : undefined;
  const message =
    (typeof details?.errMsg === "string" ? details.errMsg : "") ||
    (typeof details?.message === "string" ? details.message : "") ||
    (typeof error === "string" ? error : "");
  const candidateCode = details?.errCode ?? details?.errno ?? details?.code;
  const code =
    typeof candidateCode === "string" || typeof candidateCode === "number"
      ? candidateCode
      : undefined;
  const reason = message || "微信未返回具体原因，请重新进入小程序后重试。";
  return code === undefined ? reason : `${reason}\n错误码：${code}`;
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
