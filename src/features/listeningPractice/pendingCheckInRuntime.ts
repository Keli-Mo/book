import { getCheckInRecordingInfo, getCheckInRecoverySource } from "../../services/cloudCheckIn";
import { createPendingCheckInStore, MAX_RECORDING_FILE_BYTES } from "./pendingCheckInStore";
import type { PendingCheckIn, SavedPendingRecordingFile } from "./pendingCheckInStore";
import { createRecordingRecovery } from "./recordingRecovery";

type RecordingDiagnosticDetails = { requestId?: string; error?: unknown; fileSizeBytes?: number; fingerprintMatches?: boolean;
  platform?: string; wechatVersion?: string; sdkVersion?: string; appVersion?: string };
const diagnosticErrorCodes = new Set([
  "EACCES", "EPERM", "ENOENT", "EBUSY", "ETIMEDOUT", "EIO", "ENOSPC", "ECONNRESET",
  "FORBIDDEN", "UNAUTHENTICATED", "NOT_FOUND", "SHARE_EXPIRED", "REQUEST_DELETED",
  "RECOVERY_CAPACITY", "RECOVERY_VERIFY_FAILED", "RECOVERY_CHANGED", "RECOVERY_SOURCE_INVALID", "RECOVERY_RESPONSE_INVALID",
  "PENDING_PERSIST_FAILED", "RECORDING_INFO_INVALID", "SHARE_PROTOCOL_MISMATCH", "SHARE_RESPONSE_INVALID",
]);

/** 仅控制台诊断，不落盘、不上传；原始错误可能含路径/凭证，只输出分类与错误码。 */
export const logRecordingDiagnostic = (stage: string, details?: RecordingDiagnosticDetails) => {
  try {
    const error = details?.error as { errCode?: unknown; errno?: unknown; code?: unknown; errMsg?: unknown; message?: unknown } | undefined;
    const nativeCode = error?.errCode ?? error?.errno ?? error?.code;
    const code = (typeof nativeCode === "number" && Number.isFinite(nativeCode)) ||
      (typeof nativeCode === "string" && (diagnosticErrorCodes.has(nativeCode) || /^-?\d{1,10}$/.test(nativeCode))) ? nativeCode : undefined;
    const message = typeof error === "string" ? error : String(error?.errMsg || error?.message || "");
    const reason = /permission|denied|EACCES|EPERM/i.test(message) ? "permission_denied"
      : /quota|storage.?full|space/i.test(message) ? "storage_full"
      : /no such file|not exist|ENOENT/i.test(message) ? "not_found"
      : /busy|EBUSY/i.test(message) ? "file_busy"
      : /timeout|timed out/i.test(message) ? "timeout"
      : /not supported|not a function/i.test(message) ? "unsupported_api"
      : /not in domain list|url not in.*domain|域名.*不.*合法/i.test(message) ? "domain_not_allowed"
      : /input\/output|EIO/i.test(message) ? "io_error" : "unknown";
    const versions: Partial<Record<"wechatVersion" | "sdkVersion" | "appVersion", string>> = {};
    for (const key of ["wechatVersion", "sdkVersion", "appVersion"] as const) {
      const value = details?.[key];
      if (typeof value === "string" && /^\d[\d.a-z-]{0,31}$/i.test(value)) versions[key] = value;
    }
    const payload = {
      time: Date.now(),
      ...(details?.requestId && /^[0-9a-f]{32}$/i.test(details.requestId) ? { recording: details.requestId.slice(0, 8) } : {}),
      ...(details?.error !== undefined ? { code, reason } : {}),
      ...(Number.isSafeInteger(details?.fileSizeBytes) && details!.fileSizeBytes! >= 0 ? { fileSizeBytes: details!.fileSizeBytes } : {}),
      ...(typeof details?.fingerprintMatches === "boolean" ? { fingerprintMatches: details.fingerprintMatches } : {}),
      ...(details?.platform && ["ios", "android", "devtools", "windows", "mac"].includes(details.platform) ? { platform: details.platform } : {}),
      ...versions,
    };
    if (stage.endsWith("failed") || stage.endsWith("pending")) console.warn(`[recording] ${stage}`, payload);
    else console.info(`[recording] ${stage}`, payload);
  } catch (_error) { /* 控制台不可用时不得影响用户操作。 */ }
};

