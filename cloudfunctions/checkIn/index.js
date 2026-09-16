/* eslint-disable import/no-commonjs */
const cloud = require("wx-server-sdk");
const crypto = require("crypto");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// 只把 SDK 明确返回的 data:null 视为缺文档；网络错误必须继续抛出。
const db = cloud.database({ throwOnNotFound: false });
const checkIns = db.collection("checkins");

const success = (data) => ({ ok: true, data });
const failure = (message, code = "CHECK_IN_ERROR") => ({ ok: false, code, message });
const reject = (code, message) => { throw Object.assign(new Error(message), { code }); };
const knownActions = new Set(["prepare", "commit", "create", "detail", "listMine", "shareStatus", "remove"]);
const publicMessages = Object.freeze({
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
});
const safeCode = error => {
  const candidate = error?.code ?? error?.errCode ?? error?.errno;
  return typeof candidate === "string" && Object.prototype.hasOwnProperty.call(publicMessages, candidate)
    ? candidate : "CHECK_IN_ERROR";
};
const digest = (algorithm, value) => crypto.createHash(algorithm).update(value).digest("hex");
const SHARE_LIFETIME_MS = 30 * 86400000;
const PENDING_LIFETIME_MS = 86400000;
const isExpired = record => record.shareVersion === 2 &&
  ((Number.isFinite(record.expiresAtMs) && record.expiresAtMs <= Date.now()) ||
   (record.status === "pending" && record.pendingExpiresAtMs <= Date.now()));

const requireText = (value, fieldName, maxLength) => {
  if (typeof value !== "string" || !value.trim()) {
    reject("INVALID_ARGUMENT", `${fieldName}不能为空`);
  }
  if (value.length > maxLength) {
    reject("INVALID_ARGUMENT", `${fieldName}长度超出限制`);
  }
  return value.trim();
};

const requireInteger = (value, fieldName, min, max) => {
  if (!Number.isInteger(value) || value < min || value > max) {
    reject("INVALID_ARGUMENT", `${fieldName}格式不正确`);
  }
  return value;
};

const requireDurationMs = (value) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    reject("INVALID_ARGUMENT", "录音时长格式不正确");
  }
  // 部分真机返回带小数的毫秒值，入库前统一为整数，避免误拒绝有效录音。
  return requireInteger(Math.round(value), "录音时长", 500, 300000);
};

const normalizeSnapshot = (event) => ({
  bookId: requireText(event.bookId, "教材编号", 30),
  bookTitle: requireText(event.bookTitle, "教材名称", 100),
  practiceId: requireText(event.practiceId, "训练编号", 80),
  practiceIndex: requireInteger(event.practiceIndex, "训练序号", 0, 9999),
  pageNumber: requireInteger(event.pageNumber, "教材页号", 0, 9999),
  sectionTitle: requireText(event.sectionTitle, "训练名称", 120),
  imageUrl: requireText(event.imageUrl, "教材图片", 1000),
  durationMs: requireDurationMs(event.durationMs),
});

const bindRequest = (event, openId) => {
  if (typeof event.requestId !== "string" || !/^[a-f0-9]{32}$/i.test(event.requestId)) {
    reject("INVALID_ARGUMENT", "requestId 必须为 32 位十六进制值");
  }
  if (typeof event.contentSha1 !== "string" || !/^[a-f0-9]{40}$/i.test(event.contentSha1)) {
    reject("INVALID_ARGUMENT", "录音 SHA-1 格式不正确");
  }
  const requestId = event.requestId.toLowerCase();
  // 固定字段顺序、裁剪文本、舍入原生时长，客户端不能自行指定 payloadDigest。
  const payload = {
    ...normalizeSnapshot(event),
    fileSizeBytes: requireInteger(event.fileSizeBytes, "录音文件大小", 1, 8 * 1024 * 1024),
    contentSha1: event.contentSha1.toLowerCase(),
  };
  const payloadDigest = digest("sha256", JSON.stringify(payload));
  return { requestId, payload, payloadDigest, openId, shareVersion: event.shareVersion === 2 ? 2 : 1,
    id: digest("sha256", `${openId}:${requestId}`),
    // 新分享独立存储前缀，清理和生命周期规则不会覆盖旧录音或教材。
    cloudPath: `${event.shareVersion === 2 ? "expiring-shares-v2" : "checkins"}/${digest("sha256", openId)}/${requestId}-${payloadDigest}.mp3`,
  };
};

