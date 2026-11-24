const assert = require("node:assert/strict");
const { createHandler, validateRequest, parseReply } = require("../cloudfunctions/voiceChat/handler");
const { definitions } = require("../cloudfunctions/voiceChat/errors");

const request = {
  requestId: "a".repeat(32), mode: "free", level: "basic", topic: "animals",
  durationMs: 2000, audioBase64: Buffer.from("ID3sample").toString("base64"), turns: [],
};
const goodReply = { replyEn: "Dogs are fun! You can say, 'I went to the park.' What did you see?", replyZh: "狗很有趣！你可以说‘我去了公园’。你看到了什么？", correction: { betterEn: "I went to the park.", explanationZh: "过去发生的事用 went。" } };

assert.equal(validateRequest(request).mode, "free");
assert.throws(() => validateRequest({ ...request, audioBase64: "" }), /录音/);
assert.throws(() => validateRequest({ ...request, mode: "other" }), /模式/);
assert.throws(() => validateRequest({ ...request, durationMs: 31000 }), /时长/);
assert.throws(() => validateRequest({ ...request, turns: [{ userEn: "x".repeat(501), assistantEn: "Hi" }] }), /上下文/);
assert.equal(parseReply(JSON.stringify(goodReply)).correction.betterEn, "I went to the park.");
assert.throws(() => parseReply('{"replyEn":"你好","replyZh":"Hello"}'), /英文/);
assert.throws(() => parseReply('{"replyEn":"Hello, привет!","replyZh":"你好！"}'), /英文/);
assert.throws(() => parseReply('{"replyEn":"Hello!","replyZh":"Hello!"}'), /中文字幕/);
assert.throws(() => parseReply('{"replyEn":"","replyZh":"你好"}'), (error) => error.code === "BAD_MODEL_REPLY");

