const assert = require("node:assert/strict");
const https = require("node:https");
const { EventEmitter } = require("node:events");
const { buildMessages, createProviders, tencentClientConfig } = require("../cloudfunctions/voiceChat/providers");

const input = {
  requestId: "b".repeat(32), mode: "topic", level: "basic", topic: "animals", transcript: "I like dogs.",
  turns: [{ userEn: "Hello", assistantEn: "Hi! What animal do you like?" }],
};
const messages = buildMessages(input);
assert.equal(messages[0].role, "system");
assert.match(messages[0].content, /JSON/);
assert.match(messages[0].content, /animals/);
assert.equal(JSON.parse(messages.at(-1).content).currentUtterance, "I like dogs.");

const localEnv = { TENCENTCLOUD_SECRET_ID: "local-id", TENCENTCLOUD_SECRET_KEY: "local-key" };
const speechEnv = { VOICE_CHAT_TENCENT_SECRET_ID: "speech-id", VOICE_CHAT_TENCENT_SECRET_KEY: "speech-key" };
const runtimeEnv = { TENCENTCLOUD_RUNENV: "SCF", TENCENTCLOUD_SECRETID: "runtime-id", TENCENTCLOUD_SECRETKEY: "runtime-key", TENCENTCLOUD_REGION: "ap-shanghai" };
const configMissing = (err) => err.code === "CONFIG_MISSING";
assert.deepEqual(tencentClientConfig(localEnv).credential, { secretId: "local-id", secretKey: "local-key" });
assert.deepEqual(tencentClientConfig({ ...localEnv, ...speechEnv }).credential, { secretId: "speech-id", secretKey: "speech-key" });
assert.throws(() => tencentClientConfig({ ...localEnv, VOICE_CHAT_TENCENT_SECRET_ID: "unpaired" }), configMissing);
assert.throws(() => tencentClientConfig({ ...runtimeEnv, ...localEnv }), configMissing);
assert.equal(tencentClientConfig({ ...runtimeEnv, ...speechEnv }).region, "ap-guangzhou");
assert.equal(tencentClientConfig({ ...speechEnv, VOICE_CHAT_TENCENT_REGION: "ap-beijing" }).region, "ap-beijing");

async function testHttpFailures() {
  const originalRequest = https.request;
  try {
    for (const [scenario, expected] of [
      [{ statusCode: 401, body: "sensitive upstream detail" }, { statusCode: 401 }],
      [{ statusCode: 429, body: "private key" }, { statusCode: 429 }],
      [{ statusCode: 200, body: "broken-json" }, { code: "BAD_MODEL_REPLY", reasonCode: "MODEL_HTTP_JSON_INVALID" }],
      [{ statusCode: 200, body: "x".repeat(1000001) }, { code: "BAD_MODEL_REPLY", reasonCode: "MODEL_HTTP_RESPONSE_TOO_LARGE" }],
      [{ timeout: true }, { code: "ETIMEDOUT" }],
      [{ interrupted: true }, { code: "ECONNRESET" }],
    ]) {
      https.request = (_url, options, onResponse) => {
        assert.ok(options.timeout > 0 && options.timeout <= 20000, "不超过原有总超时预算");
        const req = new EventEmitter();
        req.destroy = (error) => req.emit("error", error);
        req.end = () => queueMicrotask(() => {
          if (scenario.timeout) return req.emit("timeout");
          const res = new EventEmitter();
          res.statusCode = scenario.statusCode || 200;
          res.setEncoding = () => {};
          onResponse(res);
          if (scenario.interrupted) return res.emit("aborted");
          res.emit("data", scenario.body);
          res.emit("end");
        });
        return req;
      };
      const provider = createProviders({ env: { DEEPSEEK_API_KEY: "test-key" } });
      await assert.rejects(() => provider.reply(input), (error) => {
        for (const [key, value] of Object.entries(expected)) assert.equal(key === "reasonCode" ? error.diagnostic?.reasonCode : error[key], value);
        assert.ok(!error.message.includes("sensitive upstream detail"));
        assert.ok(!error.message.includes("private key"));
        return true;
      });
    }
  } finally { https.request = originalRequest; }
}

