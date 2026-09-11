import type { PendingCheckIn, PendingCheckInStatus } from "./pendingCheckInStore";

type RecordingInfo = { fileSizeBytes: number; contentSha1: string };
type PreparedUpload = { state: "upload-required"; id: string; cloudPath: string };
type PreparedCommitted = { state: "committed"; id: string; shareToken: string };
type PreparedCheckIn = PreparedUpload | PreparedCommitted;
type CreatedCheckIn = { id: string; shareToken: string };

type UploadTask = {
  abort?: () => void;
  onProgressUpdate?: (listener: (event: { progress?: number }) => void) => void;
};

export type SubmissionProgress = {
  requestId: string;
  percent: number | null;
  uncertain: boolean;
};

export type SubmissionResult =
  | { state: "committed"; id: string; shareToken: string; cleanupPending: boolean }
  | { state: "failed"; error: unknown }
  | { state: "cancelled"; error: unknown };

export type CheckInSubmissionHandle = {
  promise: Promise<SubmissionResult>;
  /** 只有上传中或退避期允许取消，避免把已发出的 commit 伪装为可取消。 */
  cancel(): boolean;
};

export type CheckInSubmissionCoordinatorAdapters = {
  pendingStore: {
    update(requestId: string, patch: Pick<Partial<PendingCheckIn>, "cloudFileId" | "status">): Promise<PendingCheckIn | null>;
    markUploaded(requestId: string, cloudFileId: string): Promise<PendingCheckIn | null>;
    markFailed(requestId: string): Promise<PendingCheckIn | null>;
    complete(requestId: string, committed: boolean): Promise<boolean>;
  };
  getRecordingInfo(filePath: string): Promise<RecordingInfo>;
  prepareCheckIn(input: {
    requestId: string;
    fileSizeBytes: number;
    contentSha1: string;
    durationMs: number;
    bookId: string;
    bookTitle: string;
    practiceId: string;
    practiceIndex: number;
    pageNumber: number;
    sectionTitle: string;
    imageUrl: string;
  }): Promise<PreparedCheckIn>;
  startPreparedCheckInUpload(filePath: string, prepared: PreparedUpload): {
    task?: UploadTask;
    result: Promise<string>;
  };
  commitCheckIn(input: {
    requestId: string;
    fileSizeBytes: number;
    contentSha1: string;
    durationMs: number;
    bookId: string;
    bookTitle: string;
    practiceId: string;
    practiceIndex: number;
    pageNumber: number;
    sectionTitle: string;
    imageUrl: string;
    recordingFileId: string;
  }): Promise<CreatedCheckIn>;
  scheduler: {
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  clock: { now(): number };
};

type SubmitOptions = { onProgress?: (progress: SubmissionProgress) => void };
type Phase = "idle" | "uploading" | "backoff" | "persisting" | "committing" | "done";
const RETRY_DELAYS_MS = [1000, 3000];

const createError = (code: string, message: string) =>
  Object.assign(new Error(message), { code });

const errorCode = (error: unknown) => {
  const value = error as { code?: unknown; errCode?: unknown; errno?: unknown };
  return value?.code ?? value?.errCode ?? value?.errno;
};

const errorText = (error: unknown) => {
  const value = error as { message?: unknown; errMsg?: unknown };
  return `${errorCode(error) ?? ""} ${value?.message ?? ""} ${value?.errMsg ?? ""}`.toLowerCase();
};

const isRetryableUploadError = (error: unknown) => {
  const text = errorText(error);
  if (/permission|authori[sz]|quota|invalid|conflict|deleted|abort|cancel/.test(text)) return false;
  return /network|timeout|timed.?out|offline|connection|socket|econn|enet/.test(text);
};

const isRepairableRecordingError = (error: unknown) => {
  const code = String(errorCode(error) ?? "").toUpperCase();
  return code === "RECORDING_FILE_MISMATCH" || code === "FILE_NOT_FOUND" || code === "STORAGE_FILE_NONEXIST";
};

const normalizeProgress = (value: unknown) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, Math.round(value)));
};

/**
 * 把 prepare/upload/commit 的临界顺序集中在这里。页面只在用户明确提交时调用 submit，
 * 因而不会在重启或列表展示时偷偷消耗流量；重启恢复由页面重新显式 submit 待上传项。
 */
