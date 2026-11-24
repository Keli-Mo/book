// Public messages are fixed; provider messages may contain credentials or child speech.
const { safeFailureDetails } = require("./diagnostics");
const definitions = {
  INVALID_ARGUMENT: ["请求格式不正确，请重新录音", "validation", false],
  NOT_ENABLED: ["英语聊天暂未开放", "access", false],
  UNAUTHORIZED: ["请在微信小程序中重试", "access", false],
  TRIAL_ONLY: ["英语聊天正在试用中", "access", false],
  NO_SPEECH: ["这次没有识别到文字。请靠近麦克风，慢一点说一句简短英语", "asr", true],
  INVALID_AUDIO: ["录音文件无效，请重新录音", "asr", true],
  AUDIO_FORMAT_UNSUPPORTED: ["录音格式不兼容，请重新录音；仍失败请联系管理员", "asr", true],
  BAD_TRANSCRIPT: ["录音内容太长，请说短一点", "asr", true],
  BAD_MODEL_REPLY: ["AI 这次的回答格式异常，请重新生成回答", "reply", true],
  BAD_AUDIO: ["英文回答已生成，但语音文件异常，请重试", "tts", true],
  ASR_UNAVAILABLE: ["语音识别失败，原因暂未确认，请稍后再试", "asr", true],
  REPLY_UNAVAILABLE: ["已识别你的话，准备英文回答时出错，请稍后重试", "reply", true],
  TTS_UNAVAILABLE: ["英文回答已生成，语音生成失败，请稍后重试", "tts", true],
  ASR_TIMEOUT: ["语音识别超时，请稍后重试", "asr", true],
  REPLY_TIMEOUT: ["英文回答等待超时，请稍后重试", "reply", true],
  TTS_TIMEOUT: ["英文语音生成超时，请稍后重试", "tts", true],
  ASR_BUSY: ["语音识别服务繁忙，请稍后重试", "asr", true],
  REPLY_BUSY: ["英文对话服务繁忙，请稍后重试", "reply", true],
  TTS_BUSY: ["英文语音服务繁忙，请稍后重试", "tts", true],
  ASR_NETWORK: ["语音识别服务连接失败，请稍后重试", "asr", true],
  REPLY_NETWORK: ["英文对话服务连接失败，请稍后重试", "reply", true],
  TTS_NETWORK: ["英文语音服务连接失败，请稍后重试", "tts", true],
  CONFIG_MISSING: ["语音服务尚未配置，请联系管理员", "server", false],
  SERVICE_AUTH_FAILED: ["语音服务授权异常，请联系管理员", "server", false],
  SERVICE_QUOTA_EXHAUSTED: ["语音服务额度不足，请联系管理员", "server", false],
  SERVICE_CONFIG_ERROR: ["语音服务配置异常，请联系管理员", "server", false],
  QUOTA_UNAVAILABLE: ["体验额度查询失败，请稍后重试", "quota", true],
  QUOTA_EXHAUSTED: ["本次体验的可用轮数已用完", "quota", false],
  REQUEST_IN_PROGRESS: ["这轮对话还在处理中，请稍候", "quota", true],
  REQUEST_COMPLETED: ["这轮对话已完成", "quota", false],
  RESERVATION_EXPIRED: ["这轮对话已超时，请重新说一句", "quota", true],
  INVALID_RECEIPT: ["这轮对话的确认凭据无效", "quota", false],
  UPDATE_REQUIRED: ["请使用新版试用页面开始对话", "quota", false],
  VOICE_CHAT_ERROR: ["语音聊天出现异常，请稍后重试", "server", true],
};
const stages = new Set(["access", "validation", "asr", "reply", "tts", "quota", "server"]);
const hasCode = (code) => Object.prototype.hasOwnProperty.call(definitions, code);

class VoiceError extends Error {
  constructor(code, message, stage) {
    super(message || definitions[code][0]);
    this.code = code;
    this.stage = stage || definitions[code][1];
  }
}
const voiceError = (code, message, stage) => new VoiceError(code, message, stage);
const modelReplyError = (reasonCode, message, details = {}) =>
  Object.assign(voiceError("BAD_MODEL_REPLY", message), { diagnostic: { ...details, reasonCode } });

