export const CHECK_IN_FUNCTION_NAME = "checkIn";
const MAX_RECORDING_BYTES = 8 * 1024 * 1024;

export interface CreateCheckInInput {
  recordingFileId: string;
  durationMs: number;
  bookId: string;
  bookTitle: string;
  practiceId: string;
  practiceIndex: number;
  pageNumber: number;
  sectionTitle: string;
  imageUrl: string;
}

export interface CreatedCheckIn {
  id: string;
  shareToken: string;
  expiresAtMs: number;
}

export type LegacyCreatedCheckIn = Omit<CreatedCheckIn, "expiresAtMs">;

export type PrepareCheckInInput = Omit<CreateCheckInInput, "recordingFileId"> & {
  requestId: string;
  fileSizeBytes: number;
  contentSha1: string;
  shareVersion?: 2;
};

export type PreparedCheckInUpload = {
  state: "upload-required";
  id: string;
  cloudPath: string;
};

export type PreparedCheckIn = PreparedCheckInUpload | (CreatedCheckIn & { state: "committed" });
export type CommitCheckInInput = PrepareCheckInInput & { recordingFileId: string };

export interface CheckInSummary {
  id: string;
  status?: "deletePending";
  shareToken: string;
  /** 新版分享由服务端给出期限；旧记录缺失时继续兼容。 */
  expiresAtMs?: number;
  bookId: string;
  bookTitle: string;
  practiceId: string;
  practiceIndex: number;
  pageNumber: number;
  sectionTitle: string;
  imageUrl: string;
  durationMs: number;
  createdAt: string | number | Date;
}

export interface CheckInDetail extends CheckInSummary {
  recordingUrl: string;
  isOwner: boolean;
}

export interface RecordingRecoverySource {
  id: string;
  recordingUrl: string;
  expiresAtMs?: number;
  fileSizeBytes?: number;
  contentSha1?: string;
}

interface CloudFunctionResponse<T> {
  ok: boolean;
  data?: T;
  message?: string;
  code?: string | number;
}

const ensureCloudAvailable = () => {
  if (!wx.cloud) {
    throw new Error("当前微信版本不支持云开发，请升级微信后重试");
  }
};

const shareResponseError = (code = "SHARE_RESPONSE_INVALID") => Object.assign(
  new Error(code === "SHARE_PROTOCOL_MISMATCH"
    ? "checkIn 云函数未返回新版分享协议，请核对并部署支持 shareVersion:2 的版本"
    : "checkIn 云函数返回的分享数据格式无效"), { code },
);

const cloudErrorMessages = Object.freeze<Record<string, string>>({
  CHECK_IN_ERROR: "云端服务暂时不可用，请稍后重试",
  INVALID_ARGUMENT: "提交的信息格式不正确，请重试",
  ECONNRESET: "网络异常，请稍后重试",
  ETIMEDOUT: "网络请求超时，请稍后重试",
  DATABASE_TRANSACTION_CONFLICT: "服务繁忙，请稍后重试",
  FILE_DELETE_FAILED: "云录音删除未完成，请重试",
  FILE_REFERENCE_CONFLICT: "录音引用归属冲突，请联系管理员核验",
  FILE_REFERENCE_CHECK_FAILED: "录音引用核验失败，请稍后重试",
  FORBIDDEN: "无权操作这条录音",
  REQUEST_ID_CONFLICT: "分享请求不匹配，请重新进入后重试",
  REQUEST_DELETED: "该分享已删除，不能重新提交",
  SHARE_EXPIRED: "分享已过期或失效",
  SHARE_NOT_PREPARED: "请先准备分享后重试",
  SHARE_NOT_COMMITTED: "分享尚未完成，请稍后重试",
  INVALID_FILE_ID: "录音文件信息不匹配，请重试",
  RECORDING_FILE_MISMATCH: "录音文件校验失败，请重试",
  CLOUD_ENV_UNAVAILABLE: "云端服务配置暂不可用",
  SHARE_PROTOCOL_MISMATCH: "分享服务版本不匹配，请联系开发者",
  SHARE_RESPONSE_INVALID: "分享服务返回异常，请稍后重试",
  SHARE_STATUS_UNAVAILABLE: "暂时无法核验分享，请稍后重试",
  SHARE_GENERATION_MISMATCH: "分享请求不匹配，请重新进入后重试",
  PENDING_PERSIST_FAILED: "本机状态保存失败，录音仍保留，请重试",
  STORAGE_PREFIX_REQUIRED: "分享服务配置未完成，请联系开发者",
  LEGACY_CREATE_DISABLED: "旧版分享服务已停用，请升级后重试",
  UNAUTHENTICATED: "无法识别当前微信用户",
  NOT_FOUND: "打卡记录不存在或已失效",
  RECORDING_INFO_INVALID: "无法读取有效的录音文件信息，请重试",
  RECOVERY_SOURCE_INVALID: "云录音恢复信息异常，请稍后重试",
  RECOVERY_RESPONSE_INVALID: "云录音恢复信息异常，请稍后重试",
  CLOUD_FUNCTION_NOT_FOUND: "云函数尚未部署，请先在微信开发者工具中上传并部署 checkIn 云函数",
  DATABASE_COLLECTION_NOT_FOUND: "云数据库尚未创建 checkins 集合，请先按部署说明完成初始化",
  STORAGE_ERROR: "录音上传失败，请检查网络或云存储配置后重试",
});