export const createCheckInSubmissionCoordinator = (adapters: CheckInSubmissionCoordinatorAdapters) => {
  const activeByRequest = new Map<string, CheckInSubmissionHandle>();

  const submit = (pending: PendingCheckIn, options: SubmitOptions = {}): CheckInSubmissionHandle => {
    const requestKey = pending.requestId.toLowerCase();
    const existing = activeByRequest.get(requestKey);
    if (existing) return existing;

    let phase: Phase = "idle";
    let cancelled = false;
    let activeTask: UploadTask | undefined;
    let timer: unknown;
    let rejectCancellation: ((reason: unknown) => void) | undefined;
    let rejectBackoff: ((reason: unknown) => void) | undefined;
    let nextUploadAttempt = 0;
    let activeUploadAttempt = 0;
    const cancelledError = createError("UPLOAD_CANCELLED", "用户取消了录音上传");

    const emitProgress = (percent: number | null, uncertain: boolean) => {
      try {
        options.onProgress?.({ requestId: pending.requestId, percent, uncertain });
      } catch (_error) {
        // 页面进度渲染异常不能打断已经开始的上传或改变云端结果。
      }
    };

    const markFailedSafely = async () => {
      try {
        await adapters.pendingStore.markFailed(pending.requestId);
      } catch (_error) {
        // 保留原始网络/协议错误；仓储下一次 mutation 会继续处理其自身持久化失败。
      }
    };

    const waitForRetry = (delayMs: number) => new Promise<void>((resolve, reject) => {
      rejectBackoff = reject;
      timer = adapters.scheduler.setTimeout(() => {
        timer = undefined;
        rejectBackoff = undefined;
        resolve();
      }, delayMs);
    });

    const runUpload = async (prepared: PreparedUpload): Promise<string> => {
      for (let attempt = 0; ; attempt += 1) {
        phase = "uploading";
        const attemptToken = ++nextUploadAttempt;
        activeUploadAttempt = attemptToken;
        emitProgress(null, true);
        try {
          // start 的同步异常和 result reject 都是上传阶段；其余持久化步骤在循环外，不能重传文件。
          const upload = adapters.startPreparedCheckInUpload(pending.localPath, prepared);
          activeTask = upload.task;
          // 先把原生 result 转为永不 reject 的 outcome，再尝试可选的进度订阅；订阅 throw 不能遗留 rejection。
          const result = upload.result.then(
            (value) => ({ ok: true as const, value }),
            (error) => ({ ok: false as const, error }),
          );
          try {
            upload.task?.onProgressUpdate?.((event) => {
              if (cancelled || phase !== "uploading" || activeUploadAttempt !== attemptToken) return;
              const percent = normalizeProgress(event?.progress);
              emitProgress(percent, percent === null);
            });
          } catch (_error) {
            // 进度是可选能力：保持不确定即可，仍必须消费同一个 upload result。
            emitProgress(null, true);
          }
          const cancelledPromise = new Promise<never>((_resolve, reject) => {
            rejectCancellation = reject;
          });
          const outcome = await Promise.race([result, cancelledPromise]);
          rejectCancellation = undefined;
          activeTask = undefined;
          activeUploadAttempt = 0;
          if (!outcome.ok) throw outcome.error;
          // result 已经成功后立刻离开可取消区；markUploaded gate 不能返回“取消成功”后继续 commit。
          phase = "persisting";
          const cloudFileId = outcome.value;
          if (typeof cloudFileId !== "string" || !cloudFileId) {
            throw createError("UPLOAD_FILE_ID_EMPTY", "上传未返回云文件编号");
          }
          return cloudFileId;
        } catch (error) {
          rejectCancellation = undefined;
          activeTask = undefined;
          activeUploadAttempt = 0;
          if (cancelled) throw cancelledError;
          if (!isRetryableUploadError(error) || attempt >= RETRY_DELAYS_MS.length) throw error;
          phase = "backoff";
          await waitForRetry(RETRY_DELAYS_MS[attempt]);
          if (cancelled) throw cancelledError;
        }
      }
    };

    const buildPayload = (recordingFileId?: string) => ({
      requestId: requestKey,
      fileSizeBytes: pending.fileSizeBytes,
      contentSha1: "",
      durationMs: pending.durationMs,
      bookId: pending.context.bookId,
      bookTitle: pending.context.bookTitle,
      practiceId: pending.context.practiceId,
      practiceIndex: pending.context.practiceIndex,
      pageNumber: pending.context.pageNumber,
      sectionTitle: pending.context.sectionTitle,
      imageUrl: pending.context.imageUrl,
      ...(recordingFileId ? { recordingFileId } : {}),
    });

    const promise = (async (): Promise<SubmissionResult> => {
      try {
        const recording = await adapters.getRecordingInfo(pending.localPath);
        if (recording.fileSizeBytes !== pending.fileSizeBytes) {
          throw createError("RECORDING_SIZE_MISMATCH", "实际录音大小与停止录音时保存的大小不一致");
        }
        if (typeof recording.contentSha1 !== "string" || !/^[a-f0-9]{40}$/i.test(recording.contentSha1)) {
          throw createError("RECORDING_SHA1_INVALID", "实际录音 SHA-1 无效");
        }
        const payload = { ...buildPayload(), contentSha1: recording.contentSha1.toLowerCase() };
        const prepared = await adapters.prepareCheckIn(payload);
        if (prepared.state === "committed") {
          let cleaned = false;
          try { cleaned = await adapters.pendingStore.complete(pending.requestId, true); } catch (_error) { cleaned = false; }
          phase = "done";
          return { state: "committed", id: prepared.id, shareToken: prepared.shareToken, cleanupPending: !cleaned };
        }

        let cloudFileId = pending.cloudFileId;
        let repaired = false;
        while (true) {
          if (!cloudFileId) {
            cloudFileId = await runUpload(prepared);
            // 仅在上传 result 已成功后持久化 fileID；此处错误不得回到 runUpload 的网络重试循环。
            const uploaded = await adapters.pendingStore.markUploaded(pending.requestId, cloudFileId);
            if (!uploaded) throw createError("PENDING_PERSIST_FAILED", "录音上传结果未能保存，不能提交打卡");
          }
          phase = "committing";
          const creating = await adapters.pendingStore.update(pending.requestId, { status: "creating" as PendingCheckInStatus });
          if (!creating) throw createError("PENDING_PERSIST_FAILED", "无法保存打卡创建状态");
          try {
            const created = await adapters.commitCheckIn({ ...payload, recordingFileId: cloudFileId });
            let cleaned = false;
            try { cleaned = await adapters.pendingStore.complete(pending.requestId, true); } catch (_error) { cleaned = false; }
            phase = "done";
            return { state: "committed", id: created.id, shareToken: created.shareToken, cleanupPending: !cleaned };
          } catch (error) {
            if (!repaired && isRepairableRecordingError(error) && pending.localPath) {
              const reset = await adapters.pendingStore.update(pending.requestId, { cloudFileId: "", status: "local" });
              if (!reset) throw createError("PENDING_PERSIST_FAILED", "无法保存录音重传状态");
              cloudFileId = "";
              repaired = true;
              continue;
            }
            throw error;
          }
        }
      } catch (error) {
        phase = "done";
        await markFailedSafely();
        return cancelled || error === cancelledError
          ? { state: "cancelled", error: cancelledError }
          : { state: "failed", error };
      } finally {
        activeByRequest.delete(requestKey);
      }
    })();

    const handle: CheckInSubmissionHandle = {
      promise,
      cancel: () => {
        if (cancelled || (phase !== "uploading" && phase !== "backoff")) return false;
        cancelled = true;
        activeUploadAttempt = 0;
        if (timer !== undefined) {
          adapters.scheduler.clearTimeout(timer);
          timer = undefined;
        }
        try { activeTask?.abort?.(); } catch (_error) { /* abort 原生异常仍视为取消，不能继续重试。 */ }
        rejectCancellation?.(cancelledError);
        rejectBackoff?.(cancelledError);
        return true;
      },
    };
    activeByRequest.set(requestKey, handle);
    return handle;
  };

  return { submit };
};
