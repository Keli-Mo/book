import { createPendingCheckInStore } from "./pendingCheckInStore";

const saveLocalFile = (tempFilePath: string) =>
  new Promise<{ savedFilePath: string }>((resolve, reject) => {
    wx.saveFile({
      tempFilePath,
      success: ({ savedFilePath }) => resolve({ savedFilePath }),
      fail: reject,
    });
  });

const fileExists = (filePath: string) =>
  new Promise<boolean>((resolve) => {
    wx.getFileSystemManager().access({
      path: filePath,
      success: () => resolve(true),
      fail: () => resolve(false),
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
