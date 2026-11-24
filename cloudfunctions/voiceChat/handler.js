const MAX_AUDIO_BASE64 = 400000;
const TOPICS = new Set(["animals", "school", "food", "travel"]);
const { voiceError, modelReplyError, providerError, failure, reportFailure } = require("./errors");
const { createDiagnostics, safeFailureDetails } = require("./diagnostics");

const reject = (code, message) => { throw voiceError(code, message); };
const clean = (value, label, max) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) reject("INVALID_ARGUMENT", `${label}格式不正确`);
  return value.trim();
};
const modelText = (value, label, max, field) => {
  if (typeof value !== "string") throw modelReplyError("MODEL_FIELD_TYPE", `${label}格式不正确`, { field });
  if (!value.trim()) throw modelReplyError("MODEL_FIELD_EMPTY", `${label}格式不正确`, { field });
  if (value.length > max) throw modelReplyError("MODEL_FIELD_TOO_LONG", `${label}格式不正确`, { field, actualLength: value.length, maxLength: max });
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
  const retry = event.action === "retryReply" || event.action === "retrySpeech";
  let audio = Buffer.alloc(0), transcript, reply;
  if (retry) {
    if (event.progressProtocol !== 1) reject("INVALID_ARGUMENT");
    transcript = clean(event.transcript, "识别文字", 500);
    if (event.action === "retrySpeech") {
      try { reply = parseReply(event.reply); } catch { reject("INVALID_ARGUMENT", "回答格式不正确"); }
    }
  } else {
    if (!Number.isInteger(event.durationMs) || event.durationMs < 300 || event.durationMs > 30000) reject("INVALID_ARGUMENT", "录音时长超出限制");
    const audioBase64 = clean(event.audioBase64, "录音", MAX_AUDIO_BASE64);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(audioBase64)) reject("INVALID_ARGUMENT", "录音格式不正确");
    audio = Buffer.from(audioBase64, "base64");
    if (audio.length < 8 || audio.length > 300000) reject("INVALID_ARGUMENT", "录音大小超出限制");
  }
  if (!Array.isArray(event.turns) || event.turns.length > 8) reject("INVALID_ARGUMENT", "聊天上下文超出限制");
  const turns = event.turns.map((turn) => {
    if (!turn || typeof turn !== "object") reject("INVALID_ARGUMENT", "聊天上下文格式不正确");
    return {
      userEn: clean(turn.userEn, "聊天上下文", 500),
      assistantEn: clean(turn.assistantEn, "聊天上下文", 500),
    };
  });
  return { requestId, mode: event.mode, level: event.level, topic: event.mode === "topic" ? event.topic : undefined,
    durationMs: retry ? 0 : event.durationMs, audio, turns, ...(retry ? { transcript, reply } : {}) };
}

function parseReply(value, onCorrectionWarning) {
  let parsed;
  try { parsed = typeof value === "string" ? JSON.parse(value) : value; } catch { throw modelReplyError("MODEL_JSON_INVALID", "对话回复格式异常"); }
  if (!parsed || typeof parsed !== "object") throw modelReplyError("MODEL_OBJECT_INVALID", "对话回复格式异常");
  const replyEn = modelText(parsed.replyEn, "英文回复", 220, "replyEn");
  if (!/[A-Za-z]/.test(replyEn) || hasNonLatinLetters(replyEn)) throw modelReplyError("MODEL_ENGLISH_INVALID", "英文回复包含非英文内容", { field: "replyEn" });
  const replyZh = modelText(parsed.replyZh, "中文字幕", 350, "replyZh");
  if (!/\p{Script=Han}/u.test(replyZh)) throw modelReplyError("MODEL_CHINESE_MISSING", "中文字幕缺少中文内容", { field: "replyZh" });
  let correction;
  const warn = (error, outcome) => {
    try {
      const reporting = onCorrectionWarning?.({ ...safeFailureDetails(error), outcome });
      if (reporting?.catch) reporting.catch(() => {});
    } catch { /* Optional diagnostics must not interrupt a valid reply. */ }
  };
  if (parsed.correction != null) {
    // The bilingual answer is required; the correction card is optional. A
    // model's malformed correction must not discard valid speech and subtitles.
    try {
      const betterEn = modelText(parsed.correction.betterEn, "纠正示范", 180, "correction.betterEn");
      const explanationZh = modelText(parsed.correction.explanationZh, "纠正说明", 180, "correction.explanationZh");
      if (!/[A-Za-z]/.test(betterEn) || hasNonLatinLetters(betterEn)) throw modelReplyError("MODEL_ENGLISH_INVALID", "纠正示范不是英文", { field: "correction.betterEn" });
      if (!/\p{Script=Han}/u.test(explanationZh)) throw modelReplyError("MODEL_CHINESE_MISSING", "纠正说明缺少中文", { field: "correction.explanationZh" });
      correction = { betterEn, explanationZh };
    } catch (error) {
      if (error?.code !== "BAD_MODEL_REPLY") throw error;
      warn(error, "omitted");
    }
    // Keep a valid independent card without rewriting spoken text or its
    // translation, retrying the model, or exceeding the answer length limit.
    if (correction && !replyEn.includes(correction.betterEn)) {
      warn(modelReplyError("MODEL_CORRECTION_MISMATCH", undefined, { field: "correction.betterEn" }), "separate_card");
    }
  }
  return { replyEn, replyZh, ...(correction ? { correction } : {}) };
}

