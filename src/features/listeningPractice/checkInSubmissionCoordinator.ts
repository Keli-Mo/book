import type { PendingCheckIn, PendingCheckInStatus, RecordingShare } from "./pendingCheckInStore";

type RecordingInfo = { fileSizeBytes: number; contentSha1: string };
type PreparedUpload = { state: "upload-required"; id: string; cloudPath: string };
type PreparedCommitted = { state: "committed"; id: string; shareToken: string; expiresAtMs: number };
type PreparedCheckIn = PreparedUpload | PreparedCommitted;
type CreatedCheckIn = { id: string; shareToken: string; expiresAtMs: number };

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
  | { state: "committed"; id: string; shareToken: string; expiresAtMs: number; cleanupPending: boolean }
  | { state: "failed"; error: unknown }
  | { state: "cancelled"; error: unknown };

export type CheckInSubmissionHandle = {
  promise: Promise<SubmissionResult>;
  /** 准备、上传或退避期允许取消；进入持久化/commit 后不可再伪装取消。 */
  cancel(): boolean;
};

export type CheckInSubmissionCoordinatorAdapters = {
  pendingStore: {
    update(requestId: string, patch: Pick<Partial<PendingCheckIn>, "cloudFileId" | "status" | "fileSizeBytes" | "contentSha1">, expectedShareRequestId?: string): Promise<PendingCheckIn | null>;
    markUploaded(requestId: string, cloudFileId: string, expectedShareRequestId?: string): Promise<PendingCheckIn | null>;
    markFailed(requestId: string, expectedShareRequestId?: string): Promise<PendingCheckIn | null>;
    complete(requestId: string, committed: boolean): Promise<boolean>;
    markShared(requestId: string, share: RecordingShare, expectedShareRequestId?: string): Promise<PendingCheckIn | null>;
    markShareExpired?(requestId: string, expectedShareRequestId: string): Promise<boolean>;
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
    shareVersion?: 2;
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
    shareVersion?: 2;
  }): Promise<CreatedCheckIn>;
  scheduler: {
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  clock: { now(): number };
  diagnose?(stage: string, details: { requestId: string; error?: unknown }): void;
};

