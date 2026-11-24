const assert = require("node:assert/strict");
const { test } = require("node:test");
const { AsyncLocalStorage } = require("node:async_hooks");
const { createHandler } = require("../cloudfunctions/voiceChat/handler");
const { createProviders } = require("../cloudfunctions/voiceChat/providers");

// Every provider is fake. These tests never contact speech, model, or cloud APIs.
const credentials = {
  DEEPSEEK_API_KEY: "sk-diagnosticFixtureSecret1234",
  VOICE_CHAT_TENCENT_SECRET_ID: "AKIDdiagnosticFixture1234",
  VOICE_CHAT_TENCENT_SECRET_KEY: "fixture-tencent-secret-never-log",
};
const transcript = "I don't want to talk about animals. Could we talk about food?";
const inputAudio = "ID3-private-audio-sample-never-log";
const request = {
  requestId: "a".repeat(32), mode: "topic", level: "basic", topic: "animals",
  durationMs: 2000, audioBase64: Buffer.from(inputAudio).toString("base64"),
  turns: [{ userEn: "private-history-speech", assistantEn: "private-history-answer" }],
  privateExtra: "private-complete-request-marker",
};
const goodReply = { replyEn: "Dogs are fun! Which animal do you like?", replyZh: "狗很有趣！你喜欢哪种动物？", correction: null };
const response = (content, finishReason = "stop", usage = { prompt_tokens: 88, completion_tokens: 28 }) => ({
  choices: [{ finish_reason: finishReason, message: { content } }], usage,
});

function fixture(options = {}) {
  const logs = [], calls = { asr: 0, model: 0, tts: 0 };
  const providers = createProviders({
    env: credentials,
    asrClient: { SentenceRecognition: async () => { calls.asr++; return { Result: options.transcript ?? transcript }; } },
    ttsClient: { TextToVoice: async () => { calls.tts++; return { Audio: "QUJD" }; } },
    postJson: async (url, key, body) => {
      calls.model++;
      assert.equal(url, "https://api.deepseek.com/chat/completions");
      assert.equal(key, credentials.DEEPSEEK_API_KEY);
      assert.equal(body.response_format.type, "json_object");
      assert.ok(!JSON.stringify(body).includes(request.audioBase64), "audio never enters the model prompt");
      if (options.modelError) throw options.modelError;
      return options.response ?? response(" ".repeat(109));
    },
  });
  const handler = createHandler({
    ...providers,
    enabled: true, getOpenId: () => "tester", allowedOpenIds: new Set(["tester"]),
    logDiagnostic: (record) => logs.push(record),
    ...(options.adapters || {}),
  });
  return { handler, logs, calls };
}

function assertPublicFailure(result, reasonCode) {
  assert.deepEqual(result, {
    ok: false, code: "BAD_MODEL_REPLY", message: "AI 这次的回答格式异常，请重新生成回答",
    stage: "reply", retryable: true, requestId: request.requestId, reasonCode,
  });
}

function assertNoUnrelatedPrivateData(value) {
  const serialized = JSON.stringify(value);
  for (const text of [inputAudio, request.audioBase64, request.privateExtra,
    request.turns[0].userEn, request.turns[0].assistantEn, ...Object.values(credentials)]) {
    assert.ok(!serialized.includes(text), `diagnostics leaked unrelated private data: ${text}`);
  }
  for (const name of ["audioBase64", "authorization", "headers", "stack", "openId", "eventPayload"]) {
    assert.ok(!serialized.includes(`"${name}"`), `unexpected raw field: ${name}`);
  }
}

