/* eslint-disable import/no-commonjs */
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database({ throwOnNotFound: false });
const PAGE_SIZE = 50;

// 旧无期限记录永不进入候选；删除中的新版仍要求原期限字段存在。
const eligible = (record, now) => record?.shareVersion === 2 &&
  ["pending", "active", "deletePending", "deleted"].includes(record.status) &&
  ((Number.isFinite(record.expiresAtMs) && record.expiresAtMs <= now) ||
    (record.status !== "active" && record.expiresAtMs === undefined &&
      Number.isFinite(record.pendingExpiresAtMs) && record.pendingExpiresAtMs <= now));

const absent = result => {
  const code = result?.errCode ?? result?.code ?? result?.status;
  return code === -503003 || code === "STORAGE_FILE_NONEXIST";
};
const transaction = async operation => {
  for (let attempt = 0; ; attempt++) {
    try { return await db.runTransaction(operation, 0); } catch (error) {
      const conflict = error?.code === "DATABASE_TRANSACTION_CONFLICT" ||
        /\[ResourceUnavailable\.TransactionConflict\]/.test(error?.errMsg || error?.message || "");
      if (!conflict || attempt >= 2) throw error;
    }
  }
};
const trustedPrefix = envId => {
  const value = process.env.SHARE_STORAGE_FILE_ID_PREFIX;
  const match = typeof value === "string" && /^cloud:\/\/([\w-]+)\.([\w-]+)\/$/.exec(value);
  return envId && match && match[1] === envId ? value : null;
};
const fileFor = (record, prefix) => {
  // 路径必须是服务端新版预留的完整形状，绝不扫描教材或旧 checkins 前缀。
  if (!/^expiring-shares-v2\/[a-f0-9]{64}\/[a-f0-9]{32}-[a-f0-9]{64}\.mp3$/.test(record.cloudPath || "")) {
    throw new Error("INVALID_SHARE_PATH");
  }
  const fileID = prefix + record.cloudPath;
  if (record.recordingFileId !== undefined && record.recordingFileId !== fileID) throw new Error("INVALID_SHARE_FILE_ID");
  return fileID;
};
const cleanOne = async (id, prefix, now) => {
  const target = await transaction(async tx => {
    const doc = tx.collection("checkins").doc(id), record = (await doc.get()).data;
    // 分页后重读，避免扫描期间已完成提交的 pending 被误删。
    if (!eligible(record, now)) return null;
    const fileID = fileFor(record, prefix);
    if (record.status !== "deletePending" && record.status !== "deleted") {
      const { _id, ...data } = record;
      await doc.set({ data: { ...data, status: "deletePending" } });
    }
    return fileID;
  });
  if (!target) return false;
  try {
    const result = await cloud.deleteFile({ fileList: [target] });
    const file = result.fileList?.find(item => item.fileID === target);
    if (!file || (file.status !== 0 && !absent(file))) throw new Error("FILE_DELETE_UNCONFIRMED");
  } catch (error) { if (!absent(error)) throw error; }
  await transaction(async tx => {
    const doc = tx.collection("checkins").doc(id), record = (await doc.get()).data;
    if (!eligible(record, now) || fileFor(record, prefix) !== target ||
        !["deletePending", "deleted"].includes(record.status)) throw new Error("CLEANUP_STATE_CHANGED");
    // 保留原路径和期限永久墓碑；迟到上传或删除后的重传仍能在后续全轮扫描清理。
    const { _id, ...data } = record;
    await doc.set({ data: { ...data, status: "deleted", lastCleanupAtMs: now } });
  });
  return true;
};

exports.main = async (event = {}) => {
  const context = cloud.getWXContext();
  // SDK 来源从平台上下文获取，event.Type/SOURCE 等客户端声明不参与授权。
  if (context.SOURCE !== "wx_trigger" || context.OPENID) return { ok: false, code: "FORBIDDEN" };
  const prefix = trustedPrefix(context.ENV);
  const dryRun = process.env.SHARE_CLEANUP_ENABLED !== "true" || event.dryRun === true || !prefix;
  const result = { ok: true, dryRun, scanned: 0, candidates: 0, validated: 0, deleted: 0, failed: 0, nextCursor: "",
    ...(!prefix ? { code: "STORAGE_PREFIX_REQUIRED" } : {}) };
  try {
    const stateDoc = db.collection("shareCleanupState").doc("v2");
    // dry-run 不写游标；可用返回的 nextCursor 分页审核，事件不能改变正式清理进度。
    const state = dryRun ? null : (await stateDoc.get()).data;
    const cursor = dryRun ? (typeof event.cursor === "string" && /^[a-f0-9]{64}$/.test(event.cursor) ? event.cursor : "") : (state?.cursor || "");
    const page = await db.collection("checkins").where({ shareVersion: 2,
      ...(cursor ? { _id: db.command.gt(cursor) } : {}) }).orderBy("_id", "asc").limit(PAGE_SIZE).get();
    result.scanned = page.data.length;
    const now = Date.now();
    for (const record of page.data) {
      if (!eligible(record, now)) continue;
      result.candidates++;
      // 缺少可信前缀时只能统计，不能把候选声明为已校验通过。
      if (!prefix) continue;
      try {
        // 预演也走真实路径/环境检查；正式删除仍在事务内重读校验以防扫描竞态。
        fileFor(record, prefix);
        result.validated++;
        if (!dryRun && await cleanOne(record._id, prefix, now)) result.deleted++;
      } catch (error) {
        result.failed++;
        // 不输出录音URL、口令或OPENID，失败记录保留引用，下轮重试。
        console.error("分享清理未完成", { id: record._id, code: error?.code || error?.message || "UNKNOWN" });
      }
    }
    result.nextCursor = page.data.length === PAGE_SIZE ? page.data[page.data.length - 1]._id : "";
    if (!dryRun) await transaction(async tx => {
      const doc = tx.collection("shareCleanupState").doc("v2"), latest = (await doc.get()).data;
      // 并发执行者只推进自己读取的游标代次，不覆盖更新后的进度。
      if ((latest?.revision || 0) === (state?.revision || 0)) {
        await doc.set({ data: { cursor: result.nextCursor, revision: (state?.revision || 0) + 1, updatedAtMs: now } });
      }
    });
    console.info("分享清理批次", result);
    return result;
  } catch (error) {
    console.error("分享清理批次失败", { code: error?.code || error?.message || "UNKNOWN" });
    return { ...result, ok: false, code: error?.code || "CLEANUP_FAILED" };
  }
};