const readExisting = (record, binding) => {
  if (!record) return null;
  if (record._openid !== binding.openId) reject("FORBIDDEN", "不能访问其他用户的请求");
  if ((record.shareVersion === 2 ? 2 : 1) !== binding.shareVersion) reject("REQUEST_ID_CONFLICT", "请求编号已用于其他分享协议");
  if (isExpired(record)) reject("SHARE_EXPIRED", "分享已过期，请重新分享");
  if (record.status === "deletePending" || record.status === "deleted") {
    reject("REQUEST_DELETED", "该请求已删除，不能重新提交");
  }
  if (record.payloadDigest !== binding.payloadDigest) {
    reject("REQUEST_ID_CONFLICT", "同一请求编号已经对应另一份录音或训练内容");
  }
  if (record.shareVersion === 2 && record.status === "pending") return null;
  if (record.shareVersion === 2 && record.status !== "active") reject("SHARE_EXPIRED", "分享已失效");
  return { id: record._id, shareToken: record.shareToken,
    ...(record.shareVersion === 2 ? { expiresAtMs: record.expiresAtMs } : {}) };
};

const prepareCheckIn = async (event, openId) => {
  const binding = bindRequest(event, openId);
  if (binding.shareVersion === 2) {
    return success(await runTransaction(async transaction => {
      const doc = transaction.collection("checkins").doc(binding.id);
      const record = (await doc.get()).data;
      const existing = readExisting(record, binding);
      if (existing) return { state: "committed", ...existing };
      if (!record) await doc.set({ data: { ...binding.payload, _openid: openId,
        requestId: binding.requestId, payloadDigest: binding.payloadDigest, cloudPath: binding.cloudPath,
        shareVersion: 2, status: "pending", pendingExpiresAtMs: Date.now() + PENDING_LIFETIME_MS,
        createdAt: db.serverDate() } });
      return { state: "upload-required", id: binding.id, cloudPath: binding.cloudPath };
    }));
  }
  const existing = readExisting((await checkIns.doc(binding.id).get()).data, binding);
  return success(existing
    ? { state: "committed", ...existing }
    : { state: "upload-required", id: binding.id, cloudPath: binding.cloudPath });
};

const runTransaction = async (operation) => {
  for (let attempt = 0; ; attempt++) {
    try {
      // 关闭底层叠加重试，统一限制最多 3 次尝试；兼容微信包装后的冲突错误。
      return await db.runTransaction(operation, 0);
    } catch (error) {
      const conflict = error?.code === "DATABASE_TRANSACTION_CONFLICT" ||
        /\[ResourceUnavailable\.TransactionConflict\]/.test(error?.errMsg || error?.message || "");
      if (!conflict) throw error;
      if (attempt >= 2) reject("DATABASE_TRANSACTION_CONFLICT", "transaction conflict");
    }
  }
};

const validateFileId = (fileId, binding, envId) => {
  const value = requireText(fileId, "录音文件", 500);
  const match = /^cloud:\/\/([\w-]+)\.([\w-]+)\/(.+)$/.exec(value);
  if (!envId) reject("CLOUD_ENV_UNAVAILABLE", "无法确认当前云环境");
  if (!match || match[1] !== envId || match[3] !== binding.cloudPath) {
    reject("INVALID_FILE_ID", "录音文件必须对应当前用户、本次请求和当前云环境的完整路径");
  }
  return value;
};

const assertFileReferences = async (recordingFileId, openId) => {
  if (typeof recordingFileId !== "string" || !recordingFileId || typeof openId !== "string" || !openId) {
    reject("FILE_REFERENCE_CONFLICT", "录音引用无法核验，请联系管理员");
  }
  // 仅服务端协议的完整路径携带 owner 摘要；平铺旧路径不提供任何归属证明。
  // 即使协议文件尚未 commit、还没有本人记录，也不能经旧别名读删其他 owner 的文件。
  const protocolPath = /^cloud:\/\/[\w-]+\.[\w-]+\/(?:checkins|expiring-shares-v2)\/([a-f0-9]{64})\/[a-f0-9]{32}-[a-f0-9]{64}\.mp3$/.exec(recordingFileId);
  if (protocolPath && protocolPath[1] !== digest("sha256", openId)) {
    reject("FILE_REFERENCE_CONFLICT", "录音引用归属冲突，请联系管理员核验");
  }
  // 不过滤墓碑/期限：旧别名也可能指向协议文件；不能只检查旧记录或第一页。
  // 查询失败直接向上抛出，禁止以空引用集继续签名、下载、删除或写墓碑。
  for (let offset = 0; ; offset += 100) {
    let query = checkIns.where({ recordingFileId });
    if (offset) query = query.skip(offset);
    const result = await query.limit(100).get();
    if (!Array.isArray(result?.data)) reject("FILE_REFERENCE_CHECK_FAILED", "录音引用核验失败，请稍后重试");
    if (result.data.some(record => !record || record._openid !== openId)) {
      reject("FILE_REFERENCE_CONFLICT", "录音引用归属冲突，请联系管理员核验");
    }
    if (result.data.length < 100) return;
  }
};