for (const [name, raw, reasonCode, expected] of [
  ["whitespace response", response(" ".repeat(109)), "MODEL_CONTENT_EMPTY", {}],
  ["token limit", response('{"replyEn":"unfinished', "length"), "MODEL_FINISH_INCOMPLETE", {}],
  ["invalid JSON", response('{"replyEn":"unfinished'), "MODEL_JSON_INVALID", {}],
  ["oversized English", response(JSON.stringify({ ...goodReply, replyEn: "A".repeat(221) })), "MODEL_FIELD_TOO_LONG", { field: "replyEn", actualLength: 221, maxLength: 220 }],
]) {
  test(`failure diagnostics identify ${name} and return only its safe reason code`, async () => {
    const { handler, logs, calls } = fixture({ response: raw });
    assertPublicFailure(await handler(request), reasonCode);
    assert.deepEqual(calls, { asr: 1, model: reasonCode === "MODEL_CONTENT_EMPTY" ? 2 : 1, tts: 0 }, "only empty replies get one bounded recovery attempt");
    assert.equal(logs.length, 1);
    const record = logs[0];
    assert.equal(record.event, "voice_chat_failure");
    assert.equal(record.safeCode, "BAD_MODEL_REPLY");
    assert.equal(record.stage, "reply");
    assert.equal(record.requestId, request.requestId);
    assert.equal(record.reasonCode, reasonCode);
    for (const [key, value] of Object.entries(expected)) assert.equal(record[key], value);
    assert.equal(record.mode, "topic");
    assert.equal(record.level, "basic");
    assert.equal(record.topic, "animals");
    assert.equal(record.historyTurns, 1);
    assert.equal(record.inputAudioBytes, Buffer.byteLength(inputAudio));
    assert.equal(record.inputDurationMs, 2000);
    assert.equal(record.transcriptCharacters, transcript.length);
    assert.deepEqual(record.model, {
      finishReason: raw.choices[0].finish_reason, promptTokens: 88, completionTokens: 28,
      contentKind: raw.choices[0].message.content.trim() ? "text" : "whitespace",
      contentCharacters: raw.choices[0].message.content.length,
      trimmedCharacters: raw.choices[0].message.content.trim().length,
      blank: raw.choices[0].message.content.trim().length === 0,
    });
    assert.ok(Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0);
    assert.ok(record.stageMs.asr >= 0 && record.stageMs.reply >= 0);
    assert.equal(record.stageMs.tts, undefined);
    assert.equal(record.debugText, undefined);
    assert.ok(!JSON.stringify(record).includes(transcript));
    assertNoUnrelatedPrivateData(record);
  });
}

test("missing, non-string and empty model content remain distinguishable", async () => {
  for (const [content, kind, reasonCode] of [
    [undefined, "missing", "MODEL_CONTENT_MISSING"],
    [null, "non_string", "MODEL_CONTENT_MISSING"],
    [{ privateContent: "private-object-never-log" }, "non_string", "MODEL_CONTENT_MISSING"],
    ["", "empty", "MODEL_CONTENT_EMPTY"],
  ]) {
    const { handler, logs } = fixture({ response: response(content), adapters: {
      unlimitedOpenIds: new Set(["tester"]), debugOpenIds: new Set(["tester"]),
    } });
    assertPublicFailure(await handler(request), reasonCode);
    assert.equal(logs[0].reasonCode, reasonCode);
    assert.equal(logs[0].model.contentKind, kind);
    if (kind === "empty") {
      assert.equal(logs[0].model.contentCharacters, 0);
      assert.equal(logs[0].model.blank, true);
      assert.equal(logs[0].debugText.modelContent, "");
    } else {
      assert.equal(logs[0].model.contentCharacters, undefined);
      assert.equal(logs[0].debugText.modelContent, undefined);
    }
    assert.ok(!JSON.stringify(logs).includes("private-object-never-log"));
  }
});

test("raw speech and model text require all three server-side account lists", async () => {
  const rawContent = "not-json-private-model-text";
  for (const [name, adapters, enabled] of [
    ["default", {}, false],
    ["debug only", { debugOpenIds: new Set(["tester"]) }, false],
    ["unlimited only", { unlimitedOpenIds: new Set(["tester"]) }, false],
    ["wrong debug account", { unlimitedOpenIds: new Set(["tester"]), debugOpenIds: new Set(["other"]) }, false],
    ["allowed internal debug account", { unlimitedOpenIds: new Set(["tester"]), debugOpenIds: new Set(["tester"]) }, true],
  ]) {
    const { handler, logs } = fixture({ response: response(rawContent), adapters });
    const result = await handler({ ...request, openId: "other", debug: true, includeText: true, debugOpenIds: ["tester"] });
    assertPublicFailure(result, "MODEL_JSON_INVALID");
    assert.equal(Boolean(logs[0].debugText), enabled, name);
    if (enabled) assert.deepEqual(logs[0].debugText, {
      transcript, transcriptTruncated: false, modelContent: rawContent, modelContentTruncated: false,
    });
    else assert.ok(!JSON.stringify(logs).includes(rawContent) && !JSON.stringify(logs).includes(transcript));
    assert.equal(result.debugText, undefined, "debug content is never returned to the client");
    assertNoUnrelatedPrivateData(logs);
  }
  const { handler, logs, calls } = fixture({ adapters: {
    allowedOpenIds: new Set(), unlimitedOpenIds: new Set(["tester"]), debugOpenIds: new Set(["tester"]),
  } });
  assert.equal((await handler(request)).code, "TRIAL_ONLY");
  assert.equal(logs[0].debugText, undefined);
  assert.deepEqual(calls, { asr: 0, model: 0, tts: 0 });
});

