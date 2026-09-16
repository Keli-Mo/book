import {
  commitCheckIn,
  getCheckInRecordingInfo,
  prepareCheckIn,
  startPreparedCheckInUpload,
} from "@/services/cloudCheckIn";
import { createCheckInSubmissionCoordinator } from "./checkInSubmissionCoordinator";
import { getPendingCheckInStore, logRecordingDiagnostic } from "./pendingCheckInRuntime";

const submissionCoordinator = createCheckInSubmissionCoordinator({
  pendingStore: getPendingCheckInStore(),
  getRecordingInfo: getCheckInRecordingInfo,
  prepareCheckIn,
  startPreparedCheckInUpload,
  commitCheckIn,
  scheduler: {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
  clock: { now: () => Date.now() },
  diagnose: logRecordingDiagnostic,
});

/** 页面共用提交协调器，保证同一个 requestId 在跨页重试时只执行一条流水线。 */
export const getCheckInSubmissionCoordinator = () => submissionCoordinator;