async function testMeteredHandler() {
  const token = "b".repeat(32);
  const balance = { freeRemaining: 4, packRemaining: 0, packExpiresAt: null };
  const events = [];
  const quota = {
    status: async (id) => { events.push(["status", id]); return balance; },
    reserve: async (...args) => { events.push(["reserve", ...args]); return { token }; },
    release: async (...args) => { events.push(["release", ...args]); },
    complete: async (...args) => { events.push(["complete", ...args]); return balance; },
  };
  const base = {
    enabled: true, allowedOpenIds: new Set(["learner"]), getOpenId: () => "learner",
    quotaEnabled: true, unlimitedOpenIds: new Set(["owner"]), quota,
    transcribe: async () => { events.push(["asr"]); return "I like dogs."; },
    reply: async () => { events.push(["reply"]); return goodReply; },
    synthesize: async () => { events.push(["tts"]); return "QUJD"; },
  };
  const chat = { ...request, quotaProtocol: 1, openId: "owner", unlimited: true };
  const handler = createHandler(base);
  const status = { action: "quotaStatus", openId: "owner" };
  assert.deepEqual((await handler(status)).data.quota, { kind: "metered", ...balance });
  assert.deepEqual(events.splice(0), [["status", "learner"]]);
  assert.equal((await handler(request)).code, "UPDATE_REQUIRED");
  assert.equal((await handler({ ...chat, action: "grantPack" })).code, "INVALID_ARGUMENT");
  assert.deepEqual(events, []);

  const delivered = await handler(chat);
  assert.equal(delivered.ok, true);
  assert.deepEqual(delivered.data.receipt, { requestId: request.requestId, token });
  assert.deepEqual(events.splice(0), [
    ["reserve", "learner", request.requestId], ["asr"], ["reply"], ["tts"],
  ], "生成后断网或未确认不会扣轮");
  const confirm = { action: "confirmTurn", ...delivered.data.receipt, openId: "owner" };
  assert.equal((await handler({ ...confirm, token: "" })).code, "INVALID_RECEIPT");
  assert.deepEqual(events, []);
  for (let i = 0; i < 2; i++) {
    assert.deepEqual((await handler(confirm)).data.quota, { kind: "metered", ...balance });
    assert.deepEqual(events.splice(0), [["complete", "learner", request.requestId, token]], "重试只确认同一张收据");
  }
  assert.equal((await handler({ ...confirm, action: "cancelTurn" })).code, "INVALID_ARGUMENT");
  assert.deepEqual(events, [], "客户端不能释放已经收到的语音");

  const diagnostics = [];
  for (const [change, code] of [
    [{ transcribe: async () => "" }, "NO_SPEECH"],
    [{ transcribe: async () => undefined }, "ASR_UNAVAILABLE"],
    [{ reply: async () => null }, "BAD_MODEL_REPLY"],
    [{ synthesize: async () => "" }, "BAD_AUDIO"],
    [{ transcribe: async () => { throw new Error("provider failure"); } }, "ASR_UNAVAILABLE"],
    [{ reply: async () => { throw new Error("provider failure"); } }, "REPLY_UNAVAILABLE"],
    [{ synthesize: async () => { throw new Error("provider failure"); } }, "TTS_UNAVAILABLE"],
    [{ transcribe: async () => { throw Object.assign(new Error("private provider detail"), { code: "FailedOperation.ErrorRecognize" }); } }, "ASR_UNAVAILABLE"],
    [{ reply: async () => { throw Object.assign(new Error("missing key"), { code: "CONFIG_MISSING" }); } }, "CONFIG_MISSING"],
  ]) {
    const failure = await createHandler({ ...base, ...change, logDiagnostic: (event) => diagnostics.push(event) })(chat);
    assert.equal(failure.code, code);
    assert.match(failure.message, /没有扣轮/);
    assert.deepEqual(events.at(-1), ["release", "learner", request.requestId, token]);
    assert.ok(!events.some(([name]) => name === "complete"));
    assert.equal(typeof failure.retryable, "boolean");
    assert.equal(failure.requestId, request.requestId);
    assert.equal(diagnostics.at(-1).safeCode, code);
    events.length = 0;
  }
  const throws = (code) => async () => { throw Object.assign(new Error("do not expose"), { code }); };
  for (const code of ["QUOTA_EXHAUSTED", "REQUEST_IN_PROGRESS", "REQUEST_COMPLETED"]) {
    const denied = await createHandler({ ...base, quota: { reserve: throws(code) } })(chat);
    assert.equal(denied.code, code);
    assert.deepEqual(events, [], "预留失败后不调用收费服务");
  }
  for (const code of ["RESERVATION_EXPIRED", "INVALID_RECEIPT"]) {
    const invalid = await createHandler({ ...base, quota: { complete: throws(code) } })(confirm);
    assert.equal(invalid.code, code);
    assert.deepEqual(events, []);
  }
  const emptyStore = createHandler({ ...base, quota: null });
  assert.equal((await emptyStore(chat)).code, "QUOTA_UNAVAILABLE");
  assert.deepEqual(events, []);
  const unauthorized = createHandler({ ...base, getOpenId: () => "owner" });
  assert.equal((await unauthorized(status)).code, "TRIAL_ONLY", "内部名单也需要试用授权");
  assert.equal((await unauthorized(confirm)).code, "TRIAL_ONLY");
  assert.deepEqual(events, []);
  const forbidQuota = () => { throw new Error("Unlimited users must not access quota storage"); };
  const internal = createHandler({ ...base, unlimitedOpenIds: new Set(["learner"]), quota: {
    status: forbidQuota, reserve: forbidQuota, complete: forbidQuota, release: forbidQuota,
  } });
  assert.deepEqual((await internal(status)).data.quota, { kind: "unlimited" });
  for (let turn = 0; turn < 6; turn++) {
    const ownerTurn = await internal({ ...request, requestId: turn.toString(16).padStart(32, "0") });
    assert.equal(ownerTurn.ok, true);
    assert.equal(ownerTurn.data.receipt, undefined);
    assert.deepEqual(ownerTurn.data.quota, { kind: "unlimited" });
    assert.deepEqual(events.splice(0), [["asr"], ["reply"], ["tts"]]);
  }
}

