const messages = {
  NO_SPEECH: "这段录音没有识别到文字，请重新说一句。",
  BAD_TRANSCRIPT: "录音内容太长，请说短一点。",
  BAD_MODEL_REPLY: "英文回答格式异常，请重试。",
  BAD_AUDIO: "英文回答已生成，但语音文件异常，请重试。",
  ASR_UNAVAILABLE: "语音识别服务暂时出错，请稍后重试。",
  REPLY_UNAVAILABLE: "已识别你的话，准备英文回答时出错，请稍后重试。",
  TTS_UNAVAILABLE: "英文回答已生成，语音生成失败，请稍后重试。",
  ASR_TIMEOUT: "语音识别超时，请稍后重试。",
  ASR_BUSY: "语音识别服务繁忙，请稍后重试。",
  ASR_NETWORK: "语音识别服务连接失败，请稍后重试。",
  REPLY_TIMEOUT: "英文回答等待超时，请稍后重试。",
  REPLY_BUSY: "英文对话服务繁忙，请稍后重试。",
  REPLY_NETWORK: "英文对话服务连接失败，请稍后重试。",
  TTS_TIMEOUT: "英文语音生成超时，请稍后重试。",
  TTS_BUSY: "英文语音服务繁忙，请稍后重试。",
  TTS_NETWORK: "英文语音服务连接失败，请稍后重试。",
  INVALID_AUDIO: "录音文件无效，请重新录音。",
  SERVICE_AUTH_FAILED: "语音服务授权异常，请联系管理员。",
  SERVICE_QUOTA_EXHAUSTED: "语音服务额度不足，请联系管理员。",
  SERVICE_CONFIG_ERROR: "语音服务配置异常，请联系管理员。",
  QUOTA_UNAVAILABLE: "体验额度查询失败，请稍后重试。",
  CONFIG_MISSING: "语音服务尚未配置，请联系管理员。",
  QUOTA_EXHAUSTED: "本次体验的可用轮数已用完。",
  REQUEST_IN_PROGRESS: "这轮对话还在处理中，请稍候。",
  REQUEST_COMPLETED: "这轮对话已完成。",
  RESERVATION_EXPIRED: "这轮对话已超时，请重新说一句。",
  INVALID_RECEIPT: "这轮对话的确认凭据无效。",
  UPDATE_REQUIRED: "请使用新版试用页面开始对话。",
  NOT_ENABLED: "英语聊天暂未开放。",
  UNAUTHORIZED: "请在微信小程序中重试。",
  TRIAL_ONLY: "英语聊天正在试用中。",
  INVALID_ARGUMENT: "请求格式不正确，请重新录音。",
  VOICE_CHAT_ERROR: "语音聊天出现异常，请稍后重试。",
  RESPONSE_INVALID: "对话服务返回的数据异常，请稍后重试。",
  NETWORK_ERROR: "网络连接失败，请检查手机网络后重试。",
  CLOUD_TIMEOUT: "等待对话服务超时，请稍后重试。",
  CLOUD_UNAVAILABLE: "连接对话服务失败，请稍后重试。",
  WX_UNSUPPORTED: "当前微信不支持语音服务，请更新微信。",
  MIC_PERMISSION: "麦克风权限未开启，请在设置中允许录音。",
  MIC_PRIVACY: "录音隐私授权尚未完成，请完成授权后重试。",
  MIC_PRIVACY_CONFIG: "录音隐私配置异常，请联系管理员。",
  MIC_SETUP: "录音说明或权限检查失败，请重新进入页面。",
  RECORD_BUSY: "麦克风正在使用，请稍后重试。",
  RECORD_START: "录音设备启动失败，请检查麦克风后重试。",
  RECORD_STOP: "结束录音失败，请重新录制。",
  RECORD_TOO_SHORT: "录音时间太短，请说完一句英语后再发送。",
  RECORD_TOO_LARGE: "录音过长，请分成短句再说。",
  RECORD_INVALID: "录音文件格式异常，请重新录制。",
  FILE_READ_FAILED: "录音文件读取失败，请重新录制。",
  FILE_SAVE_FAILED: "英文语音保存失败，可点重听再试。",
  PLAYBACK_FAILED: "英文语音播放失败，可点重听再试。",
} as const;

export type VoiceErrorCode = keyof typeof messages;
export type VoiceError = Error & { code: VoiceErrorCode; stage?: string; retryable?: boolean };

export function voiceError(code: VoiceErrorCode): VoiceError {
  return Object.assign(new Error(messages[code]), { code });
}

export function safeVoiceError(error: unknown, fallback: VoiceErrorCode): VoiceError {
  const value = error as { code?: unknown; stage?: unknown; retryable?: unknown } | null;
  const code = typeof value?.code === "string" && Object.prototype.hasOwnProperty.call(messages, value.code)
    ? value.code as VoiceErrorCode : fallback;
  const result = voiceError(code);
  if (typeof value?.stage === "string" && /^(recording|network|validation|asr|reply|tts|quota|server|playback|access)$/.test(value.stage)) result.stage = value.stage;
  if (typeof value?.retryable === "boolean") result.retryable = value.retryable;
  return result;
}

function nativeDetail(error: unknown): string {
  const value = error as { errMsg?: unknown; message?: unknown } | null;
  return [value?.errMsg, value?.message].filter(item => typeof item === "string").join(" ");
}

export function cloudVoiceError(error: unknown): VoiceError {
  const detail = nativeDetail(error);
  if (/timeout|timed out|超时/i.test(detail)) return voiceError("CLOUD_TIMEOUT");
  if (/network|offline|internet|ENETUNREACH|ENOTFOUND|网络/i.test(detail)) return voiceError("NETWORK_ERROR");
  return voiceError("CLOUD_UNAVAILABLE");
}

export function microphoneError(error: unknown, fallback: VoiceErrorCode = "RECORD_START"): VoiceError {
  const safe = safeVoiceError(error, fallback);
  if (safe.code !== fallback) return safe;
  const detail = nativeDetail(error);
  if (/privacy.*(?:not declared|not configured|undeclared)|未声明.*隐私|隐私.*未(?:声明|配置)/i.test(detail)) return voiceError("MIC_PRIVACY_CONFIG");
  if (/privacy|隐私/i.test(detail)) return voiceError("MIC_PRIVACY");
  if (/auth deny|auth denied|permission.*(?:denied|deny|forbidden)|authorize:fail|麦克风权限未开启/i.test(detail)) return voiceError("MIC_PERMISSION");
  if (/busy|already recording|正在使用|正在释放/i.test(detail)) return voiceError("RECORD_BUSY");
  return safe;
}
