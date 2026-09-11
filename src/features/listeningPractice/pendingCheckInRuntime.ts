import { getCheckInRecordingInfo } from "../../services/cloudCheckIn";
import { createPendingCheckInStore } from "./pendingCheckInStore";
import type { SavedPendingRecordingFile } from "./pendingCheckInStore";

const saveLocalFile = async (tempFilePath: string): Promise<SavedPendingRecordingFile> => {
  const saved = await new Promise<{ savedFilePath: string }>((resolve, reject) => {
    wx.saveFile({
      tempFilePath,
      success: ({ savedFilePath }) => resolve({ savedFilePath }),
      fail: reject,
    });
  });
  try {
    return { ...saved, ...await getCheckInRecordingInfo(saved.savedFilePath) };
  } catch (_error) {
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
        else reject(error);
      },
    });
  });

const removeLocalFile = (filePath: string) =>
  new Promise<void>((resolve, reject) => {
    wx.getFileSystemManager().unlink({
      filePath,
      success: () => resolve(),
      fail: reject,
    });
  });

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
});

/** 训练页与“我的打卡”共用同一队列，防止页面切换产生两份内存状态。 */
export const getPendingCheckInStore = () => pendingCheckInStore;
