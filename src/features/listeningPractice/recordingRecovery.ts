import type { RecordingRecoverySource } from "../../services/cloudCheckIn";
import { MAX_RECORDING_FILE_BYTES, PENDING_RECORDING_BYTES } from "./pendingCheckInStore";
import type { createPendingCheckInStore, PendingCheckIn } from "./pendingCheckInStore";

type FileInfo = { fileSizeBytes: number; contentSha1: string };
export const getRecordingRecoveryMessage = (error: unknown) => {
  const code = (error as { code?: unknown } | undefined)?.code;
  if (code === "FORBIDDEN" || code === "UNAUTHENTICATED") return "只能恢复本人录音，请确认微信账号；原记录已保留";
  if (code === "SHARE_EXPIRED" || code === "NOT_FOUND" || code === "REQUEST_DELETED") return "分享已失效，暂时无法恢复；原记录已保留";
  if (code === "RECOVERY_CAPACITY") return "本地空间不足，请先整理录音；原记录已保留";
  if (code === "RECOVERY_VERIFY_FAILED" || code === "RECORDING_INFO_INVALID" || code === "RECOVERY_SOURCE_INVALID" || code === "RECOVERY_RESPONSE_INVALID") return "录音校验失败，暂时无法恢复；原记录已保留";
  if (code === "PENDING_PERSIST_FAILED") return "恢复文件已保存，索引写入失败，请重试；原记录已保留";
  if (code === "RECOVERY_CHANGED") return "录音或分享已变更，请重新打开；原记录已保留";
  return "恢复未完成，原录音已保留，请稍后重试";
};
const recoveryError = (code: string) => Object.assign(new Error(getRecordingRecoveryMessage({ code })), { code });
type RecoveryAdapters = {
  store: ReturnType<typeof createPendingCheckInStore>;
  source(id: string): Promise<RecordingRecoverySource>;
  download(url: string, expiresAtMs?: number): Promise<string>;
  info(path: string): Promise<FileInfo>;
  discardTemporary(path: string): Promise<void>;
  now(): number;
  usageBytes(): Promise<number>;
};

/** 只有显式 recover 才联网；页面重建可采用 active Promise，不补启动下载。 */
export const createRecordingRecovery = (adapters: RecoveryAdapters) => {
  const active = new Map<string, Promise<PendingCheckIn>>();
  const run = async (requestId: string) => {
    await adapters.store.ready();
    const retried = await adapters.store.retryRestoreRecording(requestId);
    if (retried === null) throw recoveryError("RECOVERY_CHANGED");
    if (retried) return retried;
    const snapshot = adapters.store.list().find(item => item.requestId === requestId);
    if (!snapshot?.share?.id) throw recoveryError("NOT_FOUND");
    const source = await adapters.source(snapshot.share.id);
    if (source.id !== snapshot.share.id || !/^https:\/\/[^\s]+$/i.test(source.recordingUrl)) throw recoveryError("RECOVERY_VERIFY_FAILED");
    const usage = await adapters.usageBytes();
    if (!Number.isSafeInteger(usage) || usage < 0 || usage + (source.fileSizeBytes ?? MAX_RECORDING_FILE_BYTES) > PENDING_RECORDING_BYTES) {
      throw recoveryError("RECOVERY_CAPACITY");
    }
    const path = await adapters.download(source.recordingUrl, source.expiresAtMs);
    try {
      if (path === snapshot.localPath) throw recoveryError("RECOVERY_VERIFY_FAILED");
      const info = await adapters.info(path);
      if (!Number.isSafeInteger(info.fileSizeBytes) || info.fileSizeBytes <= 0 || info.fileSizeBytes > MAX_RECORDING_FILE_BYTES ||
          !/^[0-9a-f]{40}$/i.test(info.contentSha1) ||
          (source.fileSizeBytes !== undefined && source.fileSizeBytes !== info.fileSizeBytes) ||
          (source.contentSha1 !== undefined && source.contentSha1.toLowerCase() !== info.contentSha1.toLowerCase()) ||
          (snapshot.contentSha1 !== undefined && (snapshot.fileSizeBytes !== info.fileSizeBytes || snapshot.contentSha1.toLowerCase() !== info.contentSha1.toLowerCase())) ||
          (source.expiresAtMs !== undefined && source.expiresAtMs <= adapters.now())) {
        throw recoveryError("RECOVERY_VERIFY_FAILED");
      }
      // legacy 无旧 SHA 时不能用 onStop 的旧大小作内容基准；本人授权的精确分享与实测内容建立新基准。
      const restored = await adapters.store.restoreRecording(snapshot, path, { ...info, expiresAtMs: source.expiresAtMs });
      if (!restored) throw recoveryError("RECOVERY_CHANGED");
      return restored;
    } finally {
      // saveFile 可能已移动临时文件；只清理本次下载路径，绝不清理任何旧/新保存路径。
      if (path !== snapshot.localPath) await adapters.discardTemporary(path).catch(() => undefined);
    }
  };
  const recover = (requestId: string): Promise<PendingCheckIn> => {
    const existing = active.get(requestId);
    if (existing) return existing;
    const promise = run(requestId).finally(() => { if (active.get(requestId) === promise) active.delete(requestId); });
    active.set(requestId, promise);
    return promise;
  };
  return { recover, getActive: (requestId: string) => active.get(requestId) };
};
