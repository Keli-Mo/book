/* eslint-disable import/no-commonjs */
const cloud = require("wx-server-sdk");
const crypto = require("crypto");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const checkIns = db.collection("checkins");

const success = (data) => ({ ok: true, data });
const failure = (message) => ({ ok: false, message });

const requireText = (value, fieldName, maxLength) => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${fieldName}不能为空`);
  }
  if (value.length > maxLength) {
    throw new Error(`${fieldName}长度超出限制`);
  }
  return value.trim();
};

const requireInteger = (value, fieldName, min, max) => {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${fieldName}格式不正确`);
  }
  return value;
};

const requireDurationMs = (value) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("录音时长格式不正确");
  }
  // 部分真机返回带小数的毫秒值，入库前统一为整数，避免误拒绝有效录音。
  return requireInteger(Math.round(value), "录音时长", 500, 300000);
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
});

const createCheckIn = async (event, openId) => {
  const recordingFileId = requireText(event.recordingFileId, "录音文件", 500);
  if (!recordingFileId.startsWith("cloud://") || !/\/checkins\//.test(recordingFileId)) {
    throw new Error("录音文件路径不合法");
  }

  const record = {
    // _openid 由云函数上下文写入，客户端无法冒充其他用户。
    _openid: openId,
    shareToken: crypto.randomBytes(16).toString("hex"),
    recordingFileId,
    durationMs: requireDurationMs(event.durationMs),
    bookId: requireText(event.bookId, "教材编号", 30),
    bookTitle: requireText(event.bookTitle, "教材名称", 100),
    practiceId: requireText(event.practiceId, "训练编号", 80),
    practiceIndex: requireInteger(event.practiceIndex, "训练序号", 0, 9999),
    pageNumber: requireInteger(event.pageNumber, "教材页号", 0, 9999),
    sectionTitle: requireText(event.sectionTitle, "训练名称", 120),
    imageUrl: requireText(event.imageUrl, "教材图片", 1000),
    createdAt: db.serverDate(),
  };

  const result = await checkIns.add({ data: record });
  return success({ id: result._id, shareToken: record.shareToken });
};

const getDetail = async (event, openId) => {
  const id = requireText(event.id, "打卡编号", 100);
  const result = await checkIns.doc(id).get();
  const record = result.data;
  if (!record) return failure("打卡记录不存在或已被删除");

  const isOwner = record._openid === openId;
  // 非本人访问必须携带不可枚举的分享口令，只授权当前这一条记录。
  if (!isOwner && event.shareToken !== record.shareToken) {
    return failure("分享链接无效或已经失效");
  }

  const fileResult = await cloud.getTempFileURL({
    fileList: [record.recordingFileId],
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
  const result = await checkIns
    .where({ _openid: openId })
    .orderBy("createdAt", "desc")
    .limit(50)
    .get();
  return success(result.data.map(toPublicSummary));
};

const removeCheckIn = async (event, openId) => {
  const id = requireText(event.id, "打卡编号", 100);
  const result = await checkIns.doc(id).get();
  const record = result.data;
  if (!record) return failure("打卡记录不存在或已被删除");
  if (record._openid !== openId) return failure("只能删除自己的打卡");

  await cloud.deleteFile({ fileList: [record.recordingFileId] });
  await checkIns.doc(id).remove();
  return success({ id });
};

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return failure("无法识别当前微信用户");

  try {
    switch (event.action) {
      case "create":
        return await createCheckIn(event, OPENID);
      case "detail":
        return await getDetail(event, OPENID);
      case "listMine":
        return await listMine(OPENID);
      case "remove":
        return await removeCheckIn(event, OPENID);
      default:
        return failure("不支持的打卡操作");
    }
  } catch (error) {
    console.error("checkIn 云函数执行失败", { action: event.action, error });
    return failure(error?.message || "云端服务暂时不可用");
  }
};
