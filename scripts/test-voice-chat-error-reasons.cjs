const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { failure, modelReplyError, providerError } = require("../cloudfunctions/voiceChat/errors");
const { createProviders } = require("../cloudfunctions/voiceChat/providers");

function loadClient(file, dependencies = {}, wx = {}) {
  const compiled = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/services", file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const target = { exports: {} };
  new Function("module", "exports", "require", "wx", compiled)(target, target.exports, name => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    throw Error(`Unexpected import: ${name}`);
  }, wx);
  return target.exports;
}
const client = loadClient("voiceChatErrors.ts");

test("known model failure reasons reach the existing user-facing error path", () => {
  for (const [reason, text] of [
    ["MODEL_CONTENT_EMPTY", /没有返回回答/],
    ["MODEL_CONTENT_MISSING", /没有返回回答/],
    ["MODEL_FINISH_INCOMPLETE", /未生成完整回答/],
    ["MODEL_JSON_INVALID", /内容无法读取/],
    ["MODEL_CHINESE_MISSING", /缺少中文字幕/],
  ]) {
    const result = failure(modelReplyError(reason, "private-upstream-content", { modelContent: "private-speech" }));
    assert.equal(result.reasonCode, reason);
    const error = client.safeVoiceError(result, "VOICE_CHAT_ERROR");
    assert.match(error.message, text);
    assert.match(error.message, /再试/);
    assert.equal(client.safeVoiceError(error, "VOICE_CHAT_ERROR").message, error.message, "page catch must preserve the safe reason");
    assert.ok(!JSON.stringify(result).includes("private"));
    assert.ok(!error.message.includes("private"));
  }
});

test("unknown and unrelated reasons cannot change public error text", () => {
  for (const reasonCode of ["private-raw-model-text", "__proto__", "toString"]) {
    assert.equal(failure(modelReplyError(reasonCode, "private")).reasonCode, undefined);
    const error = client.safeVoiceError({ code: "BAD_MODEL_REPLY", reasonCode, message: "private" }, "VOICE_CHAT_ERROR");
    assert.equal(error.message, client.voiceError("BAD_MODEL_REPLY").message);
    assert.equal(error.reasonCode, undefined);
  }
  const foreign = failure(Object.assign(new Error("private"), { code: "BAD_MODEL_REPLY", diagnostic: { reasonCode: "MODEL_CONTENT_EMPTY" } }));
  assert.equal(foreign.reasonCode, undefined);
  const unrelated = client.safeVoiceError({ code: "NO_SPEECH", reasonCode: "MODEL_CONTENT_EMPTY" }, "VOICE_CHAT_ERROR");
  assert.equal(unrelated.message, client.voiceError("NO_SPEECH").message);
  assert.equal(unrelated.reasonCode, undefined);
});

test("unexplained recognition failures are not blamed on speech or a guessed network problem", () => {
  const publicFailure = failure(providerError({ code: "FailedOperation.ErrorRecognize", message: "private" }, "asr"));
  const error = client.safeVoiceError(publicFailure, "VOICE_CHAT_ERROR");
  assert.equal(error.code, "ASR_UNAVAILABLE");
  assert.match(error.message, /原因暂未确认/);
  assert.doesNotMatch(error.message, /没说话|没讲清楚|没有识别到文字|检查.*网络|麦克风/);
  assert.match(client.voiceError("NO_SPEECH").message, /没有识别到文字/);
});

test("unconverted simulator audio is diagnosed before a paid recognition call", async () => {
  let requests = 0;
  const providers = createProviders({
    env: { VOICE_CHAT_TENCENT_SECRET_ID: "fixture-id", VOICE_CHAT_TENCENT_SECRET_KEY: "fixture-key" },
    asrClient: { SentenceRecognition: async () => { requests++; return { Result: "Hello" }; } },
  });
  await assert.rejects(() => providers.transcribe(Buffer.from("1a45dfa301020304", "hex")), error => error.code === "AUDIO_FORMAT_UNSUPPORTED");
  assert.equal(requests, 0);
  assert.equal(await providers.transcribe(Buffer.from("ID3sample")), "Hello");
  assert.equal(await providers.transcribe(Buffer.from("fff3506400000000", "hex")), "Hello", "MP3 without ID3 remains valid");
  assert.equal(requests, 2);
});

test("only the simulator sees local-helper instructions for incompatible audio", () => {
  for (const platform of ["devtools", "ios", "android", "throw"]) {
    const service = loadClient("voiceChat.ts", {
      "./voiceChatErrors": client,
      "@/cloud": { CLOUD_ENV_ID: "fixture-env" },
      "@/services/appEntry": { readMiniProgramEnvVersion: () => "develop" },
    }, { getDeviceInfo: () => { if (platform === "throw") throw Error("no device info"); return { platform }; } });
    assert.throws(() => service.readVoiceChatResponse({ ok: false, code: "AUDIO_FORMAT_UNSUPPORTED", stage: "asr" }, "a".repeat(32)), error => {
      assert.equal(error.code, platform === "devtools" ? "SIMULATOR_AUDIO_FORMAT" : "AUDIO_FORMAT_UNSUPPORTED");
      assert.equal(error.stage, "asr");
      if (platform === "devtools") assert.match(error.message, /模拟器.*格式.*本地语音助手/);
      else assert.doesNotMatch(error.message, /模拟器|本地语音助手/);
      return true;
    });
  }
});