const commitCheckIn = async (event, openId, envId) => {
  const binding = bindRequest(event, openId);
  const previous = (await checkIns.doc(binding.id).get()).data;
  if (binding.shareVersion === 2 && !previous) reject("SHARE_NOT_PREPARED", "请先预留分享上传");
  const existing = readExisting(previous, binding);
  const recordingFileId = validateFileId(event.recordingFileId, binding, envId);
  if (existing) {
    if (previous.recordingFileId !== recordingFileId) reject("INVALID_FILE_ID", "录音文件与已提交请求不一致");
    return success(existing);
  }
  // 文件检查在事务外完成；仅 URL 或客户端“上传成功”声明不足以证明文件有效。
  await assertFileReferences(recordingFileId, openId);
  const downloaded = await cloud.downloadFile({ fileID: recordingFileId });
  // Node SDK 成功结果可能仅含 fileContent；有 HTTP 状态时仍拒绝非 200。
  if ((downloaded.statusCode !== undefined && downloaded.statusCode !== 200) || !Buffer.isBuffer(downloaded.fileContent) ||
      downloaded.fileContent.length !== binding.payload.fileSizeBytes ||
      digest("sha1", downloaded.fileContent) !== binding.payload.contentSha1) {
    reject("RECORDING_FILE_MISMATCH", "录音文件不存在、大小或内容摘要不一致");
  }
  const record = { ...binding.payload, _openid: openId, requestId: binding.requestId,
    payloadDigest: binding.payloadDigest, recordingFileId, status: "active", protocolVersion: 1,
    shareToken: crypto.randomBytes(16).toString("hex"), createdAt: db.serverDate() };
  return success(await runTransaction(async transaction => {
    const doc = transaction.collection("checkins").doc(binding.id);
    const currentRecord = (await doc.get()).data;
    const current = readExisting(currentRecord, binding);
    if (current) return current;
    if (binding.shareVersion === 2) {
      if (!currentRecord || currentRecord.status !== "pending") reject("SHARE_NOT_PREPARED", "分享预留不存在");
      const expiresAtMs = Date.now() + SHARE_LIFETIME_MS;
      await doc.set({ data: { ...record, shareVersion: 2, cloudPath: binding.cloudPath,
        pendingExpiresAtMs: currentRecord.pendingExpiresAtMs, expiresAtMs } });
      return { id: binding.id, shareToken: record.shareToken, expiresAtMs };
    }
    await doc.set({ data: record });
    return { id: binding.id, shareToken: record.shareToken };
  }));
};

const toPublicSummary = (record) => ({
  id: record._id,
  shareToken: record.shareToken,
  bookId: record.bookId,
  bookTitle: record.bookTitle,
  practiceId: record.practiceId,
  practiceIndex: record.practiceIndex,
  pageNumber: record.pageNumber,
  sectionTitle: record.sectionTitle,
  imageUrl: record.imageUrl,
  durationMs: record.durationMs,
  createdAt: record.createdAt,
  ...(record.shareVersion === 2 ? { expiresAtMs: record.expiresAtMs } : {}),
});

const getDetail = async (event, openId) => {
  const id = requireText(event.id, "打卡编号", 100);
  const result = await checkIns.doc(id).get();
  const record = result.data;
  if (record?.shareVersion === 2 && (isExpired(record) || record.status === "deletePending" || record.status === "deleted")) {
    return failure("分享已过期或失效", "SHARE_EXPIRED");
  }
  if (record?.shareVersion === 2 && record.status !== "active") return failure("分享尚未完成", "NOT_FOUND");
  if (!record || record.status === "deletePending" || record.status === "deleted") {
    return failure("打卡记录不存在或已被删除", "NOT_FOUND");
  }

  const isOwner = record._openid === openId;
  // 非本人访问必须携带不可枚举的分享口令，只授权当前这一条记录。
  if (!isOwner && event.shareToken !== record.shareToken) {
    return failure("分享链接无效或已经失效");
  }

  await assertFileReferences(record.recordingFileId, record._openid);
  // 引用分页可能耗时，核验后再算 maxAge（秒）；不足一秒不签发，避免越过期限。
  const maxAge = record.shareVersion === 2 ? Math.min(300, Math.floor((record.expiresAtMs - Date.now()) / 1000)) : null;
  if (maxAge !== null && !(maxAge > 0)) return failure("分享已过期", "SHARE_EXPIRED");
  const fileResult = await cloud.getTempFileURL({
    fileList: [maxAge === null ? record.recordingFileId : { fileID: record.recordingFileId, maxAge }],
  });
  const recordingUrl = fileResult.fileList?.[0]?.tempFileURL;
  if (!recordingUrl) return failure("录音文件不存在或已失效");

  return success({
    ...toPublicSummary(record),
    recordingUrl,
    isOwner,
  });
};

