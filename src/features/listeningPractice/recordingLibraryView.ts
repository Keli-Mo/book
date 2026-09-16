import type { CheckInSummary } from "@/services/cloudCheckIn";
import type { PendingCheckIn } from "./pendingCheckInStore";

export type RecordingLibraryItem =
  | { kind: "local"; localId: string; pending: PendingCheckIn; sortTimeMs: number }
  | { kind: "cloud"; cloud: CheckInSummary; sortTimeMs: number };

const toTimeMs = (value: string | number | Date) => {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
};

/** 本地文件是录音库主记录；云端历史只补充本机没有的旧记录。 */
export const mergeRecordingLibrary = (
  localItems: readonly PendingCheckIn[],
  cloudItems: readonly CheckInSummary[],
): RecordingLibraryItem[] => {
  const sharedCloudIds = new Set(
    localItems.map((item) => item.share?.id).filter((id): id is string => Boolean(id)),
  );
  return [
    ...localItems.map((pending) => ({
      kind: "local" as const,
      localId: pending.requestId,
      pending,
      sortTimeMs: pending.completedAtMs ?? pending.createdAtMs ?? pending.updatedAtMs,
    })),
    ...cloudItems
      .filter((cloud) => cloud.status === "deletePending" || !sharedCloudIds.has(cloud.id))
      .map((cloud) => ({ kind: "cloud" as const, cloud, sortTimeMs: toTimeMs(cloud.createdAt) })),
  ].sort((left, right) => right.sortTimeMs - left.sortTimeMs);
};