const classifyCloudError = (error: unknown): { code: string; message: string } => {
  const details = error && typeof error === "object"
    ? error as { code?: unknown; errCode?: unknown; errno?: unknown; errMsg?: unknown; message?: unknown }
    : undefined;
  const candidate = details?.code ?? details?.errCode ?? details?.errno;
  if (typeof candidate === "string" && Object.prototype.hasOwnProperty.call(cloudErrorMessages, candidate)) {
    return { code: candidate, message: cloudErrorMessages[candidate] };
  }
  const text = [details?.errMsg, details?.message, typeof error === "string" ? error : ""]
    .filter(value => typeof value === "string").join(" ");
  if (/FunctionName|FUNCTION_NOT_FOUND|云函数不存在|-501000/i.test(text)) {
    return { code: "CLOUD_FUNCTION_NOT_FOUND", message: cloudErrorMessages.CLOUD_FUNCTION_NOT_FOUND };
  }
  if (/collection|DATABASE_COLLECTION_NOT_EXIST|-502005/i.test(text)) {
    return { code: "DATABASE_COLLECTION_NOT_FOUND", message: cloudErrorMessages.DATABASE_COLLECTION_NOT_FOUND };
  }
  if (/network|timeout|timed.?out|offline|connection|econn|enet/i.test(text)) {
    return { code: "ECONNRESET", message: cloudErrorMessages.ECONNRESET };
  }
  if (/storage|uploadFile|file/i.test(text) || candidate === -404001) {
    return { code: "STORAGE_ERROR", message: cloudErrorMessages.STORAGE_ERROR };
  }
  return { code: "CHECK_IN_ERROR", message: cloudErrorMessages.CHECK_IN_ERROR };
};

const safeCloudError = (error: unknown) => {
  const classified = classifyCloudError(error);
  return Object.assign(new Error(classified.message), { code: classified.code });
};

const callCheckInFunction = async <T>(data: Record<string, unknown>) => {
  ensureCloudAvailable();
  let response: { result: unknown };
  try {
    response = await wx.cloud.callFunction({
      name: CHECK_IN_FUNCTION_NAME,
      data,
    });
  } catch (error) {
    throw safeCloudError(error);
  }
  const result = response.result as CloudFunctionResponse<T> | undefined;

  // 新版分享的空包/畸形成功包也属于响应异常；保留明确的服务端业务失败码及旧调用语义。
  if (data.shareVersion === 2 && (!result || typeof result.ok !== "boolean" || (result.ok && result.data === undefined))) {
    throw shareResponseError();
  }
  if (!result?.ok || result.data === undefined) {
    throw safeCloudError(result);
  }

  return result.data;
};

