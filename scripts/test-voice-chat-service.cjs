const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const file = path.join(__dirname, "../src/services/voiceChat.ts");
const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const moduleRef = { exports: {} };
const cloudEnv = "expected-voice-env";
let version = "develop";
let identity = "o-trial_test";
let identityCalls = 0;
const routedCalls = [];
let transportError;
const errorSource = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/services/voiceChatErrors.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const errorModule = { exports: {} };
new Function("module", "exports", errorSource)(errorModule, errorModule.exports);
let quota = { kind: "metered", freeRemaining: 5, packRemaining: 0, packExpiresAt: null };
const receipt = { requestId: "c".repeat(32), token: "d".repeat(32) };
new Function("module", "exports", "require", "wx", compiled)(moduleRef, moduleRef.exports, (name) => {
  if (name === "@/features/voiceChat/session") return {};
  if (name === "@/cloud") return { CLOUD_ENV_ID: cloudEnv };
  if (name === "@/services/appEntry") return { readMiniProgramEnvVersion: () => version };
  if (name === "./voiceChatErrors") return errorModule.exports;
  throw new Error(`Unexpected import: ${name}`);
}, { cloud: { callFunction: async ({ name, config, data }) => {
  if (transportError) throw transportError;
  assert.equal(name, ["develop", "trial"].includes(version) ? "voiceChatDiagnostics" : "voiceChat");
  routedCalls.push({ version, name, action: data.action || "recording" });
  assert.equal(config.env, cloudEnv);
  if (data.action === "trialIdentity") {
    assert.deepEqual(data, { action: "trialIdentity" });
    identityCalls++;
    return { result: { ok: true, data: { openId: identity } } };
  }
  if (data.action === "quotaStatus" || data.action === "confirmTurn") {
    assert.deepEqual(data, data.action === "quotaStatus" ? { action: "quotaStatus" } : { action: "confirmTurn", ...receipt });
    return { result: { ok: true, data: { quota } } };
  }
  assert.equal(data.requestId, "c".repeat(32));
  assert.equal(data.quotaProtocol, 1);
  return { result: { ok: true, data: { requestId: data.requestId, transcript: "Hello", replyEn: "Hi!", replyZh: "你好！", audioBase64: "QUJD", receipt } } };
} } });