// Exact codes from Tencent SentenceRecognition/TextToVoice and common error docs.
// Never classify from an arbitrary error message or an unverified prefix.
const providerGroups = {
  SERVICE_AUTH_FAILED: ["AuthFailure", "AuthFailure.InvalidAuthorization", "AuthFailure.InvalidSecretId", "AuthFailure.SecretIdNotFound", "AuthFailure.SignatureExpire", "AuthFailure.SignatureFailure", "AuthFailure.TokenFailure", "AuthFailure.UnauthorizedOperation", "UnauthorizedOperation", "UnsupportedOperation.AuthorizationExpired", "UnsupportedOperation.AuthorizationFailed", "UnsupportedOperation.ForbiddenUse"],
  SERVICE_QUOTA_EXHAUSTED: ["FailedOperation.ServiceIsolate", "FailedOperation.UserHasNoAmount", "FailedOperation.UserHasNoFreeAmount", "UnsupportedOperation.AccountArrears", "UnsupportedOperation.NoFreeAccount", "UnsupportedOperation.PkgExhausted"],
  SERVICE_CONFIG_ERROR: ["FailedOperation.UserNotRegistered", "InvalidParameter", "InvalidParameterValue", "MissingParameter", "UnknownParameter", "UnsupportedRegion", "InvalidAction", "InvalidParameter.ErrorContentlength", "InvalidParameter.ErrorParamsMissing", "InvalidParameter.ErrorParsequest", "InvalidParameterValue.ErrorInvalidAppid", "InvalidParameterValue.ErrorInvalidEngservice", "InvalidParameterValue.ErrorInvalidSourcetype", "InvalidParameterValue.AppIdNotRegistered", "InvalidParameterValue.Codec", "InvalidParameterValue.PrimaryLanguage", "InvalidParameterValue.SampleRate", "InvalidParameterValue.VoiceType", "UnsupportedOperation.ServerNotOpen", "UnsupportedOperation.ServerStopped", "UnsupportedOperation.ServerDestoryed"],
  INVALID_AUDIO: ["InvalidParameterValue.ErrorInvalidVoiceFormat", "InvalidParameterValue.ErrorInvalidVoicedata", "InvalidParameterValue.ErrorVoicedataTooLong"],
  BUSY: ["RequestLimitExceeded", "RequestLimitExceeded.GlobalRegionUinLimitExceeded", "RequestLimitExceeded.IPLimitExceeded", "RequestLimitExceeded.UinLimitExceeded", "LimitExceeded.AccessLimit", "InternalError.ExceedMaxLimit", "InternalError.NoResource"],
  TIMEOUT: ["ETIMEDOUT", "ESOCKETTIMEDOUT"],
  NETWORK: ["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "EPIPE"],
  UNAVAILABLE: ["FailedOperation.ErrorRecognize", "InternalError.ErrorRecognize", "InternalError", "InternalError.ErrorConfigure", "InternalError.InternalError", "InternalError.ErrorGetRoute", "ServiceUnavailable"],
};
const providerCodes = new Map(Object.entries(providerGroups).flatMap(([kind, codes]) => codes.map((code) => [code, kind])));

function providerError(error, stage) {
  if (error instanceof VoiceError) return Object.assign(error, { stage });
  const prefix = { asr: "ASR", reply: "REPLY", tts: "TTS" }[stage];
  let code = `${prefix}_UNAVAILABLE`;
  let providerCode;
  // A legacy injected adapter may use this fixed configuration code.
  if (error?.code === "CONFIG_MISSING") code = "CONFIG_MISSING";
  const externalCode = providerCodes.has(error?.code) ? error.code : error?.cause?.code;
  if (providerCodes.has(externalCode)) {
    providerCode = externalCode;
    const kind = providerCodes.get(externalCode);
    code = ["TIMEOUT", "BUSY", "NETWORK", "UNAVAILABLE"].includes(kind) ? `${prefix}_${kind}` : kind;
    if (code === "INVALID_AUDIO" && stage !== "asr") code = `${prefix}_UNAVAILABLE`;
  }
  // Tencent's SDK exposes HTTP failures as httpCode; our DeepSeek adapter uses statusCode.
  const status = error?.statusCode ?? error?.httpCode;
  if (Number.isInteger(status) && status >= 400 && status <= 599) {
    providerCode = `HTTP_${status}`;
    if ([408, 504].includes(status)) code = `${prefix}_TIMEOUT`;
    else if ([429, 503].includes(status)) code = `${prefix}_BUSY`;
    else if ([401, 403].includes(status)) code = "SERVICE_AUTH_FAILED";
    else if (status === 402) code = "SERVICE_QUOTA_EXHAUSTED";
    else if ([400, 404, 413, 422].includes(status)) code = "SERVICE_CONFIG_ERROR";
  }
  return Object.assign(voiceError(code, undefined, stage), providerCode ? { providerCode } : {});
}

function failure(error, fallback = "VOICE_CHAT_ERROR", stage) {
  const code = hasCode(error?.code) ? error.code : fallback;
  const definition = definitions[code];
  // Only our own validation errors carry safe, specific field instructions.
  const message = code === "INVALID_ARGUMENT" && error instanceof VoiceError ? error.message : definition[0];
  const reasonCode = code === "BAD_MODEL_REPLY" && error instanceof VoiceError
    ? safeFailureDetails(error).reasonCode : undefined;
  return { ok: false, code, message, stage: stages.has(stage) ? stage : (error instanceof VoiceError && stages.has(error.stage) ? error.stage : definition[1]), retryable: definition[2], ...(reasonCode ? { reasonCode } : {}) };
}

function reportFailure(adapters, result, error, requestId, context) {
  try {
    const diagnostic = { event: "voice_chat_failure", stage: result.stage, safeCode: result.code };
    const providerCode = error?.providerCode;
    if (providerCodes.has(providerCode) || (typeof providerCode === "string" && /^HTTP_[45][0-9]{2}$/.test(providerCode))) diagnostic.providerCode = providerCode;
    if (typeof requestId === "string" && /^[a-f0-9]{32}$/i.test(requestId)) diagnostic.requestId = requestId;
    Object.assign(diagnostic, context?.snapshot(), error instanceof VoiceError ? safeFailureDetails(error) : {});
    const reporting = adapters.logDiagnostic?.(diagnostic);
    if (reporting?.catch) reporting.catch(() => {});
  } catch { /* Diagnostics must never change the learner's result. */ }
}

module.exports = { definitions, voiceError, modelReplyError, providerError, failure, reportFailure };