const unlimited = { kind: "unlimited" };
const metered = (balance) => ({ kind: "metered", ...balance });
async function providerCall(operation, stage, diagnostics) {
  const startedAt = Date.now();
  try {
    return await operation();
  } catch (error) {
    throw providerError(error, stage);
  } finally {
    diagnostics?.stageFinished(stage, Math.max(0, Date.now() - startedAt));
  }
}

async function generateTurn(adapters, input, openId, diagnostics, progress) {
  const transcript = input.transcript ?? await providerCall(
    () => adapters.transcribe(input.audio, { requestId: input.requestId, openId }), "asr", diagnostics);
  diagnostics.transcript(transcript);
  if (typeof transcript !== "string") reject("ASR_UNAVAILABLE");
  if (!transcript.trim()) reject("NO_SPEECH");
  if (transcript.length > 500) reject("BAD_TRANSCRIPT");
  progress.transcript = transcript.trim();
  const reply = input.reply ?? parseReply(await providerCall(
    () => adapters.reply({ ...input, transcript: transcript.trim(), openId, diagnostics }), "reply", diagnostics),
    warning => adapters.logDiagnostic?.({ event: "voice_chat_correction_warning", stage: "reply", requestId: input.requestId, ...warning }));
  Object.assign(progress, reply);
  const audioBase64 = await providerCall(
    () => adapters.synthesize(reply.replyEn, { requestId: input.requestId, level: input.level }), "tts", diagnostics);
  if (typeof audioBase64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(audioBase64) || audioBase64.length > 1200000) {
    reject("BAD_AUDIO");
  }
  return { requestId: input.requestId, transcript: transcript.trim(), ...reply, audioBase64 };
}

function createHandler(adapters) {
  return async (event) => {
    let generatingMeteredTurn = false;
    let diagnostics;
    // Only validated results from this invocation may be returned on failure.
    const progress = {};
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
      const individuallyAllowed = adapters.allowedOpenIds?.has(openId) === true;
      if (adapters.openTrial !== true && !individuallyAllowed) reject("TRIAL_ONLY");
      const isMetered = adapters.openTrial !== true && adapters.quotaEnabled && !adapters.unlimitedOpenIds?.has(openId);
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
      if (event?.action !== undefined && event.action !== "retryReply" && event.action !== "retrySpeech") reject("INVALID_ARGUMENT", "未知的对话操作");
      const input = validateRequest(event);
      // Client-supplied debug/openId flags cannot enable speech-content logs.
      diagnostics = createDiagnostics(input, individuallyAllowed && adapters.unlimitedOpenIds?.has(openId) === true && adapters.debugOpenIds?.has(openId) === true);
      stage = "server";
      if (!isMetered) return { ok: true, data: { ...await generateTurn(adapters, input, openId, diagnostics, progress), quota: unlimited } };
      stage = "quota";
      if (event.quotaProtocol !== 1) reject("UPDATE_REQUIRED");
      const { token } = await adapters.quota.reserve(openId, input.requestId);
      generatingMeteredTurn = true;
      stage = "server";
      try {
        const data = await generateTurn(adapters, input, openId, diagnostics, progress);
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
      if (event?.progressProtocol === 1 && progress.transcript && (result.stage === "reply" || result.stage === "tts")) {
        result.partial = progress;
      }
      reportFailure(adapters, result, error, event?.requestId, diagnostics);
      return result;
    }
  };
}

module.exports = { createHandler, validateRequest, parseReply };