const listMine = async (openId) => {
  const visible = [];
  // 墓碑永久保留，不能把固定前100条当成全部历史；按页读到50条有效记录或真正末页。
  for (let offset = 0; visible.length < 50; offset += 100) {
    let query = checkIns.where({ _openid: openId }).orderBy("createdAt", "desc");
    if (offset) query = query.skip(offset);
    const result = await query.limit(100).get();
    visible.push(...result.data.filter(record => record.status === "deletePending" ||
      (record.status !== "deleted" && record.status !== "pending" &&
        !(record.shareVersion === 2 && (record.status !== "active" || isExpired(record))))));
    if (result.data.length < 100) break;
  }
  return success(visible.slice(0, 50).map(record => record.status === "deletePending"
    ? { ...toPublicSummary(record), status: "deletePending", shareToken: "" }
    : toPublicSummary(record)));
};

// 只在本机录音 owner 主动修复链接时读取；不签回 URL，不修改记录或删除防重墓碑。
const getShareStatus = async (event, openId) => {
  try {
    const id = requireText(event.id, "打卡编号", 100);
    const shareRequestId = requireText(event.shareRequestId, "分享代次", 32).toLowerCase();
    const record = (await checkIns.doc(id).get()).data;
    if (record === null) return success({ state: "missing" });
    if (!record || typeof record !== "object") return failure("暂时无法核验分享，请稍后重试", "SHARE_STATUS_UNAVAILABLE");
    if (record._openid !== openId) return failure("只能核验自己的分享", "FORBIDDEN");
    if (record.requestId !== shareRequestId) return failure("分享代次不匹配", "SHARE_GENERATION_MISMATCH");
    if (record.status === "deleted" || record.status === "deletePending") return success({ state: "deleted" });
    if (isExpired(record)) return success({ state: "expired" });
    if (record.status !== "active") return failure("分享尚未完成", "SHARE_NOT_COMMITTED");
    await assertFileReferences(record.recordingFileId, openId);
    try {
      // SDK 签出地址不证明文件存在；downloadFile 才验证可读取。
      const downloaded = await cloud.downloadFile({ fileID: record.recordingFileId });
      // wx-server-sdk 成功包明确包含 statusCode:200；畸形或自相矛盾的回包不能证明文件损坏。
      if (downloaded?.statusCode !== 200 ||
          [downloaded.errCode, downloaded.code, downloaded.errno].some(code => code !== undefined && code !== 0) ||
          (downloaded.errMsg !== undefined && downloaded.errMsg !== "downloadFile:ok") ||
          !Buffer.isBuffer(downloaded.fileContent)) {
        return failure("暂时无法核验分享，请稍后重试", "SHARE_STATUS_UNAVAILABLE");
      }
      if (!Number.isSafeInteger(record.fileSizeBytes) || record.fileSizeBytes <= 0 ||
          typeof record.contentSha1 !== "string" || !/^[a-f0-9]{40}$/.test(record.contentSha1)) {
        return failure("暂时无法核验分享，请稍后重试", "SHARE_STATUS_UNAVAILABLE");
      }
      if (downloaded.fileContent.length !== record.fileSizeBytes || digest("sha1", downloaded.fileContent) !== record.contentSha1) {
        return success({ state: "invalid" });
      }
    } catch (error) {
      // 4.0.2 明确缺失码；403、超时、STORAGE_REQUEST_FAIL 及通用文案均不能失效本机状态。
      const code = error?.errCode ?? error?.code;
      if (code === -503003 || code === "STORAGE_FILE_NONEXIST") return success({ state: "missing" });
      return failure("暂时无法核验分享，请稍后重试", "SHARE_STATUS_UNAVAILABLE");
    }
    return success({ state: isExpired(record) ? "expired" : "active" });
  } catch (_error) {
    // SDK 错误可能包含签名 URL，核验路径不输出原始错误或文件标识。
    return failure("暂时无法核验分享，请稍后重试", "SHARE_STATUS_UNAVAILABLE");
  }
};

