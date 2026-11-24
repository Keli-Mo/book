import type { VoiceCorrection, VoiceLevel, VoiceMode, VoiceTopic, VoicePartialReply } from "@/features/voiceChat/session";
import { CLOUD_ENV_ID } from "@/cloud";
import { readMiniProgramEnvVersion } from "@/services/appEntry";
import { cloudVoiceError, safeVoiceError, voiceError, type VoiceError } from "./voiceChatErrors";

export type VoiceChatRequest = {
  requestId: string;
  mode: VoiceMode;
  level: VoiceLevel;
  topic: VoiceTopic;
  durationMs: number;
  audioBase64: string;
  turns: { userEn: string; assistantEn: string }[];
};

export type VoiceChatResponse = {
  requestId: string;
  transcript: string;
  replyEn: string;
  replyZh: string;
  correction?: VoiceCorrection;
  audioBase64: string;
  quota?: VoiceChatQuota;
  receipt?: VoiceChatReceipt;
};

export type VoiceChatQuota =
  | { kind: "unlimited" }
  | { kind: "metered"; freeRemaining: number; packRemaining: number; packExpiresAt: number | null; pendingUntil?: number };
export type VoiceChatReceipt = { requestId: string; token: string };
export type VoiceChatError = VoiceError & { partial?: VoicePartialReply };
export type VoiceChatContext = Pick<VoiceChatRequest, "requestId" | "mode" | "level" | "topic" | "turns">;
export type VoiceChatRetry = VoiceChatContext & { transcript: string } & (
  { action: "retryReply" } | { action: "retrySpeech"; reply: Pick<VoiceChatResponse, "replyEn" | "replyZh" | "correction"> }
);

const protocolError = () => voiceError("RESPONSE_INVALID");
const nonEmpty = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;

function readQuota(value: unknown): VoiceChatQuota {
  if (!value || typeof value !== "object") throw protocolError();
  const quota = value as VoiceChatQuota;
  if (quota.kind === "unlimited") return quota;
  const nonnegative = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (quota.kind !== "metered" || !nonnegative(quota.freeRemaining) || !nonnegative(quota.packRemaining) ||
    (quota.packExpiresAt !== null && !nonnegative(quota.packExpiresAt)) ||
    (quota.pendingUntil !== undefined && !nonnegative(quota.pendingUntil))) throw protocolError();
  return quota;
}

function readData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw protocolError();
  const result = value as { ok?: unknown; code?: unknown; message?: unknown; data?: unknown };
  if (result.ok === false) {
    const error = safeVoiceError(result, "VOICE_CHAT_ERROR");
    if (error.code === "AUDIO_FORMAT_UNSUPPORTED") {
      let simulator = false;
      try { simulator = typeof wx !== "undefined" && (wx as typeof wx & { getDeviceInfo?: () => { platform?: string } }).getDeviceInfo?.().platform === "devtools"; } catch { /* Keep the device-neutral message. */ }
      if (simulator) throw safeVoiceError({ ...error, code: "SIMULATOR_AUDIO_FORMAT" }, "AUDIO_FORMAT_UNSUPPORTED");
    }
    throw error;
  }
  if (result.ok !== true || !result.data || typeof result.data !== "object") throw protocolError();
  return result.data as Record<string, unknown>;
}

