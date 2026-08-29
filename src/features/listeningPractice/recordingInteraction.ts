export type RecordingState =
  | "idle"
  | "recording"
  | "paused"
  | "recorded"
  | "uploading";

export interface RecordingTimeline {
  accumulatedMs: number;
  activeSinceMs: number | null;
}

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

  return state === "idle" ? "allow" : "confirm-discard";
};
