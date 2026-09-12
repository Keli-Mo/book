import { getCheckInRecordingInfo } from "../../services/cloudCheckIn";
import { createPendingCheckInStore } from "./pendingCheckInStore";
import type { SavedPendingRecordingFile } from "./pendingCheckInStore";

/** 仅控制台诊断，不落盘、不上传；原始错误可能含路径/凭证，只输出分类与错误码。 */
export const logRecordingDiagnostic = (stage: string, details?: { requestId?: string; error?: unknown }) => {
  try {
    const error = details?.error as { errCode?: unknown; errno?: unknown; code?: unknown; errMsg?: unknown; message?: unknown } | undefined;
    const nativeCode = error?.errCode ?? error?.errno ?? error?.code;
    const code = typeof nativeCode === "number" || (typeof nativeCode === "string" && /^[\w-]{1,64}$/.test(nativeCode)) ? nativeCode : undefined;
    const message = typeof error === "string" ? error : String(error?.errMsg || error?.message || "");
    const reason = /permission|denied|EACCES|EPERM/i.test(message) ? "permission_denied"
      : /quota|storage.?full|space/i.test(message) ? "storage_full"
      : /no such file|not exist|ENOENT/i.test(message) ? "not_found"
      : /busy|EBUSY/i.test(message) ? "file_busy"
      : /timeout|timed out/i.test(message) ? "timeout"
      : /not supported|not a function/i.test(message) ? "unsupported_api"
      : /input\/output|EIO/i.test(message) ? "io_error" : "unknown";
    const payload = {
      time: Date.now(),
      ...(details?.requestId ? { recording: details.requestId.slice(0, 8) } : {}),
      ...(details?.error !== undefined ? { code, reason } : {}),
    };
    if (stage.endsWith("failed") || stage.endsWith("pending")) console.warn(`[recording] ${stage}`, payload);
    else console.info(`[recording] ${stage}`, payload);
  } catch (_error) { /* 控制台不可用时不得影响用户操作。 */ }
};

const saveLocalFile = async (tempFilePath: string): Promise<SavedPendingRecordingFile> => {
  logRecordingDiagnostic("save.file.start");
  const saved = await new Promise<{ savedFilePath: string }>((resolve, reject) => {
    wx.saveFile({
      tempFilePath,
      success: ({ savedFilePath }) => {
        logRecordingDiagnostic("save.file.success");
        resolve({ savedFilePath });
      },
      fail: (error) => {
        logRecordingDiagnostic("save.file.failed", { error });
        reject(error);
      },
    });
  });
  try {
    return { ...saved, ...await getCheckInRecordingInfo(saved.savedFilePath) };
  } catch (error) {
    logRecordingDiagnostic("save.fingerprint.failed", { error });
    // saveFile 已移动临时文件；指纹读取失败不能丢掉 saved 路径，提交时可再次读取补齐。
    return saved;
  }
};

const fileExists = (filePath: string) =>
  new Promise<boolean>((resolve, reject) => {
    wx.getFileSystemManager().access({
      path: filePath,
      success: () => resolve(true),
      fail: (error) => {
        const details = (error || {}) as { errCode?: unknown; errno?: unknown; code?: unknown; errMsg?: unknown };
        const code = details.errCode ?? details.errno ?? details.code;
        const message = typeof details.errMsg === "string" ? details.errMsg : "";
        // 微信 FileError 的 1300002 表示文件不存在；权限/IO错误不能清掉仍可恢复的录音引用。
        const missing = code !== undefined
          ? code === 1300002 || code === "ENOENT"
          : /^(?:access:fail\s+)?(?:ENOENT\b|no such file(?: or directory)?\b|file\b.*\b(?:not exist|does not exist)\b)/i.test(message);
        if (missing) resolve(false);
        else {
          logRecordingDiagnostic("file.access.failed", { error });
          reject(error);
        }
      },
    });
  });

const removeLocalFile = async (filePath: string, kind: "saved" | "temporary") => {
  const stage = `delete.file.${kind}`;
  logRecordingDiagnostic(`${stage}.start`);
  try {
    await new Promise<void>((resolve, reject) => {
      const options = {
        filePath,
        success: () => resolve(),
        fail: reject,
      };
      // 与 wx.saveFile 配套；缓存路径不依赖 unlink 对普通本地文件的写权限。
      if (kind === "saved") wx.removeSavedFile(options);
      else wx.getFileSystemManager().unlink(options);
    });
    logRecordingDiagnostic(`${stage}.success`);
  } catch (error) {
    logRecordingDiagnostic(`${stage}.failed`, { error });
    // access 与删除之间文件可能消失，或原生回调报错但文件实际已删；只凭再次确认不存在才收敛成功。
    try {
      if (!await fileExists(filePath)) {
        logRecordingDiagnostic(`${stage}.already_missing`);
        return;
      }
    } catch (_accessError) { /* 无法确认不存在则保留引用，不能吞掉原删除错误。 */ }
    throw error;
  }
};

/** 请求编号只负责去重，不承担分享鉴权；四段随机数足够避免本机录音碰撞。 */
const createRequestId = () =>
  Array.from({ length: 4 }, () =>
    Math.floor(Math.random() * 0x100000000)
      .toString(16)
      .padStart(8, "0"),
  ).join("");

const pendingCheckInStore = createPendingCheckInStore({
  storage: {
    get: (key) => wx.getStorageSync(key),
    set: (key, value) => wx.setStorageSync(key, value),
  },
  file: {
    save: saveLocalFile,
    exists: fileExists,
    remove: removeLocalFile,
  },
  clock: { now: () => Date.now() },
  random: { hex: createRequestId },
  diagnose: logRecordingDiagnostic,
});

/** 训练页与“我的打卡”共用同一队列，防止页面切换产生两份内存状态。 */
export const getPendingCheckInStore = () => pendingCheckInStore;