test("internal debug excerpts are bounded and indicate whether text was truncated", async () => {
  const adapters = { unlimitedOpenIds: new Set(["tester"]), debugOpenIds: new Set(["tester"]) };
  const rawContent = "not-json-" + "x".repeat(2400);
  const model = fixture({ response: response(rawContent), adapters });
  assertPublicFailure(await model.handler(request), "MODEL_JSON_INVALID");
  assert.equal(model.logs[0].debugText.modelContent.length, 2000);
  assert.equal(model.logs[0].debugText.modelContentTruncated, true);
  assert.equal(model.logs[0].model.contentCharacters, rawContent.length);
  const speech = fixture({ transcript: "y".repeat(501), adapters });
  assert.equal((await speech.handler(request)).code, "BAD_TRANSCRIPT");
  assert.equal(speech.logs[0].debugText.transcript.length, 500);
  assert.equal(speech.logs[0].debugText.transcriptTruncated, true);
  assert.equal(speech.logs[0].transcriptCharacters, 501);
  assert.equal(speech.logs[0].debugText.modelContent, undefined);
  assert.equal(speech.calls.model, 0);
});

test("internal debug text masks recognizable credentials without logging native errors", async () => {
  const sensitiveText = "my key sk-privateExampleKey1234 AKIDprivateExample1234 Bearer token.part-secret";
  const { handler, logs } = fixture({ transcript: sensitiveText, response: response(sensitiveText), adapters: {
    unlimitedOpenIds: new Set(["tester"]), debugOpenIds: new Set(["tester"]),
  } });
  assertPublicFailure(await handler(request), "MODEL_JSON_INVALID");
  assert.equal(logs[0].debugText.transcript, "my key [REDACTED] [REDACTED] Bearer [REDACTED]");
  assert.equal(logs[0].debugText.modelContent, "my key [REDACTED] [REDACTED] Bearer [REDACTED]");
  assertNoUnrelatedPrivateData(logs);
  const nativeSecret = "native-error-provider-request-private-marker";
  const native = fixture({ modelError: Object.assign(new Error(nativeSecret), {
    code: "BAD_MODEL_REPLY", headers: { Authorization: credentials.DEEPSEEK_API_KEY },
    request: request, diagnostic: { reasonCode: "MODEL_CONTENT_EMPTY", field: "replyEn" },
  }), adapters: { unlimitedOpenIds: new Set(["tester"]), debugOpenIds: new Set(["tester"]) } });
  assert.equal((await native.handler(request)).code, "REPLY_UNAVAILABLE");
  assert.equal(native.logs[0].reasonCode, undefined, "arbitrary native error fields cannot forge diagnostic reasons");
  assert.ok(!JSON.stringify(native.logs).includes(nativeSecret));
  assertNoUnrelatedPrivateData(native.logs);
});

test("untrusted provider finish reasons and token values cannot add arbitrary log contents", async () => {
  const secretReason = "private-finish-reason-do-not-log";
  const { handler, logs } = fixture({ response: response("", secretReason, { prompt_tokens: -1, completion_tokens: Infinity }) });
  assertPublicFailure(await handler(request), "MODEL_FINISH_INCOMPLETE");
  assert.equal(logs[0].model.finishReason, "unknown");
  assert.equal(logs[0].model.promptTokens, undefined);
  assert.equal(logs[0].model.completionTokens, undefined);
  assert.ok(!JSON.stringify(logs).includes(secretReason));
});