(async () => {
  await testHttpFailures();
  const asrCalls = [], ttsCalls = [], httpCalls = [];
  const providers = createProviders({
    env: { ...runtimeEnv, ...speechEnv, DEEPSEEK_API_KEY: "deepseek" },
    asrClient: { SentenceRecognition: async (args) => { asrCalls.push(args); return { Result: "I like dogs." }; } },
    ttsClient: { TextToVoice: async (args) => { ttsCalls.push(args); return { Audio: "QUJD" }; } },
    postJson: async (url, key, body) => { httpCalls.push({ url, key, body }); return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ replyEn: "Dogs are great!", replyZh: "狗很棒！" }) } }] }; },
  });
  assert.equal(await providers.transcribe(Buffer.from("ID3sample")), "I like dogs.");
  assert.equal(asrCalls[0].EngSerViceType, "16k_en");
  assert.equal(asrCalls[0].VoiceFormat, "mp3");
  const reply = await providers.reply(input);
  assert.equal(reply.replyEn, "Dogs are great!");
  assert.equal(httpCalls[0].body.model, "deepseek-flash");
  assert.equal(httpCalls[0].body.thinking.type, "disabled");
  assert.equal(httpCalls[0].body.response_format.type, "json_object");
  assert.equal(await providers.synthesize(reply.replyEn, { requestId: input.requestId, level: "basic" }), "QUJD");
  assert.equal(ttsCalls[0].VoiceType, 101050);
  assert.equal(ttsCalls[0].PrimaryLanguage, 2);
  assert.equal(ttsCalls[0].Codec, "mp3");
  assert.equal(ttsCalls[0].Speed, -1);
  const missing = createProviders({ env: {} });
  await assert.rejects(() => missing.transcribe(Buffer.from("ID3sample")), (error) => error.code === "CONFIG_MISSING");
  for (const result of [undefined, null, {}, { Result: null }, { Result: 0 }]) {
    const malformed = createProviders({ env: speechEnv, asrClient: { SentenceRecognition: async () => result } });
    await assert.rejects(() => malformed.transcribe(Buffer.from("ID3sample")), (error) => error.code === "ASR_UNAVAILABLE");
  }
  const silent = createProviders({ env: speechEnv, asrClient: { SentenceRecognition: async () => ({ Result: "" }) } });
  assert.equal(await silent.transcribe(Buffer.from("ID3sample")), "", "仅确认返回的空文字才表示未识别到内容");
  for (const [result, reasonCode] of [
    [{}, "MODEL_FINISH_INCOMPLETE"],
    [{ choices: [{ finish_reason: "length", message: { content: "{}" } }] }, "MODEL_FINISH_INCOMPLETE"],
    [{ choices: [{ finish_reason: "stop" }] }, "MODEL_CONTENT_MISSING"],
    [{ choices: [{ finish_reason: "stop", message: { content: null } }] }, "MODEL_CONTENT_MISSING"],
    [{ choices: [{ finish_reason: "stop", message: { content: "" } }] }, "MODEL_CONTENT_EMPTY"],
    [{ choices: [{ finish_reason: "stop", message: { content: " ".repeat(109) } }], usage: { completion_tokens: 28 } }, "MODEL_CONTENT_EMPTY"],
    [{ choices: [{ finish_reason: "stop", message: { content: "{private malformed model content" } }] }, "MODEL_JSON_INVALID"],
  ]) {
    let observed = false, requests = 0;
    const malformed = createProviders({ env: { DEEPSEEK_API_KEY: "test-key" }, postJson: async () => { requests++; return result; } });
    await assert.rejects(() => malformed.reply({ ...input, diagnostics: { modelResponse: (value) => {
      assert.equal(value, result, "观察原始返回，保留 finish_reason 和空白长度供安全诊断");
      observed = true;
    } } }), (error) => {
      assert.equal(observed, true, "模型校验失败之前先采集诊断");
      assert.equal(error.code, "BAD_MODEL_REPLY");
      assert.equal(error.diagnostic?.reasonCode, reasonCode);
      assert.ok(!JSON.stringify(error.diagnostic).includes("private malformed model content"));
      return true;
    });
    assert.equal(requests, reasonCode === "MODEL_CONTENT_EMPTY" ? 2 : 1, "只为空回答执行一次自动恢复");
  }
  for (const modelResponse of [() => { throw new Error("diagnostic unavailable"); }, async () => { throw new Error("diagnostic unavailable"); }]) {
    const expected = { replyEn: "Hello!", replyZh: "你好！", correction: null };
    const reliable = createProviders({ env: { DEEPSEEK_API_KEY: "test-key" }, postJson: async () => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(expected) } }] }) });
    assert.deepEqual(await reliable.reply({ ...input, diagnostics: { modelResponse } }), expected, "诊断抛异常不影响正常回答");
  }
  console.log("voice chat provider checks passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
