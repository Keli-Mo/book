export const CHECK_IN_FUNCTION_NAME = "checkIn";

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

const callCheckInFunction = async <T>(data: Record<string, unknown>) => {
  ensureCloudAvailable();
  const response = await wx.cloud.callFunction({
    name: CHECK_IN_FUNCTION_NAME,
    data,
  });
  const result = response.result as CloudFunctionResponse<T> | undefined;

  // 新版分享的空包/畸形成功包也属于响应异常；保留明确的服务端业务失败码及旧调用语义。
  if (data.shareVersion === 2 && (!result || typeof result.ok !== "boolean" || (result.ok && result.data === undefined))) {
    throw shareResponseError();
  }
  if (!result?.ok || result.data === undefined) {
    throw Object.assign(new Error(result?.message || "云端打卡服务暂时不可用"), {
      code: result?.code ?? "CHECK_IN_ERROR",
    });
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
  const details = error as { code?: unknown; errCode?: unknown; errno?: unknown; errMsg?: unknown; message?: unknown } | undefined;
  const code = details?.code ?? details?.errCode ?? details?.errno;
  if (code === "SHARE_PROTOCOL_MISMATCH") return "分享服务版本不匹配，请联系开发者";
  if (code === "SHARE_RESPONSE_INVALID") return "分享服务返回异常，请稍后重试";
  if (code === "STORAGE_PREFIX_REQUIRED") return "分享服务配置未完成，请联系开发者";
  if (code === "PENDING_PERSIST_FAILED") return "本机状态保存失败，录音仍保留，请重试";
  if (code === "SHARE_EXPIRED" || code === "REQUEST_DELETED") return "分享已失效，请再次点击生成新分享";
  const text = `${code ?? ""} ${details?.errMsg ?? details?.message ?? ""}`;
  if (/network|timeout|timed.?out|offline|connection|econn|enet/i.test(text)) return "网络异常，录音仍保留，请重试";
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
  const cloudError =
    error && typeof error === "object"
      ? (error as {
          errCode?: string | number;
          errno?: string | number;
          code?: string | number;
          errMsg?: string;
          message?: string;
        })
      : undefined;
  // 微信云开发通常以普通对象返回失败信息，不能直接 String(error)，否则只会得到 [object Object]。
  const message =
    (error instanceof Error ? error.message : "") ||
    cloudError?.errMsg ||
    cloudError?.message ||
    String(error || "");
  // 保持原生错误码优先级，再接服务端协议 code；0 也是有效码。
  const errorCode = cloudError?.errCode ?? cloudError?.errno ?? cloudError?.code;
  const codeText = errorCode === undefined ? "" : `（错误码 ${errorCode}）`;

  if (/FunctionName|FUNCTION_NOT_FOUND|云函数不存在|-501000/i.test(message)) {
    return "云函数尚未部署，请先在微信开发者工具中上传并部署 checkIn 云函数";
  }
  if (/collection|DATABASE_COLLECTION_NOT_EXIST|-502005/i.test(message)) {
    return "云数据库尚未创建 checkins 集合，请先按部署说明完成初始化";
  }
  if (/storage|uploadFile|file/i.test(message)) {
    return `录音上传失败${codeText}\n${message}`;
  }

  return `${message || "操作失败，请稍后重试"}${codeText}`;
};
