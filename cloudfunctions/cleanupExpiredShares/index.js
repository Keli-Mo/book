/* eslint-disable import/no-commonjs */
const cloud = require("wx-server-sdk");
const crypto = require("crypto");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database({ throwOnNotFound: false });
const PAGE_SIZE = 50;
const BUDGET_EXHAUSTED = Symbol("CLEANUP_BUDGET_EXHAUSTED");
const cleanupCodes = new Set([
  "INVALID_SHARE_PATH",
  "INVALID_SHARE_FILE_ID",
  "INVALID_SHARE_BINDING",
  "FILE_REFERENCE_CONFLICT",
  "FILE_REFERENCE_CHECK_FAILED",
  "FILE_DELETE_UNCONFIRMED",
  "CLEANUP_STATE_CHANGED",
  "DATABASE_TRANSACTION_CONFLICT",
  "CLEANUP_FAILED",
]);
const safeCleanupCode = error => {
  return typeof error?.message === "string" && cleanupCodes.has(error.message)
    ? error.message : "CLEANUP_FAILED";
};

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
const transaction = async (operation, assertBudget) => {
  for (let attempt = 0; ; attempt++) {
    assertBudget();
    try { return await db.runTransaction(operation, 0); } catch (error) {
      const conflict = error?.code === "DATABASE_TRANSACTION_CONFLICT" ||
        /\[ResourceUnavailable\.TransactionConflict\]/.test(error?.errMsg || error?.message || "");
      if (!conflict) throw error;
      assertBudget();
      if (attempt >= 2) throw new Error("DATABASE_TRANSACTION_CONFLICT");
    }
  }
};
const trustedPrefix = envId => {
  const value = process.env.SHARE_STORAGE_FILE_ID_PREFIX;
  const match = typeof value === "string" && /^cloud:\/\/([\w-]+)\.([\w-]+)\/$/.exec(value);
  return envId && match && match[1] === envId ? value : null;
};
const fileFor = (record, prefix) => {
  const owner = record?._openid;
  if (typeof owner !== "string" || !owner ||
      typeof record.requestId !== "string" || !/^[a-f0-9]{32}$/.test(record.requestId) ||
      typeof record.payloadDigest !== "string" || !/^[a-f0-9]{64}$/.test(record.payloadDigest)) {
    throw new Error("INVALID_SHARE_BINDING");
  }
  const ownerDigest = crypto.createHash("sha256").update(owner).digest("hex");
  const cloudPath = `expiring-shares-v2/${ownerDigest}/${record.requestId}-${record.payloadDigest}.mp3`;
  if (!/^expiring-shares-v2\/[a-f0-9]{64}\/[a-f0-9]{32}-[a-f0-9]{64}\.mp3$/.test(record.cloudPath || "")) {
    throw new Error("INVALID_SHARE_PATH");
  }
  if (record.cloudPath !== cloudPath) throw new Error("INVALID_SHARE_BINDING");
  const fileID = prefix + cloudPath;
  if (record.status === "active" && record.recordingFileId === undefined) {
    throw new Error("INVALID_SHARE_FILE_ID");
  }
  if (record.recordingFileId !== undefined && record.recordingFileId !== fileID) throw new Error("INVALID_SHARE_FILE_ID");
  return fileID;
};
const assertFileReferences = async (fileID, record) => {
  let result;
  try {
    result = await db.collection("checkins").where({ recordingFileId: fileID }).limit(2).get();
  } catch (_) {
    throw new Error("FILE_REFERENCE_CHECK_FAILED");
  }
  if (!Array.isArray(result?.data)) throw new Error("FILE_REFERENCE_CHECK_FAILED");
  if (result.data.length > 1 || (result.data.length === 1 &&
      (result.data[0]?._id !== record._id || result.data[0]?._openid !== record._openid))) {
    throw new Error("FILE_REFERENCE_CONFLICT");
  }
};
const cleanOne = async (id, expectedTarget, prefix, now, assertBudget) => {
  const target = await transaction(async tx => {
    const doc = tx.collection("checkins").doc(id), record = (await doc.get()).data;
    // 分页后重读，避免扫描期间已完成提交的 pending 被误删。
    if (!eligible(record, now)) return null;
    const fileID = fileFor(record, prefix);
    if (fileID !== expectedTarget) throw new Error("CLEANUP_STATE_CHANGED");
    if (record.status !== "deletePending" && record.status !== "deleted") {
      const { _id, ...data } = record;
      await doc.set({ data: { ...data, status: "deletePending" } });
    }
    return fileID;
  }, assertBudget);
  if (!target) return false;
  assertBudget();
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
  }, assertBudget);
  return true;
};