type SubmitOptions = { onProgress?: (progress: SubmissionProgress) => void };
type Phase = "idle" | "preparing" | "uploading" | "backoff" | "persisting" | "committing" | "done";
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
  return code === "RECORDING_FILE_MISMATCH" || code === "FILE_NOT_FOUND" || code === "STORAGE_FILE_NONEXIST" || code === "-503003";
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
  const diagnose = (stage: string, requestId: string, error?: unknown) => {
    try { adapters.diagnose?.(stage, { requestId, error }); } catch (_error) { /* 诊断失败不能改变分享结果。 */ }
  };

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
    const shareRequestId = pending.shareRequestId?.toLowerCase();

    const emitProgress = (percent: number | null, uncertain: boolean) => {
      try {
        options.onProgress?.({ requestId: pending.requestId, percent, uncertain });
      } catch (_error) {
        // 页面进度渲染异常不能打断已经开始的上传或改变云端结果。
      }
    };

    const markFailedSafely = async () => {
      try {
        await adapters.pendingStore.markFailed(pending.requestId, shareRequestId);
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
        const cancelledPromise = new Promise<never>((_resolve, reject) => {
          rejectCancellation = reject;
        });
        try {
          emitProgress(null, true);
          // onProgress 是外部回调，可能同步调用 cancel；返回后必须先过取消门闩再启动上传。
          if (cancelled) await cancelledPromise;
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

    const buildPayload = (recording: RecordingInfo) => ({
      requestId: shareRequestId || "",
      shareVersion: 2 as const,
      fileSizeBytes: recording.fileSizeBytes,
      contentSha1: recording.contentSha1.toLowerCase(),
      durationMs: pending.durationMs,
      bookId: pending.context.bookId,
      bookTitle: pending.context.bookTitle,
      practiceId: pending.context.practiceId,
      practiceIndex: pending.context.practiceIndex,
      pageNumber: pending.context.pageNumber,
      sectionTitle: pending.context.sectionTitle,
      imageUrl: pending.context.imageUrl,
    });

    // 先把 handle 登记进同录音去重表，再启动流水线；有效链接可能在首个 await 前直接完成。
    const promise = Promise.resolve().then(async (): Promise<SubmissionResult> => {
      try {
        if (cancelled) throw cancelledError;
        if (pending.share && pending.share.expiresAtMs > adapters.clock.now()) {
          phase = "done";
          return { state: "committed", ...pending.share, cleanupPending: false };
        }
        if (!shareRequestId) throw createError("SHARE_GENERATION_REQUIRED", "分享代次尚未持久化，请重新点击分享");
        phase = "preparing";
        const recording = await adapters.getRecordingInfo(pending.localPath);
        if (cancelled) throw cancelledError;
        if (!Number.isSafeInteger(recording.fileSizeBytes) || recording.fileSizeBytes <= 0 || recording.fileSizeBytes > 8 * 1024 * 1024) {
          throw createError("RECORDING_SIZE_INVALID", "录音文件为空、大小无效或超过 8 MiB，请回听检查后重新录制");
        }
        if (typeof recording.contentSha1 !== "string" || !/^[a-f0-9]{40}$/i.test(recording.contentSha1)) {
          throw createError("RECORDING_SHA1_INVALID", "实际录音 SHA-1 无效");
        }
        let cloudFileId = pending.cloudFileId;
        if (pending.contentSha1) {
          // 仅将同一实际文件的两次指纹作比较；onStop.fileSize 不是保存后文件的可靠基准。
          if (recording.fileSizeBytes !== pending.fileSizeBytes || recording.contentSha1.toLowerCase() !== pending.contentSha1.toLowerCase()) {
            throw Object.assign(createError("RECORDING_FILE_CHANGED", "本地录音文件发生变化，已保留录音，请回听检查后重新录制"), {
              expectedSizeBytes: pending.fileSizeBytes,
              actualSizeBytes: recording.fileSizeBytes,
            });
          }
        } else {
          // 旧版本仅存回调大小。用可读取的实际文件建立基准，避免原录音永久无法重试。
          const sizeChanged = recording.fileSizeBytes !== pending.fileSizeBytes;
          if (sizeChanged) {
            console.warn("录音大小已按实际文件校正", { reportedSizeBytes: pending.fileSizeBytes, actualSizeBytes: recording.fileSizeBytes });
          }
          // 旧项没有内容基准，即使大小相同也无法确认原云路径摘要；按prepare新路径上传。
          // 若云端其实已提交，prepare仍返回已有结果，不重复上传，也不删除旧云文件。
          cloudFileId = "";
          const calibrated = await adapters.pendingStore.update(pending.requestId, {
            fileSizeBytes: recording.fileSizeBytes,
            contentSha1: recording.contentSha1.toLowerCase(),
            cloudFileId: "",
            status: "local",
          }, shareRequestId);
          if (!calibrated) throw createError("PENDING_PERSIST_FAILED", "无法保存录音文件信息，已保留本地录音，请重试");
          if (cancelled) throw cancelledError;
        }
        const payload = buildPayload(recording);
        const prepared = await adapters.prepareCheckIn(payload);
        if (prepared.state === "committed") {
          let shared: PendingCheckIn | null = null;
          try { shared = await adapters.pendingStore.markShared(pending.requestId, prepared, shareRequestId); }
          catch (error) { diagnose("share.local_write.failed", pending.requestId, error); }
          diagnose(shared ? "share.ready" : "share.local_write.pending", pending.requestId);
          phase = "done";
          return { state: "committed", id: prepared.id, shareToken: prepared.shareToken, expiresAtMs: prepared.expiresAtMs, cleanupPending: !shared };
        }
        // prepare 可能已在云端确认成功；只在明确需要上传时兑现此前的离页取消。
        if (cancelled) throw cancelledError;

        let repaired = false;
        while (true) {
          if (!cloudFileId) {
            cloudFileId = await runUpload(prepared);
            // 仅在上传 result 已成功后持久化 fileID；此处错误不得回到 runUpload 的网络重试循环。
            const uploaded = await adapters.pendingStore.markUploaded(pending.requestId, cloudFileId, shareRequestId);
            if (!uploaded) throw createError("PENDING_PERSIST_FAILED", "录音上传结果未能保存，不能提交打卡");
          }
          phase = "committing";
          const creating = await adapters.pendingStore.update(pending.requestId, { status: "creating" as PendingCheckInStatus }, shareRequestId);
          if (!creating) throw createError("PENDING_PERSIST_FAILED", "无法保存打卡创建状态");
          try {
            const created = await adapters.commitCheckIn({ ...payload, recordingFileId: cloudFileId });
            let shared: PendingCheckIn | null = null;
            try { shared = await adapters.pendingStore.markShared(pending.requestId, created, shareRequestId); }
            catch (error) { diagnose("share.local_write.failed", pending.requestId, error); }
            diagnose(shared ? "share.ready" : "share.local_write.pending", pending.requestId);
            phase = "done";
            return { state: "committed", id: created.id, shareToken: created.shareToken, expiresAtMs: created.expiresAtMs, cleanupPending: !shared };
          } catch (error) {
            if (!repaired && isRepairableRecordingError(error) && pending.localPath) {
              const reset = await adapters.pendingStore.update(pending.requestId, { cloudFileId: "", status: "local" }, shareRequestId);
              if (!reset) throw createError("PENDING_PERSIST_FAILED", "无法保存录音重传状态");
              cloudFileId = "";
              repaired = true;
              continue;
            }
            throw error;
          }
        }
      } catch (error) {
        diagnose(cancelled ? "share.cancelled" : `share.${phase}.failed`, pending.requestId, error);
        phase = "done";
        const terminalShareCode = String(errorCode(error) || "").toUpperCase();
        if ((terminalShareCode === "SHARE_EXPIRED" || terminalShareCode === "REQUEST_DELETED") && shareRequestId) {
          try { await adapters.pendingStore.markShareExpired?.(pending.requestId, shareRequestId); } catch (_error) { /* 下一次主动点击仍可重试当前代。 */ }
        }
        await markFailedSafely();
        return cancelled || error === cancelledError
          ? { state: "cancelled", error: cancelledError }
          : { state: "failed", error };
      } finally {
        activeByRequest.delete(requestKey);
      }
    });

    const handle: CheckInSubmissionHandle = {
      promise,
      cancel: () => {
        if (cancelled || (phase !== "idle" && phase !== "preparing" && phase !== "uploading" && phase !== "backoff")) return false;
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

  const isSubmitting = (requestId: string) => activeByRequest.has(requestId.toLowerCase());
  const getActive = (requestId: string) => activeByRequest.get(requestId.toLowerCase());
  return { submit, isSubmitting, getActive };
};
