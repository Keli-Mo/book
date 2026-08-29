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
    throw new Error(result?.message || "云端打卡服务暂时不可用");
  }

  return result.data;
};

/** 录音只有在用户确认打卡后才上传，临时录音不会自动进入云端。 */
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

export const removeUploadedRecording = async (fileId: string) => {
  if (!wx.cloud || !fileId) return;
  try {
    await wx.cloud.deleteFile({ fileList: [fileId] });
  } catch (_error) {
    // 创建数据库记录失败时尽量清理孤立文件；清理失败不覆盖原始错误。
  }
};

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
  const errorCode = cloudError?.errCode ?? cloudError?.errno;

  if (/FunctionName|FUNCTION_NOT_FOUND|云函数不存在|-501000/i.test(message)) {
    return "云函数尚未部署，请先在微信开发者工具中上传并部署 checkIn 云函数";
  }
  if (/collection|DATABASE_COLLECTION_NOT_EXIST|-502005/i.test(message)) {
    return "云数据库尚未创建 checkins 集合，请先按部署说明完成初始化";
  }
  if (/storage|uploadFile|file/i.test(message)) {
    const codeText = errorCode === undefined ? "" : `（错误码 ${errorCode}）`;
    return `录音上传失败${codeText}\n${message}`;
  }

  return message || "操作失败，请稍后重试";
};