exports.main = async (event = {}, runtimeContext) => {
  const startedAt = Date.now();
  const result = { ok: true, dryRun: true, scanned: 0, processed: 0, candidates: 0,
    validated: 0, deleted: 0, failed: 0, budgetExhausted: false, nextCursor: "" };
  const report = () => {
    if (result.processed === 0 && result.budgetExhausted) {
      console.error("分享清理预算不足", { code: "CLEANUP_BUDGET_EXHAUSTED" });
    }
    console.info("分享清理批次", result);
    return result;
  };
  try {
    const context = cloud.getWXContext();
    // SDK 来源从平台上下文获取，event.Type/SOURCE 等客户端声明不参与授权。
    if (context.SOURCE !== "wx_trigger" || context.OPENID) return { ok: false, code: "FORBIDDEN" };
    // 只信平台第二参数；预留用于停止后续操作，不能取消已经发出的RPC。
    const configured = runtimeContext?.time_limit_in_ms;
    const limit = Number.isSafeInteger(configured) && configured > 0 ? Math.min(configured, 20000) : 3000;
    const workMs = Math.max(0, limit - 1000);
    const finishBy = startedAt + workMs;
    const admitBy = startedAt + Math.min(1200, workMs);
    const assertBudget = () => { if (Date.now() >= finishBy) throw BUDGET_EXHAUSTED; };
    const request = event && typeof event === "object" && !Array.isArray(event) ? event : {};
    const prefix = trustedPrefix(context.ENV);
    const dryRun = process.env.SHARE_CLEANUP_ENABLED !== "true" || request.dryRun === true || !prefix;
    result.dryRun = dryRun;
    if (!prefix) result.code = "STORAGE_PREFIX_REQUIRED";
    assertBudget();
    const stateDoc = db.collection("shareCleanupState").doc("v2");
    // dry-run 不写游标；可用返回的 nextCursor 分页审核，事件不能改变正式清理进度。
    const state = dryRun ? null : (await stateDoc.get()).data;
    const cursor = dryRun ? (typeof request.cursor === "string" && /^[a-f0-9]{64}$/.test(request.cursor) ? request.cursor : "") : (state?.cursor || "");
    let expectedRevision = state?.revision || 0;
    let savedCursor = cursor;
    result.nextCursor = cursor;
    const saveCursor = async nextCursor => {
      if (dryRun) {
        result.nextCursor = nextCursor;
        return;
      }
      if (nextCursor === savedCursor) return;
      await transaction(async tx => {
        const doc = tx.collection("shareCleanupState").doc("v2"), latest = (await doc.get()).data;
        if ((latest?.revision || 0) !== expectedRevision) throw new Error("CLEANUP_STATE_CHANGED");
        await doc.set({ data: { cursor: nextCursor, revision: expectedRevision + 1, updatedAtMs: Date.now() } });
      }, assertBudget);
      expectedRevision++;
      savedCursor = nextCursor;
      result.nextCursor = nextCursor;
    };
    if (Date.now() >= admitBy) {
      result.budgetExhausted = true;
      return report();
    }
    const page = await db.collection("checkins").where({ shareVersion: 2,
      ...(cursor ? { _id: db.command.gt(cursor) } : {}) }).orderBy("_id", "asc").limit(PAGE_SIZE).get();
    result.scanned = page.data.length;
    const now = Date.now();
    let lastProcessedCursor = cursor;
    for (const record of page.data) {
      if (Date.now() >= admitBy) {
        result.budgetExhausted = true;
        break;
      }
      const candidate = eligible(record, now);
      if (candidate) {
        result.candidates++;
        // 缺少可信前缀时只能统计，不能把候选声明为已校验通过。
        if (prefix) {
          try {
            // 预演和正式执行使用同一绑定与全引用预检；正式删除仍在事务内重读绑定防扫描竞态。
            const fileID = fileFor(record, prefix);
            await assertFileReferences(fileID, record);
            assertBudget();
            result.validated++;
            if (!dryRun) {
              const cleaned = await cleanOne(record._id, fileID, prefix, now, assertBudget);
              if (cleaned) result.deleted++;
            }
          } catch (error) {
            if (error === BUDGET_EXHAUSTED) {
              result.budgetExhausted = true;
              break;
            }
            result.failed++;
            // 不输出录音URL、口令或OPENID，失败记录保留引用，下轮回绕重试。
            console.error("分享清理未完成", { code: safeCleanupCode(error) });
          }
        }
      }
      result.processed++;
      lastProcessedCursor = record._id;
      // 候选完成后立即保存连续前缀；未到期记录集中到页尾或预算退出再保存。
      if (candidate && !dryRun) await saveCursor(lastProcessedCursor);
    }
    // 检查点已保存而收尾截止已到时不再为页尾回绕发起额外事务。
    if (Date.now() >= finishBy) {
      result.budgetExhausted = true;
      if (dryRun) result.nextCursor = lastProcessedCursor;
      return report();
    }
    if (result.budgetExhausted) await saveCursor(lastProcessedCursor);
    else await saveCursor(page.data.length < PAGE_SIZE ? "" : lastProcessedCursor);
    return report();
  } catch (error) {
    if (error === BUDGET_EXHAUSTED) {
      result.budgetExhausted = true;
      return report();
    }
    const code = safeCleanupCode(error);
    console.error("分享清理批次失败", { code });
    return { ...result, ok: false, code };
  }
};
