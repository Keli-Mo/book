const MAX_AUDIO_BASE64 = 400000;
const TOPICS = new Set(["animals", "school", "food", "travel"]);
const { voiceError, providerError, failure, reportFailure } = require("./errors");

const reject = (code, message) => { throw voiceError(code, message); };
const clean = (value, label, max) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) reject("INVALID_ARGUMENT", `${label}格式不正确`);
  return value.trim();
};
const modelText = (value, label, max) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) reject("BAD_MODEL_REPLY", `${label}格式不正确`);
  return value.trim();
};
const hasNonLatinLetters = (value) => [...value].some((character) => /\p{Letter}/u.test(character) && !/\p{Script=Latin}/u.test(character));

function validateRequest(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) reject("INVALID_ARGUMENT", "请求格式不正确");
  const requestId = clean(event.requestId, "请求编号", 32);
  if (!/^[a-f0-9]{32}$/i.test(requestId)) reject("INVALID_ARGUMENT", "请求编号格式不正确");
  if (event.mode !== "free" && event.mode !== "topic") reject("INVALID_ARGUMENT", "聊天模式格式不正确");
  if (event.level !== "basic" && event.level !== "advanced") reject("INVALID_ARGUMENT", "难度格式不正确");
  if (event.mode === "topic" && !TOPICS.has(event.topic)) reject("INVALID_ARGUMENT", "聊天主题格式不正确");
  if (!Number.isInteger(event.durationMs) || event.durationMs < 300 || event.durationMs > 30000) reject("INVALID_ARGUMENT", "录音时长超出限制");
  const audioBase64 = clean(event.audioBase64, "录音", MAX_AUDIO_BASE64);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(audioBase64)) reject("INVALID_ARGUMENT", "录音格式不正确");
  const audio = Buffer.from(audioBase64, "base64");
  if (audio.length < 8 || audio.length > 300000) reject("INVALID_ARGUMENT", "录音大小超出限制");
  if (!Array.isArray(event.turns) || event.turns.length > 8) reject("INVALID_ARGUMENT", "聊天上下文超出限制");
  const turns = event.turns.map((turn) => {
    if (!turn || typeof turn !== "object") reject("INVALID_ARGUMENT", "聊天上下文格式不正确");
    return {
      userEn: clean(turn.userEn, "聊天上下文", 500),
      assistantEn: clean(turn.assistantEn, "聊天上下文", 500),
    };
  });
  return { requestId, mode: event.mode, level: event.level, topic: event.mode === "topic" ? event.topic : undefined, durationMs: event.durationMs, audio, turns };
}

function parseReply(value) {
  let parsed;
  try { parsed = typeof value === "string" ? JSON.parse(value) : value; } catch { reject("BAD_MODEL_REPLY", "对话回复格式异常"); }
  if (!parsed || typeof parsed !== "object") reject("BAD_MODEL_REPLY", "对话回复格式异常");
  const replyEn = modelText(parsed.replyEn, "英文回复", 220);
  if (!/[A-Za-z]/.test(replyEn) || hasNonLatinLetters(replyEn)) reject("BAD_MODEL_REPLY", "英文回复包含非英文内容");
  const replyZh = modelText(parsed.replyZh, "中文字幕", 350);
  if (!/\p{Script=Han}/u.test(replyZh)) reject("BAD_MODEL_REPLY", "中文字幕缺少中文内容");
  let correction;
  if (parsed.correction != null) {
    const betterEn = modelText(parsed.correction.betterEn, "纠正示范", 180);
    const explanationZh = modelText(parsed.correction.explanationZh, "纠正说明", 180);
    if (hasNonLatinLetters(betterEn) || !replyEn.includes(betterEn)) reject("BAD_MODEL_REPLY", "纠正示范未包含在英文回复中");
    correction = { betterEn, explanationZh };
  }
  return { replyEn, replyZh, ...(correction ? { correction } : {}) };
}