/** 从 saveFile 后的实际文件获取原生内容指纹，不用时长/文件名猜测录音身份。 */
export const getCheckInRecordingInfo = (filePath: string): Promise<{
  fileSizeBytes: number;
  contentSha1: string;
}> => new Promise((resolve, reject) => {
  wx.getFileInfo({
    filePath,
    digestAlgorithm: "sha1",
    success: (result) => {
      // 原生异步回调里必须主动 reject，不能因摘要缺失而抛异常后让保存/提交永远等待。
      const size = result?.size;
      const digest = result?.digest;
      if (!Number.isSafeInteger(size) || size <= 0 || typeof digest !== "string" || !/^[a-f0-9]{40}$/i.test(digest)) {
        reject(Object.assign(new Error("无法读取有效的录音文件大小和内容摘要，请重试"), { code: "RECORDING_INFO_INVALID" }));
        return;
      }
      resolve({ fileSizeBytes: size, contentSha1: digest.toLowerCase() });
    },
    fail: reject,
  });
});

const isNonEmptyText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** TS 类型不能校验线上回包；期限必须来自服务器，不能在本机猜测补齐。 */
const validateCreatedShare = (value: unknown): CreatedCheckIn => {
  const share = value as Partial<CreatedCheckIn> | null;
  if (!share || !isNonEmptyText(share.id) || !isNonEmptyText(share.shareToken)) throw shareResponseError();
  if (share.expiresAtMs === undefined) throw shareResponseError("SHARE_PROTOCOL_MISMATCH");
  if (typeof share.expiresAtMs !== "number" || !Number.isSafeInteger(share.expiresAtMs) || share.expiresAtMs <= 0) throw shareResponseError();
  return { id: share.id, shareToken: share.shareToken, expiresAtMs: share.expiresAtMs };
};

/** prepare 不上传文件；先校验 v2 专用路径，防止旧云函数忽略版本后创建无期限分享。 */
export const prepareCheckIn = async (input: PrepareCheckInInput): Promise<PreparedCheckIn> => {
  const prepared = await callCheckInFunction<PreparedCheckIn>({ ...input, requestId: input.requestId.toLowerCase(), shareVersion: 2, action: "prepare" });
  if (prepared?.state === "committed") return { state: "committed", ...validateCreatedShare(prepared) };
  if (prepared?.state !== "upload-required" || !isNonEmptyText(prepared.id) || !isNonEmptyText(prepared.cloudPath)) throw shareResponseError();
  if (prepared.cloudPath.startsWith("checkins/")) throw shareResponseError("SHARE_PROTOCOL_MISMATCH");
  if (!/^expiring-shares-v2\/.+/.test(prepared.cloudPath)) throw shareResponseError();
  return prepared;
};

/** 返回原生 UploadTask，进度/取消交给页面；上传结果先持久化，再由页面调用 commit。 */
export const startPreparedCheckInUpload = (filePath: string, prepared: PreparedCheckInUpload): {
  task: WechatMiniprogram.UploadTask | undefined;
  result: Promise<string>;
} => {
  let task: WechatMiniprogram.UploadTask | undefined;
  const result = new Promise<string>((resolve, reject) => {
    try {
      ensureCloudAvailable();
      task = wx.cloud.uploadFile({
        cloudPath: prepared.cloudPath,
        filePath,
        success: ({ fileID }) => resolve(fileID),
        fail: reject,
      });
    } catch (error) {
      reject(error);
    }
  });
  return { task, result };
};

/** commit 响应不确定时保留本地/云文件，重试复用原请求，不在本层删除或自动重试。 */
export const commitCheckIn = async (input: CommitCheckInInput): Promise<CreatedCheckIn> =>
  validateCreatedShare(await callCheckInFunction<unknown>({ ...input, requestId: input.requestId.toLowerCase(), shareVersion: 2, action: "commit" }));

/** 用户只看简短分类；底层错误原文可能含 fileID、签名 URL，不能直接放进 toast。 */
export const getShareFailureMessage = (error: unknown): string => {
  const { code } = classifyCloudError(error);
  if (code === "SHARE_PROTOCOL_MISMATCH") return "分享服务版本不匹配，请联系开发者";
  if (code === "SHARE_RESPONSE_INVALID") return "分享服务返回异常，请稍后重试";
  if (code === "STORAGE_PREFIX_REQUIRED") return "分享服务配置未完成，请联系开发者";
  if (code === "PENDING_PERSIST_FAILED") return "本机状态保存失败，录音仍保留，请重试";
  if (code === "SHARE_EXPIRED" || code === "REQUEST_DELETED") return "分享已失效，请再次点击生成新分享";
  if (code === "ECONNRESET" || code === "ETIMEDOUT") return "网络异常，录音仍保留，请重试";
  return "分享失败，本机录音仍保留";
};

