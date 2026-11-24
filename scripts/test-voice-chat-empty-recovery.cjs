const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildMessages, createProviders } = require('../cloudfunctions/voiceChat/providers');
const { createDiagnostics } = require('../cloudfunctions/voiceChat/diagnostics');
const { createHandler } = require('../cloudfunctions/voiceChat/handler');
const input = { requestId: 'e'.repeat(32), mode: 'topic', topic: 'school', level: 'basic',
  transcript: "I don't like the ice skate, I like pasqui I Ming.",
  turns: [{ userEn: 'I like ice skating.', assistantEn: 'Do you skate after school?' }], audio: Buffer.from('ID3fixture'), durationMs: 6000 };
const reply = { replyEn: 'What do you like to do at school?', replyZh: '你喜欢在学校做什么？', correction: null };
const response = content => ({ choices: [{ finish_reason: 'stop', message: { content } }], usage: { completion_tokens: 22 } });

test('conversation history is preserved as data instead of plain-English assistant continuations', () => {
  const messages = buildMessages(input);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].role, 'user');
  assert.deepEqual(JSON.parse(messages[1].content), { conversation: input.turns, currentUtterance: input.transcript });
});

test('blank JSON response recovers once without repeating recognition, speech or losing transcript', async () => {
  const calls = [], bodies = [], logs = [];
  const provider = createProviders({ env: { DEEPSEEK_API_KEY: 'fixture' }, postJson: async (url, key, body, timeout) => {
    calls.push('model'); bodies.push(body); assert.ok(timeout > 0 && timeout <= 20000);
    return response(bodies.length === 1 ? ' '.repeat(94) : JSON.stringify(reply));
  } });
  const handler = createHandler({ ...provider, enabled: true, getOpenId: () => 'owner', allowedOpenIds: new Set(['owner']),
    transcribe: async () => { calls.push('asr'); return input.transcript; },
    synthesize: async () => { calls.push('tts'); return 'QUJD'; }, logDiagnostic: row => logs.push(row) });
  const result = await handler({ ...input, audioBase64: input.audio.toString('base64'), progressProtocol: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.data.transcript, input.transcript);
  assert.deepEqual(calls, ['asr', 'model', 'model', 'tts']);
  assert.deepEqual(bodies[1].messages[1], bodies[0].messages[1]);
  assert.notEqual(bodies[1].messages[0].content, bodies[0].messages[0].content);
  assert.equal(logs.length, 0, 'recovered answer must not log private content');
});

test('two empty replies stop and keep bounded attempt diagnostics', async () => {
  let calls = 0;
  const diagnostics = createDiagnostics(input);
  const provider = createProviders({ env: { DEEPSEEK_API_KEY: 'fixture' }, postJson: async () => { calls++; return response('  '); } });
  await assert.rejects(() => provider.reply({ ...input, diagnostics }), e => e.diagnostic?.reasonCode === 'MODEL_CONTENT_EMPTY');
  assert.equal(calls, 2);
  assert.equal(diagnostics.snapshot().modelAttempts.length, 2);
  assert.ok(diagnostics.snapshot().modelAttempts.every(attempt => attempt.blank));
  assert.ok(!JSON.stringify(diagnostics.snapshot()).includes(input.transcript));
});

test('automatic retry uses the original time budget and does not run after budget is exhausted', async () => {
  for (const elapsed of [15000, 19501]) {
    let clock = 0; const timeouts = [];
    const provider = createProviders({ env: { DEEPSEEK_API_KEY: 'fixture' }, now: () => clock,
      postJson: async (url, key, body, timeout) => { timeouts.push(timeout); clock = elapsed; return response(' '); } });
    await assert.rejects(() => provider.reply(input), e => e.diagnostic?.reasonCode === 'MODEL_CONTENT_EMPTY');
    assert.deepEqual(timeouts, elapsed === 15000 ? [20000, 5000] : [20000]);
  }
});

test('authorization, transport and nonblank malformed replies do not trigger paid retries', async () => {
  for (const failure of [{ statusCode: 401 }, { code: 'ETIMEDOUT' }, 'not-json']) {
    let calls = 0;
    const provider = createProviders({ env: { DEEPSEEK_API_KEY: 'fixture' }, postJson: async () => {
      calls++; if (typeof failure === 'string') return response(failure); throw Object.assign(Error('private'), failure);
    } });
    await assert.rejects(() => provider.reply(input));
    assert.equal(calls, 1);
  }
});