const unlimited = { kind: "unlimited" };
const metered = (balance) => ({ kind: "metered", ...balance });
async function providerCall(operation, stage) {
  try {
    return await operation();
  } catch (error) {
    throw providerError(error, stage);
  }
}

async function generateTurn(adapters, input, openId) {
  const transcript = await providerCall(
    () => adapters.transcribe(input.audio, { requestId: input.requestId, openId }), "asr");
  if (typeof transcript !== "string") reject("ASR_UNAVAILABLE");
  if (!transcript.trim()) reject("NO_SPEECH");
  if (transcript.length > 500) reject("BAD_TRANSCRIPT");
  const reply = parseReply(await providerCall(
    () => adapters.reply({ ...input, transcript: transcript.trim(), openId }), "reply"));
  const audioBase64 = await providerCall(
    () => adapters.synthesize(reply.replyEn, { requestId: input.requestId, level: input.level }), "tts");
  if (typeof audioBase64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(audioBase64) || audioBase64.length > 1200000) {
    reject("BAD_AUDIO");
  }
  return { requestId: input.requestId, transcript: transcript.trim(), ...reply, audioBase64 };
}

function createHandler(adapters) {
  return async (event) => {
    let generatingMeteredTurn = false;
    let stage = "server";
    try {
      stage = "access";
      const openId = adapters.getOpenId?.();
      if (event?.action === "trialIdentity") {
        if (!openId) reject("UNAUTHORIZED");
        return { ok: true, data: { openId } };
      }
      if (!adapters.enabled) reject("NOT_ENABLED");
      if (!openId) reject("UNAUTHORIZED");
      if (!adapters.allowedOpenIds?.has(openId)) reject("TRIAL_ONLY");
      const isMetered = adapters.quotaEnabled && !adapters.unlimitedOpenIds?.has(openId);
      if (event?.action === "quotaStatus") {
        stage = "quota";
        const quota = isMetered ? metered(await adapters.quota.status(openId)) : unlimited;
        return { ok: true, data: { quota } };
      }
      if (event?.action === "confirmTurn") {
        stage = "quota";
        if (!isMetered || typeof event.requestId !== "string" || !/^[a-f0-9]{32}$/i.test(event.requestId)
          || typeof event.token !== "string" || !/^[a-f0-9]{32}$/.test(event.token)) reject("INVALID_RECEIPT");
        const balance = await adapters.quota.complete(openId, event.requestId, event.token);
        return { ok: true, data: { quota: metered(balance) } };
      }
      stage = "validation";
      if (event?.action !== undefined) reject("INVALID_ARGUMENT", "未知的对话操作");
      const input = validateRequest(event);
      stage = "server";
      if (!isMetered) return { ok: true, data: { ...await generateTurn(adapters, input, openId), quota: unlimited } };
      stage = "quota";
      if (event.quotaProtocol !== 1) reject("UPDATE_REQUIRED");
      const { token } = await adapters.quota.reserve(openId, input.requestId);
      generatingMeteredTurn = true;
      stage = "server";
      try {
        const data = await generateTurn(adapters, input, openId);
        return { ok: true, data: { ...data, receipt: { requestId: input.requestId, token } } };
      } catch (error) {
        // A failed release leaves only a temporary reservation, never a debit.
        try { await adapters.quota.release(openId, input.requestId, token); } catch {}
        throw error;
      }
    } catch (error) {
      const result = failure(error, stage === "quota" ? "QUOTA_UNAVAILABLE" : "VOICE_CHAT_ERROR", stage === "server" ? undefined : stage);
      if (generatingMeteredTurn) result.message += "。本次没有扣轮。";
      if (typeof event?.requestId === "string" && /^[a-f0-9]{32}$/i.test(event.requestId)) result.requestId = event.requestId;
      reportFailure(adapters, result, error, event?.requestId);
      return result;
    }
  };
}

module.exports = { createHandler, validateRequest, parseReply };