/** 兼容旧页面的随机路径上传；新幂等流程使用 prepare + startPreparedCheckInUpload。 */
export const uploadCheckInRecording = async (
  tempFilePath: string,
  practiceId: string,
) => {
  ensureCloudAvailable();
  const day = new Date().toISOString().slice(0, 10);
  const nonce = Math.random().toString(36).slice(2, 10);
  const cloudPath = `checkins/${day}/${practiceId}-${Date.now()}-${nonce}.mp3`;
  const result = await wx.cloud.uploadFile({ cloudPath, filePath: tempFilePath });
  return result.fileID;
};

/** 仅兼容旧页面；新 prepare/commit 协议禁止用失败清理删除结果不确定的录音。 */
export const removeUploadedRecording = async (fileId: string) => {
  if (!wx.cloud || !fileId) return;
  try {
    await wx.cloud.deleteFile({ fileList: [fileId] });
  } catch (_error) {
    // 创建数据库记录失败时尽量清理孤立文件；清理失败不覆盖原始错误。
  }
};

/** 旧 create 不具备请求幂等性，保留供尚未迁移的页面兼容。 */
export const createCheckIn = (input: CreateCheckInInput) =>
  callCheckInFunction<LegacyCreatedCheckIn>({ action: "create", ...input });

export const getCheckInDetail = (id: string, shareToken?: string) =>
  callCheckInFunction<CheckInDetail>({
    action: "detail",
    id,
    shareToken: shareToken || "",
  });

export const getCheckInRecoverySource = async (id: string): Promise<RecordingRecoverySource> => {
  const result = await callCheckInFunction<unknown>({ action: "recoverySource", id });
  const value = result && typeof result === "object" ? result as Partial<RecordingRecoverySource> : null;
  const validOptionalInteger = (field: unknown, max = Number.MAX_SAFE_INTEGER) => field === undefined ||
    (Number.isSafeInteger(field) && (field as number) > 0 && (field as number) <= max);
  if (!value || value.id !== id || typeof value.recordingUrl !== "string" ||
      !/^https:\/\/[^\s]+$/i.test(value.recordingUrl) ||
      !validOptionalInteger(value.expiresAtMs) || !validOptionalInteger(value.fileSizeBytes, MAX_RECORDING_BYTES) ||
      (value.contentSha1 !== undefined && (typeof value.contentSha1 !== "string" || !/^[a-f0-9]{40}$/.test(value.contentSha1)))) {
    throw shareResponseError("RECOVERY_RESPONSE_INVALID");
  }
  return {
    id: value.id,
    recordingUrl: value.recordingUrl,
    ...(value.expiresAtMs === undefined ? {} : { expiresAtMs: value.expiresAtMs }),
    ...(value.fileSizeBytes === undefined ? {} : { fileSizeBytes: value.fileSizeBytes }),
    ...(value.contentSha1 === undefined ? {} : { contentSha1: value.contentSha1 }),
  };
};

export const listMyCheckIns = () =>
  callCheckInFunction<CheckInSummary[]>({ action: "listMine" });

export const getCheckInShareStatus = async (id: string, shareRequestId: string): Promise<{ state: "active" | "deleted" | "expired" | "missing" | "invalid" }> => {
  const result = await callCheckInFunction<{ state: "active" | "deleted" | "expired" | "missing" | "invalid" }>({ action: "shareStatus", id, shareRequestId: shareRequestId.toLowerCase() });
  if (!result || !["active", "deleted", "expired", "missing", "invalid"].includes(result.state)) throw shareResponseError();
  return { state: result.state };
};

export const removeCheckIn = (id: string) =>
  callCheckInFunction<{ id: string }>({ action: "remove", id });

export const getReadableCloudError = (error: unknown) => {
  const classified = classifyCloudError(error);
  return classified.code === "CHECK_IN_ERROR" ? "操作失败，请稍后重试" : classified.message;
};