const { callVoiceChat, retryVoiceChat, readVoiceChatResponse, getVoiceChatTrialId, getVoiceChatQuota, confirmVoiceChatTurn } = moduleRef.exports;
assert.equal(readVoiceChatResponse({ ok: true, data: { requestId: "c".repeat(32), transcript: "Hello", replyEn: "Hi!", replyZh: "你好！", audioBase64: "QUJD" } }, "c".repeat(32)).replyEn, "Hi!");
assert.throws(() => readVoiceChatResponse({ ok: true, data: { requestId: "other", transcript: "Hello", replyEn: "Hi!", replyZh: "你好！", audioBase64: "QUJD" } }, "c".repeat(32)), error => error.code === "RESPONSE_INVALID");
assert.throws(() => readVoiceChatResponse({ ok: false, code: "NO_SPEECH", message: "private details" }, "c".repeat(32)), /没有识别到文字/);
assert.throws(() => readVoiceChatResponse({ ok: false, code: "ASR_UNAVAILABLE", message: "sk-private secret user audio" }, "c".repeat(32)), error => error.code === "ASR_UNAVAILABLE" && !/private|secret|audio/.test(error.message));
const { microphoneError, safeVoiceError, voiceError } = errorModule.exports;
for (const [error, expected] of [
  [{ errMsg: "authorize:fail auth deny private-path" }, "MIC_PERMISSION"],
  [new Error("privacy agreement denied private-path"), "MIC_PRIVACY"],
  [{ errMsg: "privacy permission not declared private-path" }, "MIC_PRIVACY_CONFIG"],
  [{ errMsg: "recorder:start busy private-path" }, "RECORD_BUSY"],
  [new Error("unknown private-path"), "RECORD_START"],
]) {
  const result = microphoneError(error);
  assert.equal(result.code, expected);
  assert.ok(!/private-path/.test(result.message));
}
assert.equal(safeVoiceError({ code: "toString", message: "private-path" }, "VOICE_CHAT_ERROR").code, "VOICE_CHAT_ERROR");
assert.equal(microphoneError({ errMsg: "getSetting:fail permission check" }, "MIC_SETUP").code, "MIC_SETUP");
const safeMetadata = safeVoiceError({ code: "ASR_TIMEOUT", stage: "asr", retryable: true, message: "private-path" }, "VOICE_CHAT_ERROR");
assert.equal(safeMetadata.stage, "asr");
assert.equal(safeMetadata.retryable, true);
assert.equal(safeVoiceError({ code: "ASR_TIMEOUT", stage: "private-path", retryable: "private-path" }, "VOICE_CHAT_ERROR").stage, undefined);
for (const [code, definition] of Object.entries(require("../cloudfunctions/voiceChat/errors").definitions)) {
  assert.equal(voiceError(code).message, definition[0] + "。", `Client/server error text drift: ${code}`);
}
(async () => {
  const result = await callVoiceChat({ requestId: "c".repeat(32), mode: "free", level: "basic", topic: "animals", durationMs: 1000, audioBase64: "QUJD", turns: [] });
  assert.equal(result.transcript, "Hello");
  assert.deepEqual(result.receipt, receipt);
  assert.throws(() => readVoiceChatResponse({ ok: true, data: { ...result, receipt: { ...receipt, requestId: "wrong" } } }, result.requestId), error => error.code === "RESPONSE_INVALID");
  assert.deepEqual(await getVoiceChatQuota(), quota);
  assert.deepEqual(await confirmVoiceChatTurn(receipt), quota);
  quota = { ...quota, freeRemaining: -1 };
  await assert.rejects(getVoiceChatQuota, error => error.code === "RESPONSE_INVALID");
  for (const [error, expected] of [
    [{ errMsg: "cloud.callFunction:fail timeout private-recording" }, "CLOUD_TIMEOUT"],
    [new Error("network disconnected private-token"), "NETWORK_ERROR"],
    [{ errMsg: "cloud.callFunction:fail internal private-key" }, "CLOUD_UNAVAILABLE"],
  ]) {
    transportError = error;
    await assert.rejects(getVoiceChatQuota, thrown => thrown.code === expected && !/private/.test(thrown.message));
  }
  transportError = null;
  quota = { kind: "unlimited" };
  for (version of ["develop", "trial", "release", "", "unknown"]) {
    const context = { requestId: "c".repeat(32), mode: "free", level: "basic", topic: "animals", turns: [] };
    await callVoiceChat({ ...context, durationMs: 1000, audioBase64: "QUJD" });
    await retryVoiceChat({ ...context, action: "retryReply", transcript: "I like 意大利面。" });
    await retryVoiceChat({ ...context, action: "retrySpeech", transcript: "I like 意大利面。",
      reply: { replyEn: "Pasta is tasty!", replyZh: "意大利面很好吃！" } });
    await getVoiceChatQuota();
    await confirmVoiceChatTurn(receipt);
    assert.deepEqual(routedCalls.slice(-5).map(call => call.action), ["recording", "retryReply", "retrySpeech", "quotaStatus", "confirmTurn"]);
    assert.ok(routedCalls.slice(-5).every(call => call.name === (["develop", "trial"].includes(version) ? "voiceChatDiagnostics" : "voiceChat")));
  }
  for (version of ["develop", "trial"]) assert.equal(await getVoiceChatTrialId(), identity);
  identity = "";
  await assert.rejects(getVoiceChatTrialId, /获取试用编号/);
  for (version of ["release", ""]) await assert.rejects(getVoiceChatTrialId, /开发版或体验版/);
  assert.equal(identityCalls, 3, "正式版或未知版本不应发起身份查询");
  console.log("voice chat service checks passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