const isStorageFileAbsent = (result) => {
  // wx-server-sdk 4.0.2 把 STORAGE_FILE_NONEXIST 映射为 -503003；未知码不可借文案放行。
  const code = result?.errCode ?? result?.code ?? result?.status;
  if (code !== undefined) return code === -503003 || code === "STORAGE_FILE_NONEXIST";
  return /^(?:deleteFile:fail\s+)?storage file not exists$/.test(result?.errMsg || "");
};

const removeCheckIn = async (event, openId) => {
  const id = requireText(event.id, "打卡编号", 100);
  const result = await checkIns.doc(id).get();
  const record = result.data;
  if (!record) return failure("打卡记录不存在或已被删除");
  if (record._openid !== openId) return failure("只能删除自己的打卡");
  if (record.status === "deleted") return success({ id });
  // 尚未提交的新分享没有可删除文件，也不能提前写删除墓碑。
  if (record.status === "pending") return failure("分享尚未提交，不能删除", "SHARE_NOT_COMMITTED");

  await assertFileReferences(record.recordingFileId, record._openid);
  if (record.requestId) {
    // 幂等记录先写墓碑，阻止删除过程中或删除后的迟到 commit 复活录音。
    await runTransaction(async transaction => {
      const doc = transaction.collection("checkins").doc(id);
      const current = (await doc.get()).data;
      if (!current || current._openid !== openId) reject("FORBIDDEN", "不能删除该打卡");
      if (current.status === "pending") reject("SHARE_NOT_COMMITTED", "分享尚未提交，不能删除");
      if (current.status !== "deleted" && current.status !== "deletePending") {
        const { _id, ...data } = current;
        await doc.set({ data: { ...data, status: "deletePending" } });
      }
    });
  }
  try {
    const removed = await cloud.deleteFile({ fileList: [record.recordingFileId] });
    const fileResult = removed.fileList?.find(file => file.fileID === record.recordingFileId);
    if (!fileResult || (fileResult.status !== 0 && !isStorageFileAbsent(fileResult))) {
      reject("FILE_DELETE_FAILED", publicMessages.FILE_DELETE_FAILED);
    }
  } catch (error) {
    // 每次只删除这一文件：已删后最终写墓碑失败，重试收到明确不存在也可继续收敛。
    if (!isStorageFileAbsent(error)) throw error;
  }
  if (record.requestId) {
    await runTransaction(async transaction => {
      const doc = transaction.collection("checkins").doc(id);
      const current = (await doc.get()).data;
      if (!current || current._openid !== openId) reject("FORBIDDEN", "不能删除该打卡");
      const { _id, ...data } = current;
      if (current.status !== "deleted") await doc.set({ data: { ...data, status: "deleted" } });
    });
  } else {
    // 旧客户端创建的记录保持原 remove 行为，但同样必须确认文件删除成功。
    await checkIns.doc(id).remove();
  }
  return success({ id });
};

exports.main = async (event = {}) => {
  let action = "unknown";
  try {
    let requestedAction;
    if (event && typeof event === "object" && !Array.isArray(event)) {
      requestedAction = event.action;
      action = knownActions.has(requestedAction) ? requestedAction : "unknown";
    }
    const { OPENID, ENV } = cloud.getWXContext();
    if (!OPENID) return failure("无法识别当前微信用户", "UNAUTHENTICATED");
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      reject("INVALID_ARGUMENT", publicMessages.INVALID_ARGUMENT);
    }
    switch (requestedAction) {
      case "prepare":
        return await prepareCheckIn(event, OPENID);
      case "commit":
        return await commitCheckIn(event, OPENID, ENV);
      case "create":
        return failure("旧版新增已停用，请升级客户端后重试", "LEGACY_CREATE_DISABLED");
      case "detail":
        return await getDetail(event, OPENID);
      case "listMine":
        return await listMine(OPENID);
      case "shareStatus":
        return await getShareStatus(event, OPENID);
      case "remove":
        return await removeCheckIn(event, OPENID);
      default:
        reject("INVALID_ARGUMENT", publicMessages.INVALID_ARGUMENT);
    }
  } catch (error) {
    const code = safeCode(error);
    console.error("checkIn 云函数执行失败", {
      action,
      code,
    });
    return failure(publicMessages[code], code);
  }
};