async function testFailureTaxonomy() {
  const secret = "private-key-child-transcript-audio-base64";
  const base = {
    enabled: true, allowedOpenIds: new Set(["learner"]), getOpenId: () => "learner",
    transcribe: async () => "I like dogs.", reply: async () => goodReply, synthesize: async () => "QUJD",
  };
  const cases = [
    ["transcribe", { code: "ETIMEDOUT" }, "ASR_TIMEOUT", "asr", true, "ETIMEDOUT"],
    ["reply", { statusCode: 408 }, "REPLY_TIMEOUT", "reply", true, "HTTP_408"],
    ["synthesize", { cause: { code: "ETIMEDOUT" } }, "TTS_TIMEOUT", "tts", true, "ETIMEDOUT"],
    ["transcribe", { httpCode: 504 }, "ASR_TIMEOUT", "asr", true, "HTTP_504"],
    ["transcribe", { code: "RequestLimitExceeded" }, "ASR_BUSY", "asr", true, "RequestLimitExceeded"],
    ["reply", { statusCode: 429 }, "REPLY_BUSY", "reply", true, "HTTP_429"],
    ["reply", { statusCode: 503 }, "REPLY_BUSY", "reply", true, "HTTP_503"],
    ["synthesize", { code: "InternalError.ExceedMaxLimit" }, "TTS_BUSY", "tts", true, "InternalError.ExceedMaxLimit"],
    ["synthesize", { httpCode: 503 }, "TTS_BUSY", "tts", true, "HTTP_503"],
    ["transcribe", { code: "ECONNRESET" }, "ASR_NETWORK", "asr", true, "ECONNRESET"],
    ["reply", { code: "ENOTFOUND" }, "REPLY_NETWORK", "reply", true, "ENOTFOUND"],
    ["synthesize", { cause: { code: "EAI_AGAIN" } }, "TTS_NETWORK", "tts", true, "EAI_AGAIN"],
    ["transcribe", { code: "AuthFailure.SignatureFailure" }, "SERVICE_AUTH_FAILED", "asr", false, "AuthFailure.SignatureFailure"],
    ["reply", { statusCode: 401 }, "SERVICE_AUTH_FAILED", "reply", false, "HTTP_401"],
    ["reply", { statusCode: 402 }, "SERVICE_QUOTA_EXHAUSTED", "reply", false, "HTTP_402"],
    ["synthesize", { code: "UnsupportedOperation.PkgExhausted" }, "SERVICE_QUOTA_EXHAUSTED", "tts", false, "UnsupportedOperation.PkgExhausted"],
    ["transcribe", { code: "FailedOperation.UserNotRegistered" }, "SERVICE_CONFIG_ERROR", "asr", false, "FailedOperation.UserNotRegistered"],
    ["reply", { statusCode: 422 }, "SERVICE_CONFIG_ERROR", "reply", false, "HTTP_422"],
    ["transcribe", { code: "InvalidParameterValue.ErrorInvalidVoicedata" }, "INVALID_AUDIO", "asr", true, "InvalidParameterValue.ErrorInvalidVoicedata"],
    ["transcribe", { code: "FailedOperation.ErrorRecognize" }, "ASR_UNAVAILABLE", "asr", true, "FailedOperation.ErrorRecognize"],
    ["transcribe", { code: "FailedOperation.NoVoice" }, "ASR_UNAVAILABLE", "asr", true, undefined],
    ["reply", { statusCode: 500 }, "REPLY_UNAVAILABLE", "reply", true, "HTTP_500"],
    ["transcribe", { code: "INVALID_ARGUMENT" }, "ASR_UNAVAILABLE", "asr", true, undefined],
    ["transcribe", { code: secret, providerCode: secret, requestId: secret, stage: secret }, "ASR_UNAVAILABLE", "asr", true, undefined],
  ];
  for (const [operation, details, code, stage, retryable, providerCode] of cases) {
    const logs = [], calls = [];
    const adapters = { ...base, logDiagnostic: (record) => logs.push(record) };
    for (const name of ["transcribe", "reply", "synthesize"]) adapters[name] = async () => {
      calls.push(name);
      if (name === operation) throw Object.assign(new Error(secret), details);
      return base[name]();
    };
    const result = await createHandler(adapters)(request);
    assert.deepEqual(result, { ok: false, code, message: definitions[code][0], stage, retryable, requestId: request.requestId });
    assert.equal(logs.length, 1, "每次失败只写一条诊断日志");
    const { elapsedMs, stageMs, ...logged } = logs[0];
    assert.deepEqual(logged, {
      event: "voice_chat_failure", stage, safeCode: code, ...(providerCode ? { providerCode } : {}), requestId: request.requestId,
      mode: "free", level: "basic", historyTurns: 0, inputAudioBytes: 9, inputDurationMs: 2000,
      ...(operation === "transcribe" ? {} : { transcriptCharacters: "I like dogs.".length }),
    });
    assert.ok(Number.isInteger(elapsedMs) && elapsedMs >= 0);
    const completedStages = { transcribe: ["asr"], reply: ["asr", "reply"], synthesize: ["asr", "reply", "tts"] }[operation];
    assert.deepEqual(Object.keys(stageMs), completedStages);
    for (const value of Object.values(stageMs)) assert.ok(Number.isInteger(value) && value >= 0);
    assert.equal(calls.at(-1), operation, "失败后停止后续收费调用");
    assert.equal(calls.filter((name) => name === operation).length, 1, "服务端不自动重试收费调用");
    assert.ok(!JSON.stringify([result, logs]).includes(secret));
    const quotaCalls = [];
    const metered = await createHandler({ ...adapters, quotaEnabled: true, quota: {
      reserve: async () => { quotaCalls.push("reserve"); return { token: "b".repeat(32) }; },
      release: async () => { quotaCalls.push("release"); },
      complete: async () => { quotaCalls.push("debit"); },
    } })({ ...request, quotaProtocol: 1 });
    assert.equal(metered.code, code);
    assert.match(metered.message, /本次没有扣轮/);
    assert.deepEqual(quotaCalls, ["reserve", "release"], "各种服务失败均释放预留且不扣轮");
  }
  for (const logDiagnostic of [() => { throw new Error(secret); }, async () => { throw new Error(secret); }]) {
    const result = await createHandler({ ...base, transcribe: async () => "", logDiagnostic })(request);
    assert.equal(result.code, "NO_SPEECH", "日志失败不影响正常错误返回");
  }
  const logs = [];
  const invalid = await createHandler({ ...base, logDiagnostic: (record) => logs.push(record) })({ ...request, requestId: secret });
  assert.equal(invalid.code, "INVALID_ARGUMENT");
  assert.equal(invalid.stage, "validation");
  assert.equal(invalid.requestId, undefined);
  assert.ok(!JSON.stringify([invalid, logs]).includes(secret));
}