test("interleaved internal and ordinary requests keep diagnostic text request-local", async () => {
  const context = new AsyncLocalStorage(), logs = [], pending = new Map();
  let bothReady;
  const ready = new Promise((resolve) => { bothReady = resolve; });
  const providers = createProviders({
    env: credentials,
    asrClient: { SentenceRecognition: async ({ Data }) => ({ Result: Buffer.from(Data, "base64").toString().includes("INTERNAL") ? "internal speech unique" : "ordinary speech unique" }) },
    postJson: async (_url, _key, body) => new Promise((resolve) => {
      pending.set(JSON.parse(body.messages.at(-1).content).currentUtterance, resolve);
      if (pending.size === 2) bothReady();
    }),
  });
  const handler = createHandler({
    ...providers, enabled: true, getOpenId: () => context.getStore(),
    allowedOpenIds: new Set(["internal", "ordinary"]), unlimitedOpenIds: new Set(["internal"]),
    debugOpenIds: new Set(["internal", "ordinary"]), logDiagnostic: (record) => logs.push(record),
  });
  const internalId = "b".repeat(32), ordinaryId = "c".repeat(32);
  const internal = context.run("internal", () => handler({ ...request, requestId: internalId, audioBase64: Buffer.from("ID3 INTERNAL AUDIO").toString("base64") }));
  const ordinary = context.run("ordinary", () => handler({ ...request, requestId: ordinaryId, openId: "internal", debug: true, audioBase64: Buffer.from("ID3 ORDINARY AUDIO").toString("base64") }));
  await ready;
  pending.get("ordinary speech unique")(response("ordinary raw model unique"));
  await ordinary;
  pending.get("internal speech unique")(response("internal raw model unique"));
  await internal;
  assert.equal(logs.length, 2);
  assert.equal(logs[0].requestId, ordinaryId);
  assert.equal(logs[0].debugText, undefined);
  assert.equal(logs[1].requestId, internalId);
  assert.equal(logs[1].debugText.transcript, "internal speech unique");
  assert.equal(logs[1].debugText.modelContent, "internal raw model unique");
  assert.ok(!JSON.stringify(logs).includes("ordinary speech unique"));
  assert.ok(!JSON.stringify(logs).includes("ordinary raw model unique"));
});

for (const [name, logDiagnostic] of [
  ["synchronous", () => { throw new Error("private logger failure"); }],
  ["asynchronous", async () => { throw new Error("private logger failure"); }],
]) {
  test(`${name} logging failures do not prevent releasing a failed metered turn`, async () => {
    const quotaCalls = [];
    const { handler, calls } = fixture({ adapters: {
      quotaEnabled: true, logDiagnostic,
      quota: {
        reserve: async () => { quotaCalls.push("reserve"); return { token: "d".repeat(32) }; },
        release: async () => { quotaCalls.push("release"); },
        complete: async () => { quotaCalls.push("debit"); },
      },
    } });
    const result = await handler({ ...request, quotaProtocol: 1 });
    assert.equal(result.code, "BAD_MODEL_REPLY");
    assert.equal(result.stage, "reply");
    assert.match(result.message, /本次没有扣轮/);
    assert.deepEqual(quotaCalls, ["reserve", "release"]);
    assert.deepEqual(calls, { asr: 1, model: 2, tts: 0 });
    await new Promise((resolve) => setImmediate(resolve));
  });
}

test("successful internal conversations do not emit failure or content logs", async () => {
  const { handler, logs, calls } = fixture({ response: response(JSON.stringify(goodReply)), adapters: {
    unlimitedOpenIds: new Set(["tester"]), debugOpenIds: new Set(["tester"]),
  } });
  const result = await handler(request);
  assert.equal(result.ok, true);
  assert.equal(result.data.transcript, transcript);
  assert.equal(result.data.replyEn, goodReply.replyEn);
  assert.equal(result.data.audioBase64, "QUJD");
  assert.equal(result.data.debugText, undefined);
  assert.deepEqual(logs, []);
  assert.deepEqual(calls, { asr: 1, model: 1, tts: 1 });
});
