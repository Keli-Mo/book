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
}

export type PrepareCheckInInput = Omit<CreateCheckInInput, "recordingFileId"> & {
  requestId: string;
  fileSizeBytes: number;
  contentSha1: string;
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
  shareToken: string;
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

const callCheckInFunction = async <T>(data: Record<string, unknown>) => {
  ensureCloudAvailable();
  const response = await wx.cloud.callFunction({
    name: CHECK_IN_FUNCTION_NAME,
    data,
  });
  const result = response.result as CloudFunctionResponse<T> | undefined;

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

/** prepare 完全只读；已提交时返回既有结果，调用方应跳过再次上传。 */
export const prepareCheckIn = (input: PrepareCheckInInput) =>
  callCheckInFunction<PreparedCheckIn>({ ...input, requestId: input.requestId.toLowerCase(), action: "prepare" });

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
export const commitCheckIn = (input: CommitCheckInInput) =>
  callCheckInFunction<CreatedCheckIn>({ ...input, requestId: input.requestId.toLowerCase(), action: "commit" });

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
  callCheckInFunction<CreatedCheckIn>({ action: "create", ...input });

export const getCheckInDetail = (id: string, shareToken?: string) =>
  callCheckInFunction<CheckInDetail>({
    action: "detail",
    id,
    shareToken: shareToken || "",
  });

export const listMyCheckIns = () =>
  callCheckInFunction<CheckInSummary[]>({ action: "listMine" });

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