/** 只读取失败路径，不改索引、不上传；缺少平台接口时省略版本证据。 */
export const diagnoseLocalRecordingFailure = async (item: Pick<PendingCheckIn, "requestId" | "localPath" | "contentSha1">, error: unknown) => {
  const details: RecordingDiagnosticDetails = { requestId: item.requestId, error };
  // 当前项目原生类型较旧；这些新版只读 API 是可选能力，不升级依赖或猜系统信息。
  const native = wx as typeof wx & { getDeviceInfo?: () => { platform?: string }; getAppBaseInfo?: () => { version?: string; SDKVersion?: string } };
  try { if (typeof native.getDeviceInfo === "function") details.platform = native.getDeviceInfo().platform; } catch (_error) { /* optional */ }
  try {
    if (typeof native.getAppBaseInfo === "function") {
      const app = native.getAppBaseInfo(); details.wechatVersion = app.version; details.sdkVersion = app.SDKVersion;
    }
  } catch (_error) { /* optional */ }
  try { if (typeof wx.getAccountInfoSync === "function") details.appVersion = wx.getAccountInfoSync().miniProgram.version; } catch (_error) { /* optional */ }
  logRecordingDiagnostic("playback.local.failed", details);
  try {
    await new Promise<void>((resolve, reject) => wx.getFileSystemManager().access({ path: item.localPath, success: () => resolve(), fail: reject }));
    logRecordingDiagnostic("playback.local.access.success", { requestId: item.requestId });
  } catch (accessError) {
    logRecordingDiagnostic("playback.local.access.failed", { requestId: item.requestId, error: accessError });
  }
  try {
    const info = await getCheckInRecordingInfo(item.localPath);
    logRecordingDiagnostic("playback.local.info.success", { requestId: item.requestId, fileSizeBytes: info.fileSizeBytes,
      ...(item.contentSha1 ? { fingerprintMatches: item.contentSha1.toLowerCase() === info.contentSha1 } : {}) });
  } catch (infoError) {
    logRecordingDiagnostic("playback.local.info.failed", { requestId: item.requestId, error: infoError });
  }
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

/** saveFile 管理区的实际占用；包含尚未写入或已经脱离索引的文件。 */
export const getLocalRecordingUsageBytes = () =>
  new Promise<number>((resolve, reject) => {
    const manager = wx.getFileSystemManager();
    if (typeof manager.getSavedFileList !== "function") {
      reject(new Error("getSavedFileList unsupported"));
      return;
    }
    manager.getSavedFileList({
      success: ({ fileList }) => {
        try {
          if (!Array.isArray(fileList)) throw new Error("invalid saved file list");
          const seen = new Set<string>();
          let total = 0;
          for (const entry of fileList) {
            const filePath = entry?.filePath;
            const size = entry?.size;
            if (typeof filePath !== "string" || filePath.length === 0 || !Number.isSafeInteger(size) || size < 0) {
              throw new Error("invalid saved file metadata");
            }
            if (seen.has(filePath)) continue;
            seen.add(filePath);
            total += size;
            if (!Number.isSafeInteger(total)) throw new Error("invalid saved file usage");
          }
          resolve(total);
        } catch (error) {
          reject(error);
        }
      },
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
    info: getCheckInRecordingInfo,
    usageBytes: getLocalRecordingUsageBytes,
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

const discardRecoveryTemporary = async (filePath: string) => {
  if (!filePath || pendingCheckInStore.list().some(item => item.localPath === filePath)) return;
  await new Promise<void>((resolve) => {
    try { wx.getFileSystemManager().unlink({ filePath, success: () => resolve(), fail: () => resolve() }); }
    catch (_error) { resolve(); }
  });
};

const downloadRecoveryFile = (url: string, expiresAtMs?: number): Promise<string> => new Promise((resolve, reject) => {
  const timeoutMs = Math.min(30_000, expiresAtMs === undefined ? 30_000 : expiresAtMs - Date.now());
  if (timeoutMs <= 0) { reject(Object.assign(new Error("恢复来源已过期"), { code: "SHARE_EXPIRED" })); return; }
  const deadlineMs = Date.now() + timeoutMs;
  let settled = false;
  let task: WechatMiniprogram.DownloadTask | undefined;
  const fail = (error: unknown) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try { task?.abort(); } catch (_error) { /* late callback still cannot commit */ }
    reject(error);
  };
  const timer = setTimeout(() => fail(Object.assign(new Error("恢复下载超时"), { code: "ETIMEDOUT" })), timeoutMs);
  try {
    task = wx.downloadFile({ url, timeout: timeoutMs,
      success: result => {
        if (settled) { void discardRecoveryTemporary(result.tempFilePath); return; }
        if (Date.now() >= deadlineMs) {
          fail(Object.assign(new Error("恢复下载超时"), { code: expiresAtMs !== undefined && Date.now() >= expiresAtMs ? "SHARE_EXPIRED" : "ETIMEDOUT" }));
          void discardRecoveryTemporary(result.tempFilePath); return;
        }
        if (result.statusCode !== 200 || !result.tempFilePath) {
          fail(new Error("恢复下载失败")); void discardRecoveryTemporary(result.tempFilePath); return;
        }
        settled = true; clearTimeout(timer); resolve(result.tempFilePath);
      },
      fail,
    });
    task.onProgressUpdate(progress => {
      if (progress.totalBytesWritten > MAX_RECORDING_FILE_BYTES || progress.totalBytesExpectedToWrite > MAX_RECORDING_FILE_BYTES) fail(Object.assign(new Error("恢复文件超过大小限制"), { code: "RECOVERY_VERIFY_FAILED" }));
    });
  } catch (error) { fail(error); }
});

const recordingRecovery = createRecordingRecovery({
  store: pendingCheckInStore, source: getCheckInRecoverySource, download: downloadRecoveryFile,
  info: getCheckInRecordingInfo, discardTemporary: discardRecoveryTemporary, now: () => Date.now(),
  usageBytes: getLocalRecordingUsageBytes,
});
export const recoverPendingRecording = recordingRecovery.recover;
export const getActivePendingRecovery = recordingRecovery.getActive;