(async () => {
  await testMeteredHandler();
  await testFailureTaxonomy();
  let calls = [];
  const handler = createHandler({
    enabled: true,
    allowedOpenIds: new Set(["user-1"]),
    getOpenId: () => "user-1",
    transcribe: async (audio) => { calls.push(["asr", audio.length]); return "Yesterday I go to the park."; },
    reply: async (input) => { calls.push(["llm", input.transcript]); return goodReply; },
    synthesize: async (text) => { calls.push(["tts", text]); return "QUJD"; },
  });
  const result = await handler(request);
  assert.equal(result.ok, true);
  assert.equal(result.data.transcript, "Yesterday I go to the park.");
  assert.equal(result.data.audioBase64, "QUJD");
  assert.deepEqual(calls.map((call) => call[0]), ["asr", "llm", "tts"]);
  assert.equal(calls[2][1], goodReply.replyEn, "只合成英文回复");

  calls = [];
  const failedAsr = createHandler({ enabled: true, allowedOpenIds: new Set(["user-1"]), getOpenId: () => "user-1", transcribe: async () => "", reply: async () => { calls.push("llm"); }, synthesize: async () => { calls.push("tts"); } });
  const retry = await failedAsr(request);
  assert.equal(retry.ok, false);
  assert.equal(retry.code, "NO_SPEECH");
  assert.deepEqual(calls, []);

  const disabled = await createHandler({ enabled: false })(request);
  assert.equal(disabled.code, "NOT_ENABLED");
  const identity = await createHandler({ enabled: false, getOpenId: () => "user-1" })({ action: "trialIdentity" });
  assert.deepEqual(identity, { ok: true, data: { openId: "user-1" } });
  const trialOnly = await createHandler({ enabled: true, allowedOpenIds: new Set(), getOpenId: () => "user-1", transcribe: async () => { calls.push("asr"); } })(request);
  assert.equal(trialOnly.code, "TRIAL_ONLY");
  assert.deepEqual(calls, [], "非试用用户不能触发付费服务");
  console.log("voice chat handler checks passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
