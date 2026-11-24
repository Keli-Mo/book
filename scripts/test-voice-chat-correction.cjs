const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHandler, parseReply } = require('../cloudfunctions/voiceChat/handler');

// The actual 2026-11-24 failure: valid correction is absent from spoken reply.
const pandaReply = {
  replyEn: 'Pandas are cute! But pandas are animals, not food. We are talking about food. What food do you like to eat?',
  replyZh: '熊猫很可爱！但熊猫是动物，不是食物。我们正在聊食物，你喜欢吃什么？',
  correction: { betterEn: 'I like pandas.', explanationZh: '说喜欢一种动物时，通常使用复数 pandas。' },
};
const request = { requestId: 'd'.repeat(32), mode: 'topic', topic: 'food', level: 'basic',
  durationMs: 2124, audioBase64: Buffer.from('ID3-audio-fixture').toString('base64'), turns: [], quotaProtocol: 1 };

function fixture(reply, overrides = {}) {
  const calls = [], logs = [];
  const handler = createHandler({
    enabled: true, allowedOpenIds: new Set(['tester']), getOpenId: () => 'tester',
    transcribe: async () => { calls.push('asr'); return 'I like panda.'; },
    reply: async () => { calls.push('reply'); return reply; },
    synthesize: async text => { calls.push(['tts', text]); return 'QUJD'; },
    logDiagnostic: record => logs.push(record), ...overrides,
  });
  return { handler, calls, logs };
}

test('actual panda reply succeeds once and keeps a valid correction card even without spoken inclusion', async () => {
  const { handler, calls, logs } = fixture(pandaReply);
  const result = await handler(request);
  assert.equal(result.ok, true);
  assert.equal(result.data.transcript, 'I like panda.');
  assert.deepEqual(result.data.correction, pandaReply.correction);
  assert.equal(result.data.replyEn, pandaReply.replyEn);
  assert.equal(result.data.replyZh, pandaReply.replyZh);
  assert.deepEqual(calls, ['asr', 'reply', ['tts', pandaReply.replyEn]]);
  assert.deepEqual(logs, [{ event: 'voice_chat_correction_warning', stage: 'reply', requestId: request.requestId,
    outcome: 'separate_card', reasonCode: 'MODEL_CORRECTION_MISMATCH', field: 'correction.betterEn' }]);
});

test('a punctuation difference in an otherwise valid correction does not fail the turn', async () => {
  const reply = { ...pandaReply, replyEn: 'You can say: I like pandas! What else do you like?' };
  const { handler } = fixture(reply);
  const result = await handler(request);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.correction, reply.correction);
});

for (const [name, correction] of [
  ['wrong container type', 'bad'], ['array', []], ['missing fields', {}],
  ['blank sentence', { ...pandaReply.correction, betterEn: '  ' }],
  ['non-English sentence', { ...pandaReply.correction, betterEn: '我喜欢熊猫。' }],
  ['no letters', { ...pandaReply.correction, betterEn: '123!' }],
  ['overlong sentence', { ...pandaReply.correction, betterEn: 'a'.repeat(181) }],
  ['missing explanation', { betterEn: 'I like pandas.' }],
  ['no Chinese explanation', { ...pandaReply.correction, explanationZh: 'Use the plural.' }],
  ['overlong explanation', { ...pandaReply.correction, explanationZh: '字'.repeat(181) }],
]) {
  test(`invalid optional correction (${name}) is omitted while valid bilingual reply still plays`, async () => {
    const reply = { ...pandaReply, correction };
    const { handler, calls, logs } = fixture(reply);
    const result = await handler(request);
    assert.equal(result.ok, true);
    assert.equal(result.data.correction, undefined);
    assert.equal(result.data.replyEn, reply.replyEn);
    assert.equal(result.data.replyZh, reply.replyZh);
    assert.deepEqual(calls, ['asr', 'reply', ['tts', reply.replyEn]]);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].event, 'voice_chat_correction_warning');
    assert.equal(logs[0].outcome, 'omitted');
    assert.ok(!JSON.stringify(logs).includes('I like panda'), 'warning does not store speech or model text');
  });
}

test('valid spoken corrections and absent corrections retain normal behavior without warnings', async () => {
  for (const reply of [{ ...pandaReply, replyEn: 'You can say: I like pandas. What else do you like?' },
    { ...pandaReply, correction: null }]) {
    const { handler, logs } = fixture(reply);
    const result = await handler(request);
    assert.equal(result.ok, true);
    assert.deepEqual(result.data.correction, reply.correction || undefined);
    assert.deepEqual(logs, []);
  }
});

test('invalid primary reply still fails and never reaches TTS', async () => {
  for (const reply of [{ ...pandaReply, replyEn: '你好' }, { ...pandaReply, replyZh: 'No Chinese' },
    { ...pandaReply, replyEn: 'a'.repeat(221) }, null, '{broken']) {
    const { handler, calls } = fixture(reply);
    const result = await handler(request);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'BAD_MODEL_REPLY');
    assert.deepEqual(calls, ['asr', 'reply']);
  }
});

test('correction fallback preserves the metered receipt and never retries or releases a successful turn', async () => {
  const quotaCalls = [], token = 'e'.repeat(32);
  const { handler, calls } = fixture(pandaReply, { quotaEnabled: true, quota: {
    reserve: async () => { quotaCalls.push('reserve'); return { token }; },
    release: async () => { quotaCalls.push('release'); },
    complete: async () => { quotaCalls.push('complete'); },
  } });
  const result = await handler(request);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.receipt, { requestId: request.requestId, token });
  assert.deepEqual(quotaCalls, ['reserve']);
  assert.equal(calls.length, 3);
});

test('diagnostic failures cannot turn a correction warning into a failed reply', async () => {
  for (const logDiagnostic of [() => { throw Error('log offline'); }, async () => { throw Error('log offline'); }]) {
    assert.equal((await fixture(pandaReply, { logDiagnostic }).handler(request)).ok, true);
  }
  assert.equal(parseReply(pandaReply).replyEn, pandaReply.replyEn);
});