export function readVoiceChatResponse(value: unknown, requestId: string): VoiceChatResponse {
  let data: Partial<VoiceChatResponse>;
  try { data = readData(value) as Partial<VoiceChatResponse>; }
  catch (caught) {
    const error = caught as VoiceChatError;
    const result = value as { ok?: unknown; requestId?: unknown; stage?: unknown; partial?: VoicePartialReply } | null;
    const partial = result?.partial;
    if (result?.ok === false && result.requestId === requestId && (result.stage === "reply" || result.stage === "tts") &&
        partial && nonEmpty(partial.transcript, 500)) {
      const english = (text: unknown, max: number): text is string => nonEmpty(text, max) && /[A-Za-z]/.test(text) &&
        ![...text].some(char => /\p{Letter}/u.test(char) && !/\p{Script=Latin}/u.test(char));
      const chinese = (text: unknown, max: number): text is string => nonEmpty(text, max) && /\p{Script=Han}/u.test(text);
      if (result.stage === "reply" && partial.replyEn === undefined && partial.replyZh === undefined && partial.correction === undefined) {
        error.partial = { transcript: partial.transcript };
      } else if (result.stage === "tts" && english(partial.replyEn, 220) && chinese(partial.replyZh, 350)) {
        error.partial = { transcript: partial.transcript, replyEn: partial.replyEn, replyZh: partial.replyZh };
        if (partial.correction && english(partial.correction.betterEn, 180) && chinese(partial.correction.explanationZh, 180)) {
          error.partial.correction = { betterEn: partial.correction.betterEn, explanationZh: partial.correction.explanationZh };
        }
      }
    }
    throw error;
  }
  if (data.requestId !== requestId || !nonEmpty(data.transcript, 500) || !nonEmpty(data.replyEn, 500) ||
      !nonEmpty(data.replyZh, 500) || !nonEmpty(data.audioBase64, 1200000) ||
      /[\u3400-\u9fff]/.test(data.replyEn) || !/^[A-Za-z0-9+/]+={0,2}$/.test(data.audioBase64)) {
    throw protocolError();
  }
  if (data.correction !== undefined && (!data.correction || !nonEmpty(data.correction.betterEn, 180) || !nonEmpty(data.correction.explanationZh, 180))) {
    throw protocolError();
  }
  if (data.quota !== undefined) readQuota(data.quota);
  if (data.receipt !== undefined && (!data.receipt || data.receipt.requestId !== requestId ||
      typeof data.receipt.token !== "string" || !/^[a-f0-9]{32}$/.test(data.receipt.token))) throw protocolError();
  return data as VoiceChatResponse;
}

type VoiceChatInvocation = ((VoiceChatRequest | VoiceChatRetry) & { quotaProtocol: 1; progressProtocol: 1 }) | { action: "trialIdentity" | "quotaStatus" } |
  (VoiceChatReceipt & { action: "confirmTurn" });

async function invokeVoiceChat(data: VoiceChatInvocation): Promise<unknown> {
  if (typeof wx === "undefined" || !wx.cloud?.callFunction) throw voiceError("WX_UNSUPPORTED");
  try {
    // Preview phones use the isolated service directly; release/unknown
    // environments retain the existing production function.
    const name = isVoiceChatPreview() ? "voiceChatDiagnostics" : "voiceChat";
    const response = await wx.cloud.callFunction({ name, config: { env: CLOUD_ENV_ID }, data });
    return response.result;
  } catch (error) {
    throw cloudVoiceError(error);
  }
}

export async function callVoiceChat(request: VoiceChatRequest): Promise<VoiceChatResponse> {
  return readVoiceChatResponse(await invokeVoiceChat({ ...request, quotaProtocol: 1, progressProtocol: 1 }), request.requestId);
}

export async function retryVoiceChat(request: VoiceChatRetry): Promise<VoiceChatResponse> {
  return readVoiceChatResponse(await invokeVoiceChat({ ...request, quotaProtocol: 1, progressProtocol: 1 }), request.requestId);
}

export async function getVoiceChatQuota(): Promise<VoiceChatQuota> {
  return readQuota(readData(await invokeVoiceChat({ action: "quotaStatus" })).quota);
}

export async function confirmVoiceChatTurn(receipt: VoiceChatReceipt): Promise<VoiceChatQuota> {
  return readQuota(readData(await invokeVoiceChat({ action: "confirmTurn", requestId: receipt.requestId, token: receipt.token })).quota);
}

export const isVoiceChatPreview = () => ["develop", "trial"].includes(readMiniProgramEnvVersion());

export async function getVoiceChatTrialId(): Promise<string> {
  if (!isVoiceChatPreview()) throw new Error("请在开发版或体验版获取试用编号");
  const result = await invokeVoiceChat({ action: "trialIdentity" }) as
    { ok?: unknown; data?: { openId?: unknown } } | null;
  const openId = result?.data?.openId;
  if (result?.ok !== true || typeof openId !== "string" || !/^[\w-]{1,128}$/.test(openId)) {
    throw new Error("暂时无法获取试用编号，请重试");
  }
  return openId;
}
